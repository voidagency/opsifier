import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildpackLocators, buildpackSource, DescriptorError, readToml } from "./project-descriptor";

/** A plain copy, to compare: the reader's tables have no prototype. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("a TOML document", () => {
  it("is read into its tables, with strings as TOML writes them", () => {
    const document = [
      "\uFEFF# a comment",
      'title = "a\\tb \\u0041\\U0001F600" # trailing comment',
      "literal = 'C:\\path'",
      'multi = """',
      "one \\",
      '   two""""',
      "raw = '''",
      "keep \\n as is''''",
      "number = 1_000",
      "when = 1979-05-27 07:32:00Z",
      "flag = true",
      'list = [ "a", [ 1, "b" ], { k = "v" }, ] # trailing comma',
      "nested = [",
      '  "x", # comment inside',
      '  "y"',
      "]",
      '"quoted key" = 1',
      "'literal key' = 2",
      'a . "b.c" . d = "dotted"',
      "[table]",
      'inline = { x = "1", y.z = "2" }',
      "[[array]]",
      'name = "first"',
      "[array.sub]",
      'name = "inside the first"',
      "[[array]]",
      'name = "second"',
    ].join("\r\n");

    expect(plain(readToml(document))).toEqual({
      title: "a\tb A\u{1F600}",
      literal: "C:\\path",
      multi: 'one two"',
      raw: "keep \\n as is'",
      number: null,
      when: null,
      flag: null,
      list: ["a", [null, "b"], { k: "v" }],
      nested: ["x", "y"],
      "quoted key": null,
      "literal key": null,
      a: { "b.c": { d: "dotted" } },
      table: { inline: { x: "1", y: { z: "2" } } },
      array: [{ name: "first", sub: { name: "inside the first" } }, { name: "second" }],
    });
  });

  it("keeps a key called __proto__ as a key", () => {
    const read = readToml('__proto__ = "x"\n[constructor]\nname = "y"\n');
    expect(Object.getPrototypeOf(read)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(read, "__proto__")?.value).toBe("x");
    expect(plain(read.constructor)).toEqual({ name: "y" });
  });

  it("is refused when it is not TOML", () => {
    for (const [document, error] of [
      ['a = "unclosed\nb = 1', "A string is not closed, on line 1"],
      ["a = 'unclosed", "A string is not closed, on line 1"],
      ['a = "1"\na = "2"', "a is defined twice, on line 2"],
      ['a = "1" b = "2"', "Something follows a value on its line, on line 1"],
      ['a = ["1" "2"]', "Expected , or ] in an array, on line 1"],
      ['a = { b = "1" c = "2" }', "Expected , or } in an inline table, on line 1"],
      ["a = ", "Expected a value, on line 1"],
      ["= 1", "Expected a key, on line 1"],
      ['"""a""" = 1', "A key can't be a multi-line string, on line 1"],
      [`a = ${"[".repeat(100)}`, "Values nest too deep, on line 1"],
    ] as const) {
      expect(() => readToml(document), document).toThrow(new DescriptorError(error));
    }
  });
});

describe("the buildpacks project.toml adds", () => {
  it("are read in either version of the file, with the locator pack builds for each", () => {
    const document = readToml(
      [
        "[_]",
        'schema-version = "0.2"',
        "[[io.buildpacks.group]]",
        'uri = "docker://acme/a:1"',
        'id = "ignored/when-there-is-a-uri"',
        "[[io.buildpacks.group]]",
        'id = "acme/b"',
        'version = "1.2.3"',
        "[[io.buildpacks.group]]",
        'id = "acme/c"',
        "[[io.buildpacks.group]]",
        'id = "acme/inline"',
        'script = { api = "0.10", inline = "echo hi" }',
        "[[io.buildpacks.pre.group]]",
        'uri = "pre:1"',
        "[[io.buildpacks.post.group]]",
        'uri = "post:1"',
        "[[build.buildpacks]]",
        'uri = "old:1"',
        "[[build.pre.group]]",
        'uri = "old-pre:1"',
        "[[build.post.group]]",
        'uri = "old-post:1"',
        "[io.buildpacks.build]",
        'env = [{ name = "X", value = "docker://not/a/buildpack" }]',
      ].join("\n"),
    );

    expect(buildpackLocators(document)).toEqual([
      "docker://acme/a:1",
      "acme/b@1.2.3",
      "acme/c",
      "pre:1",
      "post:1",
      "old:1",
      "old-pre:1",
      "old-post:1",
    ]);
  });

  it("are found under names in any case, as pack's TOML library matches them", () => {
    const document = readToml(
      [
        'io.buildpacks.group = [{ "uri" = "c:1" }]',
        "[[IO.Buildpacks.Group]]",
        'URI = "a:1"',
        // Quoted, as a key that is not ASCII must be: pack still reads it as `buildpacks`.
        '[[io."buildpack\u017F".group]]',
        'Uri = "b:1"',
      ].join("\n"),
    );

    expect(buildpackLocators(document).sort()).toEqual(["a:1", "b:1", "c:1"]);
  });

  it("are refused when one sets the same thing twice, since which pack takes is not fixed", () => {
    const document = readToml('[[io.buildpacks.group]]\nuri = "a:1"\nURI = "b:1"\n');

    expect(() => buildpackLocators(document)).toThrow("A buildpack sets uri more than once");
  });
});

describe("where pack takes a buildpack from", () => {
  let dir: string;
  const builder = [
    { id: "acme/node", version: "2.0.0" },
    { id: "procfile", version: "1.0.0" },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opsifier-descriptor-"));
    mkdirSync(join(dir, "local", "bp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows pack's order, from the builder's own to an image", async () => {
    for (const [locator, source] of [
      ["from=builder", { kind: "builder" }],
      ["urn:cnb:builder:acme/node", { kind: "builder" }],
      ["from=builder:acme/node@2.0.0", { kind: "builder" }],
      ["urn:cnb:registry:acme/bp@1.0.0", { kind: "registry" }],
      ["URN:CNB:REGISTRY:acme/bp", { kind: "registry" }],
      ["docker://acme/bp:1", { kind: "image", reference: "acme/bp:1" }],
      ["docker:/acme/bp:1", { kind: "image", reference: "acme/bp:1" }],
      ["https://example.com/bp.tgz", { kind: "download" }],
      ["file:///abs/bp.tgz", { kind: "path", path: "/abs/bp.tgz" }],
      ["file://local/b%70", { kind: "path", path: join(dir, "local", "bp") }],
      ["file://local/d%FF/x", { kind: "path", path: null }],
      ["local/bp", { kind: "path", path: join(dir, "local", "bp") }],
      ["acme/node", { kind: "builder" }],
      ["acme/node@2.0.0", { kind: "builder" }],
      // Split as pack splits it: with two `@`, no version, so any of the builder's.
      ["acme/node@1@2", { kind: "builder" }],
      ["procfile", { kind: "builder" }],
      ["acme/node@1.0.0", { kind: "registry" }],
      ["acme/bp", { kind: "registry" }],
      ["acme/bp@1.0.0-rc.1+build.5", { kind: "registry" }],
      ["acme/bp:1.0.0", { kind: "image", reference: "acme/bp:1.0.0" }],
      ["registry.example.com/b/bp:1.0.0", { kind: "image", reference: "registry.example.com/b/bp:1.0.0" }],
      ["registry.example.com:5000/bp", { kind: "image", reference: "registry.example.com:5000/bp" }],
      ["other_stack-bp:1.0.0", { kind: "image", reference: "other_stack-bp:1.0.0" }],
      [`acme/bp@sha256:${"a".repeat(64)}`, { kind: "image", reference: `acme/bp@sha256:${"a".repeat(64)}` }],
      ["bp", { kind: "image", reference: "bp" }],
    ] as const) {
      expect(await buildpackSource(locator, dir, builder), locator).toEqual(source);
    }
  });
});
