import { describe, expect, it } from "vitest";

// The web app's types do not include Node, hence the indirection.
const nodeFs = "node:fs";
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true; encoding: "utf8" }): string[];
};

const source = new URL("../", import.meta.url);

/** Every `<Field ...>` opening tag in the app, with the file and line it starts on. */
function fieldTags(): Array<{ where: string; tag: string }> {
  const found: Array<{ where: string; tag: string }> = [];
  for (const file of readdirSync(source, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx") || file.includes(".test.") || file === "ui/Field.tsx") {
      continue;
    }
    const text = readFileSync(new URL(file, source), "utf8");
    for (const match of text.matchAll(/<Field\b/g)) {
      const start = match.index;
      let depth = 0;
      let quote: string | null = null;
      let end = start;
      for (let index = start; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (quote !== null) {
          quote = char === quote ? null : quote;
        } else if (char === '"' || char === "'" || char === "`") {
          quote = char;
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
        } else if (char === ">" && depth === 0 && text.charAt(index - 1) !== "=") {
          end = index;
          break;
        }
      }
      found.push({
        where: `${file}:${text.slice(0, start).split("\n").length}`,
        tag: text.slice(start, end + 1),
      });
    }
  }
  return found;
}

describe("every form field", () => {
  const tags = fieldTags();

  it("is found by this test", () => {
    expect(tags.length).toBeGreaterThan(150);
  });

  it("has a visible label and useful help, next to its error", () => {
    const missing = tags.filter(({ tag }) => !/\blabel=/.test(tag) || !/\bhint=/.test(tag));
    expect(missing.map(({ where }) => where)).toEqual([]);
  });
});
