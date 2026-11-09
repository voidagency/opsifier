import type { BuildConfig } from "./source";

/**
 * What each builder can build, from the languages each version of it detects and each builder image
 * packs. `docs/BUILDERS.md` publishes the same table, and a test holds the two together.
 */
export const nixpacksLanguages = [
  "C# and .NET",
  "Clojure",
  "COBOL",
  "Crystal",
  "Dart",
  "Deno",
  "Elixir",
  "F#",
  "Gleam",
  "Go",
  "Haskell",
  "Java",
  "Lunatic",
  "Node.js",
  "PHP",
  "Python",
  "Ruby",
  "Rust",
  "Scala",
  "Scheme",
  "Staticfile",
  "Swift",
  "Zig",
] as const;

const RAILPACK_LANGUAGES = [
  "Deno",
  "Elixir",
  "Go",
  "Java",
  "Node.js",
  "PHP",
  "Python",
  "Ruby",
  "Rust",
  "Shell scripts",
  "Staticfile",
];
/** The version of Railpack each of these arrived in. */
const RAILPACK_ADDITIONS: ReadonlyArray<readonly [version: string, language: string]> = [
  ["0.10.0", "Gleam"],
  ["0.11.0", ".NET"],
  ["0.14.0", "C and C++"],
];

const atLeast = (version: string, minimum: string): boolean => {
  const parts = (value: string) => value.split(".").map(Number);
  const [left, right] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return true;
};

export function railpackLanguages(version: string): string[] {
  return [
    ...RAILPACK_LANGUAGES,
    ...RAILPACK_ADDITIONS.filter(([added]) => atLeast(version, added)).map(([, language]) => language),
  ];
}

const HEROKU_LANGUAGES = [".NET", "Go", "Java", "Node.js", "PHP", "Python", "Ruby", "Scala"];
const OLD_HEROKU_LANGUAGES = ["Go", "Java", "Node.js", "PHP", "Python", "Ruby", "Scala"];

/** Matched by the start of the reference, which ends in the tag or digest that pins it. */
const BUILDPACK_LANGUAGES: ReadonlyArray<readonly [prefix: string, languages: readonly string[]]> = [
  ["heroku/builder:24", HEROKU_LANGUAGES],
  ["heroku/builder:22", HEROKU_LANGUAGES],
  ["heroku/builder:20", OLD_HEROKU_LANGUAGES],
  [
    "paketobuildpacks/builder-jammy-full:",
    [
      ".NET",
      "Go",
      "Java",
      "Java Native Image",
      "Node.js",
      "PHP",
      "Python",
      "Ruby",
      "Static sites (Nginx, Apache)",
    ],
  ],
  [
    "paketobuildpacks/builder-jammy-base:",
    [".NET", "Go", "Java", "Java Native Image", "Node.js", "Python", "Ruby", "Static sites (Nginx, Apache)"],
  ],
  ["paketobuildpacks/builder-jammy-tiny:", ["Go", "Java", "Java Native Image"]],
];

/** The languages this builder image packs. Null for an image the panel does not list. */
export function buildpackLanguages(builder: string): readonly string[] | null {
  return BUILDPACK_LANGUAGES.find(([prefix]) => builder.startsWith(prefix))?.[1] ?? null;
}

/** What this configuration of a builder can build. Null means it decides: any language, or unknown. */
export function builderLanguages(config: BuildConfig): readonly string[] | null {
  switch (config.type) {
    case "dockerfile":
      return null;
    case "nixpacks":
      return nixpacksLanguages;
    case "railpack":
      return railpackLanguages(config.version);
    case "buildpacks":
      return buildpackLanguages(config.builder);
  }
}
