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
  /** Skip every build cache and fetch base images again. */
  force: boolean;
  /** Build arguments. Whatever a Dockerfile declares as ARG can be read back from the image. */
  variables: readonly BuildVariable[];
  /** Handed to one step at a time, and never part of an image. */
  secrets: readonly BuildVariable[];
  /** Absolute and outside the context: a Dockerfile reads this file as the build secret `env-file`. */
  envFile?: string;
  /** Where a tool may leave files nobody else needs. Not part of the context. */
  workDir: string;
  /** The tool to run for Nixpacks and Railpack: a versioned path, or a name on the PATH. */
  tool?: string;
  /** Changes whenever a value does, so layers built with an old one are not reused. */
  secretsHash: string;
}

export interface BuildCommand {
  command: string;
  args: string[];
  /** What the log shows. Arguments can carry values of variables, so they are not printed as they are. */
  label: string;
  /** Values only this process needs, on top of the build's own. */
  env?: Readonly<Record<string, string>>;
}

const flag = (name: string, value: string): string[] => (value === "" ? [] : [`--${name}=${value}`]);

/** The commit a built image came from, in the label the OCI image specification reserves for it. */
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

/** Written next to the build's other temporary files, and all a revision stamp needs to read. */
export const REVISION_DOCKERFILE = "revision.Dockerfile";

/**
 * Every builder ends with this one step, because not all of them can set a label and the panel is the
 * one that knows which commit it checked out. It adds nothing but the label: no layer, no code.
 */
export function revisionCommand(
  input: Pick<BuildInput, "image" | "workDir">,
  revision: string,
): BuildCommand {
  return {
    command: "docker",
    args: [
      "buildx",
      "build",
      "--progress=plain",
      "--load",
      `--tag=${input.image}`,
      `--label=${OCI_REVISION_LABEL}=${revision}`,
      `--file=${input.workDir}/${REVISION_DOCKERFILE}`,
      "--",
      input.workDir,
    ],
    label: `docker buildx build, writing ${revision.slice(0, 12)} into the image's labels`,
  };
}

/** Nothing here has a value in it: each tool reads the values from the environment of the process. */
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
      ...(input.force ? ["--no-cache", "--pull"] : []),
      ...input.variables.flatMap(({ key }) => ["--build-arg", key]),
      ...input.secrets.flatMap(({ key }) => ["--secret", `id=${key},env=${key}`]),
      ...(input.envFile === undefined ? [] : ["--secret", `id=env-file,src=${input.envFile}`]),
      "--",
      input.context,
    ],
    label: `docker buildx build ${config.file || "Dockerfile"}${input.force ? " --no-cache --pull" : ""}`,
  };
}

/**
 * Nixpacks turns everything it is given into `ARG` and `ENV` lines of its Dockerfile, so a secret passed
 * to it would stay in the image. It has no other way in, and so it gets none.
 */
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

/** The lifecycle only exports what a buildpack writes to a layer, and a build's environment is not that. */
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
      // By default pack fetches the builder and run images on every build, forced or not.
      input.force ? "--pull-policy=always" : "--pull-policy=if-not-present",
      ...(input.force ? ["--clear-cache"] : []),
      ...[...input.variables, ...input.secrets].flatMap(({ key }) => ["--env", key]),
    ],
    label: `pack build --builder ${config.builder}${input.force ? " --clear-cache --pull-policy=always" : ""}`,
  };
}

const railpackFrontend = (version: string) => `ghcr.io/railwayapp/railpack-frontend:v${version}`;

/**
 * Railpack first writes a plan, then BuildKit carries it out through Railpack's own frontend. The plan
 * only needs the names, and `--env NAME` makes it read a value from its own environment, so no value is
 * ever an argument of a process anyone on the host can list.
 */
function railpackCommands(
  config: Extract<BuildConfig, { type: "railpack" }>,
  input: BuildInput,
): BuildCommand[] {
  const planFile = `${input.workDir}/railpack-plan.json`;
  const settings = Object.fromEntries(
    Object.entries({
      RAILPACK_INSTALL_CMD: config.installCommand,
      RAILPACK_BUILD_CMD: config.buildCommand,
      RAILPACK_START_CMD: config.startCommand,
      RAILPACK_PACKAGES: splitPackages(config.misePackages).join(" "),
      RAILPACK_BUILD_APT_PACKAGES: splitPackages(config.buildAptPackages).join(" "),
      RAILPACK_DEPLOY_APT_PACKAGES: splitPackages(config.deployAptPackages).join(" "),
    }).filter(([, value]) => value !== ""),
  );
  const names = [...input.variables, ...input.secrets].map(({ key }) => key);
  return [
    {
      command: input.tool ?? "railpack",
      args: [
        "prepare",
        input.context,
        `--plan-out=${planFile}`,
        ...[...new Set([...Object.keys(settings), ...names])].flatMap((name) => ["--env", name]),
      ],
      label: `railpack ${config.version} prepare`,
      env: settings,
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
        `secrets-hash=${input.secretsHash}`,
        `--file=${planFile}`,
        ...(input.force ? ["--no-cache", "--pull"] : []),
        ...names.flatMap((name) => ["--secret", `id=${name},env=${name}`]),
        "--",
        input.context,
      ],
      label: `docker buildx build railpack-plan.json${input.force ? " --no-cache --pull" : ""}`,
    },
  ];
}

/** What a forced rebuild does for this builder, in one sentence, for the build's log. */
export function forcedRebuildNote(config: BuildConfig): string {
  const replaced = "The running tasks are then replaced by the new image.";
  if (config.type === "nixpacks") {
    return `Forced rebuild: skipping the build cache. Nixpacks ${config.version} fixes its own base image, so that stays the same. ${replaced}`;
  }
  const bases = config.type === "buildpacks" ? "the builder and run images" : "the base images";
  return `Forced rebuild: skipping the build cache and pulling ${bases} again. ${replaced}`;
}

/** Whether this builder's command needs the Docker CLI's buildx plugin to run at all. */
export const needsBuildx = (config: BuildConfig): boolean => config.type !== "buildpacks";

/** What a failure's last lines say about its cause, for the error the deployment reports. */
const KNOWN_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /no such host|name or service not known|temporary failure in name resolution|could not resolve host|server misbehaving/i,
    "A name on the network could not be resolved. Check this server's DNS, then deploy again.",
  ],
  [
    /i\/o timeout|connection refused|connection reset by peer|network is unreachable|tls handshake timeout|context deadline exceeded/i,
    "A server the build needs could not be reached. Check this server's network, then deploy again.",
  ],
  [/no space left on device/i, "Docker's disk is full. Free some space, then deploy again."],
  [
    /unauthorized|authentication required|pull access denied|denied: requested access/i,
    "A registry refused the build. Check the access an image in it needs.",
  ],
  [
    /manifest unknown|manifest for .* not found|not found: manifest/i,
    "An image the build asks for does not exist. Check its name and tag.",
  ],
  [
    /no buildpack groups passed detection|no buildpacks participating/i,
    "None of this builder's buildpacks recognised the project. Check the languages it supports, or choose another builder on the Source tab.",
  ],
  [
    /unable to generate a build plan|no start command could be found/i,
    "Nixpacks could not work out how to build or start this project. Check the languages it supports, or set the commands on the Source tab.",
  ],
];

/**
 * Turns a failed build's output into the next step. The first match wins, so the causes are in the
 * order that a person can do something about them, and the builder's own line is what says which.
 */
export function explainBuildFailure(config: BuildConfig, step: number, tail: readonly string[]): string {
  const text = tail.join("\n");
  const known = KNOWN_FAILURES.find(([pattern]) => pattern.test(text))?.[1];
  if (known !== undefined) {
    return known;
  }
  if (config.type === "railpack" && step === 0) {
    return "Railpack could not work out how to build this project. Check the languages it supports, or set the commands on the Source tab.";
  }
  return "The log has the details.";
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

/** The names a Dockerfile declares with ARG, in any stage. Anything else it is given has no effect on it. */
export function declaredBuildArgs(dockerfile: string): Set<string> {
  const names = new Set<string>();
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const declared = /^\s*ARG\s+(.*)$/i.exec(line)?.[1] ?? "";
    for (const word of declared.split(/\s+/)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word)?.[0];
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}
