import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * `project.toml` as pack reads it, for the buildpacks it adds. pack decodes the file with a TOML library
 * that matches a key to a setting whatever its case, then resolves each buildpack from wherever its
 * locator leads: the builder, an image, the Buildpack Registry, a folder or archive, or a download. This
 * reads the file as TOML, and the locators in the order pack tries them.
 */

/** A TOML value, as far as the panel needs one: strings, arrays and tables. Anything else is null. */
export type TomlValue = string | null | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

/** A `project.toml` that is not TOML, or that pack could read more than one way. */
export class DescriptorError extends Error {
  override readonly name = "DescriptorError";
}

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

/** No prototype: a key called `__proto__` is a key like any other. */
const newTable = (): TomlTable => Object.create(null) as TomlTable;

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

/** A basic TOML string from `start`, up to `closing`, with its escapes applied, and where it ended. */
function basicString(
  text: string,
  start: number,
  closing: '"' | '"""',
): { value: string; end: number; closed: boolean } {
  let value = "";
  let pos = start;
  while (pos < text.length) {
    if (text.startsWith(closing, pos)) {
      return { value, end: pos + closing.length, closed: true };
    }
    const ch = text[pos] as string;
    if (ch === "\n" && closing === '"') {
      return { value, end: pos, closed: false };
    }
    if (ch !== "\\") {
      value += ch;
      pos += 1;
      continue;
    }
    const next = text[pos + 1] ?? "";
    const width = next === "u" ? 4 : next === "U" ? 8 : next === "x" ? 2 : 0;
    const hex = text.slice(pos + 2, pos + 2 + width);
    const code = Number.parseInt(hex, 16);
    if (width > 0 && hex.length === width && /^[0-9a-fA-F]+$/.test(hex) && code <= 0x10ffff) {
      value += String.fromCodePoint(code);
      pos += 2 + width;
    } else if (closing === '"""' && /[ \t\r\n]/.test(next)) {
      // A backslash ending a line drops it and every blank after it.
      pos += 1;
      while (pos < text.length && /[ \t\r\n]/.test(text[pos] as string)) {
        pos += 1;
      }
    } else {
      value += TOML_ESCAPES[next] ?? `\\${next}`;
      pos += 2;
    }
  }
  return { value, end: pos, closed: false };
}

/** Far deeper than any descriptor nests its arrays and inline tables, and well within the stack. */
const MAX_DEPTH = 64;
const BARE_KEY = /[A-Za-z0-9_-]+/y;
/** A number, a boolean or a date, which hold no string. What it is matters to no locator. */
const SCALAR = /[^,\]}#\r\n]+/y;

/** Reads a TOML document into its tables. A document that is not TOML throws {@link DescriptorError}. */
export function readToml(source: string): TomlTable {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const root = newTable();
  let current = root;
  let pos = 0;

  const fail = (what: string): never => {
    throw new DescriptorError(`${what}, on line ${text.slice(0, pos).split("\n").length}`);
  };
  const blanks = () => {
    while (text[pos] === " " || text[pos] === "\t") {
      pos += 1;
    }
  };
  const comment = () => {
    if (text[pos] === "#") {
      const end = text.indexOf("\n", pos);
      pos = end === -1 ? text.length : text[end - 1] === "\r" ? end - 1 : end;
    }
  };
  const newline = (): boolean => {
    const width = text[pos] === "\n" ? 1 : text.startsWith("\r\n", pos) ? 2 : 0;
    pos += width;
    return width > 0;
  };
  /** Blanks, comments and newlines: what may come between the values of an array. */
  const gaps = () => {
    do {
      blanks();
      comment();
    } while (newline());
  };
  const endOfLine = () => {
    blanks();
    comment();
    if (pos < text.length && !newline()) {
      fail("Something follows a value on its line");
    }
  };
  const expect = (token: string) => {
    if (!text.startsWith(token, pos)) {
      fail(`Expected ${token}`);
    }
    pos += token.length;
  };
  /** Right after an opening `"""` or `'''`, a newline is not part of the string. */
  const afterOpening = (width: number): number => {
    const start = pos + width;
    return start + (text.startsWith("\r\n", start) ? 2 : text[start] === "\n" ? 1 : 0);
  };

  const basic = (closing: '"' | '"""'): string => {
    const read = basicString(text, closing === '"""' ? afterOpening(3) : pos + 1, closing);
    if (!read.closed) {
      fail("A string is not closed");
    }
    pos = read.end;
    let value = read.value;
    // Up to two quotes may stand just inside the closing ones.
    for (let extra = 0; closing === '"""' && extra < 2 && text[pos] === '"'; extra += 1) {
      value += '"';
      pos += 1;
    }
    return value;
  };
  const literal = (closing: "'" | "'''"): string => {
    const start = closing === "'''" ? afterOpening(3) : pos + 1;
    const end = text.indexOf(closing, start);
    if (end === -1 || (closing === "'" && /[\r\n]/.test(text.slice(start, end)))) {
      fail("A string is not closed");
    }
    pos = end + closing.length;
    let value = text.slice(start, end);
    for (let extra = 0; closing === "'''" && extra < 2 && text[pos] === "'"; extra += 1) {
      value += "'";
      pos += 1;
    }
    return value;
  };

  const key = (): string => {
    if (text.startsWith('"""', pos) || text.startsWith("'''", pos)) {
      fail("A key can't be a multi-line string");
    }
    if (text[pos] === '"') {
      return basic('"');
    }
    if (text[pos] === "'") {
      return literal("'");
    }
    BARE_KEY.lastIndex = pos;
    const bare = BARE_KEY.exec(text)?.[0] ?? fail("Expected a key");
    pos += bare.length;
    return bare;
  };
  const dottedKey = (): string[] => {
    const keys = [key()];
    for (;;) {
      blanks();
      if (text[pos] !== ".") {
        return keys;
      }
      pos += 1;
      blanks();
      keys.push(key());
    }
  };

  const assign = (table: TomlTable, keys: readonly string[], value: TomlValue) => {
    let at = table;
    for (const name of keys.slice(0, -1)) {
      const next = Object.hasOwn(at, name) ? at[name] : undefined;
      if (next === undefined) {
        const created = newTable();
        at[name] = created;
        at = created;
      } else {
        at = isTable(next) ? next : fail(`${keys.join(".")} is defined twice`);
      }
    }
    const last = keys.at(-1) as string;
    if (Object.hasOwn(at, last)) {
      fail(`${keys.join(".")} is defined twice`);
    }
    at[last] = value;
  };

  const tableAt = (keys: readonly string[], inArray: boolean): TomlTable => {
    let at = root;
    for (const [index, name] of keys.entries()) {
      let next = Object.hasOwn(at, name) ? at[name] : undefined;
      if (inArray && index === keys.length - 1) {
        if (next === undefined) {
          next = [];
          at[name] = next;
        }
        const created = newTable();
        (Array.isArray(next) ? next : fail(`${keys.join(".")} is not an array of tables`)).push(created);
        return created;
      }
      if (next === undefined) {
        next = newTable();
        at[name] = next;
      }
      // A header under an array of tables goes into its last table.
      const into = Array.isArray(next) ? next.at(-1) : next;
      at = isTable(into) ? into : fail(`${keys.join(".")} is not a table`);
    }
    return at;
  };

  const value = (depth: number): TomlValue => {
    if (depth > MAX_DEPTH) {
      fail("Values nest too deep");
    }
    if (text.startsWith('"""', pos)) {
      return basic('"""');
    }
    if (text[pos] === '"') {
      return basic('"');
    }
    if (text.startsWith("'''", pos)) {
      return literal("'''");
    }
    if (text[pos] === "'") {
      return literal("'");
    }
    if (text[pos] === "[") {
      pos += 1;
      const items: TomlValue[] = [];
      for (;;) {
        gaps();
        if (text[pos] === "]") {
          pos += 1;
          return items;
        }
        items.push(value(depth + 1));
        gaps();
        if (text[pos] === ",") {
          pos += 1;
        } else if (text[pos] !== "]") {
          fail("Expected , or ] in an array");
        }
      }
    }
    if (text[pos] === "{") {
      pos += 1;
      const table = newTable();
      for (;;) {
        gaps();
        if (text[pos] === "}") {
          pos += 1;
          return table;
        }
        const keys = dottedKey();
        blanks();
        expect("=");
        blanks();
        assign(table, keys, value(depth + 1));
        gaps();
        if (text[pos] === ",") {
          pos += 1;
        } else if (text[pos] !== "}") {
          fail("Expected , or } in an inline table");
        }
      }
    }
    SCALAR.lastIndex = pos;
    const scalar = SCALAR.exec(text)?.[0] ?? "";
    if (scalar.trim() === "") {
      fail("Expected a value");
    }
    pos += scalar.length;
    return null;
  };

  for (;;) {
    gaps();
    if (pos >= text.length) {
      return root;
    }
    if (text.startsWith("[[", pos)) {
      pos += 2;
      blanks();
      const keys = dottedKey();
      blanks();
      expect("]]");
      current = tableAt(keys, true);
    } else if (text[pos] === "[") {
      pos += 1;
      blanks();
      const keys = dottedKey();
      blanks();
      expect("]");
      current = tableAt(keys, false);
    } else {
      const keys = dottedKey();
      blanks();
      expect("=");
      blanks();
      assign(current, keys, value(0));
    }
    endOfLine();
  }
}

/**
 * The values under a name, whatever its case, as pack's TOML library matches a key to a setting: by
 * Unicode case folding, where `ſ` is an `s` and the Kelvin sign a `k`.
 */
function underName(table: TomlTable, name: string): TomlValue[] {
  return Object.keys(table)
    .filter((key) => key.replaceAll("ſ", "s").toLowerCase() === name)
    .map((key) => table[key] as TomlValue);
}

/** Where `project.toml` lists buildpacks: version 0.2 of the file under `io.buildpacks`, 0.1 under `build`. */
const BUILDPACK_GROUPS: ReadonlyArray<readonly string[]> = [
  ["io", "buildpacks", "group"],
  ["io", "buildpacks", "pre", "group"],
  ["io", "buildpacks", "post", "group"],
  ["build", "buildpacks"],
  ["build", "pre", "group"],
  ["build", "post", "group"],
];

/** One setting of a buildpack. Given twice, in two cases, which one pack takes is not fixed. */
function setting(buildpack: TomlTable, name: string): TomlValue | undefined {
  const values = underName(buildpack, name);
  if (values.length > 1) {
    throw new DescriptorError(`A buildpack sets ${name} more than once`);
  }
  return values[0];
}

const text = (value: TomlValue | undefined): string => (typeof value === "string" ? value : "");

/**
 * The locator of every buildpack the file adds, in either version of the file, as pack builds it: the
 * `uri` when there is one, otherwise `id@version`, or the `id`. A buildpack written inline, an `id` with
 * `script.inline` and no `uri`, comes from the file itself and has none.
 */
export function buildpackLocators(document: TomlTable): string[] {
  const locators: string[] = [];
  for (const path of BUILDPACK_GROUPS) {
    let found: TomlValue[] = [document];
    for (const name of path) {
      found = found.flatMap((value) => (isTable(value) ? underName(value, name) : []));
    }
    for (const buildpack of found.flatMap((group) => (Array.isArray(group) ? group : []))) {
      if (!isTable(buildpack)) {
        continue;
      }
      const id = text(setting(buildpack, "id"));
      const version = text(setting(buildpack, "version"));
      const uri = text(setting(buildpack, "uri"));
      const script = setting(buildpack, "script");
      const inline = isTable(script) ? text(setting(script, "inline")) : "";
      if (uri !== "") {
        locators.push(uri);
      } else if (id !== "" && inline === "") {
        locators.push(version === "" ? id : `${id}@${version}`);
      }
    }
  }
  return locators;
}

/** A buildpack a builder holds, as its metadata label lists it. */
export interface BuilderBuildpack {
  id: string;
  version: string;
}

/** Where pack takes a buildpack from. */
export type BuildpackSource =
  | { kind: "builder" }
  | { kind: "image"; reference: string }
  | { kind: "registry" }
  | { kind: "path"; path: string | null }
  | { kind: "download" };

const SEMVER =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
  "(?:-(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?" +
  "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?";
/** What pack looks up in the Buildpack Registry when nothing else matched: `namespace/name[@version]`. */
const REGISTRY_ID = new RegExp(`^[a-z0-9\\-.]+/[a-z0-9\\-.]+(?:@${SEMVER})?$`);
/** What pack takes for a URI rather than a name: anything with `:/` after its first character. */
const URI = /^.+:\//;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * A `file:` URI as pack reads one: the rest of it unescaped, from the project's folder if relative.
 * Null when it doesn't unescape to text: pack unescapes `%FF` to a byte all the same, which leads to a
 * path the panel can't name, so can't check.
 */
function filePath(locator: string, base: string): string | null {
  const raw = locator.startsWith("file://")
    ? locator.slice("file://".length)
    : locator.replace(/^file:/i, "");
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isAbsolute(path) ? path : join(base, path);
}

/**
 * Where pack takes a buildpack from, trying what it tries in its order: one of the builder's own, the
 * Buildpack Registry by URN, a URI (`docker:/` for an image, `file:` for a path, any other a download),
 * then for a bare name an existing path from the project's folder, one of the builder's buildpacks by
 * id and version, a name of the Buildpack Registry, and last an image. The prefixes of the registry, an
 * image and a path are matched in any case here, which only ever makes more of them checked.
 */
export async function buildpackSource(
  locator: string,
  base: string,
  builder: readonly BuilderBuildpack[],
): Promise<BuildpackSource> {
  const lower = locator.toLowerCase();
  if (
    locator === "from=builder" ||
    locator.startsWith("urn:cnb:builder:") ||
    locator.startsWith("from=builder:")
  ) {
    return { kind: "builder" };
  }
  if (lower.startsWith("urn:cnb:registry")) {
    return { kind: "registry" };
  }
  if (URI.test(locator)) {
    if (lower.startsWith("docker:/")) {
      return { kind: "image", reference: locator.replace(/^docker:\/+/i, "") };
    }
    return lower.startsWith("file:") ? { kind: "path", path: filePath(locator, base) } : { kind: "download" };
  }
  const path = isAbsolute(locator) ? locator : join(base, locator);
  if (await exists(path)) {
    return { kind: "path", path };
  }
  // As pack splits it: a version only when there is exactly one `@`.
  const parts = locator.split("@");
  const id = parts[0] ?? "";
  const version = parts.length === 2 ? (parts[1] ?? "") : "";
  if (builder.some((buildpack) => buildpack.id === id && (version === "" || buildpack.version === version))) {
    return { kind: "builder" };
  }
  return REGISTRY_ID.test(locator) ? { kind: "registry" } : { kind: "image", reference: locator };
}
