import type { DockerFeature } from "@opsifier/contract";
import { ToolNotFoundError, type ToolRunner, ToolTimeoutError } from "../tools";
import { type DockerDriver, DockerDriverError, DockerUnsupportedError, type EngineInfo } from "./driver";

/** The oldest engine this release has been tested against. */
export const MINIMUM_DOCKER_VERSION = "26.0.0";
/** The Engine API that engine speaks. Unlike its version, this is what a daemon says it can do. */
export const MINIMUM_DOCKER_API = "1.45";

const CLI_PROBE_TIMEOUT_MS = 15_000;
const WAY_OUT = "Upgrade or repair Docker, then try again. Nothing was changed.";

/** Numeric comparison of the leading version numbers, so 9.0.0 sorts before 26.0.0. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export interface EngineProblem {
  feature: DockerFeature;
  message: string;
}

/**
 * What this daemon can't do that the panel needs, from what it reports about itself: its API, whether it
 * has Swarm, and the drivers it lists. A version number can come from anywhere, so on its own it decides
 * nothing here. `setup` starts Swarm itself, so it only needs Swarm to exist, not to be running yet.
 */
export function engineProblems(engine: EngineInfo, options: { settingUp?: boolean } = {}): EngineProblem[] {
  const problems: EngineProblem[] = [];
  if (compareVersions(engine.version, MINIMUM_DOCKER_VERSION) < 0) {
    problems.push({
      feature: "version",
      message: `This server runs Docker ${engine.version || "of an unknown version"}, and the oldest version tested with this panel is ${MINIMUM_DOCKER_VERSION}.`,
    });
  }
  if (compareVersions(engine.apiVersion, MINIMUM_DOCKER_API) < 0) {
    problems.push({
      feature: "api",
      message: `This Docker speaks Engine API ${engine.apiVersion || "of an unknown version"}, and the panel needs ${MINIMUM_DOCKER_API} or later.`,
    });
  }
  if (!engine.swarmAvailable) {
    problems.push({ feature: "swarm", message: "This Docker has no Swarm mode." });
  } else if (options.settingUp !== true && engine.swarm !== "active") {
    problems.push({ feature: "swarm", message: `Swarm is "${engine.swarm}" on this server, not active.` });
  } else if (options.settingUp !== true && !engine.swarmManager) {
    problems.push({
      feature: "swarm",
      message: "This node is a Swarm worker, and only a manager can run the panel's commands.",
    });
  }
  if (!engine.networkDrivers.includes("overlay")) {
    problems.push({ feature: "overlay", message: "This Docker has no overlay network driver." });
  }
  if (!engine.volumeDrivers.includes("local")) {
    problems.push({ feature: "volumes", message: "This Docker has no local volume driver." });
  }
  return problems;
}

/** The two features that live in plugins of the Docker CLI, and a command that proves each one answers. */
const CLI_PROBES = {
  buildx: {
    args: ["buildx", "inspect"],
    message: "The Docker CLI's buildx plugin does not work with this Docker, so builds cannot run.",
  },
  compose: {
    args: ["compose", "version"],
    message: "The Docker CLI's Compose plugin does not answer, so Compose stacks cannot run.",
  },
} as const;

export type CliFeature = keyof typeof CLI_PROBES;

export interface DockerCli {
  tools: ToolRunner;
  /** The environment the Docker CLI needs to find its plugins and the daemon. */
  env: Readonly<Record<string, string>>;
}

async function cliAnswers(cli: DockerCli, feature: CliFeature): Promise<boolean> {
  try {
    const { exitCode } = await cli.tools.run({
      command: "docker",
      args: CLI_PROBES[feature].args,
      env: cli.env,
      timeoutMs: CLI_PROBE_TIMEOUT_MS,
    });
    return exitCode === 0;
  } catch (error) {
    if (error instanceof ToolNotFoundError || error instanceof ToolTimeoutError) {
      return false;
    }
    throw error;
  }
}

/** Runs the plugins' own commands, because a missing plugin only shows when something calls it. */
export async function cliProblems(cli: DockerCli): Promise<EngineProblem[]> {
  const features = Object.keys(CLI_PROBES) as CliFeature[];
  const answers = await Promise.all(features.map((feature) => cliAnswers(cli, feature)));
  return features.flatMap((feature, index) =>
    answers[index] === true ? [] : [{ feature, message: CLI_PROBES[feature].message }],
  );
}

/**
 * Stops anything that needs this plugin before it runs, instead of running it and reading the wreckage.
 * The engine is asked first, because that is the answer that applies to every command of the plugin.
 */
export async function assertCliFeature(
  docker: Pick<DockerDriver, "engineInfo">,
  cli: DockerCli,
  feature: CliFeature,
): Promise<void> {
  await assertEngineSupported(docker);
  if (!(await cliAnswers(cli, feature))) {
    throw new DockerUnsupportedError(`${CLI_PROBES[feature].message} ${WAY_OUT}`);
  }
}

/** Refuses with the reason when this daemon can't run the panel's commands. Silent when it can't be asked. */
export async function assertEngineSupported(docker: Pick<DockerDriver, "engineInfo">): Promise<void> {
  let engine: EngineInfo;
  try {
    engine = await docker.engineInfo();
  } catch (error) {
    if (error instanceof DockerDriverError) {
      // Docker being away is not the same as Docker being unsuitable. The call itself will say.
      return;
    }
    throw error;
  }
  const problems = engineProblems(engine);
  if (problems.length > 0) {
    throw new DockerUnsupportedError(`${problems.map(({ message }) => message).join(" ")} ${WAY_OUT}`);
  }
}

/**
 * Which calls change anything. Reading always works, so that the panel can still say what is wrong, and
 * ending what is already running is the one change that can't make things worse. Typed over the whole
 * interface, so a call added to the driver has to be classified here before it compiles.
 */
const CHANGES_SOMETHING: Readonly<Record<Exclude<keyof DockerDriver, "kind">, boolean>> = {
  ping: false,
  swarmInfo: false,
  listNodes: false,
  swarmInit: true,
  swarmLeave: true,
  swarmContents: false,
  listNetworks: false,
  inspectNetwork: false,
  createNetwork: true,
  removeNetwork: true,
  listServices: false,
  inspectService: false,
  createService: true,
  updateService: true,
  removeService: true,
  listTasks: false,
  serviceLogs: false,
  containerLogs: false,
  execAttach: true,
  terminateExec: false,
  inspectExec: false,
  listVolumes: false,
  inspectVolume: false,
  createVolume: true,
  removeVolume: true,
  pullImage: true,
  inspectImage: false,
  tagImage: true,
  imageExposedPorts: false,
  serviceStats: false,
  listComposeContainers: false,
  containerStats: false,
  engineInfo: false,
  events: false,
  diskUsage: false,
  listBuildCache: false,
  listImages: false,
  listContainers: false,
  removeImage: true,
  removeContainer: true,
  removeBuildCache: true,
  runHelper: true,
  openHelper: true,
  removeLeftoverHelpers: false,
  dispose: false,
};

/**
 * A driver that refuses every change on a daemon that can't support it, whichever feature asked. This is
 * what makes an unsupported engine more than a warning: no command it can't run is ever sent to it.
 */
export function refuseOnUnsupportedEngine(driver: DockerDriver): DockerDriver {
  return new Proxy(driver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      if (CHANGES_SOMETHING[property as keyof typeof CHANGES_SOMETHING] !== true) {
        return value.bind(target);
      }
      return async (...args: unknown[]) => {
        await assertEngineSupported(target);
        return value.apply(target, args);
      };
    },
  });
}
