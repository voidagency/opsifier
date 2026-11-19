import { type BuildConfig, splitPackages } from "@opsifier/contract";
import { HELPER_LABEL } from "../../../../core/docker";

export interface BuildVariable {
  key: string;
  value: string;
}

/** The container Nixpacks or Railpack runs in: the panel's own image, by ID or digest, and a name. */
export interface ToolContainer {
  image: string;
  name: string;
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
  /** Where that tool runs. Without one, it doesn't. */
  toolContainer?: ToolContainer;
  /** Changes whenever a value does, so layers built with an old one are not reused. */
  secretsHash: string;
  /** For Buildpacks: the run image the panel read from the builder, checked and pulled. */
  runImage?: string;
  /** The project the build is for: its `RUN --mount=type=cache` caches are kept apart from others'. */
  project: string;
}

export interface BuildCommand {
  command: string;
  args: string[];
  /** What the log shows. Arguments can carry values of variables, so they are not printed as they are. */
  label: string;
  /** Values only this process needs, on top of the build's own. */
  env?: Readonly<Record<string, string>>;
  /** The container it starts, which goes when the run is cut short, if it has not gone already. */
  container?: string;
}

const flag = (name: string, value: string): string[] => (value === "" ? [] : [`--${name}=${value}`]);

/** A folder of the server a contained tool is given, at the same path. */
interface GivenFolder {
  path: string;
  readOnly?: boolean;
}

/** Docker reads `--mount` as one line of CSV: each field quoted, a comma in a path can't start another. */
const csvField = (field: string): string => `"${field.replaceAll('"', '""')}"`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters to refuse
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A line break would not survive the CSV reader, which turns `\r\n` into `\n`: no such path is given. */
function bindMount({ path, readOnly }: GivenFolder): string {
  if (CONTROL.test(path)) {
    throw new Error("A folder given to a build's tool has a control character in its path.");
  }
  return `--mount=${[
    "type=bind",
    `source=${path}`,
    `target=${path}`,
    ...(readOnly === true ? ["readonly"] : []),
  ]
    .map(csvField)
    .join(",")}`;
}

/** What a contained tool reads from its environment besides the build's variables: the panel's proxy. */
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

/**
 * Nixpacks and Railpack read a project's code and settings, follow its links, and Nixpacks writes files
 * where those settings say. Both run as root, and the panel holds the server's files and the Docker
 * socket. So neither runs in the panel: each runs in a throwaway container of the panel's own image,
 * which has its binary, given the build's copy of the code at the same path and nothing else of the
 * server. It gets no Docker socket, no capabilities, no way to gain privileges, and no network unless it
 * needs one. Values pass by name, from the Docker CLI's environment, never as arguments.
 */
function contained(
  input: Pick<BuildInput, "context" | "toolContainer">,
  tool: {
    command: string;
    args: string[];
    label: string;
    env?: Readonly<Record<string, string>>;
    /** What it reads from its environment. */
    names: readonly string[];
    folders: readonly GivenFolder[];
    network: boolean;
  },
): BuildCommand {
  const container = input.toolContainer;
  if (container === undefined) {
    throw new Error("Nixpacks and Railpack only run in a container of the panel's own image.");
  }
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      `--name=${container.name}`,
      `--label=${HELPER_LABEL}=true`,
      ...(tool.network ? [] : ["--network=none"]),
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--no-healthcheck",
      ...tool.folders.map(bindMount),
      `--workdir=${input.context}`,
      ...[...new Set(tool.names)].map((name) => `--env=${name}`),
      `--entrypoint=${tool.command}`,
      container.image,
      ...tool.args,
    ],
    label: tool.label,
    env: tool.env,
    container: container.name,
  };
}

/** The commit a built image came from, in the label the OCI image specification reserves for it. */
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

/** Written next to the build's other temporary files, and all a revision stamp needs to read. */
export const REVISION_DOCKERFILE = "revision.Dockerfile";

/**
 * Every builder ends with this one step, because not all of them can set a label and the panel is the
 * one that knows which commit it checked out. It adds nothing but the label: no layer, no code. It
 * starts from the image just built, which only this server has, so it is the one build that never
 * asks a registry for its base.
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

/**
 * Every project's builds share the server's one image store, where BuildKit would otherwise look first
 * for what `FROM`, `COPY --from` and `RUN --mount=from=` name: another project's image, or one it pulled
 * with its own credentials. `--pull` sends each of those to its registry instead, on every build.
 */
const PULL = "--pull";

/**
 * The frontend every Dockerfile is built with, whatever the file asks for. A frontend runs inside
 * BuildKit and chooses for itself where the images it names come from, `--pull` or not, so no file may
 * choose its own: Docker's builder reads `BUILDKIT_SYNTAX` before it looks at the file's syntax line, and
 * the frontend it starts then reads no syntax line at all. Pinned to the digest `docker/dockerfile:1`
 * named on 2026-11-18, checked on Docker 29: with it, a file's syntax line naming another frontend is
 * not even fetched.
 */
export const DOCKERFILE_FRONTEND =
  "docker/dockerfile:1.27@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e";

/**
 * Passed to every Dockerfile build: the frontend, which the file can't pick, and the project its
 * `RUN --mount=type=cache` caches belong to. The server's builder keeps one set of caches by id for
 * every build, so without it a project could read or fill the package caches of another's builds.
 */
export const pinnedFrontend = (project: string): string[] => [
  "--build-arg",
  `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
  "--build-arg",
  `BUILDKIT_CACHE_MOUNT_NS=${project}`,
];

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
      PULL,
      ...(input.force ? ["--no-cache"] : []),
      ...pinnedFrontend(input.project),
      ...input.variables.flatMap(({ key }) => ["--build-arg", key]),
      ...input.secrets.flatMap(({ key }) => ["--secret", `id=${key},env=${key}`]),
      ...(input.envFile === undefined ? [] : ["--secret", `id=env-file,src=${input.envFile}`]),
      "--",
      input.context,
    ],
    label: `docker buildx build ${config.file || "Dockerfile"} ${PULL}${input.force ? " --no-cache" : ""}`,
  };
}

/**
 * Nixpacks turns everything it is given into `ARG` and `ENV` lines of its Dockerfile, so a secret passed
 * to it would stay in the image. It has no other way in, and so it gets none.
 *
 * Nixpacks would run `docker build` itself, which takes base images from the server's store and
 * honours any syntax line a project manages to put in the Dockerfile. So it only writes what it would
 * build, `--out`, and the panel builds that, as it builds any Dockerfile: see {@link nixpacksImageCommand}.
 * `--out` writes `.nixpacks/` alone, not the code, so it goes into the build's own copy of the code,
 * which is then the context. Writing that is all it does: it runs with no network.
 */
function nixpacksCommand(
  config: Extract<BuildConfig, { type: "nixpacks" }>,
  input: BuildInput,
): BuildCommand {
  const nix = splitPackages(config.nixPackages);
  const apt = splitPackages(config.aptPackages);
  return contained(input, {
    command: input.tool ?? "nixpacks",
    args: [
      "build",
      input.context,
      `--out=${input.context}`,
      ...input.variables.flatMap(({ key }) => ["--env", key]),
      ...flag("install-cmd", config.installCommand),
      ...flag("build-cmd", config.buildCommand),
      ...flag("start-cmd", config.startCommand),
      ...(nix.length > 0 ? ["--pkgs", ...nix] : []),
      ...(apt.length > 0 ? ["--apt", ...apt] : []),
    ],
    label: `nixpacks ${config.version} build --out`,
    names: input.variables.map(({ key }) => key),
    folders: [{ path: input.context }],
    network: false,
  });
}

/** The Dockerfile Nixpacks writes, and the script with the build arguments it would give it. */
export const NIXPACKS_FOLDER = ".nixpacks";
export const NIXPACKS_DOCKERFILE = ".nixpacks/Dockerfile";
export const NIXPACKS_BUILD_SCRIPT = ".nixpacks/build.sh";

/** Build arguments that steer BuildKit itself, its frontend first: no build is given one but the panel's. */
export const STEERS_BUILDKIT = /^BUILDKIT_/i;

/**
 * Builds what Nixpacks wrote, with the build arguments it would have passed, by name: their values are
 * in `values`, which the process gets in its environment. A value of Nixpacks's own whose name would
 * act on the Docker CLI there, as `MALLOC_ARENA_MAX` would, is an argument instead: `NAME=VALUE`, in
 * `literal`. Neither ever names one of BuildKit's.
 */
export function nixpacksImageCommand(
  input: Pick<BuildInput, "image" | "context" | "force" | "project">,
  argumentNames: readonly string[],
  values: Readonly<Record<string, string>>,
  literal: ReadonlyArray<readonly [string, string]> = [],
): BuildCommand {
  const out = input.context;
  const allowed = (name: string) => !STEERS_BUILDKIT.test(name);
  return {
    command: "docker",
    args: [
      "buildx",
      "build",
      "--progress=plain",
      "--load",
      `--tag=${input.image}`,
      `--file=${out}/${NIXPACKS_DOCKERFILE}`,
      PULL,
      ...(input.force ? ["--no-cache"] : []),
      ...pinnedFrontend(input.project),
      ...argumentNames.filter(allowed).flatMap((name) => ["--build-arg", name]),
      ...literal
        .filter(([name]) => allowed(name))
        .flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]),
      "--",
      out,
    ],
    label: `docker buildx build ${NIXPACKS_DOCKERFILE} ${PULL}${input.force ? " --no-cache" : ""}`,
    env: values,
  };
}

/**
 * The lifecycle only exports what a buildpack writes to a layer, and a build's environment is not that.
 * The panel has just pulled the builder and its run image, so pack finds both on the server.
 */
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
      ...(input.runImage === undefined ? [] : [`--run-image=${input.runImage}`]),
      "--default-process=web",
      "--no-color",
      input.force ? "--pull-policy=always" : "--pull-policy=if-not-present",
      ...(input.force ? ["--clear-cache"] : []),
      ...[...input.variables, ...input.secrets].flatMap(({ key }) => ["--env", key]),
    ],
    label: `pack build --builder ${config.builder}${input.force ? " --clear-cache --pull-policy=always" : ""}`,
  };
}

const railpackFrontend = (version: string) => `ghcr.io/railwayapp/railpack-frontend:v${version}`;

/**
 * The folder Railpack's first step writes its plan in, of its own: the rest of the build's temporary
 * folder, its Docker configuration included, stays out of the container.
 */
export const railpackPlanFolder = (workDir: string): string => `${workDir}/railpack`;

/** Where Railpack's first step writes the plan its second step carries out. */
export const railpackPlanFile = (workDir: string): string =>
  `${railpackPlanFolder(workDir)}/railpack-plan.json`;

/**
 * Railpack first writes a plan, then BuildKit carries it out through Railpack's own frontend. The plan
 * only needs the names, and `--env NAME` makes it read a value from its own environment, so no value is
 * ever an argument of a process anyone on the host can list. Railpack fetches the tool it resolves
 * versions with, and asks for those versions, so its first step keeps the network.
 */
function railpackCommands(
  config: Extract<BuildConfig, { type: "railpack" }>,
  input: BuildInput,
): BuildCommand[] {
  const planFile = railpackPlanFile(input.workDir);
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
  const given = [...new Set([...Object.keys(settings), ...names])];
  return [
    contained(input, {
      command: input.tool ?? "railpack",
      args: ["prepare", input.context, `--plan-out=${planFile}`, ...given.flatMap((name) => ["--env", name])],
      label: `railpack ${config.version} prepare`,
      env: settings,
      names: [...given, ...PROXY_NAMES],
      folders: [{ path: input.context }, { path: railpackPlanFolder(input.workDir) }],
      network: true,
    }),
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
        PULL,
        ...(input.force ? ["--no-cache"] : []),
        ...names.flatMap((name) => ["--secret", `id=${name},env=${name}`]),
        "--",
        input.context,
      ],
      label: `docker buildx build railpack-plan.json ${PULL}${input.force ? " --no-cache" : ""}`,
    },
  ];
}

/** What a forced rebuild does for this builder, in one sentence, for the build's log. */
export function forcedRebuildNote(config: BuildConfig): string {
  const replaced = "The running tasks are then replaced by the new image.";
  if (config.type === "nixpacks") {
    return `Forced rebuild: skipping the build cache. Nixpacks ${config.version} fixes its own base image, so that stays the same, pulled from its registry as on every build. ${replaced}`;
  }
  if (config.type === "buildpacks") {
    return `Forced rebuild: clearing the build cache, and having pack pull every image it uses again. The builder and run images are pulled from their registry, as on every build. ${replaced}`;
  }
  return `Forced rebuild: skipping the build cache. The base images are fetched from their registry, as on every build. ${replaced}`;
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
