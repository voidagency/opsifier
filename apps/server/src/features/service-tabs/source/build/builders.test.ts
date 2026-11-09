import { buildConfig } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import {
  type BuildInput,
  declaredBuildArgs,
  explainBuildFailure,
  forcedRebuildNote,
  needsBuildx,
  planBuild,
} from "./builders";

const input = (overrides: Partial<BuildInput> = {}): BuildInput => ({
  image: "opsifier/shop/web:latest",
  context: "/data/projects/shop/web/code/apps/web",
  dockerfile: "/data/projects/shop/web/code/apps/web/Dockerfile",
  force: false,
  variables: [
    { key: "PORT", value: "80" },
    { key: "GIT_SHA", value: "abc" },
  ],
  secrets: [],
  workDir: "/data/tmp/build-1",
  secretsHash: "hash-of-the-values",
  ...overrides,
});

const SECRET = { key: "NPM_TOKEN", value: "hunter2-build-secret" };

describe("a Dockerfile build", () => {
  it("runs buildx with the tag, the context and the variables by name", () => {
    const [command] = planBuild(buildConfig.parse({ type: "dockerfile" }), input());

    expect(command?.command).toBe("docker");
    expect(command?.args).toEqual([
      "buildx",
      "build",
      "--progress=plain",
      "--load",
      "--tag=opsifier/shop/web:latest",
      "--file=/data/projects/shop/web/code/apps/web/Dockerfile",
      "--build-arg",
      "PORT",
      "--build-arg",
      "GIT_SHA",
      "--",
      "/data/projects/shop/web/code/apps/web",
    ]);
  });

  it("skips the cache and pulls the base images again on a force rebuild", () => {
    const [command] = planBuild(buildConfig.parse({ type: "dockerfile" }), input({ force: true }));
    expect(command?.args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
    expect(command?.label).toContain("--pull");
  });

  it("leaves the base images alone on an ordinary build", () => {
    const [command] = planBuild(buildConfig.parse({ type: "dockerfile" }), input());
    expect(command?.args).not.toContain("--pull");
  });

  it("never lists a value in the arguments", () => {
    const [command] = planBuild(
      buildConfig.parse({ type: "dockerfile" }),
      input({ variables: [{ key: "SECRET", value: "hunter2" }] }),
    );
    expect(command?.args.join(" ")).not.toContain("hunter2");
    expect(command?.label).not.toContain("hunter2");
  });

  it("hands over a build secret only as a BuildKit secret, never as a build argument", () => {
    const [command] = planBuild(buildConfig.parse({ type: "dockerfile" }), input({ secrets: [SECRET] }));

    expect(command?.args).toEqual(expect.arrayContaining(["--secret", "id=NPM_TOKEN,env=NPM_TOKEN"]));
    expect(command?.args).not.toContain("NPM_TOKEN");
    expect(command?.args.join(" ")).not.toContain(SECRET.value);
    expect(command?.label).not.toContain(SECRET.value);
  });

  it("mounts a file kept out of the context as a secret of its own", () => {
    const [command] = planBuild(
      buildConfig.parse({ type: "dockerfile" }),
      input({ envFile: "/data/tmp/build-1/env-file" }),
    );

    expect(command?.args).toEqual(
      expect.arrayContaining(["--secret", "id=env-file,src=/data/tmp/build-1/env-file"]),
    );
  });
});

describe("what a Dockerfile declares", () => {
  it("finds every ARG, with or without a default, in any stage and in either case", () => {
    expect([
      ...declaredBuildArgs(
        "ARG BASE=node:22\nFROM $BASE AS build\narg TOKEN\nARG A=1 B=2 \\\n  C\n# ARG NOT_ME\nRUN echo ARG NEITHER\n",
      ),
    ]).toEqual(["BASE", "TOKEN", "A", "B", "C"]);
  });
});

describe("a Nixpacks build", () => {
  it("names the image and passes the overrides, which replace what was detected", () => {
    const config = buildConfig.parse({
      type: "nixpacks",
      version: "1.40.0",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      startCommand: "npm start",
      nixPackages: "ffmpeg imagemagick",
      aptPackages: "curl",
    });
    const [command] = planBuild(config, input({ tool: "/opt/opsifier/builders/nixpacks/1.40.0/nixpacks" }));

    expect(command?.command).toBe("/opt/opsifier/builders/nixpacks/1.40.0/nixpacks");
    expect(command?.args).toEqual([
      "build",
      "/data/projects/shop/web/code/apps/web",
      "--name=opsifier/shop/web:latest",
      "--env",
      "PORT",
      "--env",
      "GIT_SHA",
      "--install-cmd=npm ci",
      "--build-cmd=npm run build",
      "--start-cmd=npm start",
      "--pkgs",
      "ffmpeg",
      "imagemagick",
      "--apt",
      "curl",
    ]);
    expect(command?.label).toContain("nixpacks 1.40.0");
  });

  it("leaves out what was not set, so detection still applies", () => {
    const [command] = planBuild(buildConfig.parse({ type: "nixpacks" }), input());

    expect(command?.args.some((arg) => arg.startsWith("--install-cmd"))).toBe(false);
    expect(command?.args).not.toContain("--pkgs");
    expect(command?.command).toBe("nixpacks");
  });

  it("keeps an override that starts with a dash attached to its flag", () => {
    const [command] = planBuild(buildConfig.parse({ type: "nixpacks", startCommand: "--version" }), input());
    expect(command?.args).toContain("--start-cmd=--version");
  });

  it("skips the cache on a force rebuild", () => {
    const [command] = planBuild(buildConfig.parse({ type: "nixpacks" }), input({ force: true }));
    expect(command?.args).toContain("--no-cache");
  });

  it("is given no build secret, because it writes all it gets into the image", () => {
    const [command] = planBuild(buildConfig.parse({ type: "nixpacks" }), input({ secrets: [SECRET] }));
    expect(command?.args).not.toContain("NPM_TOKEN");
    expect(command?.args.join(" ")).not.toContain(SECRET.value);
  });
});

describe("a Buildpacks build", () => {
  it("uses the chosen builder and the web process", () => {
    const [command] = planBuild(
      buildConfig.parse({ type: "buildpacks", builder: "paketobuildpacks/builder-jammy-base:0.4.681" }),
      input(),
    );

    expect(command?.command).toBe("pack");
    expect(command?.args).toEqual([
      "build",
      "opsifier/shop/web:latest",
      "--path=/data/projects/shop/web/code/apps/web",
      "--builder=paketobuildpacks/builder-jammy-base:0.4.681",
      "--default-process=web",
      "--no-color",
      "--pull-policy=if-not-present",
      "--env",
      "PORT",
      "--env",
      "GIT_SHA",
    ]);
  });

  it("clears the cache and pulls the builder again on a force rebuild", () => {
    const [command] = planBuild(buildConfig.parse({ type: "buildpacks" }), input({ force: true }));
    expect(command?.args).toEqual(expect.arrayContaining(["--clear-cache", "--pull-policy=always"]));
  });

  it("passes a build secret by name, for the build phase alone", () => {
    const [command] = planBuild(buildConfig.parse({ type: "buildpacks" }), input({ secrets: [SECRET] }));
    expect(command?.args).toEqual(expect.arrayContaining(["--env", "NPM_TOKEN"]));
    expect(command?.args.join(" ")).not.toContain(SECRET.value);
  });
});

describe("a Railpack build", () => {
  const config = buildConfig.parse({
    type: "railpack",
    version: "0.16.0",
    buildCommand: "bun run build",
    misePackages: "node@20, python",
    buildAptPackages: "curl",
    deployAptPackages: "ca-certificates",
  });

  it("writes a plan, with commands and packages as Railpack's own variables, read from its environment", () => {
    const [prepare] = planBuild(config, input({ tool: "railpack" }));

    expect(prepare?.command).toBe("railpack");
    expect(prepare?.args.slice(0, 3)).toEqual([
      "prepare",
      "/data/projects/shop/web/code/apps/web",
      "--plan-out=/data/tmp/build-1/railpack-plan.json",
    ]);
    expect(prepare?.args).toEqual(
      expect.arrayContaining([
        "--env",
        "RAILPACK_BUILD_CMD",
        "RAILPACK_PACKAGES",
        "RAILPACK_BUILD_APT_PACKAGES",
        "RAILPACK_DEPLOY_APT_PACKAGES",
        "PORT",
      ]),
    );
    expect(prepare?.env).toEqual({
      RAILPACK_BUILD_CMD: "bun run build",
      RAILPACK_PACKAGES: "node@20 python",
      RAILPACK_BUILD_APT_PACKAGES: "curl",
      RAILPACK_DEPLOY_APT_PACKAGES: "ca-certificates",
    });
    expect(prepare?.label).toBe("railpack 0.16.0 prepare");
  });

  it("never puts a value on a command line", () => {
    const secrets = [SECRET];
    const variables = [{ key: "API_KEY", value: "hunter2-variable" }];
    for (const command of planBuild(config, input({ variables, secrets }))) {
      expect(command.args.join(" ")).not.toContain("hunter2");
    }
    const [, build] = planBuild(config, input({ variables, secrets }));
    expect(build?.args).toEqual(
      expect.arrayContaining(["id=API_KEY,env=API_KEY", "id=NPM_TOKEN,env=NPM_TOKEN"]),
    );
  });

  it("carries out the plan through the frontend of the same version, with variables as secrets", () => {
    const [, build] = planBuild(config, input());

    expect(build?.command).toBe("docker");
    expect(build?.args).toEqual(
      expect.arrayContaining([
        "--tag=opsifier/shop/web:latest",
        "--file=/data/tmp/build-1/railpack-plan.json",
        "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.16.0",
        "--secret",
        "id=PORT,env=PORT",
        "id=GIT_SHA,env=GIT_SHA",
      ]),
    );
    expect(build?.args.some((arg) => arg.startsWith("secrets-hash="))).toBe(true);
  });

  it("does not show variable values in the log label", () => {
    const [prepare] = planBuild(config, input({ variables: [{ key: "API_KEY", value: "hunter2" }] }));
    expect(prepare?.label).not.toContain("hunter2");
  });

  it("skips the cache and pulls the base images again on a force rebuild", () => {
    const [, build] = planBuild(config, input({ force: true }));
    expect(build?.args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
  });
});

describe("what a forced rebuild does", () => {
  it("is stated for each builder, including what stays the same", () => {
    expect(forcedRebuildNote(buildConfig.parse({ type: "dockerfile" }))).toContain("the base images");
    expect(forcedRebuildNote(buildConfig.parse({ type: "railpack" }))).toContain("the base images");
    expect(forcedRebuildNote(buildConfig.parse({ type: "buildpacks" }))).toContain(
      "the builder and run images",
    );
    expect(forcedRebuildNote(buildConfig.parse({ type: "nixpacks" }))).toContain("stays the same");
  });
});

describe("which builders need the buildx plugin", () => {
  it("is every one but Buildpacks", () => {
    expect(needsBuildx(buildConfig.parse({ type: "dockerfile" }))).toBe(true);
    expect(needsBuildx(buildConfig.parse({ type: "nixpacks" }))).toBe(true);
    expect(needsBuildx(buildConfig.parse({ type: "railpack" }))).toBe(true);
    expect(needsBuildx(buildConfig.parse({ type: "buildpacks" }))).toBe(false);
  });
});

describe("explaining a failed build", () => {
  const nixpacks = buildConfig.parse({ type: "nixpacks" });
  const railpack = buildConfig.parse({ type: "railpack" });
  const buildpacks = buildConfig.parse({ type: "buildpacks" });

  it.each([
    ["dial tcp: lookup registry-1.docker.io on 127.0.0.11:53: no such host", /DNS/],
    ["curl: (6) Could not resolve host: deb.debian.org", /DNS/],
    ["Temporary failure in name resolution", /DNS/],
    ["dial tcp 1.2.3.4:443: i/o timeout", /could not be reached/],
    ["net/http: TLS handshake timeout", /could not be reached/],
    ["write /var/lib/docker/tmp/x: no space left on device", /disk is full/],
    ["pull access denied for foo, repository does not exist", /refused/],
    ["manifest for foo:1 not found: manifest unknown", /does not exist/],
  ])("names the cause of %s", (line, explanation) => {
    expect(explainBuildFailure(nixpacks, 0, [line])).toMatch(explanation);
  });

  it("says when a builder doesn't know the project", () => {
    expect(explainBuildFailure(buildpacks, 0, ["ERROR: No buildpack groups passed detection."])).toMatch(
      /languages it supports/,
    );
    expect(
      explainBuildFailure(nixpacks, 0, ["Nixpacks was unable to generate a build plan for this app."]),
    ).toMatch(/languages it supports/);
  });

  it("treats Railpack's plan failing differently from its build failing", () => {
    expect(explainBuildFailure(railpack, 0, ["something"])).toMatch(/could not work out/);
    expect(explainBuildFailure(railpack, 1, ["something"])).toBe("The log has the details.");
  });

  it("falls back to the log when it has nothing better to say", () => {
    expect(explainBuildFailure(nixpacks, 0, ["boom"])).toBe("The log has the details.");
  });
});
