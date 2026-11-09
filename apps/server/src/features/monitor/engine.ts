import type { SystemMetrics } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError, type TaskStats } from "../../core/docker";
import { metricOriginOf } from "../service-runtime/metrics";
import { HostProbe, type HostReading } from "./probe";
import { readMonitoringSettings } from "./settings";
import { StorageScanner } from "./storage";
import { insertReading, latestServiceReadingAt, pruneMetrics, rollUp } from "./store";

const ROLLUP_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const MAX_CONCURRENT_SERVICES = 4;
/** A second of real sampling on Docker's side means a reading is not worth repeating sooner. */
const CURRENT_CACHE_MS = 750;
/** A daemon that accepts a connection and then says nothing must not hold up a reading. */
const DOCKER_ANSWER_MS = 5000;

async function withinDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DockerDriverError(`${what}: Docker did not answer.`)),
          DOCKER_ANSWER_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Docker counters reset when a task restarts, so one interval can go backwards. */
const counterDelta = (current: number, previous: number) => (current >= previous ? current - previous : null);

interface ContainerCounters {
  rx: number;
  tx: number;
  at: number;
}

/** Network readings need two samples, so the counters are remembered between scrapes. */
export class NetworkRate {
  private readonly last = new Map<string, ContainerCounters>();

  /** Bytes per second across these tasks, or null until a previous reading exists. */
  rate(tasks: readonly TaskStats[], now: number): { rx: number; tx: number } | null {
    let rx = 0;
    let tx = 0;
    let any = false;
    const seen = new Set<string>();
    for (const task of tasks) {
      seen.add(task.containerId);
      if (task.networkRxBytes === null || task.networkTxBytes === null) {
        this.last.delete(task.containerId);
        continue;
      }
      const previous = this.last.get(task.containerId);
      this.last.set(task.containerId, { rx: task.networkRxBytes, tx: task.networkTxBytes, at: now });
      if (previous === undefined || now <= previous.at) {
        continue;
      }
      const seconds = (now - previous.at) / 1000;
      const rxDelta = counterDelta(task.networkRxBytes, previous.rx);
      const txDelta = counterDelta(task.networkTxBytes, previous.tx);
      if (rxDelta !== null && txDelta !== null) {
        rx += rxDelta / seconds;
        tx += txDelta / seconds;
        any = true;
      }
    }
    for (const id of this.last.keys()) {
      if (!seen.has(id)) {
        this.last.delete(id);
      }
    }
    return any ? { rx, tx } : null;
  }
}

/** The tasks' figures added up, or null if none of them reported this one. */
const sumKnown = (values: ReadonlyArray<number | null>): number | null =>
  values.reduce<number | null>((total, value) => (value === null ? total : (total ?? 0) + value), null);
const maxMemoryLimit = (tasks: readonly TaskStats[]): number | null =>
  tasks.reduce<number | null>(
    (highest, task) =>
      task.memoryLimitBytes === null ? highest : Math.max(highest ?? 0, task.memoryLimitBytes),
    null,
  );

interface LatestNetwork {
  rx: number | null;
  tx: number | null;
}

/** Keeps the history current: one reading of the server and of each service, every scrape interval. */
export class MonitorEngine {
  private readonly probe: HostProbe;
  readonly storage: StorageScanner;
  private readonly systemRate = new NetworkRate();
  private readonly serviceRates = new Map<string, NetworkRate>();
  private timer: NodeJS.Timeout | undefined;
  private rollupTimer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private scraping = false;
  private dockerAvailable = true;
  private dockerLastSeenAt: number | null = null;
  private network: LatestNetwork = { rx: null, tx: null };
  private cached: { at: number; reading: HostReading } | null = null;

  constructor(private readonly deps: AppDeps) {
    this.probe = new HostProbe(deps.config.dataDir);
    this.storage = new StorageScanner(deps);
  }

  start(): void {
    this.stopped = false;
    this.schedule();
    this.rollupTimer = setInterval(() => this.safely(() => rollUp(this.deps.db)), ROLLUP_INTERVAL_MS);
    this.rollupTimer.unref();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
    this.prune();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.rollupTimer);
    clearInterval(this.pruneTimer);
    this.storage.stop();
  }

  private prune(): void {
    this.safely(() => {
      const { metrics } = readMonitoringSettings(this.deps);
      pruneMetrics(
        this.deps.db,
        { retention: metrics.retention, unit: metrics.retentionUnit },
        this.deps.now(),
      );
    });
  }

  private safely(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not maintain the metrics history");
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    const { metrics } = readMonitoringSettings(this.deps);
    this.timer = setTimeout(() => {
      void this.tick();
    }, metrics.scrapeSeconds * 1000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      if (readMonitoringSettings(this.deps).metrics.enabled) {
        await this.scrape();
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not record metrics");
    } finally {
      this.schedule();
    }
  }

  /** One reading of everything. Skipped while the previous one is still going, rather than piling up. */
  async scrape(): Promise<void> {
    if (this.scraping) {
      return;
    }
    this.scraping = true;
    try {
      await this.record();
    } finally {
      this.scraping = false;
    }
  }

  private async record(): Promise<void> {
    const { deps } = this;
    const now = deps.now();
    const host = await this.probe.read();
    this.cached = { at: now, reading: host };

    const samples = await this.readServices();
    this.network = samples === null ? { rx: null, tx: null } : this.applyServiceSamples(samples, now);

    insertReading(deps.db, {
      scope: "system",
      at: now,
      cpu: host.cpuPercent,
      memoryUsed: host.memoryUsed,
      memoryTotal: host.memoryTotal,
      diskUsed: host.diskUsed,
      diskTotal: host.diskTotal,
      rx: this.network.rx,
      tx: this.network.tx,
    });
  }

  private applyServiceSamples(samples: ReadonlyMap<string, TaskStats[]>, now: number): LatestNetwork {
    const { deps } = this;
    const everything = [...samples.values()].flat();
    const total = this.systemRate.rate(everything, now);

    for (const [scope, tasks] of samples) {
      let rates = this.serviceRates.get(scope);
      if (rates === undefined) {
        rates = new NetworkRate();
        this.serviceRates.set(scope, rates);
      }
      const rate = rates.rate(tasks, now);
      const disk = this.storage.sizeOf(scope);
      insertReading(deps.db, {
        scope,
        at: now,
        cpu: sumKnown(tasks.map((task) => task.cpuPercent)),
        memoryUsed: sumKnown(tasks.map((task) => task.memoryUsedBytes)),
        memoryTotal: maxMemoryLimit(tasks) || null,
        diskUsed: disk,
        diskTotal: null,
        rx: rate?.rx ?? null,
        tx: rate?.tx ?? null,
      });
    }
    for (const scope of this.serviceRates.keys()) {
      if (!samples.has(scope)) {
        this.serviceRates.delete(scope);
      }
    }
    return { rx: total?.rx ?? null, tx: total?.tx ?? null };
  }

  /** Null when Docker is not answering, which is a different thing from nothing running. */
  private async readServices(): Promise<Map<string, TaskStats[]> | null> {
    const { docker } = this.deps;
    let names: string[];
    try {
      names = (await withinDeadline(docker.listServices(), "list services"))
        .map((service) => service.name)
        .filter((name) => name.includes("_"));
      this.dockerAvailable = true;
      this.dockerLastSeenAt = this.deps.now();
    } catch (error) {
      if (!(error instanceof DockerDriverError)) {
        throw error;
      }
      this.dockerAvailable = false;
      return null;
    }

    const samples = new Map<string, TaskStats[]>();
    for (let start = 0; start < names.length; start += MAX_CONCURRENT_SERVICES) {
      await Promise.all(
        names.slice(start, start + MAX_CONCURRENT_SERVICES).map(async (name) => {
          const separator = name.indexOf("_");
          const scope = `${name.slice(0, separator)}/${name.slice(separator + 1)}`;
          const tasks = await docker
            .serviceStats(name, { signal: AbortSignal.timeout(DOCKER_ANSWER_MS) })
            .catch(() => [] as TaskStats[]);
          if (tasks.length > 0) {
            samples.set(scope, tasks);
          }
        }),
      );
    }
    return samples;
  }

  /** What the gauges show right now. Figures that can't be read are null, never zero. */
  async current(): Promise<SystemMetrics> {
    const { deps } = this;
    const now = deps.now();
    const cached = this.cached;
    const reading =
      cached !== null && now - cached.at < CURRENT_CACHE_MS ? cached.reading : await this.probe.read();
    if (cached === null || now - cached.at >= CURRENT_CACHE_MS) {
      this.cached = { at: now, reading };
    }

    await withinDeadline(deps.docker.ping(), "ping")
      .then(() => {
        this.dockerAvailable = true;
        this.dockerLastSeenAt = deps.now();
      })
      .catch((error: unknown) => {
        if (error instanceof DockerDriverError) {
          this.dockerAvailable = false;
          return;
        }
        throw error;
      });

    return {
      readAt: new Date(now).toISOString(),
      origin: "host",
      scope: "host",
      cpu: { percent: reading.cpuPercent, cores: reading.cores, load: reading.load },
      memory: {
        usedBytes: reading.memoryUsed,
        totalBytes: reading.memoryTotal,
        percent: percentOf(reading.memoryUsed, reading.memoryTotal),
      },
      disk: {
        usedBytes: reading.diskUsed,
        totalBytes: reading.diskTotal,
        percent: percentOf(reading.diskUsed, reading.diskTotal),
        path: deps.config.dataDir,
      },
      network: {
        scope: "containers",
        origin: metricOriginOf(deps),
        rxBytesPerSecond: this.dockerAvailable ? this.network.rx : null,
        txBytesPerSecond: this.dockerAvailable ? this.network.tx : null,
      },
      docker: {
        available: this.dockerAvailable,
        // Nothing seen yet in this run: the newest reading on record is the last Docker is known to have given.
        lastSeenAt:
          this.dockerLastSeenAt === null
            ? latestServiceReadingAt(deps.db)
            : new Date(this.dockerLastSeenAt).toISOString(),
      },
    };
  }
}

function percentOf(used: number | null, total: number | null): number | null {
  return used === null || total === null || total <= 0 ? null : (used / total) * 100;
}

const engines = new WeakMap<AppDeps, MonitorEngine>();

export function engineFor(deps: AppDeps): MonitorEngine {
  let engine = engines.get(deps);
  if (engine === undefined) {
    engine = new MonitorEngine(deps);
    engines.set(deps, engine);
  }
  return engine;
}
