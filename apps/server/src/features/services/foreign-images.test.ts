import { describe, expect, it } from "vitest";
import { AppError } from "../../core/errors";
import { TOO_MUCH_TO_READ } from "./dockerfile-reader";
import {
  assertDockerfileAllowed,
  assertImageAllowed,
  dockerfileRefusals,
  IMAGE_NOT_ALLOWED,
  imageOwner,
  isDockerFrontend,
  normalizeImageReference,
  readDockerfileImages,
} from "./foreign-images";

const DIGEST = `sha256:${"a".repeat(64)}`;
/** Characters Go and JavaScript disagree about: Go takes NEL for a blank and not the byte order mark. */
const NEL = String.fromCharCode(0x85);
const BOM = String.fromCharCode(0xfeff);
/** The long s, which Go's case folding takes for an s. */
const LONG_S = String.fromCharCode(0x17f);
/** `${NAME}`, as a Dockerfile writes a substitution. */
const v = (name: string): string => `\${${name}}`;

describe("comparing image references", () => {
  it.each([
    ["docker.io/library/node:20", "node"],
    ["index.docker.io/opsifier/shop/web:latest", "opsifier/shop/web"],
    [`node:20@${DIGEST}`, "node"],
    ["localhost:5000/foo:1", "localhost:5000/foo"],
    ["Registry.Example.com/acme/app", "registry.example.com/acme/app"],
    ["library/postgres", "postgres"],
  ])("reads %s as %s", (reference, normalized) => {
    expect(normalizeImageReference(reference)).toBe(normalized);
  });
});

describe("whose an image is", () => {
  it.each([
    "opsifier/shop/web:latest",
    "opsifier/shop/web:previous",
    "shop_web-app",
    "shop_api-worker:latest",
    "shop_web/app",
    "node:20",
    "docker.io/library/postgres:17",
    "ghcr.io/acme/app:1.2.3",
    "registry.example.com/team_a/app:1",
    "localhost:5000/other_web-app",
    "opsifier",
  ])("lets shop use %s", (reference) => {
    expect(imageOwner(reference, "shop")).toBeNull();
  });

  it.each([
    "opsifier/other/web:latest",
    "docker.io/opsifier/other/web",
    `index.docker.io/opsifier/other/web@${DIGEST}`,
    "opsifier/other/web/extra",
    "other_web-app",
    "docker.io/library/other_web-app:latest",
    "other_web/app",
    "shop-two_web-app",
  ])("gives %s to another project", (reference) => {
    expect(imageOwner(reference, "shop")).toBe("another-project");
  });

  it.each(["opsifier/releases/0c6a8f1e:3", "opsifier/panel:1", "opsifier/shop:latest"])(
    "keeps %s for the server",
    (reference) => {
      expect(imageOwner(reference, "shop")).toBe("server");
    },
  );

  it("keeps every release for the server, even from a project called releases", () => {
    expect(imageOwner("opsifier/releases/0c6a8f1e:3", "releases")).toBe("server");
    expect(imageOwner("opsifier/releases/web:latest", "releases")).toBe("server");
  });
});

describe("refusing an image", () => {
  it("names the field, answering a request", () => {
    const error = (() => {
      try {
        assertImageAllowed("opsifier/other/web:latest", "shop", "image");
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 400,
      code: IMAGE_NOT_ALLOWED,
      fields: { image: "Belongs to another project" },
    });
    expect((error as AppError).message).toContain("another project on this server");
    expect((error as AppError).message).not.toContain("other/web is");
  });

  it("is a conflict when it stops a deployment", () => {
    expect(() => assertImageAllowed("opsifier/releases/abc:2", "shop")).toThrow(
      expect.objectContaining({ status: 409, code: IMAGE_NOT_ALLOWED }),
    );
  });

  it("lets an image from a registry through", () => {
    expect(() => assertImageAllowed("nginx:1.27", "shop", "image")).not.toThrow();
  });
});

const images = (dockerfile: string, buildArgs?: Record<string, string>) =>
  readDockerfileImages(dockerfile, new Map(Object.entries(buildArgs ?? {}))).images.sort();
const refused = (dockerfile: string, buildArgs?: Record<string, string>, strict = false) =>
  dockerfileRefusals(dockerfile, "shop", { buildArgs: new Map(Object.entries(buildArgs ?? {})), strict });

describe("reading a Dockerfile", () => {
  it("finds the images of an ordinary multi-stage build, and nothing of its stages", () => {
    const dockerfile = [
      "# syntax=docker/dockerfile:1.7",
      "ARG NODE_VERSION=22",
      `FROM --platform=$BUILDPLATFORM node:\${NODE_VERSION}-alpine AS build_env`,
      "WORKDIR /app",
      "RUN --mount=type=cache,target=/root/.npm --mount=type=secret,id=npm_token npm ci",
      "COPY . .",
      "RUN npm run build \\",
      "  && npm prune --omit=dev",
      "",
      "FROM build_env AS tested",
      "RUN npm test",
      "",
      "FROM nginx:1.27-alpine",
      "COPY --from=build_env /app/dist /usr/share/nginx/html",
      "COPY --from=0 /app/package.json /",
      "COPY --link --from=Tested /app/report /report",
      "RUN --mount=type=bind,from=build_env,source=/app,target=/src ls /src",
      "FROM scratch AS empty",
    ].join("\n");

    expect(images(dockerfile)).toEqual(["nginx:1.27-alpine", "node:22-alpine"]);
    expect(refused(dockerfile, {}, true)).toEqual([]);
  });

  it("reads one level of ONBUILD, as BuildKit refuses a second, so a line of them reads once", () => {
    expect(refused("FROM alpine\nONBUILD COPY --from=opsifier/other/web /a /b")).toEqual([
      expect.objectContaining({ reason: "another-project" }),
    ]);
    const nested = `FROM alpine\n${"ONBUILD ".repeat(16_384)}RUN ${"x".repeat(64 * 1024)}\n`;
    const started = performance.now();
    refused(nested);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses another project's image, wherever the file names it", () => {
    for (const dockerfile of [
      "FROM opsifier/other/web:latest",
      "FROM alpine\nCOPY --from=opsifier/other/web:latest /app /app",
      "FROM alpine\nRUN --mount=type=bind,from=other_web-app,target=/x cat /x/secret",
      'FROM alpine\nRUN --mount="type=bind,from=opsifier/other/web,target=/x" true',
      'FROM alpine\nRUN --mount=type=bind,"from=opsifier/other/web",target=/x true',
      "FROM alpine\nRUN --mount=type=cache,FROM=opsifier/other/web,target=/x true",
      'FROM alpine\nCOPY --"from"=opsifier/other/web /a /b',
      "FROM alpine\nCOPY --fr\\om=opsifier/other/web /a /b",
      "FROM alpine\nONBUILD COPY --from=opsifier/other/web /a /b",
      'FROM "opsifier/other/web"',
      "from   docker.io/opsifier/other/web AS stolen",
    ]) {
      expect(refused(dockerfile), dockerfile).toEqual([
        expect.objectContaining({ reason: "another-project" }),
      ]);
    }
  });

  it("refuses a release, whatever the project is called", () => {
    expect(dockerfileRefusals("FROM opsifier/releases/abc:4", "releases")).toEqual([
      { reference: "opsifier/releases/abc:4", reason: "server" },
    ]);
  });

  it("substitutes global arguments, and the values a build passes", () => {
    expect(refused(`ARG BASE=opsifier/other/web\nFROM \${BASE}`)).toHaveLength(1);
    expect(refused('ARG BASE="opsifier/other/web"\nFROM $BASE')).toHaveLength(1);
    expect(refused(`ARG BASE\nFROM \${BASE:-opsifier/other/web}`)).toHaveLength(1);
    expect(refused(`ARG A=opsifier B=other\nFROM \${A}/\${B}/web`)).toHaveLength(1);
    expect(refused("ARG BASE=node:22\nFROM $BASE")).toEqual([]);
    expect(refused("ARG BASE=node:22\nFROM $BASE", { BASE: "opsifier/other/web" })).toHaveLength(1);
    expect(images("ARG BASE=node:22\nFROM $BASE", { BASE: "python:3.13" })).toEqual(["python:3.13"]);
  });

  it("substitutes a stage's arguments and variables where a stage reads them", () => {
    expect(refused("FROM alpine\nARG SRC=opsifier/other/web\nCOPY --from=$SRC /a /b")).toHaveLength(1);
    expect(
      refused(`FROM alpine\nENV SRC=other_web-app\nRUN --mount=from=\${SRC},target=/x true`),
    ).toHaveLength(1);
    expect(refused("ARG SRC=opsifier/other/web\nFROM alpine\nARG SRC\nCOPY --from=$SRC /a /b")).toHaveLength(
      1,
    );
  });

  it("counts every platform the server could have", () => {
    expect(refused(`FROM opsifier/\${TARGETOS}/web`)).toEqual([
      { reference: "opsifier/linux/web", reason: "another-project" },
    ]);
    expect(
      images(`FROM node:22 AS base-amd64\nFROM node:22-slim AS base-arm64\nFROM base-\${TARGETARCH}`),
    ).toEqual(expect.arrayContaining(["node:22", "node:22-slim"]));
  });

  it("follows continuations, under either escape character, and skips comments inside them", () => {
    expect(refused("FROM \\\n  opsifier/other/web")).toHaveLength(1);
    expect(refused("FROM \\\n# a comment\n\n   opsifier/other/web")).toHaveLength(1);
    expect(refused("# escape=`\nFROM alpine\nRUN echo \\\nFROM opsifier/other/web AS x")).toHaveLength(1);
    expect(refused("# escape=`\nFROM `\n  opsifier/other/web")).toHaveLength(1);
  });

  it("reads an escaped escape at the end of a line both ways parsers have", () => {
    expect(refused("FROM alpine\nRUN echo \\\\\nFROM opsifier/other/web AS x")).toHaveLength(1);
    expect(refused("FROM \\\\\nopsifier/other/web")).toHaveLength(1);
  });

  it("takes for blank what Go takes for blank, as BuildKit does", () => {
    // A command line Nixpacks writes as it is: the next-line character makes a comment of the middle line.
    expect(
      refused(
        `FROM alpine\nRUN \\\n${NEL}# x\n--mount=type=bind,from=opsifier/other/web,target=/x cat /x/secret`,
      ),
    ).toEqual([{ reference: "opsifier/other/web", reason: "another-project" }]);
    expect(refused(`${NEL}FROM opsifier/other/web`)).toHaveLength(1);
    expect(refused(`FROM \\\n${NEL}  \nopsifier/other/web`)).toHaveLength(1);
    expect(refused(`FROM alpine\nCOPY${NEL}--from=opsifier/other/web /a /b`)).toEqual([]);
    expect(refused(`FROM alpine\nRUN --mount=from=other_web-app,target=/x${NEL}true`)).toHaveLength(1);
    // Go does not take the byte order mark for blank, past the first line: BuildKit refuses that line.
    expect(images(`FROM node:22\n${BOM}FROM opsifier/other/web`)).toEqual(["node:22"]);
  });

  it("reads an instruction's flags byte by byte, as BuildKit does", () => {
    // à is C3 A0 and ą is C4 85 in UTF-8: BuildKit ends a flag at A0 and 85, which Go takes for blanks.
    for (const split of ["à", "ą", " ", NEL]) {
      expect(refused(`FROM alpine\nCOPY --exclude=x${split}--from=opsifier/other/web / /x`), split).toEqual([
        { reference: "opsifier/other/web", reason: "another-project" },
      ]);
    }
    expect(refused(`FROM alpine\nRUN --mount=from=other_web-app${"ą"},target=/x true`)).toEqual([]);
    // A character beyond ASCII where a flag would start ends the flags: none of its bytes is a dash.
    expect(images(`FROM alpine\nCOPY 　--from=opsifier/other/web / /x`)).toEqual(["alpine"]);
    expect(images(`FROM alpine\nCOPY --chown=1 é --from=opsifier/other/web / /x`)).toEqual(["alpine"]);
  });

  it("reads a variable's name in any alphabet, as BuildKit does", () => {
    expect(refused("ARG é=opsifier/other/web\nFROM $é")).toHaveLength(1);
    const script = String.fromCodePoint(0x1d49c);
    expect(refused(`ARG ${script}=opsifier/other/web\nFROM ${v(script)}`)).toHaveLength(1);
    // A name of digits only, in any script, is a positional parameter, and ends where the digits do.
    expect(refused(`ARG ١=other\nFROM opsifier/$١/web`)).toHaveLength(1);
  });

  it("can't be shown a heredoc that hides an instruction or invents a stage", () => {
    expect(refused("FROM alpine\nRUN cat <<'X\\'\nX\\\nFROM \\\nopsifier/other/web AS stolen")).toHaveLength(
      1,
    );
    expect(
      refused("FROM alpine\nRUN <<EOF\nFROM alpine AS other_web-app\nEOF\nCOPY --from=other_web-app /a /b"),
    ).toHaveLength(1);
    expect(refused('FROM alpine\nRUN ["sh", "-c", "cat <<EOF"]\nFROM opsifier/other/web')).toHaveLength(1);
    expect(refused("FROM alpine\nCOPY <<-EOF /x\n\tFROM opsifier/other/web\n\tEOF\n")).toHaveLength(1);
  });

  it("lets a heredoc's own lines through when they name nothing", () => {
    const dockerfile = [
      "FROM alpine",
      "COPY --chmod=0755 <<'OPSIFIER_EOF_1' /usr/local/bin/start",
      "#!/bin/sh",
      "exec node server.js",
      "OPSIFIER_EOF_1",
      "RUN <<EOF",
      "set -e",
      "apk add --no-cache curl \\",
      "EOF",
    ].join("\n");
    expect(images(dockerfile)).toEqual(["alpine"]);
  });

  it("says when it can't work out a name, and refuses it only for a build", () => {
    const substitution = `\${X/Z//}`;
    const dockerfile = `ARG X=opsifierZother/web\nFROM ${substitution}`;
    expect(readDockerfileImages(dockerfile).unresolved).toEqual([substitution]);
    expect(refused(dockerfile)).toEqual([]);
    expect(refused(dockerfile, {}, true)).toEqual([{ reference: substitution, reason: "unresolved" }]);
  });

  it("lets a variable it can't work out be, until an image reference uses it", () => {
    const harmless = [
      "ARG VERSION=22.11.0",
      `ENV MAJOR=\${VERSION%%.*} PREFIX=\${PWD%/*}`,
      `ARG SUFFIX=\${VERSION/./-}`,
      "FROM node:22",
      `ENV DIR=\${PWD%/*}`,
      "RUN <<EOF",
      `env DIR=\${PWD%/*} make`,
      "EOF",
    ].join("\n");
    expect(readDockerfileImages(harmless).unresolved).toEqual([]);
    expect(refused(harmless, {}, true)).toEqual([]);

    expect(refused(`ARG X=\${Y#a}\nFROM \${X}`, {}, true)).toEqual([
      { reference: `\${X}`, reason: "unresolved" },
    ]);
    expect(refused(`FROM alpine\nENV V=\${A/b/c}\nCOPY --from=$V /a /b`, {}, true)).toEqual([
      { reference: "$V", reason: "unresolved" },
    ]);
    expect(
      refused(`ARG X=\${Y#a}\nFROM alpine\nARG X\nRUN --mount=from=\${X},target=/x true`, {}, true),
    ).toEqual([{ reference: `\${X}`, reason: "unresolved" }]);
  });

  it("stops reading a file written to be slow to read, which a build then refuses", () => {
    const line = `FROM a\${TARGETPLATFORM}\${TARGETARCH}b`;
    const dockerfile = Array.from({ length: 2000 }, () => line).join("\n");

    const started = performance.now();
    const read = readDockerfileImages(dockerfile);

    expect(performance.now() - started).toBeLessThan(1000);
    expect(read.unresolved).toContain(TOO_MUCH_TO_READ);
    expect(() => assertDockerfileAllowed(dockerfile, "shop", { strict: true })).toThrow(
      /more images, or more ways to spell them, than the panel reads in one file/,
    );
  });

  it.each([
    ["one long word of substitutions", `FROM ${`x${v("TARGETPLATFORM")}`.repeat(2000)}`],
    ["words of substitutions, many times", `FROM ${`x${v("TARGETARCH")}`.repeat(40)}\n`.repeat(400)],
    [
      "nested defaults",
      `FROM a${`${v(`TARGETPLATFORM:+${v("TARGETPLATFORM")}${v("TARGETARCH")}`)}`.repeat(2)}b\n`.repeat(500),
    ],
    [
      "a value that grows",
      `${Array.from({ length: 50 }, (_, i) => `ARG A${i + 1}=$A${i}$A${i}${v("TARGETARCH")}`).join("\n")}\nFROM $A50`,
    ],
    [
      "a mount of many sources",
      `FROM alpine\nRUN ${`--mount=from=x${v("TARGETPLATFORM")}y,target=/x `.repeat(2000)}true`,
    ],
  ])("reads %s in well under a second", (_name, dockerfile) => {
    const started = performance.now();
    readDockerfileImages(dockerfile);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads no file longer than it reads, and says so", () => {
    const read = readDockerfileImages(`FROM node:22\n${"# padding\n".repeat(110_000)}`);
    expect(read).toEqual({ images: [], frontends: [], json: false, unresolved: [TOO_MUCH_TO_READ] });
  });

  it("gives up on a name longer than any image reference without working it out", () => {
    const long = `FROM opsifier/other/web${v("A")}${"x".repeat(2000)}`;
    expect(readDockerfileImages(long).unresolved).toEqual([
      expect.stringMatching(/^opsifier\/other\/web\$\{A\}x+\.\.\.$/),
    ]);
  });

  it("allows Docker's own frontend only, in every form BuildKit reads a syntax line", () => {
    for (const frontend of [
      "docker/dockerfile:1",
      "docker/dockerfile:1.7-labs",
      "docker.io/docker/dockerfile:1",
      `docker/dockerfile@${DIGEST}`,
      "docker/dockerfile-upstream:master",
    ]) {
      expect(isDockerFrontend(frontend), frontend).toBe(true);
      expect(refused(`# syntax=${frontend}\nFROM node:22`)).toEqual([]);
    }
    for (const dockerfile of [
      "# syntax=acme/frontend:1\nFROM node:22",
      "#syntax = acme/frontend:1 --some option\nFROM node:22",
      "# SYNTAX=acme/frontend\nFROM node:22",
      "#!/usr/bin/env docker\n# syntax=acme/frontend\nFROM node:22",
      "// syntax=acme/frontend\nFROM node:22",
      "FROM node:22\n# syntax=acme/frontend",
      `${BOM}# syntax=acme/frontend\nFROM node:22`,
      `#${NEL}syntax=acme/frontend\nFROM node:22`,
      `${NEL}# syntax${NEL}=${NEL}acme/frontend\nFROM node:22`,
    ]) {
      expect(refused(dockerfile), dockerfile).toEqual([
        { reference: expect.stringContaining("acme/frontend"), reason: "frontend" },
      ]);
    }
  });

  it("refuses a file that is one JSON object, whatever its keys, as BuildKit reads one for a frontend", () => {
    for (const dockerfile of [
      '{"syntax": "acme/frontend:1"}',
      `${BOM}{"syntax": "acme/frontend:1"}`,
      '#!/usr/bin/env docker\n{"syntax": "acme/frontend:1"}',
      `${BOM}#!x\n  {"${LONG_S}yntax": "acme/frontend:1"}  `,
      '{"Syntax": "acme/frontend:1", "other": 1}',
    ]) {
      expect(refused(dockerfile), dockerfile).toEqual([{ reference: "a JSON document", reason: "frontend" }]);
    }
    expect(() => assertDockerfileAllowed('{"syntax": "acme/frontend"}', "shop")).toThrow(
      "This Dockerfile is a JSON document",
    );
    expect(refused('["FROM", "node:22"]')).toEqual([]);
  });

  it("refuses the first of them with a clear message, in a request or a build", () => {
    expect(() => assertDockerfileAllowed("FROM opsifier/other/web", "shop", { field: "dockerfile" })).toThrow(
      expect.objectContaining({ status: 400, fields: { dockerfile: "Belongs to another project" } }),
    );
    expect(() => assertDockerfileAllowed("# syntax=acme/frontend\nFROM node", "shop")).toThrow(
      /Only Docker's own, docker\/dockerfile, builds here/,
    );
  });
});
