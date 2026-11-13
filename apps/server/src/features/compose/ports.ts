import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { firstPortInUseByStack, type HostPort } from "../services/host-ports";
import { listServiceRecords } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { composeProject } from "./names";

/** The ports every server's platform holds: the proxy, the panel, Docker and Swarm. */
export function platformPorts(panelPort: number): Map<number, string> {
  return new Map<number, string>([
    [80, "the proxy"],
    [443, "the proxy"],
    [panelPort, "the panel"],
    [2375, "Docker's API"],
    [2376, "Docker's API"],
    [2377, "Swarm's cluster management"],
    [4789, "Swarm's overlay networks"],
    [7946, "Swarm's node discovery"],
  ]);
}

/**
 * Every host port something else already holds: the platform, and the saved services of every
 * project, stopped ones included since they will want theirs back. A service of another project
 * stays anonymous, so a conflict never says what that project holds.
 */
export function takenPorts(deps: Pick<AppDeps, "db" | "config">, target: ServiceTarget): Map<number, string> {
  const taken = platformPorts(deps.config.port);
  for (const record of listServiceRecords(deps.db)) {
    if (record.projectName === target.projectName && record.name === target.serviceName) {
      continue;
    }
    const owner = record.projectName === target.projectName ? `${record.projectName}/${record.name}` : "";
    for (const port of record.spec.ports) {
      taken.set(port.published, owner);
    }
    if (record.spec.database !== null && record.spec.database.exposedPort > 0) {
      taken.set(record.spec.database.exposedPort, owner);
    }
  }
  return taken;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `8080`, or a range such as `8000-8010`, kept to what a range can sensibly hold. */
function portRange(text: string): number[] {
  const [first, last = first] = text.split("-").map((part) => Number(part.trim()));
  if (!Number.isInteger(first) || !Number.isInteger(last) || first === undefined || last === undefined) {
    return [];
  }
  if (first < 1 || last > 65_535 || last < first || last - first > 1024) {
    return [];
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** The host ports one `ports` entry publishes, in the long form Compose resolves to or the short one. */
function publishedBy(entry: unknown): HostPort[] {
  if (isRecord(entry)) {
    const protocol = entry.protocol === "udp" ? "udp" : "tcp";
    const published = entry.published;
    if (published === undefined || published === null || published === "") {
      return [];
    }
    return portRange(String(published)).map((port) => ({ protocol, port }));
  }
  const text = String(entry);
  const [mapping = "", protocolText] = text.split("/");
  const protocol = protocolText === "udp" ? "udp" : "tcp";
  // [ip:]host:container: the host part is the one before the last colon.
  const parts = mapping.split(":");
  if (parts.length < 2) {
    return [];
  }
  return portRange(parts[parts.length - 2] ?? "").map((port) => ({ protocol, port }));
}

/** Every host port the services of a configuration Compose resolved publish. */
export function resolvedHostPorts(config: Record<string, unknown>): HostPort[] {
  const services = isRecord(config.services) ? config.services : {};
  return Object.values(services).flatMap((service) =>
    isRecord(service) && Array.isArray(service.ports) ? service.ports.flatMap(publishedBy) : [],
  );
}

const portTaken = (port: number, holder: string) =>
  conflict(
    "port_taken",
    `Port ${port} is already used on this server${holder === "" ? "" : ` by ${holder}`}. Publish another port, or reach the stack through a domain.`,
  );

/**
 * Refuses, before anything starts, a host port something else holds: Docker would only find out by
 * failing to bind, or worse, take it while its holder is stopped and keep it from coming back. What
 * the stack's own containers hold is its own.
 */
export async function assertStackPortsFree(
  deps: AppDeps,
  target: ServiceTarget,
  wanted: readonly HostPort[],
): Promise<void> {
  if (wanted.length === 0) {
    return;
  }
  const taken = takenPorts(deps, target);
  for (const { port } of wanted) {
    const holder = taken.get(port);
    if (holder !== undefined) {
      throw portTaken(port, holder);
    }
  }
  const live = await firstPortInUseByStack(deps, composeProject(target), wanted);
  if (live !== null) {
    throw portTaken(live.port, "");
  }
}
