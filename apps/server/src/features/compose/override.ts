import { stringify } from "yaml";
import { composeChildAddress, projectNetworkName, projectProxyNetworkName } from "../services/compile";
import { idLabel } from "../services/compile/names";

/** How the generated override refers to the project's networks. Not names a stack would pick by accident. */
const PROJECT_NETWORK_KEY = "opsifier_project_network";
const PROXY_NETWORK_KEY = "opsifier_proxy_network";

export interface OverrideChild {
  name: string;
  /** Services with their own networks stay on them. Those without have to be kept on `default`. */
  declaresNetworks: boolean;
  /** Set when the child runs on the host or another container's network, and cannot join a network. */
  networkMode: string | null;
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
 * Marks every child as the panel's, and puts it on the project's networks: the one other services
 * reach it on, and the one domains reach it on. Nothing the file says about the workload is changed.
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

/** Reads what the override needs from a Compose file that is known to parse. */
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
