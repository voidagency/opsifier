import { setTimeout as sleep } from "node:timers/promises";
import type { AppDeps } from "../../core/context";
import { type DockerDriver, DockerDriverError, type NetworkInfo, type ServiceInfo } from "../../core/docker";
import { projectNetworkName } from "../services/compile";

/** The Swarm service the installer creates to run Traefik. */
export const PROXY_SERVICE = "opsifier-traefik";

/** Creates the project's attachable overlay network unless it is already there. */
export async function ensureProjectNetwork(docker: DockerDriver, project: string): Promise<NetworkInfo> {
  const name = projectNetworkName(project);
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

type ProxyNetworks = NonNullable<ServiceInfo["spec"]["TaskTemplate"]["Networks"]>;

const attachments = (proxy: ServiceInfo): ProxyNetworks => proxy.spec.TaskTemplate.Networks ?? [];

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

/** Puts the proxy on a project network, unless it is already there or is not installed. */
export function joinProxyToNetwork(
  docker: DockerDriver,
  network: NetworkInfo,
  log: (line: string) => void,
): Promise<void> {
  return changeProxyNetworks(docker, (attached) => {
    if (attached.some((attachment) => isAttachedTo(attachment, network))) {
      return attached;
    }
    log(`Connecting the proxy to ${network.name}`);
    return [...attached, { Target: network.id }];
  });
}

function detachProxyFromNetwork(
  docker: DockerDriver,
  network: NetworkInfo,
  log: (line: string) => void,
): Promise<void> {
  return changeProxyNetworks(docker, (attached) => {
    if (!attached.some((attachment) => isAttachedTo(attachment, network))) {
      return attached;
    }
    log(`Disconnecting the proxy from ${network.name}`);
    return attached.filter((attachment) => !isAttachedTo(attachment, network));
  });
}

/**
 * Detaches the proxy and removes the network. Docker refuses while tasks are still shutting down
 * on it, so this keeps trying until the rollout timeout runs out.
 */
export async function removeProjectNetwork(
  deps: Pick<AppDeps, "docker" | "rollout">,
  project: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const name = projectNetworkName(project);
  const network = await deps.docker.inspectNetwork(name);
  if (network === null) {
    return;
  }
  await detachProxyFromNetwork(deps.docker, network, log);

  const deadline = performance.now() + deps.rollout.timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await deps.docker.removeNetwork(name);
      return;
    } catch (error) {
      if (!(error instanceof DockerDriverError) || performance.now() >= deadline) {
        throw error;
      }
    }
    await sleep(deps.rollout.pollMs, undefined, { signal });
  }
}
