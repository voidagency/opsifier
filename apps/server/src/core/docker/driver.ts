import type { Duplex } from "node:stream";

/**
 * The one way the panel talks to Docker. `DockerodeDriver` implements it against the socket and
 * `FakeDriver` simulates it in memory. Names are checked by both implementations before use.
 */
export interface DockerDriver {
  readonly kind: "dockerode" | "fake";

  /** Resolves when the daemon answers, rejects otherwise. */
  ping(): Promise<void>;

  swarmInfo(): Promise<SwarmInfo>;
  swarmInit(options: SwarmInitOptions): Promise<{ nodeId: string }>;

  listNetworks(): Promise<NetworkInfo[]>;
  /** Null when no network has this name. */
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  createNetwork(options: CreateNetworkOptions): Promise<NetworkInfo>;
  /** Removing a network that does not exist is not an error. */
  removeNetwork(name: string): Promise<void>;

  listServices(): Promise<ServiceInfo[]>;
  /** Null when no service has this name. */
  inspectService(name: string): Promise<ServiceInfo | null>;
  createService(spec: SwarmServiceSpec, options?: RegistryOptions): Promise<ServiceInfo>;
  updateService(name: string, spec: SwarmServiceSpec, options?: RegistryOptions): Promise<ServiceInfo>;
  /** Removing a service that does not exist is not an error. */
  removeService(name: string): Promise<void>;

  listTasks(filter?: { service?: string }): Promise<TaskInfo[]>;

  /** Yields lines until the logs end, the service goes away or `signal` aborts. */
  serviceLogs(name: string, options?: LogOptions): AsyncIterable<LogLine>;

  /** Attaches to a new process in a running task of the service. */
  execAttach(options: ExecOptions): Promise<ExecSession>;

  listVolumes(): Promise<VolumeInfo[]>;
  /** Null when no volume has this name. */
  inspectVolume(name: string): Promise<VolumeInfo | null>;
  createVolume(options: CreateVolumeOptions): Promise<VolumeInfo>;
  /** Removing a volume that does not exist is not an error. */
  removeVolume(name: string, options?: { force?: boolean }): Promise<void>;

  /** Pulls an image and reports progress. Rejects if `signal` aborts. */
  pullImage(ref: string, options?: PullOptions): Promise<void>;
  /** The TCP ports an image's configuration declares. Empty when the image isn't on this daemon. */
  imageExposedPorts(ref: string): Promise<number[]>;

  /** One sample for each running task of the service. */
  serviceStats(name: string, options?: { signal?: AbortSignal }): Promise<TaskStats[]>;

  /** Releases timers and connections held by the driver. */
  dispose(): Promise<void>;
}

export type SwarmState = "inactive" | "pending" | "active" | "error" | "locked";

export interface SwarmInfo {
  state: SwarmState;
  nodeId: string | null;
  /** The address other nodes reach this one on. */
  nodeAddr: string | null;
  isManager: boolean;
}

export interface SwarmInitOptions {
  advertiseAddr: string;
  listenAddr?: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  attachable: boolean;
  labels: Record<string, string>;
}

export interface CreateNetworkOptions {
  name: string;
  /** Defaults to `overlay`. */
  driver?: string;
  attachable?: boolean;
  labels?: Record<string, string>;
}

/** Docker's own wire format, because this is what `compileService` will produce. */
export interface SwarmServiceSpec {
  Name: string;
  Labels?: Record<string, string>;
  TaskTemplate: {
    ContainerSpec: {
      Image: string;
      Labels?: Record<string, string>;
      Command?: string[];
      Args?: string[];
      Env?: string[];
      Dir?: string;
      User?: string;
      Hostname?: string;
      TTY?: boolean;
      Mounts?: Array<{
        Type: "bind" | "volume" | "tmpfs";
        Source?: string;
        Target: string;
        ReadOnly?: boolean;
      }>;
      [key: string]: unknown;
    };
    Resources?: {
      Limits?: { NanoCPUs?: number; MemoryBytes?: number };
      Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
    };
    RestartPolicy?: {
      Condition?: "none" | "on-failure" | "any";
      Delay?: number;
      MaxAttempts?: number;
      Window?: number;
    };
    Placement?: { Constraints?: string[] };
    Networks?: Array<{ Target: string; Aliases?: string[] }>;
    ForceUpdate?: number;
    [key: string]: unknown;
  };
  Mode?: { Replicated?: { Replicas?: number }; Global?: Record<string, never> };
  UpdateConfig?: Record<string, unknown>;
  RollbackConfig?: Record<string, unknown>;
  EndpointSpec?: {
    Mode?: "vip" | "dnsrr";
    Ports?: Array<{
      Protocol?: "tcp" | "udp" | "sctp";
      TargetPort: number;
      PublishedPort?: number;
      PublishMode?: "ingress" | "host";
    }>;
  };
}

export interface RegistryOptions {
  registryAuth?: RegistryAuth;
}

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

export interface ServiceInfo {
  id: string;
  name: string;
  /** The Swarm object version. Updates are made against it. */
  version: number;
  spec: SwarmServiceSpec;
  createdAt: string;
  updatedAt: string;
}

export type TaskState =
  | "new"
  | "allocated"
  | "pending"
  | "assigned"
  | "accepted"
  | "preparing"
  | "ready"
  | "starting"
  | "running"
  | "complete"
  | "shutdown"
  | "failed"
  | "rejected"
  | "remove"
  | "orphaned";

export interface TaskInfo {
  id: string;
  serviceId: string;
  /** Empty for a task whose service has already gone. */
  serviceName: string;
  slot: number | null;
  nodeId: string | null;
  containerId: string | null;
  image: string;
  desiredState: TaskState;
  state: TaskState;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogOptions {
  follow?: boolean;
  /** Lines of history to start from. Defaults to 100. */
  tail?: number;
  /** Seconds since the epoch. */
  since?: number;
  timestamps?: boolean;
  signal?: AbortSignal;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
  /** RFC 3339, present when `timestamps` was requested. */
  timestamp?: string;
}

export interface ExecOptions {
  service: string;
  /** The task to run in. Without it, any running task of the service. */
  taskId?: string;
  /** Run as an argument vector: nothing here ever passes through a shell on the panel's side. */
  command: string[];
  tty?: boolean;
  env?: string[];
  user?: string;
  workingDir?: string;
  /** The terminal's size from the first byte, so programs do not start at 80x24 and jump. */
  consoleSize?: { columns: number; rows: number };
}

export interface ExecSession {
  stream: Duplex;
  resize(columns: number, rows: number): Promise<void>;
  /** The exit code once the process ends, or null when Docker does not report one. */
  exited(): Promise<number | null>;
  /**
   * Ends the process and whatever it started. Hanging up is not enough: with a TTY attached,
   * Docker leaves a process running after its client goes away. Only test doubles leave it out.
   */
  terminate?(): Promise<void>;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  createdAt: string | null;
}

export interface CreateVolumeOptions {
  name: string;
  driver?: string;
  /** Driver-specific options, such as binding a `local` volume to a host directory. */
  driverOptions?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface PullProgress {
  status: string;
  id?: string;
  current?: number;
  total?: number;
}

export interface PullOptions {
  registryAuth?: RegistryAuth;
  signal?: AbortSignal;
  onProgress?: (progress: PullProgress) => void;
}

export interface TaskStats {
  taskId: string;
  slot: number | null;
  containerId: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  readAt: string;
}

/** Everything a driver reports that the caller may want to act on. */
export class DockerDriverError extends Error {
  override readonly name = "DockerDriverError";

  constructor(
    message: string,
    /** The HTTP status from the Docker API, when there was one. */
    readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class InvalidDockerInputError extends DockerDriverError {}

// Docker requires service names to be valid DNS labels.
const SERVICE_NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$/;
const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const IMAGE_REFERENCE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

function assertMatches(pattern: RegExp, value: string, what: string): void {
  if (!pattern.test(value)) {
    throw new InvalidDockerInputError(`Invalid ${what}: ${JSON.stringify(value)}.`);
  }
}

export const assertServiceName = (name: string): void => assertMatches(SERVICE_NAME, name, "service name");
export const assertNetworkName = (name: string): void => assertMatches(NETWORK_NAME, name, "network name");
export const assertVolumeName = (name: string): void => assertMatches(VOLUME_NAME, name, "volume name");

export function assertImageReference(ref: string): void {
  assertMatches(IMAGE_REFERENCE, ref, "image reference");
  if (ref.length > 512) {
    throw new InvalidDockerInputError("Invalid image reference: too long.");
  }
}

export function assertServiceSpec(spec: SwarmServiceSpec): void {
  assertServiceName(spec.Name);
  assertImageReference(spec.TaskTemplate.ContainerSpec.Image);
}
