import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Duplex, Readable } from "node:stream";
import Dockerode from "dockerode";
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
  InvalidDockerInputError,
  type LogLine,
  type LogOptions,
  type NetworkInfo,
  type PullOptions,
  type RegistryOptions,
  type ServiceInfo,
  type SwarmInfo,
  type SwarmInitOptions,
  type SwarmServiceSpec,
  type SwarmState,
  type TaskInfo,
  type TaskState,
  type TaskStats,
  type VolumeInfo,
} from "./driver";
import { DockerLogParser } from "./log-parser";

const DEFAULT_SOCKET = "/var/run/docker.sock";
const DEFAULT_TCP_PORT = 2375;
const DEFAULT_TAIL = 100;
const UPDATE_ATTEMPTS = 3;

/** Set on every exec, and inherited by what it starts, so that the whole session can be found again. */
const EXEC_MARKER = "OPSIFIER_EXEC_ID";

/**
 * Runs inside the container to end one exec. Docker has no call for it, and the process IDs it reports
 * mean nothing in the container. `$1` is the marker's `NAME=value`, so nothing is interpolated here.
 */
const TERMINATE_SCRIPT = `
find_marked() {
  for dir in /proc/[0-9]*; do
    if { tr '\\0' '\\n' < "$dir/environ" | grep -qx "$1"; } 2>/dev/null; then
      echo "\${dir#/proc/}"
    fi
  done
}
pids=$(find_marked "$1")
[ -n "$pids" ] || exit 0
kill -HUP $pids 2>/dev/null
sleep 1
pids=$(find_marked "$1")
[ -n "$pids" ] || exit 0
kill -KILL $pids 2>/dev/null
exit 0
`;

interface RawService {
  ID: string;
  Version: { Index: number };
  CreatedAt: string;
  UpdatedAt: string;
  Spec: SwarmServiceSpec;
}

interface RawTask {
  ID: string;
  ServiceID: string;
  Slot?: number;
  NodeID?: string;
  DesiredState: TaskState;
  CreatedAt: string;
  UpdatedAt: string;
  Spec: { ContainerSpec?: { Image?: string } };
  Status: { State: TaskState; Message?: string; Err?: string; ContainerStatus?: { ContainerID?: string } };
}

interface RawVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string> | null;
  CreatedAt?: string;
}

interface RawNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Attachable?: boolean;
  Labels?: Record<string, string> | null;
}

interface RawStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

interface DockerApiError {
  statusCode?: number;
  reason?: string;
  json?: { message?: string } | null;
  message?: string;
}

/** The socket path wins over the host, and with neither set the local socket is used. */
function connectionOptions(options: { socketPath?: string; host?: string }): Dockerode.DockerOptions {
  if (options.socketPath !== undefined) {
    return { socketPath: options.socketPath };
  }
  if (options.host === undefined) {
    return { socketPath: DEFAULT_SOCKET };
  }
  let url: URL;
  try {
    url = new URL(options.host);
  } catch {
    throw new InvalidDockerInputError(`Invalid Docker host: ${JSON.stringify(options.host)}.`);
  }
  if (url.protocol === "unix:" && url.pathname !== "") {
    return { socketPath: url.pathname };
  }
  if (url.protocol === "tcp:" && url.hostname !== "") {
    return {
      host: url.hostname,
      port: url.port === "" ? DEFAULT_TCP_PORT : Number(url.port),
      protocol: "http",
    };
  }
  throw new InvalidDockerInputError(`Unsupported Docker host: ${JSON.stringify(options.host)}.`);
}

/** Streamed responses carry no parsed body, so Docker's reason is only in the error's message. */
function causeFromMessage(message: string | undefined): string | undefined {
  return message?.match(/^\(HTTP code \d+\) .*? - ([\s\S]*?)\s*$/)?.[1];
}

function toDriverError(what: string, error: unknown): DockerDriverError {
  if (error instanceof DockerDriverError) {
    return error;
  }
  const apiError = error as DockerApiError;
  const detail =
    apiError.json?.message ??
    causeFromMessage(apiError.message) ??
    apiError.reason ??
    apiError.message ??
    "unknown error";
  return new DockerDriverError(`${what}: ${detail}`, apiError.statusCode, { cause: error });
}

function isNotFound(error: unknown): boolean {
  return (error as DockerApiError).statusCode === 404;
}

function isUpdateConflict(error: unknown): boolean {
  const message = (error as DockerApiError).json?.message ?? (error as DockerApiError).message ?? "";
  return message.includes("update out of sequence");
}

function toServiceInfo(raw: RawService): ServiceInfo {
  return {
    id: raw.ID,
    name: raw.Spec.Name,
    version: raw.Version.Index,
    spec: raw.Spec,
    createdAt: raw.CreatedAt,
    updatedAt: raw.UpdatedAt,
  };
}

function toTaskInfo(raw: RawTask, serviceNames: ReadonlyMap<string, string>): TaskInfo {
  return {
    id: raw.ID,
    serviceId: raw.ServiceID,
    serviceName: serviceNames.get(raw.ServiceID) ?? "",
    slot: raw.Slot ?? null,
    nodeId: raw.NodeID ?? null,
    containerId: raw.Status.ContainerStatus?.ContainerID ?? null,
    image: raw.Spec.ContainerSpec?.Image ?? "",
    desiredState: raw.DesiredState,
    state: raw.Status.State,
    message: raw.Status.Message ?? "",
    error: raw.Status.Err ?? null,
    createdAt: raw.CreatedAt,
    updatedAt: raw.UpdatedAt,
  };
}

function toVolumeInfo(raw: RawVolume): VolumeInfo {
  return {
    name: raw.Name,
    driver: raw.Driver,
    mountpoint: raw.Mountpoint,
    labels: raw.Labels ?? {},
    createdAt: raw.CreatedAt ?? null,
  };
}

function toNetworkInfo(raw: RawNetwork): NetworkInfo {
  return {
    id: raw.Id,
    name: raw.Name,
    driver: raw.Driver,
    scope: raw.Scope,
    attachable: raw.Attachable === true,
    labels: raw.Labels ?? {},
  };
}

function toTaskStats(task: TaskInfo, containerId: string, raw: RawStats): TaskStats {
  const cpu = raw.cpu_stats;
  const previous = raw.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (previous?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (previous?.system_cpu_usage ?? 0);
  const cpus = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;
  const memory = raw.memory_stats;
  const inactive = memory?.stats?.inactive_file ?? memory?.stats?.total_inactive_file ?? 0;
  const networks = Object.values(raw.networks ?? {});

  return {
    taskId: task.id,
    slot: task.slot,
    containerId,
    cpuPercent: systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0,
    memoryUsedBytes: Math.max(0, (memory?.usage ?? 0) - inactive),
    memoryLimitBytes: memory?.limit ?? 0,
    networkRxBytes: networks.reduce((sum, network) => sum + (network.rx_bytes ?? 0), 0),
    networkTxBytes: networks.reduce((sum, network) => sum + (network.tx_bytes ?? 0), 0),
    readAt: new Date().toISOString(),
  };
}

/** Talks to the Docker Engine API over its Unix socket. */
export class DockerodeDriver implements DockerDriver {
  readonly kind = "dockerode";

  private readonly docker: Dockerode;

  constructor(options: { socketPath?: string; host?: string } = {}) {
    this.docker = new Dockerode(connectionOptions(options));
  }

  async ping(): Promise<void> {
    await this.call("ping", () => this.docker.ping());
  }

  async swarmInfo(): Promise<SwarmInfo> {
    const info = await this.call("swarm info", () => this.docker.info());
    const swarm = (info as { Swarm?: Record<string, unknown> }).Swarm ?? {};
    const nodeId = typeof swarm.NodeID === "string" && swarm.NodeID !== "" ? swarm.NodeID : null;
    const nodeAddr = typeof swarm.NodeAddr === "string" && swarm.NodeAddr !== "" ? swarm.NodeAddr : null;
    return {
      state: (swarm.LocalNodeState as SwarmState | undefined) ?? "inactive",
      nodeId,
      nodeAddr,
      isManager: swarm.ControlAvailable === true,
    };
  }

  async swarmInit(options: SwarmInitOptions): Promise<{ nodeId: string }> {
    if (isIP(options.advertiseAddr) === 0) {
      throw new InvalidDockerInputError(
        `Invalid advertise address: ${JSON.stringify(options.advertiseAddr)}.`,
      );
    }
    const nodeId = await this.call("swarm init", () =>
      this.docker.swarmInit({
        ListenAddr: options.listenAddr ?? "0.0.0.0:2377",
        AdvertiseAddr: options.advertiseAddr,
      }),
    );
    return { nodeId: String(nodeId) };
  }

  async listNetworks(): Promise<NetworkInfo[]> {
    const networks = await this.call("list networks", () => this.docker.listNetworks());
    return (networks as unknown as RawNetwork[]).map(toNetworkInfo);
  }

  async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    assertNetworkName(name);
    return this.orNull("inspect network", async () => {
      const raw = await this.docker.getNetwork(name).inspect();
      return toNetworkInfo(raw as unknown as RawNetwork);
    });
  }

  async createNetwork(options: CreateNetworkOptions): Promise<NetworkInfo> {
    assertNetworkName(options.name);
    return this.call("create network", async () => {
      const network = await this.docker.createNetwork({
        Name: options.name,
        Driver: options.driver ?? "overlay",
        Attachable: options.attachable ?? false,
        Labels: options.labels ?? {},
        CheckDuplicate: true,
      });
      return toNetworkInfo((await network.inspect()) as unknown as RawNetwork);
    });
  }

  async removeNetwork(name: string): Promise<void> {
    assertNetworkName(name);
    await this.ignoringNotFound("remove network", () => this.docker.getNetwork(name).remove());
  }

  async listServices(): Promise<ServiceInfo[]> {
    const services = await this.call("list services", () => this.docker.listServices());
    return (services as unknown as RawService[]).map(toServiceInfo);
  }

  async inspectService(name: string): Promise<ServiceInfo | null> {
    assertServiceName(name);
    return this.orNull("inspect service", async () =>
      toServiceInfo((await this.docker.getService(name).inspect()) as RawService),
    );
  }

  async createService(spec: SwarmServiceSpec, options: RegistryOptions = {}): Promise<ServiceInfo> {
    assertServiceSpec(spec);
    return this.call("create service", async () => {
      // Without an explicit first argument dockerode sends the whole spec as the auth header.
      const service = await this.docker.createService(
        options.registryAuth as Dockerode.AuthConfig,
        spec as unknown as Dockerode.ServiceSpec,
      );
      return toServiceInfo((await service.inspect()) as RawService);
    });
  }

  async updateService(
    name: string,
    spec: SwarmServiceSpec,
    options: RegistryOptions = {},
  ): Promise<ServiceInfo> {
    assertServiceName(name);
    assertServiceSpec(spec);
    if (spec.Name !== name) {
      throw new InvalidDockerInputError("A service cannot be renamed.");
    }

    const service = this.docker.getService(name);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const current = (await service.inspect()) as RawService;
        await service.update({
          authconfig: options.registryAuth,
          _query: { version: current.Version.Index },
          _body: spec,
        });
        return toServiceInfo((await service.inspect()) as RawService);
      } catch (error) {
        // Swarm rejects a stale version when something else updated the service in between.
        if (attempt >= UPDATE_ATTEMPTS || !isUpdateConflict(error)) {
          throw toDriverError("update service", error);
        }
      }
    }
  }

  async removeService(name: string): Promise<void> {
    assertServiceName(name);
    await this.ignoringNotFound("remove service", () => this.docker.getService(name).remove());
  }

  async listTasks(filter: { service?: string } = {}): Promise<TaskInfo[]> {
    if (filter.service !== undefined) {
      assertServiceName(filter.service);
    }
    // Docker answers 404 when the filter names a service it does not know.
    const tasks = await this.orNull("list tasks", async () => {
      const [tasks, services] = await Promise.all([
        this.docker.listTasks(filter.service === undefined ? {} : { filters: { service: [filter.service] } }),
        this.docker.listServices(),
      ]);
      const names = new Map(
        (services as unknown as RawService[]).map((service) => [service.ID, service.Spec.Name]),
      );
      return (tasks as RawTask[]).map((task) => toTaskInfo(task, names));
    });
    return tasks ?? [];
  }

  async *serviceLogs(name: string, options: LogOptions = {}): AsyncGenerator<LogLine> {
    assertServiceName(name);
    const timestamps = options.timestamps === true;
    const parser = new DockerLogParser({ timestamps });

    let source: unknown;
    try {
      // `_query` keeps the signal out of the URL Docker receives. The outer `follow` asks dockerode
      // for a stream even for a one-off read, so that a large log is never held in memory whole.
      source = await this.docker.getService(name).logs({
        follow: true,
        abortSignal: options.signal,
        _query: {
          stdout: true,
          stderr: true,
          follow: options.follow === true,
          tail: options.tail ?? DEFAULT_TAIL,
          since: options.since ?? 0,
          timestamps,
        },
      } as unknown as Dockerode.ContainerLogsOptions);
    } catch (error) {
      if (options.signal?.aborted === true) {
        return;
      }
      throw toDriverError("service logs", error);
    }

    // Without `follow` Docker answers in one response: a Buffer, or JSON if the text parsed as such.
    if (!isReadable(source)) {
      const chunk = Buffer.isBuffer(source) ? source : Buffer.from(JSON.stringify(source));
      yield* parser.push(chunk);
      yield* parser.flush();
      return;
    }

    try {
      for await (const chunk of source) {
        yield* parser.push(chunk as Buffer);
      }
      yield* parser.flush();
    } catch (error) {
      if (options.signal?.aborted === true) {
        return;
      }
      throw toDriverError("service logs", error);
    } finally {
      source.destroy();
    }
  }

  async execAttach(options: ExecOptions): Promise<ExecSession> {
    assertServiceName(options.service);
    return this.call("exec", async () => {
      const task = (await this.listTasks({ service: options.service })).find(
        (candidate) =>
          candidate.state === "running" &&
          candidate.containerId !== null &&
          (options.taskId === undefined || candidate.id === options.taskId),
      );
      if (task?.containerId == null) {
        throw new DockerDriverError(`No running task for service ${options.service}.`, 409);
      }

      const tty = options.tty ?? true;
      const container = this.docker.getContainer(task.containerId);
      const marker = `${EXEC_MARKER}=${randomBytes(16).toString("hex")}`;
      const exec = await container.exec({
        Cmd: options.command,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: tty,
        Env: [...(options.env ?? []), marker],
        User: options.user,
        WorkingDir: options.workingDir,
      });
      const stream = (await exec.start({
        hijack: true,
        stdin: true,
        Tty: tty,
        ...(options.consoleSize === undefined
          ? {}
          : { ConsoleSize: [options.consoleSize.rows, options.consoleSize.columns] }),
      })) as Duplex;
      const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));

      return {
        stream,
        resize: async (columns, rows) => {
          await exec.resize({ w: columns, h: rows });
        },
        exited: async () => {
          await closed;
          const inspected = await exec.inspect();
          return inspected.ExitCode ?? null;
        },
        terminate: async () => {
          stream.destroy();
          // Best effort: the container may have gone away, which ended the session anyway.
          const killer = await container.exec({
            Cmd: ["/bin/sh", "-c", TERMINATE_SCRIPT, "opsifier-terminate", marker],
            AttachStdout: false,
            AttachStderr: false,
          });
          await killer.start({ Detach: true });
        },
      };
    });
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const result = await this.call("list volumes", () => this.docker.listVolumes());
    return (result.Volumes as unknown as RawVolume[]).map(toVolumeInfo);
  }

  async inspectVolume(name: string): Promise<VolumeInfo | null> {
    assertVolumeName(name);
    return this.orNull("inspect volume", async () =>
      toVolumeInfo((await this.docker.getVolume(name).inspect()) as unknown as RawVolume),
    );
  }

  async createVolume(options: CreateVolumeOptions): Promise<VolumeInfo> {
    assertVolumeName(options.name);
    return this.call("create volume", async () => {
      const volume = await this.docker.createVolume({
        Name: options.name,
        Driver: options.driver ?? "local",
        DriverOpts: options.driverOptions ?? {},
        Labels: options.labels ?? {},
      });
      return toVolumeInfo((await volume.inspect()) as unknown as RawVolume);
    });
  }

  async removeVolume(name: string, options: { force?: boolean } = {}): Promise<void> {
    assertVolumeName(name);
    // dockerode's Volume#remove sends no query string: the modem only adds one to a path holding "?".
    await this.ignoringNotFound("remove volume", () =>
      this.dial({
        path: `/volumes/${name}?`,
        method: "DELETE",
        statusCodes: { 204: true, 404: "no such volume", 409: "conflict", 500: "server error" },
        options: { force: options.force === true },
      }),
    );
  }

  async imageExposedPorts(ref: string): Promise<number[]> {
    assertImageReference(ref);
    const image = await this.orNull("inspect image", () => this.docker.getImage(ref).inspect());
    return Object.keys(image?.Config?.ExposedPorts ?? {})
      .filter((port) => port.endsWith("/tcp"))
      .map((port) => Number.parseInt(port, 10))
      .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
      .sort((a, b) => a - b);
  }

  async pullImage(ref: string, options: PullOptions = {}): Promise<void> {
    assertImageReference(ref);
    options.signal?.throwIfAborted();

    const stream = await this.call("pull image", () =>
      (
        this.docker.pull as unknown as (
          repoTag: string,
          options: Record<string, never>,
          callback: undefined,
          auth?: unknown,
        ) => Promise<Readable>
      ).call(this.docker, ref, {}, undefined, options.registryAuth),
    );

    const abort = () => stream.destroy(options.signal?.reason as Error | undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      let pending = "";
      for await (const chunk of stream) {
        pending += (chunk as Buffer).toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          this.reportPullLine(line, options);
        }
      }
      this.reportPullLine(pending, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw toDriverError("pull image", error);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    options.signal?.throwIfAborted();
  }

  async serviceStats(name: string, options: { signal?: AbortSignal } = {}): Promise<TaskStats[]> {
    assertServiceName(name);
    const running = (await this.listTasks({ service: name })).filter(
      (task) => task.state === "running" && task.containerId !== null,
    );

    const samples = await Promise.all(
      running.map(async (task): Promise<TaskStats | null> => {
        const containerId = task.containerId as string;
        try {
          // `_query` keeps the signal out of the URL Docker receives.
          const raw = await this.docker.getContainer(containerId).stats({
            stream: false,
            abortSignal: options.signal,
            _query: { stream: false },
          } as { stream: false });
          return toTaskStats(task, containerId, raw as unknown as RawStats);
        } catch (error) {
          // A task on another node, or one that just stopped, has no local stats to read.
          if (isNotFound(error)) {
            return null;
          }
          throw toDriverError("service stats", error);
        }
      }),
    );
    return samples.filter((sample) => sample !== null);
  }

  async dispose(): Promise<void> {}

  private dial(options: Parameters<Dockerode["modem"]["dial"]>[0]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.docker.modem.dial(options, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  private async call<T>(what: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toDriverError(what, error);
    }
  }

  private async orNull<T>(what: string, operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw toDriverError(what, error);
    }
  }

  private async ignoringNotFound(what: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!isNotFound(error)) {
        throw toDriverError(what, error);
      }
    }
  }

  private reportPullLine(line: string, options: PullOptions): void {
    if (line.trim() === "") {
      return;
    }
    let event: {
      status?: string;
      id?: string;
      error?: string;
      progressDetail?: { current?: number; total?: number };
    };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // Docker reports a failed pull inside a successful response.
    if (event.error !== undefined) {
      throw new DockerDriverError(`pull image: ${event.error}`);
    }
    options.onProgress?.({
      status: event.status ?? "",
      id: event.id,
      current: event.progressDetail?.current,
      total: event.progressDetail?.total,
    });
  }
}

function isReadable(value: unknown): value is Readable {
  return typeof (value as Readable | null)?.on === "function" && !Buffer.isBuffer(value);
}
