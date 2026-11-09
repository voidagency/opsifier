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
  /** Leaves the swarm this node is in. Refused while it manages services, unless `force` is set. */
  swarmLeave(options?: { force?: boolean }): Promise<void>;
  /** What this swarm holds besides services and networks. */
  swarmContents(): Promise<SwarmContents>;

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
  /** The same for one container, which is what a Compose stack's children are. */
  containerLogs(id: string, options?: LogOptions): AsyncIterable<LogLine>;

  /** Attaches to a new process in a running task of the service. */
  execAttach(options: ExecOptions): Promise<ExecSession>;
  /**
   * Ends the process started with this marker and everything it started, for when the session object
   * that could have done it died with an earlier process of the panel. Nothing else in the container is
   * touched. A task or container that is no longer there means there is nothing left to end, which is
   * not an error; only a daemon that could not be asked rejects.
   */
  terminateExec(options: ExecTarget & { marker: string }): Promise<void>;
  /**
   * What Docker remembers about a process started by `execAttach`, however long ago and by whichever
   * run of the panel. Null once it has forgotten, as it does a few minutes after the process ended,
   * or as soon as its container is gone. Only a daemon that could not be asked rejects.
   */
  inspectExec(id: string): Promise<ExecState | null>;

  listVolumes(): Promise<VolumeInfo[]>;
  /** Null when no volume has this name. */
  inspectVolume(name: string): Promise<VolumeInfo | null>;
  createVolume(options: CreateVolumeOptions): Promise<VolumeInfo>;
  /** Removing a volume that does not exist is not an error. */
  removeVolume(name: string, options?: { force?: boolean }): Promise<void>;

  /** Pulls an image and reports progress. Rejects if `signal` aborts. */
  pullImage(ref: string, options?: PullOptions): Promise<void>;
  /** Null when this image is not on the daemon. */
  inspectImage(ref: string): Promise<ImageDetail | null>;
  /** Gives an image already on this daemon one more name. */
  tagImage(ref: string, target: string): Promise<void>;
  /** The TCP ports an image's configuration declares. Empty when the image isn't on this daemon. */
  imageExposedPorts(ref: string): Promise<number[]>;

  /** One sample for each running task of the service. */
  serviceStats(name: string, options?: { signal?: AbortSignal }): Promise<TaskStats[]>;

  /** Containers Docker Compose started, of every stack or of one. Cheap enough to poll. */
  listComposeContainers(project?: string): Promise<ComposeContainerInfo[]>;
  /** One sample of a container, or null once it has gone. */
  containerStats(id: string, options?: { signal?: AbortSignal }): Promise<TaskStats | null>;

  /** What the engine says about itself. */
  engineInfo(): Promise<EngineInfo>;
  /** Yields daemon events until `signal` aborts or the connection ends. */
  events(options?: EngineEventOptions): AsyncIterable<EngineEvent>;
  /** What Docker holds on disk, by kind. Slow: the daemon adds up every volume to answer. */
  diskUsage(options?: { signal?: AbortSignal }): Promise<EngineDiskUsage>;
  /** Only the build cache, which the daemon can answer without measuring anything else. */
  listBuildCache(options?: { signal?: AbortSignal }): Promise<BuildCacheRecord[]>;
  listImages(): Promise<ImageInfo[]>;
  /** Measuring each container's size is what makes this slow. Leave it out when nobody needs it. */
  listContainers(options?: { size?: boolean }): Promise<ContainerInfo[]>;
  /** Removing an image that does not exist is not an error. One still in use is. */
  removeImage(id: string): Promise<void>;
  /** Removing a container that does not exist is not an error. */
  removeContainer(id: string): Promise<void>;
  /** Removes these build cache records and returns how many bytes that freed. */
  removeBuildCache(ids: readonly string[]): Promise<number>;
  /** Runs a one-off helper container to the end and returns what it printed. */
  runHelper(options: HelperOptions): Promise<HelperResult>;
  /** Starts a helper container with a terminal attached. Ending the session removes the container. */
  openHelper(
    options: HelperOptions & { consoleSize?: { columns: number; rows: number } },
  ): Promise<ExecSession>;
  /** Removes every helper container there is, running or not, and says how many it removed. */
  removeLeftoverHelpers(): Promise<number>;

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

export interface SwarmContents {
  nodes: number;
  secrets: number;
  configs: number;
}

export interface SwarmInitOptions {
  /** Without it Docker picks the address itself, and refuses if the host leaves that ambiguous. */
  advertiseAddr?: string;
  listenAddr?: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  attachable: boolean;
  labels: Record<string, string>;
  /** The address ranges Docker allocated for it, as CIDRs. */
  subnets?: string[];
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
        VolumeOptions?: { Labels?: Record<string, string> };
      }>;
      [key: string]: unknown;
    };
    Resources?: {
      Limits?: { NanoCPUs?: number; MemoryBytes?: number; Pids?: number };
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
  /** The task's CPU limit in cores. Left out when it has none. */
  cpuLimitCores?: number;
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

/** The place an exec runs. */
export interface ExecTarget {
  service: string;
  /** The task to run in. Without it, any running task of the service. */
  taskId?: string;
  /** Runs in this container instead of a task, for a Compose stack whose children have no tasks. */
  containerId?: string;
}

export interface ExecOptions extends ExecTarget {
  /** Run as an argument vector: nothing here ever passes through a shell on the panel's side. */
  command: string[];
  /** Set for a process that a later run of the panel must be able to end with `terminateExec`. */
  marker?: string;
  tty?: boolean;
  env?: string[];
  user?: string;
  workingDir?: string;
  /** The terminal's size from the first byte, so programs do not start at 80x24 and jump. */
  consoleSize?: { columns: number; rows: number };
}

/** A process Docker started with `execAttach`. */
export interface ExecState {
  running: boolean;
  /** Null while it is running, and when Docker never learned how it ended. */
  exitCode: number | null;
}

export interface ExecSession {
  /** Docker's own id for this process, for asking about it later. Only test doubles leave it out. */
  id?: string;
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

export interface ImageDetail {
  /** The user the image runs as, as its USER line has it. Empty means root. */
  user: string;
  id: string;
  /** Registry digests, such as `repo@sha256:...`. Empty for an image that never saw a registry. */
  digests: string[];
  sizeBytes: number;
  labels: Record<string, string>;
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

/** Docker leaves figures out while a container starts or dies. Those are null, never zero. */
export interface TaskStats {
  taskId: string;
  slot: number | null;
  containerId: string;
  cpuPercent: number | null;
  /** What `cpuPercent` can reach for this task: 100 per core it may use. */
  cpuCapacityPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
  readAt: string;
}

export interface EngineInfo {
  version: string;
  apiVersion: string;
  operatingSystem: string;
  kernelVersion: string;
  cores: number;
  memoryBytes: number;
  rootDir: string;
  swarm: SwarmState;
  /** False when the daemon's answer has no Swarm section at all, as on an engine built without it. */
  swarmAvailable: boolean;
  /** Whether this node can issue Swarm commands, which only a manager can. */
  swarmManager: boolean;
  /** The network and volume drivers the daemon says it has. Empty when it doesn't say. */
  networkDrivers: string[];
  volumeDrivers: string[];
}

export interface EngineEventOptions {
  /** Seconds since the epoch: start from this point in the daemon's history. */
  since?: number;
  signal?: AbortSignal;
}

export interface EngineEvent {
  type: string;
  action: string;
  actorId: string;
  attributes: Record<string, string>;
  scope: string | null;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface BuildCacheRecord {
  id: string;
  sizeBytes: number;
  inUse: boolean;
  shared: boolean;
  description: string;
  lastUsedAt: string | null;
}

export interface EngineDiskUsage {
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
  buildCache: BuildCacheRecord[];
}

export interface ImageInfo {
  id: string;
  /** Repository tags. Empty for a dangling image. */
  tags: string[];
  sizeBytes: number;
  labels: Record<string, string>;
  createdAt: string | null;
}

export interface ContainerInfo {
  id: string;
  /** Without the leading slash. */
  name: string;
  image: string;
  imageId: string;
  state: string;
  labels: Record<string, string>;
  sizeBytes: number | null;
  /** The host ports it holds. Only a running container has any. */
  ports?: Array<{ protocol: "tcp" | "udp"; port: number }>;
}

/** A container Docker Compose started: what a stack's state is read from. */
export interface ComposeContainerInfo {
  id: string;
  /** Without the leading slash. */
  name: string;
  image: string;
  /** The Compose project, which is the service's qualified name. */
  project: string;
  /** The name of the child in the Compose file. */
  child: string;
  /** Which replica of the child this is. */
  number: number;
  state: string;
  /** Docker's own sentence, such as `Up 3 minutes (healthy)` or `Exited (137) 2 minutes ago`. */
  status: string;
  /** Parsed from `status`. Null while the container has not exited. */
  exitCode: number | null;
  health: "healthy" | "unhealthy" | "starting" | null;
  /** Published ports, as `8080:80/tcp`. */
  ports: string[];
  /** Left out by simulations that have none to report. */
  labels?: Record<string, string>;
  /** The networks it is attached to, by name. Left out by simulations that have none to report. */
  networks?: string[];
}

export interface HelperOptions {
  image: string;
  /** Run as an argument vector. Nothing here passes through a shell on the panel's side. */
  command: string[];
  binds?: string[];
  privileged?: boolean;
  hostPid?: boolean;
  hostNetwork?: boolean;
  signal?: AbortSignal;
}

export interface HelperResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
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

/** A command that was refused because this daemon can't run it. Nothing was sent to Docker. */
export class DockerUnsupportedError extends DockerDriverError {
  constructor(message: string) {
    super(message, 503);
  }
}

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
