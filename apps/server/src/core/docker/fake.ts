import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import {
  assertImageReference,
  assertNetworkName,
  assertServiceName,
  assertServiceSpec,
  assertVolumeName,
  type CreateNetworkOptions,
  type CreateVolumeOptions,
  type DockerDriver,
  DockerDriverError,
  type ExecOptions,
  type ExecSession,
  type LogLine,
  type LogOptions,
  type NetworkInfo,
  type PullOptions,
  type RegistryOptions,
  type ServiceInfo,
  type SwarmInfo,
  type SwarmInitOptions,
  type SwarmServiceSpec,
  type TaskInfo,
  type TaskState,
  type TaskStats,
  type VolumeInfo,
} from "./driver";

/** The order a healthy task moves through, one step per tick. */
const STARTUP: readonly TaskState[] = [
  "new",
  "pending",
  "assigned",
  "accepted",
  "preparing",
  "starting",
  "running",
];
const MAX_LOG_LINES = 1000;
const DEFAULT_TAIL = 100;

interface FakeTask extends TaskInfo {
  /** Set while the task is being replaced or removed. */
  stopping: boolean;
}

/** One exec session, so tests can see what was run and whether it was closed. */
export interface FakeExec {
  options: ExecOptions;
  stream: Duplex;
  resizes: Array<{ columns: number; rows: number }>;
  terminated: boolean;
}

interface FakeService extends ServiceInfo {
  tasks: FakeTask[];
  logs: LogLine[];
  /** Called with each new line, and with nothing when the service goes away. */
  listeners: Set<(line?: LogLine) => void>;
}

export interface FakeDriverOptions {
  /** How often tasks advance a state. */
  tickMs?: number;
  /** Whether the node already belongs to a swarm. Defaults to true, as after the installer. */
  swarmActive?: boolean;
  nodeAddr?: string;
}

type Operation = Exclude<keyof DockerDriver, "kind">;

/**
 * An in-memory Docker: services get tasks that move through Swarm's states, produce logs and
 * can be exec'd into. `OPSIFIER_DRIVER=fake` uses it in development and tests.
 */
export class FakeDriver implements DockerDriver {
  readonly kind = "fake";

  private readonly tickMs: number;
  private readonly nodeAddr: string;
  private readonly nodeId = randomUUID();
  private swarmState: SwarmInfo["state"];
  private readonly networks = new Map<string, NetworkInfo>();
  private readonly services = new Map<string, FakeService>();
  private readonly volumes = new Map<string, VolumeInfo>();
  private readonly pulledImages = new Set<string>();
  private readonly failures = new Map<Operation, Error>();
  private timer: NodeJS.Timeout | undefined;

  /** Every exec session started so far, oldest first. */
  readonly execs: FakeExec[] = [];

  constructor(options: FakeDriverOptions = {}) {
    this.tickMs = options.tickMs ?? 250;
    this.nodeAddr = options.nodeAddr ?? "203.0.113.10";
    this.swarmState = options.swarmActive === false ? "inactive" : "active";
    if (this.swarmState === "active") {
      this.addSwarmNetworks();
    }
  }

  /** Makes the next call to `operation` reject, to exercise failure paths. */
  failNext(operation: Operation, error: Error = new DockerDriverError(`${operation} failed`, 500)): void {
    this.failures.set(operation, error);
  }

  /** Adds a line to a service's logs, as if one of its tasks had printed it. */
  writeLog(name: string, line: string, stream: LogLine["stream"] = "stdout"): void {
    this.appendLog(this.requireService(name), stream, line);
  }

  /** Advances every task one state without waiting for the timer. */
  advance(steps = 1): void {
    for (let step = 0; step < steps; step += 1) {
      this.tick();
    }
  }

  async ping(): Promise<void> {
    this.check("ping");
  }

  async swarmInfo(): Promise<SwarmInfo> {
    this.check("swarmInfo");
    const active = this.swarmState === "active";
    return {
      state: this.swarmState,
      nodeId: active ? this.nodeId : null,
      nodeAddr: active ? this.nodeAddr : null,
      isManager: active,
    };
  }

  async swarmInit(_options: SwarmInitOptions): Promise<{ nodeId: string }> {
    this.check("swarmInit");
    if (this.swarmState === "active") {
      throw new DockerDriverError("This node is already part of a swarm.", 503);
    }
    this.swarmState = "active";
    this.addSwarmNetworks();
    return { nodeId: this.nodeId };
  }

  async listNetworks(): Promise<NetworkInfo[]> {
    this.check("listNetworks");
    return [...this.networks.values()].map((network) => ({ ...network }));
  }

  async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    this.check("inspectNetwork");
    assertNetworkName(name);
    const network = this.networks.get(name);
    return network === undefined ? null : { ...network };
  }

  async createNetwork(options: CreateNetworkOptions): Promise<NetworkInfo> {
    this.check("createNetwork");
    assertNetworkName(options.name);
    this.requireSwarm();
    if (this.networks.has(options.name)) {
      throw new DockerDriverError(`network with name ${options.name} already exists`, 409);
    }
    const network: NetworkInfo = {
      id: randomUUID(),
      name: options.name,
      driver: options.driver ?? "overlay",
      scope: "swarm",
      attachable: options.attachable ?? false,
      labels: options.labels ?? {},
    };
    this.networks.set(options.name, network);
    return { ...network };
  }

  async removeNetwork(name: string): Promise<void> {
    this.check("removeNetwork");
    assertNetworkName(name);
    this.networks.delete(name);
  }

  async listServices(): Promise<ServiceInfo[]> {
    this.check("listServices");
    return [...this.services.values()].map(toServiceInfo);
  }

  async inspectService(name: string): Promise<ServiceInfo | null> {
    this.check("inspectService");
    assertServiceName(name);
    const service = this.services.get(name);
    return service === undefined ? null : toServiceInfo(service);
  }

  async createService(spec: SwarmServiceSpec, _options?: RegistryOptions): Promise<ServiceInfo> {
    this.check("createService");
    assertServiceSpec(spec);
    this.requireSwarm();
    if (this.services.has(spec.Name)) {
      throw new DockerDriverError(`service ${spec.Name} already exists`, 409);
    }
    const now = new Date().toISOString();
    const service: FakeService = {
      id: randomUUID(),
      name: spec.Name,
      version: 1,
      spec,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      logs: [],
      listeners: new Set(),
    };
    this.services.set(spec.Name, service);
    this.startTasks(service);
    this.startTimer();
    return toServiceInfo(service);
  }

  async updateService(
    name: string,
    spec: SwarmServiceSpec,
    _options?: RegistryOptions,
  ): Promise<ServiceInfo> {
    this.check("updateService");
    assertServiceName(name);
    assertServiceSpec(spec);
    const service = this.requireService(name);
    if (spec.Name !== name) {
      throw new DockerDriverError("A service cannot be renamed.", 400);
    }
    service.spec = spec;
    service.version += 1;
    service.updatedAt = new Date().toISOString();
    for (const task of service.tasks) {
      if (!task.stopping) {
        task.stopping = true;
        task.desiredState = "shutdown";
      }
    }
    this.startTasks(service);
    this.startTimer();
    return toServiceInfo(service);
  }

  async removeService(name: string): Promise<void> {
    this.check("removeService");
    assertServiceName(name);
    const service = this.services.get(name);
    if (service === undefined) {
      return;
    }
    this.services.delete(name);
    for (const listener of service.listeners) {
      listener();
    }
  }

  async listTasks(filter: { service?: string } = {}): Promise<TaskInfo[]> {
    this.check("listTasks");
    if (filter.service !== undefined) {
      assertServiceName(filter.service);
    }
    const services =
      filter.service === undefined
        ? [...this.services.values()]
        : [this.services.get(filter.service)].filter((service) => service !== undefined);
    return services.flatMap((service) => service.tasks.map(toTaskInfo));
  }

  async *serviceLogs(name: string, options: LogOptions = {}): AsyncGenerator<LogLine> {
    this.check("serviceLogs");
    assertServiceName(name);
    const service = this.requireService(name);

    const tail = options.tail ?? DEFAULT_TAIL;
    for (const line of tail > 0 ? service.logs.slice(-tail) : []) {
      yield this.renderLine(line, options);
    }
    if (options.follow !== true) {
      return;
    }

    const incoming: LogLine[] = [];
    let wake: (() => void) | undefined;
    const onLine = (line?: LogLine) => {
      if (line !== undefined) {
        incoming.push(line);
      }
      wake?.();
    };
    const onAbort = () => wake?.();
    service.listeners.add(onLine);
    options.signal?.addEventListener("abort", onAbort);
    try {
      while (options.signal?.aborted !== true && this.services.get(name) === service) {
        const line = incoming.shift();
        if (line === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        } else {
          yield this.renderLine(line, options);
        }
      }
    } finally {
      service.listeners.delete(onLine);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async execAttach(options: ExecOptions): Promise<ExecSession> {
    this.check("execAttach");
    assertServiceName(options.service);
    const service = this.requireService(options.service);
    const running = service.tasks.filter(
      (task) => task.state === "running" && (options.taskId === undefined || task.id === options.taskId),
    );
    if (running.length === 0) {
      throw new DockerDriverError(`No running task for service ${options.service}.`, 409);
    }

    let finish: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    let buffered = "";
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        const text = chunk.toString("utf8");
        this.push(text);
        buffered += text;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "exit") {
            this.push(null);
            // After the data events already scheduled, as with a real process.
            setImmediate(() => finish(0));
            break;
          }
          this.push(`fake: ${line}\r\n$ `);
        }
        callback();
      },
      final(callback) {
        finish(0);
        callback();
      },
      destroy(error, callback) {
        finish(null);
        callback(error);
      },
    });
    stream.push(`Connected to ${options.service} (fake)\r\n$ `);

    const exec: FakeExec = { options, stream, resizes: [], terminated: false };
    this.execs.push(exec);
    return {
      stream,
      resize: async (columns, rows) => {
        exec.resizes.push({ columns, rows });
      },
      exited: () => exited,
      terminate: async () => {
        exec.terminated = true;
        stream.destroy();
      },
    };
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    this.check("listVolumes");
    return [...this.volumes.values()].map((volume) => ({ ...volume }));
  }

  async inspectVolume(name: string): Promise<VolumeInfo | null> {
    this.check("inspectVolume");
    assertVolumeName(name);
    const volume = this.volumes.get(name);
    return volume === undefined ? null : { ...volume };
  }

  async createVolume(options: CreateVolumeOptions): Promise<VolumeInfo> {
    this.check("createVolume");
    assertVolumeName(options.name);
    const existing = this.volumes.get(options.name);
    if (existing !== undefined) {
      return { ...existing };
    }
    const volume: VolumeInfo = {
      name: options.name,
      driver: options.driver ?? "local",
      mountpoint: `/var/lib/docker/volumes/${options.name}/_data`,
      labels: options.labels ?? {},
      createdAt: new Date().toISOString(),
    };
    this.volumes.set(options.name, volume);
    return { ...volume };
  }

  async removeVolume(name: string, _options?: { force?: boolean }): Promise<void> {
    this.check("removeVolume");
    assertVolumeName(name);
    this.volumes.delete(name);
  }

  async pullImage(ref: string, options: PullOptions = {}): Promise<void> {
    this.check("pullImage");
    assertImageReference(ref);
    const steps = ["Pulling fs layer", "Downloading", "Verifying Checksum", "Extracting", "Pull complete"];
    for (const [index, status] of steps.entries()) {
      options.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.tickMs, 20)));
      options.signal?.throwIfAborted();
      options.onProgress?.({ status, id: "fake-layer", current: index + 1, total: steps.length });
    }
    options.onProgress?.({ status: `Status: Downloaded newer image for ${ref}` });
    this.pulledImages.add(ref);
  }

  async imageExposedPorts(ref: string): Promise<number[]> {
    this.check("imageExposedPorts");
    assertImageReference(ref);
    return this.pulledImages.has(ref) ? [80] : [];
  }

  async serviceStats(name: string, _options?: { signal?: AbortSignal }): Promise<TaskStats[]> {
    this.check("serviceStats");
    assertServiceName(name);
    return this.requireService(name)
      .tasks.filter((task) => task.state === "running")
      .map((task, index) => ({
        taskId: task.id,
        slot: task.slot,
        containerId: task.containerId ?? task.id,
        cpuPercent: 1.5 + index,
        memoryUsedBytes: 64 * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
        networkRxBytes: 1024 * (index + 1),
        networkTxBytes: 2048 * (index + 1),
        readAt: new Date().toISOString(),
      }));
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private check(operation: Operation): void {
    const failure = this.failures.get(operation);
    if (failure !== undefined) {
      this.failures.delete(operation);
      throw failure;
    }
  }

  private requireSwarm(): void {
    if (this.swarmState !== "active") {
      throw new DockerDriverError("This node is not a swarm manager.", 503);
    }
  }

  private requireService(name: string): FakeService {
    const service = this.services.get(name);
    if (service === undefined) {
      throw new DockerDriverError(`no such service: ${name}`, 404);
    }
    return service;
  }

  private addSwarmNetworks(): void {
    for (const name of ["ingress", "opsifier"]) {
      this.networks.set(name, {
        id: randomUUID(),
        name,
        driver: "overlay",
        scope: "swarm",
        attachable: name === "opsifier",
        labels: {},
      });
    }
  }

  private startTasks(service: FakeService): void {
    const replicas = service.spec.Mode?.Replicated?.Replicas ?? 1;
    const now = new Date().toISOString();
    for (let slot = 1; slot <= replicas; slot += 1) {
      service.tasks.push({
        id: randomUUID(),
        serviceId: service.id,
        serviceName: service.name,
        slot,
        nodeId: this.nodeId,
        containerId: null,
        image: service.spec.TaskTemplate.ContainerSpec.Image,
        desiredState: "running",
        state: "new",
        message: "created",
        error: null,
        createdAt: now,
        updatedAt: now,
        stopping: false,
      });
    }
  }

  private startTimer(): void {
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref();
    }
  }

  private tick(): void {
    for (const service of this.services.values()) {
      for (const task of service.tasks) {
        this.advanceTask(service, task);
      }
      service.tasks = service.tasks.filter((task) => task.state !== "remove");
    }
  }

  private advanceTask(service: FakeService, task: FakeTask): void {
    if (task.stopping) {
      if (task.state !== "shutdown") {
        this.setState(task, "shutdown", "shutdown");
        this.appendLog(service, "stdout", `[fake] task ${task.slot} stopped`);
      } else {
        task.state = "remove";
      }
      return;
    }
    const position = STARTUP.indexOf(task.state);
    const next = STARTUP[position + 1];
    if (position === -1 || next === undefined) {
      return;
    }
    this.setState(task, next, next);
    if (next === "starting") {
      task.containerId = randomUUID().replaceAll("-", "");
      this.appendLog(service, "stdout", `[fake] task ${task.slot} pulling ${task.image}`);
    }
    if (next === "running") {
      this.appendLog(service, "stdout", `[fake] task ${task.slot} is running`);
    }
  }

  private setState(task: FakeTask, state: TaskState, message: string): void {
    task.state = state;
    task.message = message;
    task.updatedAt = new Date().toISOString();
  }

  private appendLog(service: FakeService, stream: LogLine["stream"], line: string): void {
    const entry: LogLine = { stream, line, timestamp: new Date().toISOString() };
    service.logs.push(entry);
    if (service.logs.length > MAX_LOG_LINES) {
      service.logs.splice(0, service.logs.length - MAX_LOG_LINES);
    }
    for (const listener of service.listeners) {
      listener(entry);
    }
  }

  private renderLine(line: LogLine, options: LogOptions): LogLine {
    return options.timestamps === true ? { ...line } : { stream: line.stream, line: line.line };
  }
}

function toServiceInfo(service: FakeService): ServiceInfo {
  return {
    id: service.id,
    name: service.name,
    version: service.version,
    spec: service.spec,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

function toTaskInfo(task: FakeTask): TaskInfo {
  const { stopping: _stopping, ...info } = task;
  return info;
}
