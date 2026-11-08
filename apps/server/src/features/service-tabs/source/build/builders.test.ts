import { buildConfig } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { type BuildInput, planBuild } from "./builders";

const input = (overrides: Partial<BuildInput> = {}): BuildInput => ({
  image: "opsifier/shop/web:latest",
  context: "/data/projects/shop/web/code/apps/web",
  dockerfile: "/data/projects/shop/web/code/apps/web/Dockerfile",
  force: false,
  variables: [
    { key: "PORT", value: "80" },
    { key: "GIT_SHA", value: "abc" },
  ],
  workDir: "/data/tmp/build-1",
  ...overrides,
});

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

  it("skips the cache on a force rebuild", () => {
    const [command] = planBuild(buildConfig.parse({ type: "dockerfile" }), input({ force: true }));
    expect(command?.args).toContain("--no-cache");
  });

  it("never lists a value in the arguments", () => {
    const [command] = planBuild(
      buildConfig.parse({ type: "dockerfile" }),
      input({ variables: [{ key: "SECRET", value: "hunter2" }] }),
    );
    expect(command?.args.join(" ")).not.toContain("hunter2");
    expect(command?.label).not.toContain("hunter2");
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
});

describe("a Buildpacks build", () => {
  it("uses the chosen builder and the web process", () => {
    const [command] = planBuild(
      buildConfig.parse({ type: "buildpacks", builder: "paketobuildpacks/builder-jammy-base:latest" }),
      input(),
    );

    expect(command?.command).toBe("pack");
    expect(command?.args).toEqual([
      "build",
      "opsifier/shop/web:latest",
      "--path=/data/projects/shop/web/code/apps/web",
      "--builder=paketobuildpacks/builder-jammy-base:latest",
      "--default-process=web",
      "--no-color",
      "--env",
      "PORT",
      "--env",
      "GIT_SHA",
    ]);
  });

  it("clears the cache on a force rebuild", () => {
    const [command] = planBuild(buildConfig.parse({ type: "buildpacks" }), input({ force: true }));
    expect(command?.args).toContain("--clear-cache");
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

  it("writes a plan, with commands and packages as Railpack's own variables", () => {
    const [prepare] = planBuild(config, input({ tool: "railpack" }));

    expect(prepare?.command).toBe("railpack");
    expect(prepare?.args.slice(0, 3)).toEqual([
      "prepare",
      "/data/projects/shop/web/code/apps/web",
      "--plan-out=/data/tmp/build-1/railpack-plan.json",
    ]);
    expect(prepare?.args).toEqual(
      expect.arrayContaining([
        "RAILPACK_BUILD_CMD=bun run build",
        "RAILPACK_PACKAGES=node@20 python",
        "RAILPACK_BUILD_APT_PACKAGES=curl",
        "RAILPACK_DEPLOY_APT_PACKAGES=ca-certificates",
        "PORT=80",
      ]),
    );
    expect(prepare?.label).toBe("railpack 0.16.0 prepare");
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

  it("skips the cache on a force rebuild, and a new secret value changes the hash", () => {
    const [, build] = planBuild(config, input({ force: true }));
    expect(build?.args).toContain("--no-cache");

    const hashOf = (value: string) =>
      planBuild(config, input({ variables: [{ key: "A", value }] }))[1]?.args.find((arg) =>
        arg.startsWith("secrets-hash="),
      );
    expect(hashOf("one")).not.toBe(hashOf("two"));
  });
});
