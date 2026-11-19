// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyMarks, fitJpeg, MAX_DATA_URL_CHARS, markPage, type Still, shiftOf } from "./snapshot";

const style = (position: string, extra: Partial<CSSStyleDeclaration> = {}) =>
  ({
    position,
    top: "auto",
    left: "auto",
    marginTop: "0px",
    marginLeft: "0px",
    ...extra,
  }) as CSSStyleDeclaration;
const box = (top: number, left = 0) => ({ top, left, width: 100, height: 40 });
const scroll = { top: 900, left: 30 };

describe("a child of a scrolled container, in the picture", () => {
  it("moves up and left by the container's scroll, keeping its own offset", () => {
    expect(shiftOf(style("static"), scroll, null)).toEqual({ mode: "relative", top: -900, left: -30 });
    expect(shiftOf(style("relative", { top: "12px", left: "-4px" }), scroll, null)).toEqual({
      mode: "relative",
      top: -888,
      left: -34,
    });
  });

  it("moves by its margins when it is positioned absolutely, and stays when it is fixed", () => {
    expect(shiftOf(style("absolute", { marginTop: "8px", marginLeft: "2px" }), scroll, null)).toEqual({
      mode: "margin",
      top: -892,
      left: -28,
    });
    expect(shiftOf(style("fixed"), scroll, null)).toBeNull();
  });

  it("goes where it is on the screen when it sticks", () => {
    // A header at the top of the container's content, stuck at its top: shown at the top.
    expect(shiftOf(style("sticky"), scroll, { now: box(0, 0), still: box(-900, -30) })).toEqual({
      mode: "relative",
      top: 0,
      left: 0,
    });
    // A heading further down, not stuck yet: it moves with the content.
    expect(shiftOf(style("sticky"), scroll, { now: box(200), still: box(200) })?.top).toBe(-900);
  });
});

describe("the copy of the page", () => {
  const STILL: Still = {
    css: "display: inline; width: 320px; height: 180px;",
    frame: null,
    poster: null,
    fit: "cover",
    shift: null,
  };

  it("takes the marks the page was given, then loses them", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p data-opsifier-snapshot-shift="relative -900px -30px" style="bottom: 4px">a</p>' +
      '<span data-opsifier-snapshot-shift="margin -892px -28px">b</span><em>c</em>' +
      '<div data-opsifier-snapshot-text="-900px 0px">Some words <b>and</b> more</div>' +
      '<img data-opsifier-snapshot-hidden="" src="/far.jpg" srcset="/far-2x.jpg 2x" sizes="50vw" alt="">';
    applyMarks(root);

    const [moved, absolute, untouched, text, image] = [...root.children] as HTMLElement[];
    expect(moved?.style.position).toBe("relative");
    expect(moved?.style.top).toBe("-900px");
    expect(moved?.style.left).toBe("-30px");
    expect(moved?.style.bottom).toBe("auto");
    expect(absolute?.style.marginTop).toBe("-892px");
    expect(absolute?.style.marginLeft).toBe("-28px");
    expect(untouched?.getAttribute("style")).toBeNull();
    // Its own words move as its elements would: wrapped, the element in it left as it is.
    expect(text?.innerHTML).toBe(
      '<span style="position: relative; top: -900px; left: 0px;">Some words </span><b>and</b><span style="position: relative; top: -900px; left: 0px;"> more</span>',
    );
    // Out of the window: nothing to fetch, its place kept.
    expect(image?.getAttribute("src")).toMatch(/^data:image\/gif;base64,/);
    expect(image?.hasAttribute("srcset")).toBe(false);
    expect(image?.hasAttribute("sizes")).toBe(false);
    expect(root.querySelector("[data-opsifier-snapshot-shift], [data-opsifier-snapshot-text]")).toBeNull();
    expect(root.querySelector("[data-opsifier-snapshot-hidden]")).toBeNull();
  });

  it("puts a block in each video's place among the copied children, with its frame or its poster", () => {
    const root = document.createElement("div");
    // Where the page had: video, canvas (copied as another element), video, video, paragraph, video.
    root.innerHTML =
      '<section data-opsifier-snapshot-stills="v0:0 v1:1 v2:1 v3:2"><img alt="canvas"><p>after</p></section>';
    applyMarks(
      root,
      new Map([
        ["v0", { ...STILL, frame: "data:image/jpeg;base64,AAAA" }],
        ["v1", { ...STILL, poster: "https://example.com/poster.jpg", fit: "contain" }],
        ["v2", { ...STILL, shift: { mode: "relative", top: -900, left: 0 } }],
        ["v3", STILL],
      ]),
    );

    const section = root.firstElementChild as HTMLElement;
    const [first, canvas, second, third, paragraph, last] = [...section.children] as HTMLElement[];
    expect([...section.children].map((one) => one.tagName)).toEqual(["DIV", "IMG", "DIV", "DIV", "P", "DIV"]);
    expect(canvas?.getAttribute("alt")).toBe("canvas");
    expect(paragraph?.textContent).toBe("after");
    expect(first?.style.backgroundImage).toBe('url("data:image/jpeg;base64,AAAA")');
    expect(first?.style.backgroundSize).toBe("100% 100%");
    // A video shown inline would leave a block of no size: it takes its size.
    expect(first?.style.display).toBe("inline-block");
    expect(first?.style.width).toBe("320px");
    expect(second?.style.backgroundImage).toBe('url("https://example.com/poster.jpg")');
    expect(second?.style.backgroundSize).toBe("contain");
    // A video in a scrolled container moves with it.
    expect(third?.style.position).toBe("relative");
    expect(third?.style.top).toBe("-900px");
    expect(last?.getAttribute("style")).not.toContain("background-image");
    expect(root.querySelector("[data-opsifier-snapshot-stills]")).toBeNull();
  });

  it("is told where each video's block goes, and the page gets its own attributes back", () => {
    document.body.innerHTML =
      '<main><h1>x</h1><style>p{}</style><video src="/a.mp4"></video><script>1</script><p id="after" data-x="1">after</p></main>' +
      '<section id="end"><video src="/b.mp4" poster="/b.jpg"></video></section><img id="pic" src="/p.jpg" alt="">';

    const { stills, undo } = markPage(document);

    // After the heading, the one copied element before it: the style is not copied.
    expect(document.querySelector("main")?.getAttribute("data-opsifier-snapshot-stills")).toBe("v0:1");
    expect(document.getElementById("end")?.getAttribute("data-opsifier-snapshot-stills")).toBe("v1:0");
    expect(stills.get("v1")?.poster).toMatch(/\/b\.jpg$/);
    expect(stills.get("v0")?.frame).toBeNull();
    expect(stills.get("v0")?.shift).toBeNull();
    undo();
    expect(
      document.body.querySelector("[data-opsifier-snapshot-stills], [data-opsifier-snapshot-hidden]"),
    ).toBeNull();
    expect(document.getElementById("after")?.getAttribute("data-x")).toBe("1");
    expect(document.getElementById("pic")?.getAttribute("src")).toBe("/p.jpg");
  });
});

describe("the picture as a JPEG", () => {
  /** Canvases whose JPEG grows with their surface and quality, and what was made. */
  function fakeCanvases(charsPerPixel: number) {
    const made: Array<{ width: number; height: number; quality: number }> = [];
    const make = (width: number, height: number) =>
      ({
        width,
        height,
        getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
        toDataURL: (_type: string, quality: number) => {
          made.push({ width, height, quality });
          return `data:image/jpeg;base64,${"A".repeat(Math.round(width * height * quality * charsPerPixel))}`;
        },
      }) as unknown as HTMLCanvasElement;
    return { made, make };
  }

  it("gets lighter, then smaller, until it fits", () => {
    const { made, make } = fakeCanvases(0.2);
    const url = fitJpeg(make(1600, 1000), make);

    expect(url.length).toBeLessThanOrEqual(MAX_DATA_URL_CHARS);
    // Lighter first, at the same size.
    expect(made.map((one) => [one.width, Math.round(one.quality * 100)])).toEqual([
      [1600, 85],
      [1600, 75],
      [1600, 65],
    ]);
  });

  it("is refused when it never fits", () => {
    const { make } = fakeCanvases(50);
    expect(() => fitJpeg(make(4000, 3000), make)).toThrow("The screenshot is too large.");
  });
});
