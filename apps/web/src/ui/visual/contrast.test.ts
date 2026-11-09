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

const channels = (hex: string) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [number, number, number];

const toHex = (parts: readonly number[]) =>
  `#${parts.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;

/** `amount` of `top` over `bottom`, as `color-mix` and a translucent fill both compute it. */
const mixed = (top: string, amount: number, bottom: string) => {
  const [a, b] = [channels(top), channels(bottom)];
  return toHex(a.map((value, index) => value * amount + (b[index] as number) * (1 - amount)));
};

/** A token as the colour that ends up on the screen, painted over `surface` if it is translucent. */
function paint(tokens: Tokens, name: string, surface: string): string {
  const value = resolveToken(tokens, name);
  const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, (?:var\((--[\w-]+)\)|transparent)\)$/.exec(
    value,
  );
  if (mix !== null) {
    const bottom = mix[3] === undefined ? surface : paint(tokens, mix[3], surface);
    return mixed(paint(tokens, mix[1] as string, surface), Number(mix[2]) / 100, bottom);
  }
  const rgba = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (rgba !== null) {
    return mixed(toHex([Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]), Number(rgba[4]), surface);
  }
  return value;
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

/**
 * Every pair of colours the interface puts together, so that a change to any token is caught. Each
 * row is a foreground, the surfaces it is drawn on and the contrast it needs: 4.5:1 for text, 3:1 for
 * the boundaries of controls and for indicators. Amber on white is the one deliberate exception,
 * only ever decoration (see theme.css).
 */
type ColourPair = [what: string, foreground: string, surfaces: readonly string[], minimum: number];

const SURFACES = ["--bg", "--raised"];
const HOVERED = ["--wash"];

const everyCombination: readonly ColourPair[] = [
  ["body text", "--ink", SURFACES, MIN_TEXT_CONTRAST],
  ["secondary text", "--muted", SURFACES, MIN_TEXT_CONTRAST],
  ["links and accented text", "--accent", SURFACES, MIN_TEXT_CONTRAST],
  ["success text", "--ok", SURFACES, MIN_TEXT_CONTRAST],
  ["error text", "--bad", SURFACES, MIN_TEXT_CONTRAST],
  ["hovered row or button text", "--ink", HOVERED, MIN_TEXT_CONTRAST],
  ["hovered secondary text", "--muted", HOVERED, MIN_TEXT_CONTRAST],
  ["control borders", "--off", SURFACES, MIN_INDICATOR_CONTRAST],
  ["focus rings and active tabs", "--accent", SURFACES, MIN_INDICATOR_CONTRAST],
  ["primary buttons", "--on-accent", ["--accent", "--accent-strong"], MIN_TEXT_CONTRAST],
  ["danger buttons", "--on-bad", ["--bad", "--bad-strong"], MIN_TEXT_CONTRAST],
  ["tooltips", "--bg", ["--ink"], MIN_TEXT_CONTRAST],
];

/** The top bar is its own navy surface, so only what it really draws is held to it. */
const topBarCombination: readonly ColourPair[] = [
  ["body text", "--ink", SURFACES, MIN_TEXT_CONTRAST],
  ["secondary text", "--muted", SURFACES, MIN_TEXT_CONTRAST],
  ["hovered text", "--ink", HOVERED, MIN_TEXT_CONTRAST],
  ["hovered secondary text", "--muted", HOVERED, MIN_TEXT_CONTRAST],
  ["control borders", "--off", SURFACES, MIN_INDICATOR_CONTRAST],
  ["focus rings and active tabs", "--accent", SURFACES, MIN_INDICATOR_CONTRAST],
];

function backgroundsOf(tokens: Tokens, surface: string): Set<string> {
  // A hover wash is translucent, so it is checked over each surface a row or button can sit on.
  return surface === "--wash"
    ? new Set(["--bg", "--raised"].map((under) => paint(tokens, "--wash", paint(tokens, under, "#000000"))))
    : new Set([paint(tokens, surface, paint(tokens, "--bg", "#000000"))]);
}

describe.each([
  ["light theme", light, everyCombination],
  ["dark theme", dark, everyCombination],
  ["top bar over the dark theme", topBar, topBarCombination],
  ["top bar over the light theme", topBarOnLight, topBarCombination],
] as const)("every colour combination in the %s", (_context, tokens, combinations) => {
  describe.each([...combinations])("%s", (_what, foreground, surfaces, minimum) => {
    it.each([...surfaces])("on %s", (surface) => {
      for (const background of backgroundsOf(tokens, surface)) {
        expect(contrastRatio(paint(tokens, foreground, background), background)).toBeGreaterThanOrEqual(
          minimum,
        );
      }
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
