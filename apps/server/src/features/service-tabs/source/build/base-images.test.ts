import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDriver } from "../../../../core/docker";
import {
  BUILDER_METADATA_LABEL,
  builderRunImage,
  nixpacksArguments,
  nixpacksArgumentValues,
  prepareBuilder,
  projectBuildpackImages,
  pullBaseImages,
  railpackBaseImages,
  readNixpacksOutput,
} from "./base-images";
import { NIXPACKS_BUILD_SCRIPT, NIXPACKS_DOCKERFILE, NIXPACKS_FOLDER } from "./builders";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opsifier-base-images-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (lines: string[] = []) => ({
  log: (line: string) => {
    lines.push(line);
  },
  signal: new AbortController().signal,
});

const metadata = (value: unknown) => ({ [BUILDER_METADATA_LABEL]: JSON.stringify(value) });

describe("the run image a builder names", () => {
  it("is the first of its run images, or its stack's in an older builder", () => {
    expect(builderRunImage(metadata({ images: [{ image: "heroku/heroku:24" }, { image: "other:1" }] }))).toBe(
      "heroku/heroku:24",
    );
    expect(builderRunImage(metadata({ stack: { runImage: { image: "paketobuildpacks/run:base" } } }))).toBe(
      "paketobuildpacks/run:base",
    );
  });

  it("is nothing when the builder does not say", () => {
    expect(builderRunImage({})).toBeNull();
    expect(builderRunImage({ [BUILDER_METADATA_LABEL]: "{not json" })).toBeNull();
    expect(builderRunImage(metadata({ images: [{ image: 42 }] }))).toBeNull();
  });
});

describe("pulling a builder and its run image", () => {
  const builder = "acme/builder:1.2.3";

  it("pulls both, and answers the run image and the builder's own buildpacks", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.publishImage(
      builder,
      metadata({
        images: [{ image: "acme/run:1.2.3" }],
        buildpacks: [{ id: "acme/node", version: "2.0.0" }, { id: "acme/unversioned" }, { version: "1" }],
      }),
    );
    const lines: string[] = [];

    expect(await prepareBuilder({ docker }, builder, "shop", ctx(lines))).toEqual({
      runImage: "acme/run:1.2.3",
      buildpacks: [
        { id: "acme/node", version: "2.0.0" },
        { id: "acme/unversioned", version: "" },
      ],
    });
    expect(await docker.inspectImage(builder)).not.toBeNull();
    expect(await docker.inspectImage("acme/run:1.2.3")).not.toBeNull();
    expect(lines).toContain("acme/builder:1.2.3 runs its builds on acme/run:1.2.3");
  });

  it("refuses a builder or a run image of another project, before pulling it", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.publishImage(builder, metadata({ images: [{ image: "opsifier/other/web:latest" }] }));

    await expect(prepareBuilder({ docker }, "other_web-app:1.0.0", "shop", ctx())).rejects.toMatchObject({
      code: "image_not_allowed",
    });
    await expect(prepareBuilder({ docker }, builder, "shop", ctx())).rejects.toThrow(
      "opsifier/other/web:latest is an image of another project on this server",
    );
    expect(await docker.inspectImage("opsifier/other/web:latest")).toBeNull();
  });

  it("stops when the registry won't give the builder, or it names no run image", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.failNext("pullImage", new Error("pull access denied for acme/builder"));
    await expect(prepareBuilder({ docker }, builder, "shop", ctx())).rejects.toThrow(
      "Could not pull acme/builder:1.2.3 from its registry, so nothing was built: pull access denied",
    );

    await expect(prepareBuilder({ docker }, builder, "shop", ctx())).rejects.toThrow(
      "does not say which run image it uses",
    );
  });
});

describe("pulling base images", () => {
  it("pulls each once, and refuses what is not an image reference", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const lines: string[] = [];

    await pullBaseImages({ docker }, ["node:22", "node:22", "alpine:3.20"], ctx(lines));

    expect(lines.filter((line) => line.startsWith("Pulling base image"))).toEqual([
      "Pulling base image node:22",
      "Pulling base image alpine:3.20",
    ]);
    await expect(pullBaseImages({ docker }, ["Not An Image"], ctx())).rejects.toThrow(
      "which is not an image reference",
    );
  });
});

describe("what Nixpacks wrote", () => {
  // As Nixpacks writes it: the words of one command joined with spaces, none of them quoted.
  const SCRIPT =
    "docker build /out -f /out/.nixpacks/Dockerfile --build-arg NIXPACKS_METADATA=node --build-arg NODE_ENV=production\n";

  const writing = async (files: { dockerfile?: string; script?: string }) => {
    const out = dir;
    await mkdir(join(out, NIXPACKS_FOLDER), { recursive: true });
    if (files.dockerfile !== undefined) {
      await writeFile(join(out, NIXPACKS_DOCKERFILE), files.dockerfile);
    }
    if (files.script !== undefined) {
      await writeFile(join(out, NIXPACKS_BUILD_SCRIPT), files.script);
    }
  };

  it("is read from its Dockerfile, and the values of its build's arguments from its script", async () => {
    await writing({
      dockerfile:
        "FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067\nARG NIXPACKS_METADATA NODE_ENV\nCOPY . /app\nFROM alpine:3.20\nCOPY --from=0 /app /app\n",
      script: SCRIPT,
    });

    const output = await readNixpacksOutput(dir, "shop");

    expect(output.images.sort()).toEqual(["alpine:3.20", "ghcr.io/railwayapp/nixpacks:ubuntu-1745885067"]);
    expect(output.argumentNames).toEqual(["NIXPACKS_METADATA", "NODE_ENV"]);
    expect([...output.values]).toEqual([
      ["NIXPACKS_METADATA", "node"],
      ["NODE_ENV", "production"],
    ]);
  });

  it("takes only the arguments its Dockerfile declares, which are all a build of it reads", async () => {
    await writing({ dockerfile: "FROM alpine:3.20\nARG NODE_ENV\n", script: SCRIPT });

    const output = await readNixpacksOutput(dir, "shop");

    expect(output.argumentNames).toEqual(["NODE_ENV"]);
    expect([...output.values]).toEqual([["NODE_ENV", "production"]]);
  });

  it("refuses a run image of another project that nixpacks.toml put in it", async () => {
    await writing({
      dockerfile: "FROM ghcr.io/railwayapp/nixpacks:ubuntu-1\nFROM opsifier/other/web:latest\n",
      script: SCRIPT,
    });

    await expect(readNixpacksOutput(dir, "shop")).rejects.toMatchObject({ code: "image_not_allowed" });
  });

  it("reads its images with the values its build is given, so that an argument can't hide one", async () => {
    await writing({
      dockerfile: `ARG X\nFROM \${X}\n`,
      script: "docker build /out -f /out/.nixpacks/Dockerfile --build-arg X=opsifier/other/web:latest",
    });

    await expect(readNixpacksOutput(dir, "shop")).rejects.toMatchObject({ code: "image_not_allowed" });
  });

  it("reads them with the project's own value of an argument, which the build gets over Nixpacks's", async () => {
    await writing({
      dockerfile: `ARG X\nFROM \${X}\n`,
      script: "docker build /out --build-arg X=alpine:3.20",
    });

    await expect(
      readNixpacksOutput(dir, "shop", new Map([["X", "opsifier/other/web:latest"]])),
    ).rejects.toMatchObject({ code: "image_not_allowed" });
    const output = await readNixpacksOutput(dir, "shop", new Map([["X", "alpine:3.21"]]));
    expect(output.images).toEqual(["alpine:3.21"]);
    expect(output.arguments.names).toEqual(["X"]);
    expect(output.arguments.values).toEqual({});
  });

  it("refuses a name it can't work out, as any build does", async () => {
    await writing({ dockerfile: `ARG X=opsifierZother/web\nFROM \${X/Z//}\n`, script: SCRIPT });

    await expect(readNixpacksOutput(dir, "shop")).rejects.toThrow("which the panel can't work out");
  });

  it("stops when Nixpacks wrote nothing where the panel reads it", async () => {
    await writing({ script: SCRIPT });
    await expect(readNixpacksOutput(dir, "shop")).rejects.toThrow("Nixpacks wrote no .nixpacks/Dockerfile");

    rmSync(join(dir, NIXPACKS_FOLDER), { recursive: true });
    await writing({ dockerfile: "FROM alpine:3.20\n" });
    await expect(readNixpacksOutput(dir, "shop")).rejects.toThrow(
      "Nixpacks wrote no .nixpacks/build.sh, so the panel can't tell which values its build takes",
    );
  });

  it("reads files, never through a link left where its folder or its files go", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "opsifier-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "Dockerfile"), "FROM alpine:3.20\n");
      writeFileSync(join(elsewhere, "build.sh"), SCRIPT);
      symlinkSync(elsewhere, join(dir, NIXPACKS_FOLDER));
      await expect(readNixpacksOutput(dir, "shop")).rejects.toThrow("Nixpacks wrote no .nixpacks folder");

      unlinkSync(join(dir, NIXPACKS_FOLDER));
      await writing({ script: SCRIPT });
      symlinkSync(join(elsewhere, "Dockerfile"), join(dir, NIXPACKS_DOCKERFILE));
      await expect(readNixpacksOutput(dir, "shop")).rejects.toThrow("Nixpacks wrote no .nixpacks/Dockerfile");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("what a build of Nixpacks's output is given", () => {
  it("is the project's own value by name, Nixpacks's for the rest, a reserved name's as written, and BuildKit's none", () => {
    const given = nixpacksArguments(
      ["NODE_ENV", "OWN", "MALLOC_ARENA_MAX", "BUILDKIT_SYNTAX", "UNSET"],
      new Map([
        ["NODE_ENV", "production"],
        ["OWN", "theirs"],
        ["MALLOC_ARENA_MAX", "2"],
        ["BUILDKIT_SYNTAX", "example/frontend"],
      ]),
      new Map([["OWN", "mine"]]),
    );

    expect(given.names).toEqual(["NODE_ENV", "OWN"]);
    expect(given.values).toEqual({ NODE_ENV: "production" });
    expect(given.literal).toEqual([["MALLOC_ARENA_MAX", "2"]]);
    expect(given.steering).toEqual(["BUILDKIT_SYNTAX"]);
    expect([...given.passed]).toEqual([
      ["NODE_ENV", "production"],
      ["OWN", "mine"],
      ["MALLOC_ARENA_MAX", "2"],
    ]);
  });
});

describe("the values Nixpacks's script gives its build's arguments", () => {
  const names = new Set(["A", "B", "C", "D"]);

  it("are taken as they are written, spaces, quotes, backslashes and newlines included", () => {
    const script = [
      "docker build /out -f /out/.nixpacks/Dockerfile",
      '--build-arg A=it\'s a "test"',
      "--build-arg B=two  spaces and $HOME \\ back",
      "--build-arg C=line one\nline two",
      "--build-arg D=",
    ].join(" ");

    expect([...nixpacksArgumentValues(`${script}\n`, names)]).toEqual([
      ["A", `it's a "test"`],
      ["B", "two  spaces and $HOME \\ back"],
      ["C", "line one\nline two"],
      ["D", ""],
    ]);
  });

  it("only end where an argument of the Dockerfile starts", () => {
    const script =
      "docker build /out --build-arg A=x --build-arg OTHER=y --build-arg B=--build-arg=z --build-arg NOT-A-NAME=w";

    expect([...nixpacksArgumentValues(script, names)]).toEqual([
      ["A", "x --build-arg OTHER=y"],
      ["B", "--build-arg=z --build-arg NOT-A-NAME=w"],
    ]);
  });

  it("leave out the newline that ends the script, and keep the last value a name is given", () => {
    expect([
      ...nixpacksArgumentValues("docker build /out --build-arg A=1 --build-arg A=2\n\n", names),
    ]).toEqual([["A", "2\n"]]);
    expect([...nixpacksArgumentValues("docker build /out --build-arg A=1\r\n", names)]).toEqual([["A", "1"]]);
    expect([...nixpacksArgumentValues("docker build /out", names)]).toEqual([]);
  });
});

describe("what a Railpack plan builds from", () => {
  it("is every image the plan names, wherever it names one", async () => {
    const plan = join(dir, "railpack-plan.json");
    writeFileSync(
      plan,
      JSON.stringify({
        steps: [
          { name: "packages:mise", inputs: [{ image: "ghcr.io/railwayapp/railpack-builder:latest" }] },
          {
            name: "build",
            inputs: [{ step: "packages:mise" }],
            commands: [{ src: "/a", dest: "/b", image: "busybox:1" }],
          },
        ],
        deploy: {
          base: { image: "ghcr.io/railwayapp/railpack-runtime:latest" },
          inputs: [{ image: "ghcr.io/railwayapp/railpack-builder:latest" }],
        },
      }),
    );

    expect((await railpackBaseImages(plan, "shop")).sort()).toEqual([
      "busybox:1",
      "ghcr.io/railwayapp/railpack-builder:latest",
      "ghcr.io/railwayapp/railpack-runtime:latest",
    ]);
  });

  it("refuses a plan that names another project's image, as railpack.json can", async () => {
    const plan = join(dir, "railpack-plan.json");
    writeFileSync(plan, JSON.stringify({ deploy: { base: { image: "opsifier/other/web:latest" } } }));

    await expect(railpackBaseImages(plan, "shop")).rejects.toMatchObject({ code: "image_not_allowed" });
  });

  it("stops when the plan can't be read", async () => {
    await expect(railpackBaseImages(join(dir, "missing.json"), "shop")).rejects.toThrow(
      "Railpack's plan can't be read",
    );
  });

  it("reads a file, never a link left in its place, and no more of it than a plan holds", async () => {
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, "{}");
    const plan = join(dir, "railpack-plan.json");
    symlinkSync(elsewhere, plan);
    await expect(railpackBaseImages(plan, "shop")).rejects.toThrow(
      "Railpack's plan can't be read, so nothing was built: Railpack wrote no plan.",
    );

    unlinkSync(plan);
    writeFileSync(plan, `{"padding": "${"x".repeat(4 * 1024 * 1024)}"}`);
    await expect(railpackBaseImages(plan, "shop")).rejects.toThrow("larger than the 4 MiB the panel reads");
  });
});

describe("the buildpacks a project.toml names by image", () => {
  const descriptor = (text: string) => writeFileSync(join(dir, "project.toml"), text);
  const BUILDER = [{ id: "heroku/nodejs", version: "3.0.0" }];

  it("are checked and handed over to be pulled, whatever way the name is written", async () => {
    descriptor(
      [
        "[[io.buildpacks.group]]",
        'uri = "docker://acme/buildpack:1.2.3"',
        "[[io.buildpacks.group]]",
        'uri = "\\u0064ocker:/acme/other:2"',
        "[[io.buildpacks.group]]",
        'uri = "registry.example.com/b/bp:1.0.0"',
        "[[io.buildpacks.pre.group]]",
        'URI = "acme-bp:1.0.0"',
        "[[io.buildpacks.group]]",
        'id = "heroku/nodejs"',
        "[[io.buildpacks.group]]",
        'uri = "urn:cnb:builder:heroku/procfile"',
        "[[io.buildpacks.group]]",
        'id = "inline"',
        "[io.buildpacks.group.script]",
        'api = "0.10"',
        'inline = "echo hi"',
        "[[io.buildpacks.group]]",
        'uri = "https://example.com/bp.tgz"',
      ].join("\n"),
    );

    expect(await projectBuildpackImages(dir, "shop", BUILDER)).toEqual([
      "acme/buildpack:1.2.3",
      "acme/other:2",
      "registry.example.com/b/bp:1.0.0",
      "acme-bp:1.0.0",
    ]);
  });

  it("refuse one of another project, and one from the Buildpack Registry however it is named", async () => {
    descriptor('[[io.buildpacks.group]]\nuri = "docker://opsifier/other/web:latest"\n');
    await expect(projectBuildpackImages(dir, "shop", BUILDER)).rejects.toMatchObject({
      code: "image_not_allowed",
    });
    descriptor('[[build.buildpacks]]\nuri = "other_stack-bp:1.0.0"\n');
    await expect(projectBuildpackImages(dir, "shop", BUILDER)).rejects.toMatchObject({
      code: "image_not_allowed",
    });

    for (const registry of [
      'uri = "urn:cnb:registry:acme/bp@1.0.0"',
      'uri = "acme/bp"',
      'id = "acme/bp"\nversion = "1.0.0"',
      // The builder holds another version only: pack goes to the registry for this one.
      'id = "heroku/nodejs"\nversion = "2.0.0"',
    ]) {
      descriptor(`[[io.buildpacks.group]]\n${registry}\n`);
      await expect(projectBuildpackImages(dir, "shop", BUILDER), registry).rejects.toThrow(
        "Buildpack Registry",
      );
    }
  });

  it("refuse a folder or an archive outside the source, which pack would read on the panel's disk", async () => {
    const outside = mkdtempSync(join(tmpdir(), "opsifier-outside-"));
    try {
      mkdirSync(join(dir, "buildpacks", "mine"), { recursive: true });
      symlinkSync(outside, join(dir, "buildpacks", "away"));
      descriptor('[[io.buildpacks.group]]\nuri = "buildpacks/mine"\n');
      expect(await projectBuildpackImages(dir, "shop", BUILDER)).toEqual([]);

      for (const locator of [
        outside,
        `file://${outside}`,
        "buildpacks/away",
        "../",
        "file://../",
        // pack unescapes `%FF` to a byte all the same, and reads where that leads.
        "file://buildpacks/d%FF/../../../../../etc",
        "file://buildpacks/nowhere.tgz",
      ]) {
        descriptor(`[[io.buildpacks.group]]\nuri = "${locator}"\n`);
        await expect(projectBuildpackImages(dir, "shop", BUILDER), locator).rejects.toThrow(
          "which is outside the source or not found in it",
        );
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("are none without a project.toml, and one that leads out of the source or isn't TOML is refused", async () => {
    expect(await projectBuildpackImages(dir, "shop", BUILDER)).toEqual([]);

    descriptor('[[io.buildpacks.group]]\nuri = "docker://acme/bp:1\n');
    await expect(projectBuildpackImages(dir, "shop", BUILDER)).rejects.toThrow(
      "project.toml can't be read, so nothing was built: A string is not closed, on line 2.",
    );

    rmSync(join(dir, "project.toml"));
    const outside = mkdtempSync(join(tmpdir(), "opsifier-outside-"));
    try {
      writeFileSync(join(outside, "secret.toml"), 'uri = "docker://x"');
      symlinkSync(join(outside, "secret.toml"), join(dir, "project.toml"));
      await expect(projectBuildpackImages(dir, "shop", BUILDER)).rejects.toThrow("leaves the source");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
