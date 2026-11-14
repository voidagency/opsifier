import { createHash, randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import {
  assertImageReference,
  assertNetworkName,
  assertServiceName,
  assertServiceSpec,
  assertVolumeName,
  type BuildCacheRecord,
  type ComposeContainerInfo,
  type ContainerInfo,
  type CreateNetworkOptions,
  type CreateVolumeOptions,
  type DockerDriver,
  DockerDriverError,
  type EngineDiskUsage,
  type EngineEvent,
  type EngineEventOptions,
  type EngineInfo,
  type ExecOptions,
  type ExecSession,
  type ExecState,
  type ExecTarget,
  type HelperOptions,
  type HelperResult,
  type ImageDetail,
  type ImageInfo,
  type LogLine,
  type LogOptions,
  type NetworkInfo,
  type NodeInfo,
  type PullOptions,
  type RegistryOptions,
  type ServiceInfo,
  type SwarmContents,
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
/** `df -kP` on the simulated host: 200 GiB, half of it free. */
const SIMULATED_DISK_FREE =
  "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 209715200 104857600 104857600 50% /host\n";
const FAKE_CPU_CORES = 4;
const DEFAULT_TAIL = 100;
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

function swarmNetwork(name: string): NetworkInfo {
  return {
    id: randomUUID(),
    name,
    driver: "overlay",
    scope: "swarm",
    attachable: name === "opsifier",
    labels: {},
    subnets: [name === "opsifier" ? "10.0.1.0/24" : "10.0.0.0/24"],
  };
}

/** An id a real daemon could have given: the same content always gets the same one. */
const fakeImageId = (seed: string): string => `sha256:${createHash("sha256").update(seed).digest("hex")}`;

/** The repository of a reference: everything but its tag and digest. */
function imageRepository(ref: string): string {
  const name = ref.split("@", 1)[0] as string;
  const colon = name.lastIndexOf(":");
  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
}

interface FakeTask extends TaskInfo {
  /** Set while the task is being replaced or removed. */
  stopping: boolean;
}

/** One exec session, so tests can see what was run and whether it was closed. */
export interface FakeExec {
  /** Docker's id for the process. */
  id: string;
  options: ExecOptions;
  stream: Duplex;
  resizes: Array<{ columns: number; rows: number }>;
  terminated: boolean;
  /** Every byte the program was sent, so tests can see what reached it. */
  input: number[];
  state: ExecState;
  /** Ends a script run as if its shell had exited with this code. */
  exit(code: number): void;
}

interface LogSource {
  logs: LogLine[];
  /** Called with each new line, and with nothing when the source goes away. */
  listeners: Set<(line?: LogLine) => void>;
}

interface FakeService extends ServiceInfo, LogSource {
  tasks: FakeTask[];
}

export interface FakeDriverOptions {
  /** How often tasks advance a state. */
  tickMs?: number;
  /** Whether the node already belongs to a swarm. Defaults to true, as after the installer. */
  swarmActive?: boolean;
  /** The swarm this node is in cannot be managed from here. Defaults to a manager. */
  swarmWorker?: boolean;
  nodeAddr?: string;
}

type Operation = Exclude<keyof DockerDriver, "kind">;

/** What a simulated command prints, and what it exits with. */
export interface FakeExecReply {
  output: string;
  exitCode: number;
}

/**
 * An in-memory Docker: services get tasks that move through Swarm's states, produce logs and
 * can be exec'd into. `OPSIFIER_DRIVER=fake` uses it in development and tests.
 */
/** What every database script prints as its last act, so that scripts run against the fake succeed. */
const FAKE_SCRIPT_OK = "opsifier-ok";

export class FakeDriver implements DockerDriver {
  readonly kind = "fake";

  private readonly tickMs: number;
  private readonly nodeAddr: string;
  private readonly nodeId = randomUUID();
  private swarmState: SwarmInfo["state"];
  private isManager = true;
  private readonly networks = new Map<string, NetworkInfo>();
  private readonly services = new Map<string, FakeService>();
  private readonly volumes = new Map<string, VolumeInfo>();
  private readonly pulledImages = new Set<string>();
  /** What every name on this daemon points at. A name can move. An id can't. */
  private readonly imageNames = new Map<string, string>();
  /** The registry digest of an image that came from one, by image id. */
  private readonly imageDigests = new Map<string, string>();
  private readonly imageLabels = new Map<string, Record<string, string>>();
  /** How many times a tag has been moved in the registry: the next pull gets something else. */
  private readonly registryMoves = new Map<string, number>();
  private builds = 0;
  private readonly failures = new Map<Operation, Error>();
  private readonly containerLogSources = new Map<string, LogSource>();
  /** How to end each helper with a terminal still attached. */
  private readonly openHelpers = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;

  /** Every exec session started so far, oldest first. */
  readonly execs: FakeExec[] = [];
  /** The markers `terminateExec` was asked to end, in order. */
  readonly endedMarkers: string[] = [];
  /** Runs first. Answering for a command replaces the simulation of a shell. */
  execHandler: ((options: ExecOptions) => FakeExecReply | undefined) | undefined;

  constructor(options: FakeDriverOptions = {}) {
    this.tickMs = options.tickMs ?? 250;
    this.nodeAddr = options.nodeAddr ?? "203.0.113.10";
    this.swarmState = options.swarmActive === false ? "inactive" : "active";
    this.isManager = options.swarmWorker !== true;
    if (this.swarmState === "active") {
      this.addSwarmNetworks();
    }
  }

  /** When this names a reason for a service's spec, its tasks fail with it, as Swarm would report. */
  taskFailure: ((spec: SwarmServiceSpec) => string | null) | null = null;

  /** Makes the next call to `operation` reject, to exercise failure paths. */
  failNext(operation: Operation, error: Error = new DockerDriverError(`${operation} failed`, 500)): void {
    this.failures.set(operation, error);
  }

  /** Adds a line to a service's logs, as if one of its tasks had printed it. */
  writeLog(name: string, line: string, stream: LogLine["stream"] = "stdout"): void {
    this.appendLog(this.requireService(name), stream, line);
  }

  /** Adds a line to one container's logs, as if a Compose child had printed it. */
  writeContainerLog(id: string, line: string, stream: LogLine["stream"] = "stdout"): void {
    this.appendLog(this.containerLogSource(id), stream, line);
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
      isManager: active && this.isManager,
    };
  }

  async swarmInit(_options: SwarmInitOptions): Promise<{ nodeId: string }> {
    this.check("swarmInit");
    if (this.swarmState === "active") {
      throw new DockerDriverError("This node is already part of a swarm.", 503);
    }
    this.swarmState = "active";
    // A new Swarm has only Docker's own network: the panel's comes from `setup`.
    this.networks.set("ingress", swarmNetwork("ingress"));
    return { nodeId: this.nodeId };
  }

  async swarmLeave(options: { force?: boolean } = {}): Promise<void> {
    this.check("swarmLeave");
    if (this.swarmState !== "active" && this.swarmState !== "error" && this.swarmState !== "locked") {
      throw new DockerDriverError("This node is not part of a swarm.", 503);
    }
    if (this.isManager && options.force !== true) {
      throw new DockerDriverError("You are attempting to leave the swarm on a node that is a manager.", 503);
    }
    this.swarmState = "inactive";
    this.isManager = true;
    this.services.clear();
    this.networks.clear();
  }

  /** Nodes other than this one, as a test adds them to the swarm. */
  otherNodes: NodeInfo[] = [];

  async listNodes(): Promise<NodeInfo[]> {
    this.check("listNodes");
    if (this.swarmState !== "active") {
      throw new DockerDriverError("This node is not a swarm manager.", 503);
    }
    const self: NodeInfo = {
      id: this.nodeId,
      hostname: "fake-node",
      role: this.isManager ? "manager" : "worker",
      leader: this.isManager,
      state: "ready",
      availability: "active",
      address: this.nodeAddr,
      engineVersion: "29.1.0",
      os: "linux",
      architecture: "x86_64",
      cpus: 4,
      memoryBytes: 8 * 1024 ** 3,
    };
    return [self, ...this.otherNodes].map((node) => ({ ...node }));
  }

  /** What `swarmContents` answers. Tests change it to simulate a Swarm others have joined or filled. */
  swarmExtras: SwarmContents = { nodes: 1, secrets: 0, configs: 0 };

  async swarmContents(): Promise<SwarmContents> {
    this.check("swarmContents");
    return this.swarmExtras;
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
      subnets: [`10.0.${this.networks.size}.0/24`],
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
    yield* this.readLogs(service, options, () => this.services.get(name) === service);
  }

  async *containerLogs(id: string, options: LogOptions = {}): AsyncGenerator<LogLine> {
    this.check("containerLogs");
    const source = this.containerLogSource(id);
    yield* this.readLogs(source, options, () =>
      this.composeContainers.some((container) => container.id === id && container.state === "running"),
    );
  }

  private async *readLogs(
    source: LogSource,
    options: LogOptions,
    alive: () => boolean,
  ): AsyncGenerator<LogLine> {
    const tail = options.tail ?? DEFAULT_TAIL;
    for (const line of tail > 0 ? source.logs.slice(-tail) : []) {
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
    source.listeners.add(onLine);
    options.signal?.addEventListener("abort", onAbort);
    try {
      while (options.signal?.aborted !== true && alive()) {
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
      source.listeners.delete(onLine);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async execAttach(options: ExecOptions): Promise<ExecSession> {
    this.check("execAttach");
    assertServiceName(options.service);
    if (options.containerId === undefined) {
      const service = this.requireService(options.service);
      const running = service.tasks.filter(
        (task) => task.state === "running" && (options.taskId === undefined || task.id === options.taskId),
      );
      if (running.length === 0) {
        throw new DockerDriverError(`No running task for service ${options.service}.`, 409);
      }
    } else if (!this.composeContainers.some((container) => container.id === options.containerId)) {
      throw new DockerDriverError(`No such container: ${options.containerId}.`, 404);
    }

    const reply = this.execHandler?.(options);
    if (reply !== undefined) {
      return this.scriptedExec(options, reply);
    }

    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    // A saved script runs under watch: no terminal to type into, and it ends on its own.
    const isScript = options.tty === false && options.marker !== undefined;
    const state: ExecState = { running: true, exitCode: null };
    const finish = (code: number | null) => {
      if (state.running) {
        state.running = false;
        state.exitCode = code;
      }
      resolveExit(code);
    };
    let buffered = "";
    const input: number[] = [];
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        input.push(...chunk);
        const text = chunk.toString("utf8");
        if (isScript) {
          callback();
          return;
        }
        // What a real terminal's line discipline does with these two keys.
        if (text === CTRL_C) {
          buffered = "";
          this.push(`^C\r\n$ `);
          callback();
          return;
        }
        if (text === CTRL_D && buffered === "") {
          this.push(null);
          setImmediate(() => finish(0));
          callback();
          return;
        }
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
        // A saved script plays out by itself. Any other script without a terminal gets the answer
        // its last line asks for.
        if (!isScript) {
          if (options.tty === false) {
            this.push(`${FAKE_SCRIPT_OK}\n`);
          }
          finish(0);
        }
        callback();
      },
      destroy(error, callback) {
        finish(null);
        callback(error);
      },
    });
    if (options.tty !== false) {
      stream.push(`Connected to ${options.service} (fake)\r\n$ `);
    }

    const exec: FakeExec = {
      id: randomUUID().replaceAll("-", ""),
      options,
      stream,
      resizes: [],
      terminated: false,
      input,
      state,
      exit: (code) => {
        if (state.running) {
          finish(code);
          stream.push(null);
        }
      },
    };
    this.execs.push(exec);
    if (isScript) {
      void this.playScript(exec);
    }
    return {
      id: exec.id,
      stream,
      resize: async (columns, rows) => {
        exec.resizes.push({ columns, rows });
      },
      exited: () => exited,
      terminate: async () => {
        exec.terminated = true;
        // Like a real kill: the process is gone, and what it was doing with it.
        if (state.running) {
          state.running = false;
          state.exitCode = 137;
        }
        stream.destroy();
      },
    };
  }

  /** A process whose whole output is known: it prints it and exits as soon as its input ends. */
  private scriptedExec(options: ExecOptions, reply: FakeExecReply): ExecSession {
    const state: ExecState = { running: true, exitCode: null };
    const exited = new Promise<number | null>((resolve) => {
      queueMicrotask(() => {
        state.running = false;
        state.exitCode = reply.exitCode;
        resolve(reply.exitCode);
      });
    });
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        this.push(reply.output);
        this.push(null);
        callback();
      },
    });
    const exec: FakeExec = {
      id: randomUUID().replaceAll("-", ""),
      options,
      stream,
      resizes: [],
      terminated: false,
      input: [],
      state,
      exit: () => {},
    };
    this.execs.push(exec);
    return { id: exec.id, stream, resize: async () => {}, exited: () => exited };
  }

  /** Just enough of a shell for a saved script to be seen running: `echo`, `sleep` and `exit`. */
  private async playScript(exec: FakeExec): Promise<void> {
    const body = exec.options.command.at(-1) ?? "";
    for (const raw of body.split("\n")) {
      if (!exec.state.running) {
        return;
      }
      const line = raw.trim();
      const sleeping = /^sleep\s+(\d+(?:\.\d+)?)$/.exec(line);
      const exiting = /^exit(?:\s+(\d+))?$/.exec(line);
      if (sleeping !== null) {
        await new Promise((resolve) => setTimeout(resolve, Number(sleeping[1]) * 1000).unref());
      } else if (exiting !== null) {
        exec.exit(Number(exiting[1] ?? 0));
        return;
      } else if (line.startsWith("echo ")) {
        exec.stream.push(`${line.slice("echo ".length)}\n`);
      } else if (line !== "") {
        exec.stream.push(`fake: ${line}\n`);
      }
    }
    exec.exit(0);
  }

  async inspectExec(id: string): Promise<ExecState | null> {
    this.check("inspectExec");
    const exec = this.execs.find((candidate) => candidate.id === id);
    return exec === undefined ? null : { ...exec.state };
  }

  async terminateExec(options: ExecTarget & { marker: string }): Promise<void> {
    this.check("terminateExec");
    assertServiceName(options.service);
    this.endedMarkers.push(options.marker);
    for (const exec of this.execs.filter((candidate) => candidate.options.marker === options.marker)) {
      exec.terminated = true;
      if (exec.state.running) {
        exec.state.running = false;
        exec.state.exitCode = 137;
      }
      exec.stream.destroy();
    }
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
    if (this.volumes.delete(name)) {
      const freed = this.volumeBytesFreed.get(name) ?? 0;
      this.disk = { ...this.disk, volumesBytes: Math.max(0, this.disk.volumesBytes - freed) };
    }
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
    const id = fakeImageId(`${ref}#${this.registryMoves.get(ref) ?? 0}`);
    this.imageNames.set(ref, id);
    this.imageDigests.set(id, `${imageRepository(ref)}@${id}`);
  }

  /** Moves a tag in the registry, so that the next pull of it brings a different image. */
  moveRegistryTag(ref: string): void {
    this.registryMoves.set(ref, (this.registryMoves.get(ref) ?? 0) + 1);
  }

  /** Moves a tag on this daemon to the image another name stands for, as `docker tag` would. */
  moveLocalTag(ref: string, to: string): void {
    const id = this.imageIdOf(to);
    if (id === undefined) {
      throw new Error(`No such image: ${to}`);
    }
    this.imageNames.set(ref, id);
  }

  /** What a build leaves on this daemon: every build makes an image of its own. */
  addBuiltImage(ref: string, labels: Record<string, string> = {}): void {
    this.builds += 1;
    const inherited = this.imageLabels.get(this.imageNames.get(ref) ?? "") ?? {};
    const id = fakeImageId(`${ref}#build-${this.builds}`);
    this.imageNames.set(ref, id);
    this.imageLabels.set(id, { ...inherited, ...labels });
  }

  /** The image a tag, an id or a digest reference stands for, if this daemon holds it. */
  private imageIdOf(ref: string): string | undefined {
    const named = this.imageNames.get(ref);
    if (named !== undefined) {
      return named;
    }
    const id = ref.includes("@") ? ref.slice(ref.indexOf("@") + 1) : ref;
    return [...this.imageNames.values()].includes(id) ? id : undefined;
  }

  /** The same user whichever name the image is looked up by. */
  private imageUser(ref: string, id: string): string {
    const name = [...this.imageNames].find(([name, named]) => named === id && this.imageUsers.has(name))?.[0];
    return this.imageUsers.get(ref) ?? this.imageUsers.get(name ?? "") ?? "";
  }

  async inspectImage(ref: string): Promise<ImageDetail | null> {
    this.check("inspectImage");
    assertImageReference(ref);
    const listed = this.images.find((image) => image.tags.includes(ref) || image.id === ref);
    if (listed !== undefined) {
      return {
        id: listed.id,
        digests: [],
        sizeBytes: listed.sizeBytes,
        labels: listed.labels,
        user: this.imageUsers.get(ref) ?? "",
      };
    }
    const id = this.imageIdOf(ref);
    if (id === undefined) {
      return null;
    }
    const digest = this.imageDigests.get(id);
    return {
      id,
      digests: digest === undefined ? [] : [digest],
      sizeBytes: 1024,
      labels: this.imageLabels.get(id) ?? {},
      user: this.imageUser(ref, id),
    };
  }

  async tagImage(ref: string, target: string): Promise<void> {
    this.check("tagImage");
    assertImageReference(ref);
    assertImageReference(target);
    const image = await this.inspectImage(ref);
    if (image === null) {
      throw new DockerDriverError(`No such image: ${ref}`, 404);
    }
    this.imageNames.set(target, image.id);
  }

  /** Puts an image on this daemon, as a build would. */
  addLocalImage(ref: string): void {
    this.imageNames.set(ref, fakeImageId(ref));
  }

  async imageExposedPorts(ref: string): Promise<number[]> {
    this.check("imageExposedPorts");
    assertImageReference(ref);
    return this.pulledImages.has(ref) ? [80] : [];
  }

  async listComposeContainers(project?: string): Promise<ComposeContainerInfo[]> {
    this.check("listComposeContainers");
    return this.composeContainers.filter(
      (container) => project === undefined || container.project === project,
    );
  }

  /** The containers of a simulated stack, as a test or the fake `docker compose` left them. */
  readonly composeContainers: ComposeContainerInfo[] = [];

  async containerStats(id: string, _options?: { signal?: AbortSignal }): Promise<TaskStats | null> {
    this.check("containerStats");
    const container = this.composeContainers.find((candidate) => candidate.id === id);
    if (container === undefined || container.state !== "running") {
      return null;
    }
    return {
      taskId: id,
      slot: container.number,
      containerId: id,
      cpuPercent: 2.5,
      cpuCapacityPercent: FAKE_CPU_CORES * 100,
      memoryUsedBytes: 32 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
      networkRxBytes: 1024,
      networkTxBytes: 2048,
      readAt: new Date().toISOString(),
    };
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
        cpuCapacityPercent: (task.cpuLimitCores ?? FAKE_CPU_CORES) * 100,
        memoryUsedBytes: 64 * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
        networkRxBytes: 1024 * (index + 1),
        networkTxBytes: 2048 * (index + 1),
        readAt: new Date().toISOString(),
      }));
  }

  /** What `engineInfo` answers. Tests change it to simulate another daemon. */
  engine: EngineInfo = {
    version: "29.1.0",
    apiVersion: "1.52",
    operatingSystem: "Fake Linux",
    kernelVersion: "6.1.0",
    cores: 4,
    memoryBytes: 8 * 1024 ** 3,
    rootDir: "/var/lib/docker",
    swarm: "active",
    swarmAvailable: true,
    swarmManager: true,
    networkDrivers: ["bridge", "host", "ipvlan", "macvlan", "null", "overlay"],
    volumeDrivers: ["local"],
  };
  readonly images: ImageInfo[] = [];
  /** The USER line of an image. Images not listed here run as root. */
  readonly imageUsers = new Map<string, string>();
  readonly containers: ContainerInfo[] = [];
  disk: EngineDiskUsage = {
    imagesBytes: 0,
    containersBytes: 0,
    volumesBytes: 0,
    buildCacheBytes: 0,
    buildCache: [],
  };
  readonly helpers: HelperOptions[] = [];
  private readonly eventListeners = new Set<(event: EngineEvent) => void>();
  helperResult: (options: HelperOptions) => HelperResult = (options) => ({
    exitCode: 0,
    stdout: options.command[0] === "df" ? SIMULATED_DISK_FREE : "",
    stderr: "",
  });

  /** Delivers an event to everyone following `events`. */
  emitEvent(event: Partial<EngineEvent> & Pick<EngineEvent, "type" | "action">): void {
    const complete: EngineEvent = {
      actorId: "fake",
      attributes: {},
      scope: "local",
      at: Date.now(),
      ...event,
    };
    for (const listener of this.eventListeners) {
      listener(complete);
    }
  }

  async engineInfo(): Promise<EngineInfo> {
    this.check("engineInfo");
    return this.engine;
  }

  async *events(options: EngineEventOptions = {}): AsyncGenerator<EngineEvent> {
    this.check("events");
    const queue: EngineEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: EngineEvent) => {
      queue.push(event);
      wake?.();
    };
    this.eventListeners.add(listener);
    const abort = () => wake?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (options.signal?.aborted !== true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.eventListeners.delete(listener);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async diskUsage(_options?: { signal?: AbortSignal }): Promise<EngineDiskUsage> {
    this.check("diskUsage");
    return this.disk;
  }

  async listBuildCache(_options?: { signal?: AbortSignal }): Promise<BuildCacheRecord[]> {
    this.check("listBuildCache");
    return [...this.disk.buildCache];
  }

  async listImages(): Promise<ImageInfo[]> {
    this.check("listImages");
    return [...this.images];
  }

  async listContainers(_options?: { size?: boolean }): Promise<ContainerInfo[]> {
    this.check("listContainers");
    return [...this.containers];
  }

  /** What `removeImage` was asked to remove, in order, for tests. */
  readonly removedImageReferences: string[] = [];

  /** What removing a volume gives back by Docker's count. */
  readonly volumeBytesFreed = new Map<string, number>();
  /** What removing an image gives back, when it shares layers. Otherwise its listed size. */
  readonly imageBytesFreed = new Map<string, number>();

  async removeImage(id: string): Promise<void> {
    this.removedImageReferences.push(id);
    this.pulledImages.delete(id);
    this.imageNames.delete(id);
    for (const [name, named] of this.imageNames) {
      if (named === id) {
        this.imageNames.delete(name);
      }
    }
    const index = this.images.findIndex((image) => image.id === id || image.tags.includes(id));
    if (index !== -1) {
      const image = this.images[index] as ImageInfo;
      this.images.splice(index, 1);
      const freed = this.imageBytesFreed.get(image.id) ?? image.sizeBytes;
      this.disk = { ...this.disk, imagesBytes: Math.max(0, this.disk.imagesBytes - freed) };
    }
  }

  async removeContainer(id: string): Promise<void> {
    const index = this.containers.findIndex((container) => container.id === id);
    if (index !== -1) {
      const freed = this.containers[index]?.sizeBytes ?? 0;
      this.containers.splice(index, 1);
      this.disk = { ...this.disk, containersBytes: Math.max(0, this.disk.containersBytes - freed) };
    }
  }

  async removeBuildCache(ids: readonly string[]): Promise<number> {
    const removed = this.disk.buildCache.filter((record) => ids.includes(record.id));
    this.disk = {
      ...this.disk,
      buildCache: this.disk.buildCache.filter((record) => !ids.includes(record.id)),
      buildCacheBytes: this.disk.buildCacheBytes - removed.reduce((total, r) => total + r.sizeBytes, 0),
    };
    return removed.reduce((total, record) => total + record.sizeBytes, 0);
  }

  async runHelper(options: HelperOptions): Promise<HelperResult> {
    this.helpers.push(options);
    return this.helperResult(options);
  }

  async openHelper(
    options: HelperOptions & { consoleSize?: { columns: number; rows: number } },
  ): Promise<ExecSession> {
    this.helpers.push(options);
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    let finish: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    const end = () => {
      stream.destroy();
      finish(null);
      this.openHelpers.delete(end);
    };
    this.openHelpers.add(end);
    return { stream, resize: async () => {}, exited: () => exited, terminate: async () => end() };
  }

  async removeLeftoverHelpers(): Promise<number> {
    this.check("removeLeftoverHelpers");
    const open = [...this.openHelpers];
    for (const end of open) {
      end();
    }
    return open.length;
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
      this.networks.set(name, swarmNetwork(name));
    }
  }

  private startTasks(service: FakeService): void {
    const replicas = service.spec.Mode?.Replicated?.Replicas ?? 1;
    const now = new Date().toISOString();
    const nanoCpus = service.spec.TaskTemplate.Resources?.Limits?.NanoCPUs ?? 0;
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
        ...(nanoCpus > 0 ? { cpuLimitCores: nanoCpus / 1e9 } : {}),
      });
    }
  }

  /** Swarm's restart policy: a task that failed is replaced, for as long as the service wants one. */
  private restartTask(service: FakeService, failed: FakeTask): void {
    const now = new Date().toISOString();
    service.tasks.push({
      ...failed,
      id: randomUUID(),
      containerId: null,
      desiredState: "running",
      state: "new",
      message: "created",
      error: null,
      createdAt: now,
      updatedAt: now,
    });
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
    const failure = next === "starting" ? this.taskFailure?.(service.spec) : null;
    if (failure !== null && failure !== undefined) {
      this.setState(task, "failed", failure);
      task.error = failure;
      task.desiredState = "shutdown";
      this.restartTask(service, task);
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

  private containerLogSource(id: string): LogSource {
    let source = this.containerLogSources.get(id);
    if (source === undefined) {
      source = { logs: [], listeners: new Set() };
      this.containerLogSources.set(id, source);
    }
    return source;
  }

  private appendLog(service: LogSource, stream: LogLine["stream"], line: string): void {
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
