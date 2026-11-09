import type { SwarmServiceSpec } from "../core/docker";
import type { AddressChallenge } from "../features/opsifier-address/proxy-env";
import { renderProxyEnv } from "../features/server/proxy";
import { SHARED_NETWORK } from "../features/services/compile/names";

export const PANEL_SWARM_SERVICE = "opsifier";
export const PROXY_SWARM_SERVICE = "opsifier-traefik";
export const PROXY_IMAGE = "traefik:3";
export const PANEL_PORT = 3000;
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;
export { SHARED_NETWORK };

/** Marks what `setup` created, so it can tell our services from someone else's of the same name. */
export const MANAGED_LABEL = "opsifier.managed";
export const MANAGED_LABELS = { [MANAGED_LABEL]: "true" };

const SECOND = 1_000_000_000;
const SOCKET = "/var/run/docker.sock";

/** Stop-first: a replica publishes its host ports, so the next task cannot start until it has gone. */
const STOP_FIRST = { Parallelism: 1, Delay: 0, Order: "stop-first", MaxFailureRatio: 0 };

/** How long after a new panel task is running Swarm still counts a crash against the update. */
export const PANEL_UPDATE_MONITOR_SECONDS = 30;

/**
 * The way back from a panel that fails to start: nothing of ours is running by then, so it has to be
 * the daemon that rolls the service back. Never a rollback of a rollback, which would flap for ever.
 */
export const PANEL_UPDATE_CONFIG = {
  ...STOP_FIRST,
  FailureAction: "rollback",
  Monitor: PANEL_UPDATE_MONITOR_SECONDS * SECOND,
};
export const PANEL_ROLLBACK_CONFIG = {
  ...STOP_FIRST,
  FailureAction: "pause",
  Monitor: PANEL_UPDATE_MONITOR_SECONDS * SECOND,
};

export interface ServiceInputs {
  /** The panel's data directory, the same path inside and outside the containers. */
  dataDir: string;
  image: string;
  networkId: string;
}

const hostPort = (port: number) => ({
  Protocol: "tcp" as const,
  TargetPort: port,
  PublishedPort: port,
  PublishMode: "host" as const,
});

const MANAGER_ONLY = { Constraints: ["node.role==manager"] };
const ALWAYS_RESTART = { Condition: "any" as const, Delay: 5 * SECOND };

export interface ProxyInputs extends ServiceInputs {
  /** The server's address, when it has one, for the wildcard certificate. */
  addressChallenge?: AddressChallenge | null;
}

/** Traefik with no configuration of its own: its routes are the files the panel writes. */
export function proxyServiceSpec(input: ProxyInputs): SwarmServiceSpec {
  const directory = `${input.dataDir}/traefik`;
  return {
    Name: PROXY_SWARM_SERVICE,
    Labels: MANAGED_LABELS,
    TaskTemplate: {
      ContainerSpec: {
        Image: input.image,
        Env: renderProxyEnv({
          directory,
          email: null,
          trustAll: false,
          entries: [],
          userEnv: "",
          addressChallenge: input.addressChallenge,
        }),
        Mounts: [{ Type: "bind", Source: directory, Target: directory }],
      },
      Placement: MANAGER_ONLY,
      RestartPolicy: ALWAYS_RESTART,
      Networks: [{ Target: input.networkId }],
    },
    Mode: { Replicated: { Replicas: 1 } },
    UpdateConfig: { ...STOP_FIRST, FailureAction: "pause" },
    RollbackConfig: { ...STOP_FIRST, FailureAction: "pause" },
    EndpointSpec: { Ports: [hostPort(HTTP_PORT), hostPort(HTTPS_PORT)] },
  };
}

export interface PanelEnvironment {
  /** The overlay network's ranges, which is the only place Traefik's requests can come from. */
  trustedProxies: readonly string[];
  /** The address to show people, when it isn't the one Swarm advertises, as behind NAT. */
  serverIp?: string;
  /** Passed on when it was set, so the panel asks the same service `setup` did. */
  namesUrl?: string;
}

export function panelEnv(environment: PanelEnvironment): Record<string, string> {
  return {
    OPSIFIER_TRUSTED_PROXIES: environment.trustedProxies.join(","),
    ...(environment.serverIp === undefined ? {} : { OPSIFIER_SERVER_IP: environment.serverIp }),
    ...(environment.namesUrl === undefined ? {} : { OPSIFIER_NAMES_URL: environment.namesUrl }),
  };
}

/** The panel itself. Its image already says everything else about how to run it. */
export function panelServiceSpec(input: ServiceInputs & PanelEnvironment): SwarmServiceSpec {
  return {
    Name: PANEL_SWARM_SERVICE,
    Labels: MANAGED_LABELS,
    TaskTemplate: {
      ContainerSpec: {
        Image: input.image,
        Env: Object.entries(panelEnv(input)).map(([key, value]) => `${key}=${value}`),
        Mounts: [
          { Type: "bind", Source: SOCKET, Target: SOCKET },
          { Type: "bind", Source: input.dataDir, Target: input.dataDir },
        ],
        StopGracePeriod: 20 * SECOND,
      },
      Placement: MANAGER_ONLY,
      RestartPolicy: ALWAYS_RESTART,
      Networks: [{ Target: input.networkId }],
    },
    Mode: { Replicated: { Replicas: 1 } },
    UpdateConfig: PANEL_UPDATE_CONFIG,
    RollbackConfig: PANEL_ROLLBACK_CONFIG,
    EndpointSpec: { Ports: [hostPort(PANEL_PORT)] },
  };
}

type Container = SwarmServiceSpec["TaskTemplate"]["ContainerSpec"];
type EndpointPorts = NonNullable<NonNullable<SwarmServiceSpec["EndpointSpec"]>["Ports"]>;

function withEnv(container: Container, wanted: Record<string, string>): Container {
  const env = [...(container.Env ?? [])];
  for (const [key, value] of Object.entries(wanted)) {
    const entry = `${key}=${value}`;
    const index = env.findIndex((existing) => existing.startsWith(`${key}=`));
    if (index === -1) {
      env.push(entry);
    } else if (env[index] !== entry) {
      env[index] = entry;
    }
  }
  return { ...container, Env: env };
}

function withMounts(container: Container, wanted: NonNullable<Container["Mounts"]>): Container {
  const mounts = [...(container.Mounts ?? [])];
  for (const mount of wanted) {
    if (!mounts.some((existing) => existing.Source === mount.Source && existing.Target === mount.Target)) {
      mounts.push(mount);
    }
  }
  return { ...container, Mounts: mounts };
}

function withPorts(existing: EndpointPorts, wanted: EndpointPorts): EndpointPorts {
  const ports = [...existing];
  for (const port of wanted) {
    if (!ports.some((candidate) => candidate.PublishedPort === port.PublishedPort)) {
      ports.push(port);
    }
  }
  return ports;
}

/** Docker leaves zeros out of what it reports back, so only the fields we set are compared. */
function sameConfig(actual: Record<string, unknown> | undefined, wanted: Record<string, unknown>): boolean {
  return (
    actual !== undefined &&
    Object.entries(wanted).every(([key, value]) => (actual[key] ?? (value === 0 ? 0 : undefined)) === value)
  );
}

export interface Convergence {
  /** Docker reports its attachments by ID, so a name in `wanted` also needs the ID that matches. */
  networkId: string;
  networkName: string;
  /** What this service must have set. Anything else on it is left alone. */
  env?: Record<string, string>;
}

/**
 * Brings an existing service up to what `setup` needs, keeping everything else on it: networks the
 * panel joined it to, settings people changed, and above all its image, which only an update moves.
 * The result is the same object content when nothing had to change, so "up to date" is a comparison.
 */
export function converge(
  current: SwarmServiceSpec,
  desired: SwarmServiceSpec,
  { networkId, networkName, env }: Convergence,
): SwarmServiceSpec {
  let container = current.TaskTemplate.ContainerSpec;
  if (env !== undefined) {
    container = withEnv(container, env);
  }
  container = withMounts(container, desired.TaskTemplate.ContainerSpec.Mounts ?? []);

  const networks = [...(current.TaskTemplate.Networks ?? [])];
  if (!networks.some((network) => network.Target === networkId || network.Target === networkName)) {
    networks.push({ Target: networkId });
  }

  const ports = withPorts(current.EndpointSpec?.Ports ?? [], desired.EndpointSpec?.Ports ?? []);
  const update = sameConfig(current.UpdateConfig, desired.UpdateConfig ?? {})
    ? current.UpdateConfig
    : { ...current.UpdateConfig, ...desired.UpdateConfig };
  const rollback = sameConfig(current.RollbackConfig, desired.RollbackConfig ?? {})
    ? current.RollbackConfig
    : { ...current.RollbackConfig, ...desired.RollbackConfig };

  return {
    ...current,
    Labels: { ...current.Labels, ...MANAGED_LABELS },
    TaskTemplate: { ...current.TaskTemplate, ContainerSpec: container, Networks: networks },
    UpdateConfig: update,
    RollbackConfig: rollback,
    EndpointSpec: { ...current.EndpointSpec, Ports: ports },
  };
}
