import { stringify } from "yaml";
import { DOCKERFILE_FRONTEND } from "../service-tabs/source/build/builders";
import { composeChildAddress, projectNetworkName, projectProxyNetworkName } from "../services/compile";
import { idLabel } from "../services/compile/names";
import { pullsItsImage } from "./images";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How the generated override refers to the project's networks. Not names a stack would pick by accident. */
const PROJECT_NETWORK_KEY = "opsifier_project_network";
const PROXY_NETWORK_KEY = "opsifier_proxy_network";

export interface OverrideChild {
  name: string;
  /** Services with their own networks stay on them. Those without have to be kept on `default`. */
  declaresNetworks: boolean;
  /** Set when the child runs on the host or another container's network, and cannot join a network. */
  networkMode: string | null;
  /** Runs an image it does not build, which Compose then pulls on every deploy. See `pullsItsImage`. */
  pullAlways?: boolean;
  /**
   * Builds its image: the build then pulls every image it starts from rather than take the store's,
   * runs Docker's frontend at the version the panel pins, and keeps its caches to the project's builds.
   */
  builds?: boolean;
}

export interface OverrideInput {
  project: string;
  /** The service's own name. */
  service: string;
  /** The service's stable identifier. */
  id?: string | null;
  /** The stack's qualified name, which is also its Compose project. */
  qualified: string;
  children: readonly OverrideChild[];
}

/**
 * What every build of a stack is given, as an App's build is: the frontend, which neither a syntax
 * line nor an argument of the file can then pick, and the project its `RUN --mount=type=cache` caches
 * belong to, since the server's one builder otherwise shares them by id with every other project.
 * Compose merges these into the file's own arguments, the override's winning.
 */
const buildArgs = (project: string) => ({
  BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND,
  BUILDKIT_CACHE_MOUNT_NS: project,
});

/**
 * Marks every child as the panel's, and puts it on the project's networks: the one other services
 * reach it on, and the one domains reach it on. Nothing the file says about the workload is changed,
 * except that an image the stack does not build is pulled again rather than taken from the store, and
 * a build pulls the images it starts from, with the frontend and the cache namespace the panel gives.
 */
export function renderComposeOverride({ project, service, id, qualified, children }: OverrideInput): string {
  const services: Record<string, unknown> = {};
  for (const child of children) {
    services[child.name] = {
      labels: {
        "opsifier.project": project,
        "opsifier.service": service,
        "opsifier.type": "compose",
        ...idLabel(id),
      },
      ...(child.pullAlways === true ? { pull_policy: "always" } : {}),
      ...(child.builds === true ? { build: { pull: true, args: buildArgs(project) } } : {}),
      ...(child.networkMode === null
        ? {
            networks: {
              ...(child.declaresNetworks ? {} : { default: {} }),
              [PROJECT_NETWORK_KEY]: { aliases: [composeChildAddress(qualified, child.name)] },
              [PROXY_NETWORK_KEY]: { aliases: [composeChildAddress(qualified, child.name)] },
            },
          }
        : {}),
    };
  }
  return stringify({
    services,
    networks: {
      default: {},
      [PROJECT_NETWORK_KEY]: { name: projectNetworkName(project), external: true },
      [PROXY_NETWORK_KEY]: { name: projectProxyNetworkName(project), external: true },
    },
  });
}

/**
 * Reads what the override needs from a Compose file that is known to parse, before Compose has read
 * the stack. Only the file on the page is known then, so its children are all there is to mark.
 */
export function overrideChildren(file: { services: Record<string, unknown> }): OverrideChild[] {
  return Object.entries(file.services)
    .filter(([, child]) => typeof child === "object" && child !== null)
    .map(([name, child]) => {
      const service = child as { networks?: unknown; network_mode?: unknown };
      const networks = service.networks;
      return {
        name,
        declaresNetworks: Array.isArray(networks)
          ? networks.length > 0
          : typeof networks === "object" && networks !== null
            ? Object.keys(networks).length > 0
            : false,
        networkMode: typeof service.network_mode === "string" ? service.network_mode : null,
      };
    });
}

/**
 * Reads what the override needs from what Compose resolved: every child, those an included file
 * brings in among them, with the image it really runs. Compose keeps a child that names no network on
 * `default`, and it stays there once the override names the project's networks.
 */
export function resolvedOverrideChildren(config: Record<string, unknown>, stack: string): OverrideChild[] {
  const services = isRecord(config.services) ? config.services : {};
  return Object.entries(services).flatMap(([name, child]) => {
    if (!isRecord(child)) {
      return [];
    }
    const networks = isRecord(child.networks) ? child.networks : {};
    return [
      {
        name,
        declaresNetworks: !Object.hasOwn(networks, "default"),
        networkMode: typeof child.network_mode === "string" ? child.network_mode : null,
        pullAlways: pullsItsImage(child, stack),
        builds: isRecord(child.build),
      },
    ];
  });
}
