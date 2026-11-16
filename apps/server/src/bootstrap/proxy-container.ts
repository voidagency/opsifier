import { setTimeout as sleep } from "node:timers/promises";
import {
  type DockerDriver,
  DockerDriverError,
  type NetworkInfo,
  type PlainContainerInfo,
  type PlainContainerSpec,
  type SwarmServiceSpec,
} from "../core/docker";

/**
 * The proxy, Traefik, runs as a plain container outside Swarm, kept up by Docker's restart policy. It
 * joins each project's network while it runs, so a project that comes or goes changes nothing for the
 * sites already served. As the Swarm service of earlier versions it had to be replaced for each new
 * network, and every site on the server stopped answering while it restarted.
 *
 * A container joined to a network this way keeps it across its own restarts and Docker's, with or
 * without the panel, and Swarm refuses to remove the network until the container has left it. A Swarm
 * task joined the same way does neither, and leaves a network behind on the node once the network is
 * removed: that is why the proxy is not a Swarm service any more.
 *
 * It is created on Docker's default bridge, which carries its published ports, and joins every other
 * network before it starts. With a Swarm network as its main one it could not start whenever nothing
 * else held that network on this node, as right after a reboot.
 */
export const PROXY_CONTAINER = "opsifier-traefik";
/** The Swarm service earlier versions ran the proxy as. `moveProxyOffSwarm` replaces it. */
export const LEGACY_PROXY_SERVICE = "opsifier-traefik";
/** Where the proxy being replaced waits, ready to come back if its successor does not stay up. */
const PREVIOUS_PROXY = "opsifier-traefik-previous";
/** Long enough for a request under way to end, short enough that the sites hardly notice. */
export const PROXY_STOP_SECONDS = 3;
export const PROXY_ROLE_LABEL = "opsifier.role";
/** Swarm's label on the containers of a service's tasks. */
const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";
/** Docker's default network, which every plain container is created on. */
const DEFAULT_BRIDGE = "bridge";

export interface ProxyTiming {
  pollMs: number;
  /** How long a new proxy has to stay up before the one it replaces is let go. */
  settleMs: number;
  /** How long the proxy's ports may take to be free once the one holding them is asked to stop. */
  freeMs: number;
}

const DEFAULT_TIMING: ProxyTiming = { pollMs: 500, settleMs: 5_000, freeMs: 60_000 };

type Log = (line: string) => void;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One change to the proxy at a time per Docker: each reads what the proxy is on, then changes it. */
const changes = new WeakMap<DockerDriver, Promise<unknown>>();

export function serializeProxyChange<T>(docker: DockerDriver, change: () => Promise<T>): Promise<T> {
  const next = (changes.get(docker) ?? Promise.resolve()).catch(() => undefined).then(change);
  changes.set(
    docker,
    next.catch(() => undefined),
  );
  return next;
}

const isOn = (proxy: PlainContainerInfo, network: Pick<NetworkInfo, "id" | "name">) =>
  proxy.networks.some((on) => on.id === network.id || on.name === network.name);

/**
 * Joins the proxy to these networks while it runs, unless it is on them already. False when there is no
 * proxy container: on a server whose proxy is still a Swarm service, the caller does it that way. Call it
 * inside `serializeProxyChange`.
 */
export async function connectProxyNow(
  docker: DockerDriver,
  networks: readonly NetworkInfo[],
  log: Log,
): Promise<boolean> {
  const proxy = await docker.inspectPlainContainer(PROXY_CONTAINER);
  if (proxy === null) {
    return false;
  }
  for (const network of networks) {
    if (!isOn(proxy, network)) {
      log(`Connecting the proxy to ${network.name}`);
      await docker.connectNetwork(network.id, PROXY_CONTAINER);
    }
  }
  return true;
}

/**
 * Takes the proxy off these networks while it runs, which has to come before removing them: Swarm
 * refuses to remove a network a container is still on. False when there is no proxy container, as
 * `connectProxyNow`. Call it inside `serializeProxyChange`.
 */
export async function disconnectProxyNow(
  docker: DockerDriver,
  networks: readonly NetworkInfo[],
  log: Log,
): Promise<boolean> {
  const proxy = await docker.inspectPlainContainer(PROXY_CONTAINER);
  if (proxy === null) {
    return false;
  }
  for (const network of networks) {
    if (isOn(proxy, network)) {
      log(`Disconnecting the proxy from ${network.name}`);
      await docker.disconnectNetwork(network.id, PROXY_CONTAINER);
    }
  }
  return true;
}

/** Starts it, then waits until it has stayed up for `settleMs`: Docker restarting it does not count. */
async function startAndSettle(docker: DockerDriver, name: string, timing: ProxyTiming): Promise<void> {
  await docker.startContainer(name);
  const started = await docker.inspectPlainContainer(name);
  const restarts = started?.restartCount ?? 0;
  const deadline = Date.now() + timing.settleMs;
  for (;;) {
    const now = await docker.inspectPlainContainer(name);
    if (now === null || now.state !== "running" || now.restartCount > restarts) {
      const exit = now?.exitCode === null || now?.exitCode === undefined ? "" : `, exit code ${now.exitCode}`;
      throw new DockerDriverError(
        `The proxy stopped right after it started (${now?.state ?? "gone"}${exit}).`,
        500,
      );
    }
    if (Date.now() >= deadline) {
      return;
    }
    await sleep(timing.pollMs);
  }
}

/** Creates the proxy from `spec` and waits until it stays up. For a server that has none yet. */
export function createProxy(
  docker: DockerDriver,
  spec: PlainContainerSpec,
  log: Log,
  timing: Partial<ProxyTiming> = {},
): Promise<void> {
  return serializeProxyChange(docker, async () => {
    log("Starting the proxy");
    await docker.createPlainContainer(spec);
    try {
      await startAndSettle(docker, spec.name, { ...DEFAULT_TIMING, ...timing });
    } catch (error) {
      await docker.stopContainer(spec.name).catch(() => undefined);
      await docker.removeContainer(spec.name).catch(() => undefined);
      throw error;
    }
  });
}

/** What the proxy was made from, as Docker reports it, to make the next one from. */
export function proxySpecOf(proxy: PlainContainerInfo): PlainContainerSpec {
  return {
    name: PROXY_CONTAINER,
    image: proxy.image,
    env: [...proxy.env],
    labels: { ...proxy.labels },
    binds: proxy.binds.map((bind) => ({ ...bind })),
    ports: [...proxy.ports],
    // The default bridge comes with every plain container: only the others are joined.
    networks: proxy.networks.map((network) => network.name).filter((name) => name !== DEFAULT_BRIDGE),
    stopTimeoutSeconds: PROXY_STOP_SECONDS,
  };
}

/**
 * Replaces the proxy with one made by `change` from the current one: it joins every network the current
 * one is on before it starts, the current one stops only then, and comes back if the new one does not
 * stay up. The sites stop answering for the few seconds between the two, as for any restart.
 */
export function replaceProxy(
  docker: DockerDriver,
  change: (spec: PlainContainerSpec) => PlainContainerSpec,
  log: Log,
  timing: Partial<ProxyTiming> = {},
): Promise<void> {
  return serializeProxyChange(docker, async () => {
    const settings = { ...DEFAULT_TIMING, ...timing };
    const current = await docker.inspectPlainContainer(PROXY_CONTAINER);
    if (current === null) {
      throw new DockerDriverError("The proxy's container is not on this server.", 404);
    }
    const spec = { ...change(proxySpecOf(current)), name: PROXY_CONTAINER };
    // A replacement that stopped halfway left its predecessor behind: the running one is what counts.
    const leftover = await docker.inspectPlainContainer(PREVIOUS_PROXY);
    if (leftover !== null && leftover.id !== current.id) {
      await docker.stopContainer(PREVIOUS_PROXY).catch(() => undefined);
      await docker.removeContainer(leftover.id);
    }

    await docker.renameContainer(PROXY_CONTAINER, PREVIOUS_PROXY);
    try {
      await docker.createPlainContainer(spec);
    } catch (error) {
      await docker.renameContainer(PREVIOUS_PROXY, PROXY_CONTAINER);
      throw error;
    }
    log("Stopping the proxy for its replacement");
    await docker.stopContainer(PREVIOUS_PROXY, { timeoutSeconds: PROXY_STOP_SECONDS });
    try {
      await startAndSettle(docker, PROXY_CONTAINER, settings);
    } catch (error) {
      log(`The new proxy did not stay up (${messageOf(error)}): the previous one comes back`);
      await docker.stopContainer(PROXY_CONTAINER, { timeoutSeconds: 0 }).catch(() => undefined);
      await docker.removeContainer(PROXY_CONTAINER).catch(() => undefined);
      await docker.renameContainer(PREVIOUS_PROXY, PROXY_CONTAINER);
      await docker.startContainer(PROXY_CONTAINER);
      throw error;
    }
    await docker.removeContainer(PREVIOUS_PROXY);
    log("The proxy is back");
  });
}

/** Waits until no container of the old proxy service runs any more, which frees the ports it held. */
async function waitForLegacyGone(docker: DockerDriver, timing: ProxyTiming): Promise<void> {
  const deadline = Date.now() + timing.freeMs;
  for (;;) {
    const containers = await docker.listContainers({ size: false });
    const holding = containers.some(
      (container) =>
        container.labels[SWARM_SERVICE_LABEL] === LEGACY_PROXY_SERVICE &&
        (container.state === "running" || container.state === "restarting"),
    );
    if (!holding) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new DockerDriverError("The proxy's Swarm service did not stop in time.", 500);
    }
    await sleep(timing.pollMs);
  }
}

/** Puts the Swarm service back as it was, for a move that did not work out. */
async function restoreLegacyService(
  docker: DockerDriver,
  spec: SwarmServiceSpec,
  timing: ProxyTiming,
): Promise<void> {
  const deadline = Date.now() + timing.freeMs;
  for (;;) {
    try {
      await docker.createService(spec);
      return;
    } catch (error) {
      // Swarm takes a moment to forget the removed service's name.
      if (!(error instanceof DockerDriverError) || Date.now() >= deadline) {
        throw error;
      }
    }
    await sleep(timing.pollMs);
  }
}

/** The container that takes over from the Swarm service: its image, settings, folder, ports and networks. */
export function proxySpecFromService(
  spec: SwarmServiceSpec,
  networks: readonly NetworkInfo[],
): PlainContainerSpec {
  const container = spec.TaskTemplate.ContainerSpec;
  const joined = (spec.TaskTemplate.Networks ?? [])
    .map((attachment) =>
      networks.find((network) => network.id === attachment.Target || network.name === attachment.Target),
    )
    .filter((network): network is NetworkInfo => network !== undefined && network.name !== "ingress");
  return {
    name: PROXY_CONTAINER,
    image: container.Image,
    env: [...(container.Env ?? [])],
    labels: { ...(spec.Labels ?? {}), [PROXY_ROLE_LABEL]: "proxy" },
    binds: (container.Mounts ?? [])
      .filter((mount) => mount.Type === "bind" && mount.Source !== undefined)
      .map((mount) => ({ source: mount.Source as string, target: mount.Target })),
    ports: (spec.EndpointSpec?.Ports ?? [])
      .map((port) => port.PublishedPort)
      .filter((port): port is number => port !== undefined),
    networks: joined.map((network) => network.name),
    stopTimeoutSeconds: PROXY_STOP_SECONDS,
  };
}

/**
 * Moves a proxy that runs as the Swarm service of earlier versions to a plain container with the same
 * image, settings, folder, ports and networks. The sites stop answering while the service stops and the
 * container starts, once; if the container does not stay up, the service comes back as it was. True
 * when there was a service to move.
 */
export function moveProxyOffSwarm(
  docker: DockerDriver,
  log: Log,
  timing: Partial<ProxyTiming> = {},
): Promise<boolean> {
  return serializeProxyChange(docker, async () => {
    const settings = { ...DEFAULT_TIMING, ...timing };
    const service = await docker.inspectService(LEGACY_PROXY_SERVICE);
    if (service === null) {
      return false;
    }
    const existing = await docker.inspectPlainContainer(PROXY_CONTAINER);
    if (existing?.state === "running") {
      // Both can't hold the ports: the container won, and the service is only a leftover.
      await docker.removeService(LEGACY_PROXY_SERVICE);
      return true;
    }
    if (existing !== null) {
      await docker.removeContainer(existing.id);
    }

    const spec = proxySpecFromService(service.spec, await docker.listNetworks());
    log(`Moving the proxy out of Swarm, with its ${spec.networks.length} networks`);
    await docker.createPlainContainer(spec);
    log("Stopping the proxy's Swarm service: the sites stop answering until the container is up");
    await docker.removeService(LEGACY_PROXY_SERVICE);
    try {
      await waitForLegacyGone(docker, settings);
      await startAndSettle(docker, PROXY_CONTAINER, settings);
    } catch (error) {
      log(`The proxy did not start as a container (${messageOf(error)}): its Swarm service comes back`);
      await docker.stopContainer(PROXY_CONTAINER, { timeoutSeconds: 0 }).catch(() => undefined);
      await docker.removeContainer(PROXY_CONTAINER).catch(() => undefined);
      await restoreLegacyService(docker, service.spec, settings);
      throw error;
    }
    log("The proxy runs as a container: a project now joins it without restarting it");
    return true;
  });
}
