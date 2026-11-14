import { describe, expect, it } from "vitest";
import { createStyles } from "./format";
import type { CommandContext } from "./shared";
import { showNewOutput } from "./wait";

function printer() {
  let written = "";
  const context = {
    styles: createStyles(false),
    write: (text: string) => {
      written += text;
    },
  } as unknown as CommandContext;
  return { context, written: () => written };
}

describe("following output", () => {
  it("prints only what is new while the whole output is returned", () => {
    const { context, written } = printer();

    let shown = showNewOutput(context, "", "one\n");
    shown = showNewOutput(context, shown, "one\ntwo\n");

    expect(written()).toBe("one\ntwo\n");
    expect(shown).toBe("one\ntwo\n");
  });

  it("carries on after what it already showed once the panel returns only a moving tail", () => {
    const { context, written } = printer();
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}\n`);

    let shown = showNewOutput(context, "", lines.slice(0, 120).join(""));
    // The panel now returns a window that has moved past the first lines.
    shown = showNewOutput(context, shown, lines.slice(80, 200).join(""));

    expect(written()).toBe(lines.join(""));
    expect(shown).toBe(lines.slice(80, 200).join(""));
  });

  it("marks a gap when the window has moved past everything it showed", () => {
    const { context, written } = printer();

    const shown = showNewOutput(context, "", "a\nb\n");
    showNewOutput(context, shown, "y\nz\n");

    expect(written()).toBe("a\nb\n[…]\ny\nz\n");
  });
});
