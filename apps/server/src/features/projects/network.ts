import { setTimeout as sleep } from "node:timers/promises";
import { isDatabaseEngine } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { type DockerDriver, DockerDriverError, type NetworkInfo, type ServiceInfo } from "../../core/docker";
import { conflict } from "../../core/errors";
import { projectNetworkName, projectProxyNetworkName, SHARED_NETWORK } from "../services/compile";
import { listProjects } from "./repo";

/** The Swarm service the installer creates to run Traefik. */
export const PROXY_SERVICE = "opsifier-traefik";

/** Said by every refusal at a project's boundary, because it is the part someone can act on. */
export const SUPPORTED_WAY =
  "To use a database from another project, publish its port on its Expose tab and connect through the server's address, or run both in one project.";

export const foreignNetworkRefusal = (network: string) =>
  conflict(
    "compose_foreign_network",
    `This stack uses ${network}, a network its project does not own: a project only joins its own, so that one project can't reach into another. Remove it from the file. ${SUPPORTED_WAY}`,
  );

async function ensureNetwork(docker: DockerDriver, name: string, project: string): Promise<NetworkInfo> {
  const existing = await docker.inspectNetwork(name);
  if (existing !== null) {
    return existing;
  }
  try {
    return await docker.createNetwork({
      name,
      driver: "overlay",
      attachable: true,
      labels: { "opsifier.project": project },
    });
  } catch (error) {
    // Two deploys can race to create it. Whichever loses just uses the winner's network.
    const again =
      error instanceof DockerDriverError && error.statusCode === 409
        ? await docker.inspectNetwork(name)
        : null;
    if (again === null) {
      throw error;
    }
    return again;
  }
}

/** The project's network: what its services talk to each other over, and all a database ever joins. */
export const ensureProjectNetwork = (docker: DockerDriver, project: string): Promise<NetworkInfo> =>
  ensureNetwork(docker, projectNetworkName(project), project);

/** The network the proxy reaches the project's routed workloads on, and holds nothing else. */
export const ensureProxyNetwork = (docker: DockerDriver, project: string): Promise<NetworkInfo> =>
  ensureNetwork(docker, projectProxyNetworkName(project), project);

type ProxyNetworks = NonNullable<ServiceInfo["spec"]["TaskTemplate"]["Networks"]>;

const attachments = (service: ServiceInfo): ProxyNetworks => service.spec.TaskTemplate.Networks ?? [];

/** Docker reports attachments by ID, while a spec may name the network: either can match. */
const isAttachedTo = (attachment: ProxyNetworks[number], network: Pick<NetworkInfo, "id" | "name">) =>
  attachment.Target === network.id || attachment.Target === network.name;

/** One change at a time per Docker: each one reads the proxy's network list and writes it back. */
const proxyChanges = new WeakMap<DockerDriver, Promise<unknown>>();

function serializeProxyChange<T>(docker: DockerDriver, change: () => Promise<T>): Promise<T> {
  const next = (proxyChanges.get(docker) ?? Promise.resolve()).catch(() => undefined).then(change);
  proxyChanges.set(
    docker,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Rewrites the proxy's network list and updates the service only if it changed. Attachments to
 * networks that no longer exist are dropped first, because Docker refuses any update that keeps one.
 */
function changeProxyNetworks(
  docker: DockerDriver,
  change: (attached: ProxyNetworks) => ProxyNetworks,
): Promise<void> {
  return serializeProxyChange(docker, async () => {
    const proxy = await docker.inspectService(PROXY_SERVICE);
    if (proxy === null) {
      return;
    }
    const existing = await docker.listNetworks();
    const current = attachments(proxy);
    const live = current.filter((attachment) =>
      existing.some((network) => isAttachedTo(attachment, network)),
    );
    const next = change(live);
    const unchanged =
      next.length === current.length &&
      next.every((attachment, index) => attachment.Target === current[index]?.Target);
    if (!unchanged) {
      await docker.updateService(PROXY_SERVICE, {
        ...proxy.spec,
        TaskTemplate: { ...proxy.spec.TaskTemplate, Networks: next },
      });
    }
  });
}

/** Puts the proxy on these networks, in one change, unless it is already on them or is not installed. */
export function joinProxyToNetworks(
  docker: DockerDriver,
  networks: readonly NetworkInfo[],
  log: (line: string) => void,
): Promise<void> {
  return changeProxyNetworks(docker, (attached) => {
    const missing = networks.filter(
      (network) => !attached.some((attachment) => isAttachedTo(attachment, network)),
    );
    for (const { name } of missing) {
      log(`Connecting the proxy to ${name}`);
    }
    return missing.length === 0 ? attached : [...attached, ...missing.map(({ id }) => ({ Target: id }))];
  });
}

function detachProxyFromNetworks(
  docker: DockerDriver,
  networks: readonly NetworkInfo[],
  log: (line: string) => void,
): Promise<void> {
  return changeProxyNetworks(docker, (attached) =>
    attached.filter((attachment) => {
      const network = networks.find((candidate) => isAttachedTo(attachment, candidate));
      if (network !== undefined) {
        log(`Disconnecting the proxy from ${network.name}`);
      }
      return network === undefined;
    }),
  );
}

/**
 * Both networks of a project, with the proxy on the one that is meant for it. Every other project's
 * proxy network comes along, because each change to the proxy's networks restarts it: a server
 * moving to proxy networks takes that once, at its first deployment, and not once per project.
 */
export async function prepareRoutedNetworks(
  deps: Pick<AppDeps, "docker" | "db">,
  project: string,
  log: (line: string) => void,
): Promise<void> {
  const { docker } = deps;
  await ensureProjectNetwork(docker, project);
  const own = await ensureProxyNetwork(docker, project);
  const known = await docker.listNetworks();
  const others = await Promise.all(
    listProjects(deps.db)
      .filter(({ name }) => name !== project)
      .map(({ name }) => {
        const existing = known.find((network) => network.name === projectProxyNetworkName(name));
        // Another project's network is no reason to fail this deployment: its own will see to it.
        return existing ?? ensureProxyNetwork(docker, name).catch(() => null);
      }),
  );
  await joinProxyToNetworks(docker, [own, ...others.filter((network) => network !== null)], log);
}

/** Whether this service still sits on the network databases used to share with the panel. */
export async function isOnSharedNetwork(docker: DockerDriver, service: ServiceInfo): Promise<boolean> {
  const shared = await docker.inspectNetwork(SHARED_NETWORK);
  return shared !== null && attachments(service).some((attachment) => isAttachedTo(attachment, shared));
}

/**
 * Anything of this project the proxy may route to that it could only reach over the project's own
 * network. A workload deployed before the proxy had a network of its own stays like that until its
 * next deployment, and Swarm gives a service no new network without replacing its tasks.
 */
async function hasWorkloadOutOfProxyReach(
  docker: DockerDriver,
  project: string,
  network: NetworkInfo,
  proxyNetwork: NetworkInfo | null,
): Promise<boolean> {
  const services = await docker.listServices();
  const stranded = services.some((service) => {
    const labels = service.spec.Labels ?? {};
    return (
      labels["opsifier.project"] === project &&
      !isDatabaseEngine(labels["opsifier.type"] ?? "") &&
      attachments(service).some((attachment) => isAttachedTo(attachment, network)) &&
      !(
        proxyNetwork !== null &&
        attachments(service).some((attachment) => isAttachedTo(attachment, proxyNetwork))
      )
    );
  });
  if (stranded) {
    return true;
  }
  const containers = await docker.listComposeContainers();
  return containers.some(
    (container) =>
      container.project.split("_", 1)[0] === project &&
      container.networks?.includes(network.name) === true &&
      !(proxyNetwork !== null && container.networks.includes(proxyNetwork.name)),
  );
}

/**
 * Takes the proxy off a project's own network once nothing there needs it, which is what makes the
 * two networks really separate. Until then a project deployed before the proxy had a network of its
 * own keeps working as it did. New projects never have the proxy on that network to begin with.
 */
export async function releaseProxyFromProjectNetwork(
  docker: DockerDriver,
  project: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const network = await docker.inspectNetwork(projectNetworkName(project));
    if (network === null) {
      return;
    }
    const proxyNetwork = await docker.inspectNetwork(projectProxyNetworkName(project));
    if (!(await hasWorkloadOutOfProxyReach(docker, project, network, proxyNetwork))) {
      await detachProxyFromNetworks(docker, [network], log);
    }
  } catch (error) {
    // The workload it was checked for is deployed, and the next deployment looks again.
    log(`Could not settle the proxy's networks: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Keeps trying until the rollout timeout runs out, because Docker refuses while tasks are still
 * shutting down on the network, then waits until it has really gone.
 */
async function removeNetworkWhenFree(
  deps: Pick<AppDeps, "docker" | "rollout">,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + deps.rollout.timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await deps.docker.removeNetwork(name);
      break;
    } catch (error) {
      if (!(error instanceof DockerDriverError) || performance.now() >= deadline) {
        throw error;
      }
    }
    await sleep(deps.rollout.pollMs, undefined, { signal });
  }
  // Docker goes on describing a network for a few seconds after deleting it. A new project of the
  // same name would take that for its own network and then fail, when the deployment finds it isn't.
  while ((await deps.docker.inspectNetwork(name)) !== null && performance.now() < deadline) {
    signal?.throwIfAborted();
    await sleep(deps.rollout.pollMs, undefined, { signal });
  }
}

/** Detaches the proxy from both of the project's networks, in one change, and removes them. */
export async function removeProjectNetwork(
  deps: Pick<AppDeps, "docker" | "rollout">,
  project: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const found = await Promise.all(
    [projectNetworkName(project), projectProxyNetworkName(project)].map((name) =>
      deps.docker.inspectNetwork(name),
    ),
  );
  const networks = found.filter((network): network is NetworkInfo => network !== null);
  if (networks.length === 0) {
    return;
  }
  await detachProxyFromNetworks(deps.docker, networks, log);
  for (const { name } of networks) {
    await removeNetworkWhenFree(deps, name, signal);
  }
}
