import type { StudioRemark } from "@opsifier/contract";

/**
 * An element the person pointed at in the preview, as the Studio inspector describes it, and the
 * block of text that carries it to the agent in a message. A remark left on the preview travels the
 * same way, in a block of its own, followed by its element's.
 */
export interface SelectedElement {
  tag: string;
  text: string;
  classes: string[];
  attributes: Record<string, string>;
  selector: string;
  /** The React components around it, nearest first. */
  components: string[];
  path: string;
}

const OPEN = "<selected_element>";
const CLOSE = "</selected_element>";
const BLOCK = /<selected_element>([\s\S]*?)<\/selected_element>/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const short = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const strings = (value: unknown, count: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => short(item, max))
        .filter((item) => item !== "")
        .slice(0, count)
    : [];

/** What the preview's page sent, kept only when it has the shape of an element. */
export function readSelected(value: unknown): SelectedElement | null {
  if (!isRecord(value)) {
    return null;
  }
  const tag = short(value.tag, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    return null;
  }
  const attributes: Record<string, string> = {};
  if (isRecord(value.attributes)) {
    for (const [name, attribute] of Object.entries(value.attributes).slice(0, 10)) {
      const text = short(attribute, 200);
      if (/^[a-z-]{1,30}$/.test(name) && text !== "") {
        attributes[name] = text;
      }
    }
  }
  return {
    tag,
    text: short(value.text, 160),
    classes: strings(value.classes, 10, 80),
    attributes,
    selector: short(value.selector, 400),
    components: strings(value.components, 4, 80),
    path: short(value.path, 300) || "/",
  };
}

const quoted = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A few words that name the element: its nearest component, its tag, and the start of its text. */
export function elementLabel(element: Pick<SelectedElement, "tag" | "text" | "components">): string {
  const parts = [
    element.components[0],
    `<${element.tag}>`,
    element.text === "" ? null : `« ${quoted(element.text, 40)} »`,
  ];
  return parts.filter((part) => part !== undefined && part !== null).join(" ");
}

/**
 * What a page or a client wrote, made unable to open or close a block: no `<` reaches the agent from
 * them, so no text of theirs can end the block it sits in and speak in the person's name.
 */
export const fence = (text: string): string => text.replaceAll("<", "‹");

/** The block a message carries for the agent: plain lines, easy for a model and a person to read. */
export function elementBlock(element: SelectedElement): string {
  const classes = element.classes.length === 0 ? "" : ` class="${fence(element.classes.join(" "))}"`;
  const attributes = Object.entries(element.attributes)
    .map(([name, value]) => `${fence(name)}="${fence(value)}"`)
    .join(" ");
  return [
    OPEN,
    `Page: ${fence(element.path)}`,
    `Element: <${fence(element.tag)}${classes}>${element.text === "" ? "" : ` "${fence(element.text)}"`}`,
    ...(element.components.length === 0
      ? []
      : [`React components: ${element.components.map(fence).join(" < ")}`]),
    `Selector: ${fence(element.selector)}`,
    ...(attributes === "" ? [] : [`Attributes: ${attributes}`]),
    CLOSE,
  ].join("\n");
}

export type Device = "desktop" | "tablet" | "mobile";

/** The kind of screen a window this wide is: a phone's up to 600 pixels, a tablet's up to 1024. */
export function deviceOfWidth(width: number): Device {
  return width <= 600 ? "mobile" : width <= 1024 ? "tablet" : "desktop";
}

const REMARK_OPEN = "<client_remark>";
const REMARK_CLOSE = "</client_remark>";
const REMARK_BLOCK = /<client_remark>([\s\S]*?)<\/client_remark>/g;

/**
 * The block a message carries to hand the agent a remark: what was written, by whom, where, on what
 * screen, and which of the message's images is the screenshot the remark came with, counted from 1.
 */
export function remarkBlock(remark: StudioRemark, screenshot: number | null = null): string {
  const window =
    remark.viewport === null
      ? []
      : [
          `Window: ${remark.viewport.width} × ${remark.viewport.height} (${deviceOfWidth(remark.viewport.width)})`,
        ];
  return [
    REMARK_OPEN,
    `Remark: ${remark.number}`,
    `From: ${fence(remark.author)}`,
    `Page: ${fence(remark.path)}`,
    ...window,
    // Before the text, which runs to the end of the block.
    ...(screenshot === null
      ? []
      : [`Screenshot: image ${screenshot} of this message, taken in the client's browser`]),
    "Text:",
    fence(remark.text),
    REMARK_CLOSE,
    ...(remark.element === null ? [] : ["", elementBlock({ ...remark.element, path: remark.path })]),
  ].join("\n");
}

/** A remark a sent message carries, as its tag shows it. */
export interface RemarkTag {
  number: number;
  path: string;
  device: Device | null;
  text: string;
}

const lineOf = (body: string, prefix: string): string =>
  body
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? "";

/**
 * A sent message's own words, the elements it points at, each named as {@link elementLabel} does, and
 * the remarks it hands the agent.
 */
export function splitMessage(text: string): { text: string; elements: string[]; remarks: RemarkTag[] } {
  const remarks: RemarkTag[] = [];
  const withoutRemarks = text.replace(REMARK_BLOCK, (_, body: string) => {
    const width = /^(\d+)/.exec(lineOf(body, "Window:"));
    const words = body.split("\nText:\n")[1] ?? "";
    remarks.push({
      number: Number(lineOf(body, "Remark:")) || 0,
      path: lineOf(body, "Page:") || "/",
      device: width === null ? null : deviceOfWidth(Number(width[1])),
      text: words.trim(),
    });
    return "";
  });
  const elements: string[] = [];
  const rest = withoutRemarks.replace(BLOCK, (_, body: string) => {
    const line = (prefix: string) =>
      body
        .split("\n")
        .find((candidate) => candidate.startsWith(prefix))
        ?.slice(prefix.length)
        .trim() ?? "";
    const element = /^<([a-z][a-z0-9-]*)[^>]*>(?:\s+"(.*)")?$/.exec(line("Element:"));
    elements.push(
      elementLabel({
        tag: element?.[1] ?? "element",
        text: element?.[2] ?? "",
        components: line("React components:")
          .split("<")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      }),
    );
    return "";
  });
  return { text: rest.trim(), elements, remarks };
}
