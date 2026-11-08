import { createHash } from "node:crypto";
import { type BuildConfig, splitPackages } from "@opsifier/contract";

export interface BuildVariable {
  key: string;
  value: string;
}

export interface BuildInput {
  /** The tag the result gets. */
  image: string;
  /** Absolute, and already confirmed to be inside the checkout. */
  context: string;
  /** Absolute, for a Dockerfile build. */
  dockerfile?: string;
  /** Skip every build cache. */
  force: boolean;
  variables: readonly BuildVariable[];
  /** Where a tool may leave files nobody else needs. Not part of the context. */
  workDir: string;
  /** The tool to run for Nixpacks and Railpack: a versioned path, or a name on the PATH. */
  tool?: string;
}

export interface BuildCommand {
  command: string;
  args: string[];
  /** What the log shows. Arguments can carry values of variables, so they are not printed as they are. */
  label: string;
}

const flag = (name: string, value: string): string[] => (value === "" ? [] : [`--${name}=${value}`]);

/** Values reach the build through the environment of the process, so they are not in its arguments. */
function dockerfileCommand(
  config: Extract<BuildConfig, { type: "dockerfile" }>,
  input: BuildInput,
): BuildCommand {
  if (input.dockerfile === undefined) {
    throw new Error("A Dockerfile build needs the path of the Dockerfile.");
  }
  return {
    command: "docker",
    args: [
      "buildx",
      "build",
      "--progress=plain",
      "--load",
      `--tag=${input.image}`,
      `--file=${input.dockerfile}`,
      ...(input.force ? ["--no-cache"] : []),
      ...input.variables.flatMap(({ key }) => ["--build-arg", key]),
      "--",
      input.context,
    ],
    label: `docker buildx build ${config.file || "Dockerfile"}${input.force ? " --no-cache" : ""}`,
  };
}

function nixpacksCommand(
  config: Extract<BuildConfig, { type: "nixpacks" }>,
  input: BuildInput,
): BuildCommand {
  const nix = splitPackages(config.nixPackages);
  const apt = splitPackages(config.aptPackages);
  return {
    command: input.tool ?? "nixpacks",
    args: [
      "build",
      input.context,
      `--name=${input.image}`,
      ...(input.force ? ["--no-cache"] : []),
      ...input.variables.flatMap(({ key }) => ["--env", key]),
      ...flag("install-cmd", config.installCommand),
      ...flag("build-cmd", config.buildCommand),
      ...flag("start-cmd", config.startCommand),
      ...(nix.length > 0 ? ["--pkgs", ...nix] : []),
      ...(apt.length > 0 ? ["--apt", ...apt] : []),
    ],
    label: `nixpacks ${config.version} build${input.force ? " --no-cache" : ""}`,
  };
}

function buildpacksCommand(
  config: Extract<BuildConfig, { type: "buildpacks" }>,
  input: BuildInput,
): BuildCommand {
  return {
    command: "pack",
    args: [
      "build",
      input.image,
      `--path=${input.context}`,
      `--builder=${config.builder}`,
      "--default-process=web",
      "--no-color",
      ...(input.force ? ["--clear-cache"] : []),
      ...input.variables.flatMap(({ key }) => ["--env", key]),
    ],
    label: `pack build --builder ${config.builder}${input.force ? " --clear-cache" : ""}`,
  };
}

const railpackFrontend = (version: string) => `ghcr.io/railwayapp/railpack-frontend:v${version}`;

/** Changes whenever a secret does, so layers built with an old value are not reused. */
function secretsHash(variables: readonly BuildVariable[]): string {
  const hash = createHash("sha256");
  for (const { key, value } of variables) {
    hash.update(`${key}=${value}\n`);
  }
  return hash.digest("hex");
}

/** Railpack first writes a plan, then BuildKit carries it out through Railpack's own frontend. */
function railpackCommands(
  config: Extract<BuildConfig, { type: "railpack" }>,
  input: BuildInput,
): BuildCommand[] {
  const planFile = `${input.workDir}/railpack-plan.json`;
  const settings: BuildVariable[] = [
    { key: "RAILPACK_INSTALL_CMD", value: config.installCommand },
    { key: "RAILPACK_BUILD_CMD", value: config.buildCommand },
    { key: "RAILPACK_START_CMD", value: config.startCommand },
    { key: "RAILPACK_PACKAGES", value: splitPackages(config.misePackages).join(" ") },
    { key: "RAILPACK_BUILD_APT_PACKAGES", value: splitPackages(config.buildAptPackages).join(" ") },
    { key: "RAILPACK_DEPLOY_APT_PACKAGES", value: splitPackages(config.deployAptPackages).join(" ") },
  ].filter(({ value }) => value !== "");
  return [
    {
      command: input.tool ?? "railpack",
      args: [
        "prepare",
        input.context,
        `--plan-out=${planFile}`,
        ...[...settings, ...input.variables].flatMap(({ key, value }) => ["--env", `${key}=${value}`]),
      ],
      label: `railpack ${config.version} prepare`,
    },
    {
      command: "docker",
      args: [
        "buildx",
        "build",
        "--progress=plain",
        "--load",
        `--tag=${input.image}`,
        "--build-arg",
        `BUILDKIT_SYNTAX=${railpackFrontend(config.version)}`,
        "--build-arg",
        `secrets-hash=${secretsHash(input.variables)}`,
        `--file=${planFile}`,
        ...(input.force ? ["--no-cache"] : []),
        ...input.variables.flatMap(({ key }) => ["--secret", `id=${key},env=${key}`]),
        "--",
        input.context,
      ],
      label: `docker buildx build railpack-plan.json${input.force ? " --no-cache" : ""}`,
    },
  ];
}

/** Every process a build runs, in order. Pure: what it returns is exactly what gets spawned. */
export function planBuild(config: BuildConfig, input: BuildInput): BuildCommand[] {
  switch (config.type) {
    case "dockerfile":
      return [dockerfileCommand(config, input)];
    case "nixpacks":
      return [nixpacksCommand(config, input)];
    case "buildpacks":
      return [buildpacksCommand(config, input)];
    case "railpack":
      return railpackCommands(config, input);
  }
}
