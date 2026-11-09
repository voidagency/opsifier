import { describe, expect, it } from "vitest";
import { contrastRatio, MIN_INDICATOR_CONTRAST } from "../../ui/visual/contrast";

// Vitest blanks every CSS import, and the web app's types do not include Node, hence the indirection.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("./purpose.css", import.meta.url), "utf8");

function colours(selector: string): string[] {
  const body =
    new RegExp(`${selector.replaceAll(/[.[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return [...body.matchAll(/--purpose-(?:development|staging|production):\s*(#[0-9a-f]{6})/g)].map(
    (match) => match[1] as string,
  );
}

describe.each([
  [":root", ["#ffffff", "#f6f7fa"]],
  [':root[data-theme="dark"]', ["#0f1b36", "#16264a"]],
  [".brand-bar", ["#16264a", "#1d3058"]],
])("the purpose colours under %s", (selector, surfaces) => {
  const values = colours(selector);

  it("are all declared, one each", () => {
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
  });

  it.each(surfaces)("reach 3:1 on %s", (surface) => {
    for (const color of values) {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(MIN_INDICATOR_CONTRAST);
    }
  });
});
