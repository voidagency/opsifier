import { describe, expect, it } from "vitest";
import { contrastRatio, MIN_INDICATOR_CONTRAST, MIN_TEXT_CONTRAST } from "./contrast";
import { stateLanguage, visualStates } from "./state";

// Vitest blanks every CSS import, and the web app's types do not include Node, hence the indirection.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");

type Tokens = Map<string, string>;

/** Collects the custom properties of one rule, across every block with that exact selector. */
function declarations(selector: string): Tokens {
  const tokens: Tokens = new Map();
  for (const match of css.matchAll(/(^|\n)([^\n{}]+)\{([^{}]*)\}/g)) {
    if (match[2]?.trim() !== selector) {
      continue;
    }
    for (const declaration of (match[3] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(declaration[1] as string, (declaration[2] as string).trim());
    }
  }
  return tokens;
}

function resolveToken(tokens: Tokens, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`Token ${name} is not declared`);
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference?.[1] === undefined ? value : resolveToken(tokens, reference[1]);
}

const light = declarations(":root");
const dark = new Map([...light, ...declarations(':root[data-theme="dark"]')]);
const topBar = new Map([...dark, ...declarations(".brand-bar")]);
const topBarOnLight = new Map([...light, ...declarations(".brand-bar")]);

const indicators = visualStates.map((state) => stateLanguage[state].color.slice(4, -1));

describe.each([
  ["light", light],
  ["dark", dark],
])("contrast in the %s theme", (_theme, tokens) => {
  describe.each(["--bg", "--raised"])("on %s", (surface) => {
    it.each(indicators)("%s reaches 3:1 as an indicator", (token) => {
      expect(
        contrastRatio(resolveToken(tokens, token), resolveToken(tokens, surface)),
      ).toBeGreaterThanOrEqual(MIN_INDICATOR_CONTRAST);
    });

    it.each(["--ink", "--muted"])("%s reaches 4.5:1 as text", (token) => {
      expect(
        contrastRatio(resolveToken(tokens, token), resolveToken(tokens, surface)),
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
  });

  it.each(indicators)("%s reaches 3:1 against the unfilled track", (token) => {
    expect(
      contrastRatio(resolveToken(tokens, token), resolveToken(tokens, "--track")),
    ).toBeGreaterThanOrEqual(MIN_INDICATOR_CONTRAST);
  });
});

describe("contrast on the navy top bar", () => {
  describe.each([
    ["dark theme", topBar],
    ["light theme", topBarOnLight],
  ])("in the %s", (_theme, tokens) => {
    describe.each(["--bg", "--raised"])("on %s", (surface) => {
      it.each(indicators)("%s reaches 3:1", (token) => {
        expect(
          contrastRatio(resolveToken(tokens, token), resolveToken(tokens, surface)),
        ).toBeGreaterThanOrEqual(MIN_INDICATOR_CONTRAST);
      });
    });
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("rejects anything but #rrggbb", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow();
  });
});
