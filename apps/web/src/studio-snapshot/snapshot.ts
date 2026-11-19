import { domToCanvas } from "modern-screenshot";

/**
 * The screenshot a remark comes with: the window of the preview as its writer sees it, with the element
 * the remark is about outlined and its pin drawn. The page is drawn again from its own DOM, in the
 * writer's browser, without asking them anything: a browser lets no page take a picture of itself.
 *
 * The page is left as it is. What the copy needs is written on the page as attributes for the time of
 * the copy, and taken off after: how the children of a scrolled container move, which images are out
 * of the window, where the stills of its videos go.
 *
 * Built on its own, as `studio-snapshot.js`, which the inspector loads from the panel when someone
 * starts a remark. It is never part of the panel's app.
 */

/** A rectangle of the window, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SnapshotRequest {
  /** What stays out of the picture: the inspector's own layer, and its outline. */
  exclude: readonly Node[];
  /** The element the remark is about, outlined. Measured as the screenshot is taken. */
  element: Element | null;
  /** Where in it the remark's pin goes, from its top left corner, as fractions of its size. */
  point: { x: number; y: number } | null;
}

/** The longest side of the picture: the size the agent reads a screenshot at. */
const MAX_SIDE = 1600;
/** The largest screenshot the panel keeps with a remark, and that a message to the agent may hold. */
export const MAX_DATA_URL_CHARS = 240_000;
/** How long an image, a font or a video of the page is waited for: past it, it is drawn as it is. */
const MEDIA_TIMEOUT_MS = 3000;
/** How long a screenshot may take before it is given up. */
const CAPTURE_TIMEOUT_MS = 15_000;
const ACCENT = "#f97316";
/** A transparent pixel: what an image out of the window is drawn as, so that nothing is fetched for it. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** On a child of a scrolled container: how its copy moves. */
const SHIFT = "data-opsifier-snapshot-shift";
/** On a scrolled container with text of its own: how that text moves. */
const TEXT_SHIFT = "data-opsifier-snapshot-text";
/** On an image out of the window. */
const HIDDEN = "data-opsifier-snapshot-hidden";
/**
 * On the parent of videos: where each one's still goes, as `<id>:<place>`, its place among the
 * parent's children that have a copy. A copy of a canvas or a frame is made again without the
 * attributes of its element, so no mark is put on a sibling.
 */
const STILLS = "data-opsifier-snapshot-stills";
const MARKS = [SHIFT, TEXT_SHIFT, HIDDEN, STILLS];

export interface Shift {
  /** `relative` moves an element where it lies; `margin` moves one positioned absolutely. */
  mode: "relative" | "margin";
  top: number;
  left: number;
}

type Position = Pick<CSSStyleDeclaration, "position" | "top" | "left" | "marginTop" | "marginLeft">;

const pixels = (value: string) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
};

/**
 * How a child of a scrolled container moves in the picture, which lays every container out unscrolled:
 * up and left by the container's scroll, or, for a sticky child, to where it is on the screen. `still`
 * is where a sticky child would be without sticking, measured on the page. A fixed child does not
 * move with its container.
 */
export function shiftOf(
  style: Position,
  scroll: { top: number; left: number },
  sticky: { now: Box; still: Box } | null,
): Shift | null {
  switch (style.position) {
    case "fixed":
      return null;
    case "sticky":
      return sticky === null
        ? null
        : {
            mode: "relative",
            top: sticky.now.top - sticky.still.top - scroll.top,
            left: sticky.now.left - sticky.still.left - scroll.left,
          };
    case "absolute":
      return {
        mode: "margin",
        top: pixels(style.marginTop) - scroll.top,
        left: pixels(style.marginLeft) - scroll.left,
      };
    case "relative":
      return {
        mode: "relative",
        top: pixels(style.top) - scroll.top,
        left: pixels(style.left) - scroll.left,
      };
    default:
      return { mode: "relative", top: -scroll.top, left: -scroll.left };
  }
}

const round = (value: number) => `${Math.round(value * 100) / 100}px`;

/** A video as its copy shows it: a block of its size and place, with the frame on screen or its poster. */
export interface Still {
  /** Every computed property of the video, which the block takes. */
  css: string;
  /** The frame on screen, drawn as the video draws it, when the page may read it. */
  frame: string | null;
  poster: string | null;
  /** How the poster fills the block: the video's `object-fit`. */
  fit: string;
  /** How it moves, as a child of a scrolled container. */
  shift: Shift | null;
}

/** Moves a copy as {@link shiftOf} says. */
function applyShift(node: HTMLElement, mode: string, top: string, left: string): void {
  if (mode === "margin") {
    node.style.setProperty("margin-top", top, "important");
    node.style.setProperty("margin-left", left, "important");
  } else if (mode === "relative") {
    node.style.setProperty("position", "relative", "important");
    node.style.setProperty("top", top, "important");
    node.style.setProperty("left", left, "important");
    node.style.setProperty("bottom", "auto", "important");
    node.style.setProperty("right", "auto", "important");
  }
}

/** Applies to a copy of the page what {@link markPage} wrote on the page, then takes the marks off. */
export function applyMarks(root: Element, stills: ReadonlyMap<string, Still> = new Map()): void {
  const marked = (name: string) => [
    ...(root.hasAttribute(name) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(`[${name}]`),
  ];
  for (const node of marked(SHIFT)) {
    const [mode = "", top, left] = (node.getAttribute(SHIFT) ?? "").split(" ");
    if (top !== undefined && left !== undefined && node instanceof HTMLElement) {
      applyShift(node, mode, top, left);
    }
  }
  // Text right inside a scrolled container: wrapped, to move as its elements do.
  for (const node of marked(TEXT_SHIFT)) {
    const [top, left] = (node.getAttribute(TEXT_SHIFT) ?? "").split(" ");
    for (const text of [...node.childNodes]) {
      if (text.nodeType === 3 && (text.textContent ?? "").trim() !== "" && top !== undefined) {
        const span = node.ownerDocument.createElement("span");
        span.style.cssText = `position: relative; top: ${top}; left: ${left ?? "0px"};`;
        text.replaceWith(span);
        span.append(text);
      }
    }
  }
  // An image out of the window takes its place, and nothing is fetched for it.
  for (const node of marked(HIDDEN)) {
    node.removeAttribute("srcset");
    node.removeAttribute("sizes");
    node.setAttribute("src", BLANK);
  }
  for (const node of marked(STILLS)) {
    // Every place is read before any still goes in.
    const places = (node.getAttribute(STILLS) ?? "").split(" ").map((entry) => {
      const [id = "", place = ""] = entry.split(":");
      return { still: stills.get(id), before: node.children[Number(place)] ?? null };
    });
    for (const { still, before } of places) {
      if (still !== undefined) {
        node.insertBefore(stillElement(node.ownerDocument, still), before);
      }
    }
  }
  for (const name of MARKS) {
    for (const node of marked(name)) {
      node.removeAttribute(name);
    }
  }
}

const FIT_SIZES: Record<string, string> = {
  cover: "cover",
  contain: "contain",
  "scale-down": "contain",
  none: "auto",
};

function stillElement(document: Document, still: Still): HTMLElement {
  const block = document.createElement("div");
  block.style.cssText = still.css;
  if (block.style.display === "inline") {
    block.style.display = "inline-block";
  }
  if (still.shift !== null) {
    applyShift(block, still.shift.mode, round(still.shift.top), round(still.shift.left));
  }
  const image = still.frame ?? still.poster;
  if (image !== null) {
    block.style.setProperty("background-image", `url("${image.replaceAll('"', "%22")}")`);
    block.style.setProperty("background-repeat", "no-repeat");
    block.style.setProperty("background-position", "center");
    block.style.setProperty(
      "background-size",
      still.frame !== null ? "100% 100%" : (FIT_SIZES[still.fit] ?? "100% 100%"),
    );
  }
  return block;
}

/** Where a sticky element would be without sticking: measured with it set static for a moment, unpainted. */
function stillBox(element: HTMLElement): Box {
  const value = element.style.getPropertyValue("position");
  const priority = element.style.getPropertyPriority("position");
  element.style.setProperty("position", "static", "important");
  const box = element.getBoundingClientRect();
  if (value === "") {
    element.style.removeProperty("position");
  } else {
    element.style.setProperty("position", value, priority);
  }
  return box;
}

type CanvasMaker = (width: number, height: number) => HTMLCanvasElement;

const makeCanvas: CanvasMaker = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * The frame a video shows, drawn as it draws it in its box (`object-fit`, centred) at the picture's
 * scale, or null when the page may not read it: not loaded, or from another site that does not allow it.
 */
function videoFrame(video: HTMLVideoElement, fit: string, ratio: number): string | null {
  const width = video.clientWidth;
  const height = video.clientHeight;
  if (video.readyState < 2 || video.videoWidth === 0 || width === 0 || height === 0) {
    return null;
  }
  const canvas = makeCanvas(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }
  const across = canvas.width / video.videoWidth;
  const down = canvas.height / video.videoHeight;
  const scale =
    fit === "cover"
      ? Math.max(across, down)
      : fit === "none"
        ? ratio
        : fit === "scale-down"
          ? Math.min(ratio, across, down)
          : Math.min(across, down);
  const [drawnWidth, drawnHeight] =
    fit === "fill" ? [canvas.width, canvas.height] : [video.videoWidth * scale, video.videoHeight * scale];
  try {
    context.drawImage(
      video,
      (canvas.width - drawnWidth) / 2,
      (canvas.height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
    // A frame that leaves part of its box empty keeps it see-through, as the video does.
    const covers = drawnWidth >= canvas.width - 1 && drawnHeight >= canvas.height - 1;
    return canvas.toDataURL(covers ? "image/jpeg" : "image/png", 0.85);
  } catch {
    return null;
  }
}

/** An element's place among its parent's children that have a copy: scripts, styles, videos and what stays out have none. */
function placeAmongCopies(element: Element, left: (node: Element) => boolean): number {
  let place = 0;
  for (let before = element.previousElementSibling; before !== null; before = before.previousElementSibling) {
    if (!/^(SCRIPT|STYLE|VIDEO)$/i.test(before.tagName) && !left(before)) {
      place += 1;
    }
  }
  return place;
}

const isOut = (box: DOMRect) =>
  box.width === 0 ||
  box.height === 0 ||
  box.bottom <= 0 ||
  box.right <= 0 ||
  box.top >= window.innerHeight ||
  box.left >= window.innerWidth;

/**
 * Writes on the page what its copy needs: how the children of each container scrolled away from its
 * start move (the window's own scroll is not one: the whole copy moves for it), which images are out
 * of the window, and where each video's still goes. `undo` takes every mark off.
 */
export function markPage(
  document: Document,
  exclude: readonly Node[] = [],
  ratio = 1,
): { stills: Map<string, Still>; undo: () => void } {
  const marked = new Set<Element>();
  const mark = (element: Element, name: string, value: string) => {
    const before = element.getAttribute(name);
    element.setAttribute(name, before === null ? value : `${before} ${value}`);
    marked.add(element);
  };
  const left = (node: Node) => exclude.some((one) => one === node || one.contains(node));
  // A video has no copy to carry its mark: its still carries how it moves.
  const videoShifts = new Map<Element, Shift>();
  const windowScroller = document.scrollingElement ?? document.documentElement;
  for (const container of document.querySelectorAll<HTMLElement>("*")) {
    if (container === windowScroller || (container.scrollTop === 0 && container.scrollLeft === 0)) {
      continue;
    }
    const scroll = { top: container.scrollTop, left: container.scrollLeft };
    for (const child of container.children) {
      if (!(child instanceof HTMLElement || child instanceof SVGElement)) {
        continue;
      }
      const style = getComputedStyle(child);
      const sticky =
        style.position === "sticky" && child instanceof HTMLElement
          ? { now: child.getBoundingClientRect(), still: stillBox(child) }
          : null;
      const shift = shiftOf(style, scroll, sticky);
      if (shift !== null && child.tagName === "VIDEO") {
        videoShifts.set(child, shift);
      } else if (shift !== null) {
        mark(child, SHIFT, `${shift.mode} ${round(shift.top)} ${round(shift.left)}`);
      }
    }
    if (
      [...container.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "")
    ) {
      mark(container, TEXT_SHIFT, `${round(-scroll.top)} ${round(-scroll.left)}`);
    }
  }
  for (const image of document.querySelectorAll("img")) {
    if (!left(image) && isOut(image.getBoundingClientRect())) {
      mark(image, HIDDEN, "");
    }
  }
  const stills = new Map<string, Still>();
  for (const video of document.querySelectorAll("video")) {
    if (left(video) || video.parentElement === null) {
      continue;
    }
    const id = `v${stills.size}`;
    const style = getComputedStyle(video);
    const css = [...style].map((name) => `${name}: ${style.getPropertyValue(name)};`).join(" ");
    const fit = style.getPropertyValue("object-fit") || "contain";
    stills.set(id, {
      css,
      fit,
      frame: isOut(video.getBoundingClientRect()) ? null : videoFrame(video, fit, ratio),
      poster: video.poster || null,
      shift: videoShifts.get(video) ?? null,
    });
    mark(video.parentElement, STILLS, `${id}:${placeAmongCopies(video, left)}`);
  }
  return {
    stills,
    undo: () => {
      for (const element of marked) {
        for (const name of MARKS) {
          element.removeAttribute(name);
        }
      }
    },
  };
}

/** The element's outline and the pin, as the inspector draws them on the page, at the picture's scale. */
function drawMarks(
  context: CanvasRenderingContext2D,
  ratio: number,
  box: Box | null,
  pin: { x: number; y: number } | null,
): void {
  if (box !== null && box.width > 0 && box.height > 0) {
    context.save();
    context.fillStyle = "rgba(249, 115, 22, 0.08)";
    context.strokeStyle = ACCENT;
    context.lineWidth = 2 * ratio;
    context.beginPath();
    const [x, y, w, h] = [box.left * ratio, box.top * ratio, box.width * ratio, box.height * ratio];
    if (typeof context.roundRect === "function") {
      context.roundRect(x, y, w, h, 3 * ratio);
    } else {
      context.rect(x, y, w, h);
    }
    context.fill();
    context.stroke();
    context.restore();
  }
  if (pin !== null) {
    const radius = 11 * ratio;
    const x = Math.min(Math.max(pin.x * ratio, radius), context.canvas.width - radius);
    const y = Math.min(Math.max(pin.y * ratio, radius), context.canvas.height - radius);
    context.save();
    context.shadowColor = "rgba(15, 23, 42, 0.35)";
    context.shadowBlur = 6 * ratio;
    context.shadowOffsetY = 2 * ratio;
    context.fillStyle = ACCENT;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = "transparent";
    context.lineWidth = 2 * ratio;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.restore();
  }
}

/**
 * What the window shows behind the page, as an opaque colour: the root's background, or the body's,
 * which a browser paints across the whole window, over white. The copy has no window of its own.
 */
function pageBackground(): string {
  const canvas = makeCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (const element of [document.documentElement, document.body]) {
    const color = element === null ? "" : getComputedStyle(element).backgroundColor;
    if (context === null || color === "") {
      continue;
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red = 255, green = 255, blue = 255, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    if (alpha > 0) {
      const over = (value: number) => Math.round((value * alpha + 255 * (255 - alpha)) / 255);
      return `rgb(${over(red)}, ${over(green)}, ${over(blue)})`;
    }
  }
  return "#ffffff";
}

/**
 * The picture as a JPEG data URL of at most {@link MAX_DATA_URL_CHARS} characters: lighter, then
 * smaller, until it fits. A JPEG has no transparency: what the page left transparent shows
 * `background`, as the window would.
 */
export function fitJpeg(
  picture: HTMLCanvasElement,
  make: CanvasMaker = makeCanvas,
  background = "#ffffff",
): string {
  let width = picture.width;
  let height = picture.height;
  let quality = 0.85;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = make(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("This browser cannot draw the screenshot.");
    }
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.startsWith("data:image/jpeg;base64,") && url.length <= MAX_DATA_URL_CHARS) {
      return url;
    }
    if (quality > 0.62) {
      quality -= 0.1;
    } else {
      width *= 0.8;
      height *= 0.8;
    }
  }
  throw new Error("The screenshot is too large.");
}

/** An image the writer chose or pasted instead, as a screenshot: a JPEG data URL that fits. */
export async function fromFile(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = makeCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return fitJpeg(canvas);
  } finally {
    bitmap.close();
  }
}

const SANDBOX = 'iframe[id^="__SANDBOX__"]';

async function captureNow(request: SnapshotRequest): Promise<string> {
  const root = document.documentElement;
  const width = root.clientWidth || window.innerWidth;
  const height = root.clientHeight || window.innerHeight;
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SIDE / Math.max(width, height, 1));
  // The copy's own frame, which a copy given up would leave in the page.
  const frames = new Set(document.querySelectorAll(SANDBOX));
  const background = pageBackground();
  // The element and the pin where they are now, with the page as it is copied.
  const element = request.element?.isConnected ? request.element.getBoundingClientRect() : null;
  const box = element !== null && (element.width > 0 || element.height > 0) ? element : null;
  const at = request.point ?? { x: 1, y: 0 };
  const pin = box === null ? null : { x: box.left + at.x * box.width, y: box.top + at.y * box.height };
  const { stills, undo } = markPage(document, request.exclude, scale);
  let picture: HTMLCanvasElement;
  try {
    const drawing = domToCanvas(root, {
      width,
      height,
      scale,
      timeout: MEDIA_TIMEOUT_MS,
      // Videos are drawn as their stills: a copy of a video loads it again, and may wait for it forever.
      filter: (node) => !request.exclude.includes(node) && (node as Element).tagName !== "VIDEO",
      // The copy of the page moves up and left by the window's scroll: unlike a transform, this leaves
      // what is fixed where the window has it, and what sticks to the window's top stuck there.
      style: { position: "relative", top: round(-window.scrollY), left: round(-window.scrollX) },
      onCloneNode: (copy) => {
        if (copy instanceof Element) {
          applyMarks(copy, stills);
        }
      },
    });
    drawing.catch(() => {});
    picture = await Promise.race([
      drawing,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("The screenshot took too long.")), CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    undo();
    for (const frame of document.querySelectorAll(SANDBOX)) {
      if (!frames.has(frame)) {
        frame.remove();
      }
    }
  }
  const context = picture.getContext("2d");
  if (context !== null) {
    drawMarks(context, picture.width / width, box, pin);
  }
  // Behind the copy, which has no window of its own, what the window shows behind the page. The copy
  // can't carry it: WebKit and Firefox clear the canvas as they draw the copy again.
  return fitJpeg(picture, makeCanvas, background);
}

let running: Promise<unknown> = Promise.resolve();

/** Takes the screenshot: the window, as it is now, as a JPEG data URL. One at a time. */
export function capture(request: SnapshotRequest): Promise<string> {
  const next = running.then(() => captureNow(request));
  running = next.catch(() => {});
  return next;
}
