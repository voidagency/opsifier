import type { AppDeps } from "../../core/context";
import type { ServiceInfo } from "../../core/docker";
import { helperImage } from "../server/disk";
import { qualifiedName } from "./compile";
import type { ServiceTarget } from "./service";

export interface HostPort {
  protocol: "tcp" | "udp";
  port: number;
}

/** Thrown when a host port a service needs is taken, by anything at all. Nothing has been replaced. */
export class PortInUseError extends Error {
  override readonly name = "PortInUseError";
}

const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";
const key = ({ protocol, port }: HostPort) => `${protocol}:${port}`;

/** What Docker has publishing a service's ports, in the terms the rest of this file compares. */
function publishedBy(service: ServiceInfo): HostPort[] {
  return (service.spec.EndpointSpec?.Ports ?? []).flatMap((entry) =>
    entry.PublishedPort === undefined
      ? []
      : [
          {
            protocol: entry.Protocol === "udp" ? ("udp" as const) : ("tcp" as const),
            port: entry.PublishedPort,
          },
        ],
  );
}

const PROC_NET_LISTENING_TCP = "0A";

/** `/proc/net/{tcp,udp}{,6}` holds one socket per line: `sl  address:port  remote  state ...`, in hex. */
export function parseProcNet(protocol: HostPort["protocol"], text: string): HostPort[] {
  return text.split("\n").flatMap((line): HostPort[] => {
    const [, local, , state] = line.trim().split(/\s+/);
    const port = Number.parseInt(local?.split(":")[1] ?? "", 16);
    if (Number.isNaN(port) || port <= 0 || (protocol === "tcp" && state !== PROC_NET_LISTENING_TCP)) {
      return [];
    }
    return [{ protocol, port }];
  });
}

/** Marks where one `/proc/net` file ends and the next begins, in one helper's output. */
const SECTION = "--- ";

/** Every socket listening on the host itself. Null when there is nothing to read it with. */
async function hostListeners(deps: Pick<AppDeps, "config" | "docker">): Promise<HostPort[] | null> {
  const image = await helperImage(deps);
  if (image === null) {
    return null;
  }
  const { exitCode, stdout } = await deps.docker.runHelper({
    image,
    hostNetwork: true,
    command: [
      "sh",
      "-c",
      `for f in tcp tcp6 udp udp6; do echo "${SECTION}$f"; cat /proc/net/$f 2>/dev/null; done`,
    ],
  });
  if (exitCode !== 0) {
    return null;
  }
  return stdout.split(SECTION).flatMap((section) => {
    const [name = "", ...rest] = section.split("\n");
    return name === "" ? [] : parseProcNet(name.startsWith("udp") ? "udp" : "tcp", rest.join("\n"));
  });
}

/**
 * The first of these host ports already held by something other than this service: another Swarm
 * service, a container Docker alone runs, or a process on the host. Whichever of them Docker would
 * only have discovered by failing to bind, with the service already stopped.
 */
export async function firstPortInUse(
  deps: Pick<AppDeps, "config" | "docker">,
  target: ServiceTarget,
  wanted: readonly HostPort[],
): Promise<HostPort | null> {
  if (wanted.length === 0) {
    return null;
  }
  const self = qualifiedName(target.projectName, target.serviceName);
  const [services, containers] = await Promise.all([
    deps.docker.listServices(),
    deps.docker.listContainers({ size: false }),
  ]);

  const own = services.find((service) => service.name === self);
  const running = own !== undefined && (own.spec.Mode?.Replicated?.Replicas ?? 0) > 0;
  // A task's own port looks like anybody else's from the outside.
  const mine = new Set(running ? publishedBy(own).map(key) : []);

  const held = new Set([
    ...services
      .filter((service) => service.name !== self)
      .flatMap(publishedBy)
      .map(key),
    ...containers
      .filter((container) => container.labels[SWARM_SERVICE_LABEL] !== self)
      .flatMap((container) => container.ports ?? [])
      .map(key),
    ...((await hostListeners(deps).catch(() => null)) ?? []).map(key),
  ]);
  return wanted.find((port) => held.has(key(port)) && !mine.has(key(port))) ?? null;
}
