import type { MetricOrigin, ServiceMetrics, ServicesMetrics, TaskMetrics } from "@opsifier/contract";
import { servicesMetricsTopic } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError, type TaskStats } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";
import { latestReadingAt, latestServiceReadingAt } from "../monitor/store";
import { qualifiedName } from "../services/compile";
import type { ServiceRef } from "./repo";
import { sleep } from "./timing";
import { parseServiceTopic } from "./topics";

const TOPIC_PREFIX = "service-metrics:";

export const METRICS_INTERVAL_MS = 3000;
/** Docker takes a second or two to sample a container, so the wait is measured from the start. */
const MIN_REST_MS = 200;
const MAX_CONCURRENT_SERVICES = 4;

/** Docker can leave out any figure while a container starts or dies. Only a real number gets past. */
const reading = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;
const bytes = (value: number | null): number | null => {
  const known = reading(value);
  return known === null ? null : Math.round(known);
};

/** Adds what is known. Only a figure no task reported at all stays unknown. */
const plus = (total: number | null, value: number | null): number | null =>
  value === null ? total : (total ?? 0) + value;

type Figures = Pick<
  ServiceMetrics,
  | "cpuPercent"
  | "cpuCapacityPercent"
  | "memoryUsedBytes"
  | "memoryLimitBytes"
  | "networkRxBytes"
  | "networkTxBytes"
  | "readAt"
>;

const NO_FIGURES: Figures = {
  cpuPercent: null,
  cpuCapacityPercent: null,
  memoryUsedBytes: null,
  memoryLimitBytes: null,
  networkRxBytes: null,
  networkTxBytes: null,
  readAt: null,
};

export function metricOriginOf(deps: Pick<AppDeps, "docker">): MetricOrigin {
  return deps.docker.kind === "fake" ? "simulated" : "docker";
}

/** Adds up the tasks of a service. */
export function sumTaskStats(samples: readonly TaskStats[]): Figures {
  return samples.reduce<Figures>(
    (total, sample) => ({
      cpuPercent: plus(total.cpuPercent, reading(sample.cpuPercent)),
      cpuCapacityPercent: plus(total.cpuCapacityPercent, reading(sample.cpuCapacityPercent)),
      memoryUsedBytes: plus(total.memoryUsedBytes, bytes(sample.memoryUsedBytes)),
      memoryLimitBytes: plus(total.memoryLimitBytes, bytes(sample.memoryLimitBytes)),
      networkRxBytes: plus(total.networkRxBytes, bytes(sample.networkRxBytes)),
      networkTxBytes: plus(total.networkTxBytes, bytes(sample.networkTxBytes)),
      readAt: sample.readAt,
    }),
    NO_FIGURES,
  );
}

function toTaskMetrics(sample: TaskStats): TaskMetrics {
  const used = bytes(sample.memoryUsedBytes);
  const limit = bytes(sample.memoryLimitBytes);
  return {
    taskId: sample.taskId,
    slot: sample.slot,
    cpuPercent: reading(sample.cpuPercent),
    cpuCapacityPercent: reading(sample.cpuCapacityPercent),
    memoryUsedBytes: used,
    memoryLimitBytes: limit,
    memoryPercent: used === null || limit === null || limit <= 0 ? null : (used / limit) * 100,
    networkRxBytes: bytes(sample.networkRxBytes),
    networkTxBytes: bytes(sample.networkTxBytes),
  };
}

type ReadingDeps = Pick<AppDeps, "docker" | "db">;

/** What these tasks add up to. With none there are no figures, and only the last reading can be dated. */
export function serviceReading(
  deps: ReadingDeps,
  target: ServiceRef,
  samples: readonly TaskStats[],
): ServiceMetrics {
  const figures = sumTaskStats(samples);
  return {
    ...figures,
    available: true,
    tasks: samples.length,
    lastReadAt: figures.readAt ?? latestReadingAt(deps.db, `${target.projectName}/${target.serviceName}`),
    origin: metricOriginOf(deps),
    scope: "service",
  };
}

/** Docker did not answer, which says nothing about the service except when it was last seen. */
export function unavailableReading(deps: ReadingDeps, target: ServiceRef): ServiceMetrics {
  return { ...serviceReading(deps, target, []), available: false };
}

/** One reading of one service. A service with nothing running has no figures, and that is not zero. */
export async function readServiceMetrics(
  deps: ReadingDeps,
  target: ServiceRef,
  signal?: AbortSignal,
): Promise<ServiceMetrics> {
  try {
    return serviceReading(
      deps,
      target,
      await deps.docker.serviceStats(qualifiedName(target.projectName, target.serviceName), { signal }),
    );
  } catch (error) {
    if (!(error instanceof DockerDriverError)) {
      throw error;
    }
    // Docker knows no such service, so it is simply not running. Anything else is a daemon that is away.
    return error.statusCode === 404 ? serviceReading(deps, target, []) : unavailableReading(deps, target);
  }
}

async function readAllServices(
  deps: Pick<AppDeps, "docker" | "now" | "db">,
  signal: AbortSignal,
): Promise<ServicesMetrics> {
  const origin = metricOriginOf(deps);
  const unavailable = (): ServicesMetrics => ({
    available: false,
    readAt: null,
    lastReadAt: latestServiceReadingAt(deps.db),
    origin,
    scope: "containers",
    services: [],
  });

  let names: string[];
  try {
    // Only names with an underscore are workloads. The panel and the proxy have none.
    names = (await deps.docker.listServices())
      .map((service) => service.name)
      .filter((name) => name.includes("_"));
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return unavailable();
    }
    throw error;
  }

  const services: ServicesMetrics["services"] = [];
  let unanswered = 0;
  for (let start = 0; start < names.length && !signal.aborted; start += MAX_CONCURRENT_SERVICES) {
    const readings = await Promise.all(
      names.slice(start, start + MAX_CONCURRENT_SERVICES).map(async (name) => {
        // Project names have no underscore, so the first one is always the separator.
        const separator = name.indexOf("_");
        const projectName = name.slice(0, separator);
        const serviceName = name.slice(separator + 1);
        const samples = await deps.docker.serviceStats(name, { signal }).catch(() => {
          unanswered += 1;
          return [] as TaskStats[];
        });
        return { projectName, serviceName, tasks: samples.map(toTaskMetrics) };
      }),
    );
    services.push(...readings.filter((service) => service.tasks.length > 0));
  }
  // Docker listed its services and then answered nothing about any of them: it went away just now.
  if (names.length > 0 && unanswered === names.length) {
    return unavailable();
  }
  services.sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.serviceName.localeCompare(b.serviceName),
  );
  const readAt = new Date(deps.now()).toISOString();
  return { available: true, readAt, lastReadAt: readAt, origin, scope: "containers", services };
}

/**
 * Takes a reading now and then at every interval, for as long as someone is subscribed. The next
 * reading starts after the last one ended, so a slow server gets fewer of them rather than a pile.
 */
export class PollingFeed<T> implements TopicFeed {
  private readonly controller = new AbortController();
  private latest: T | undefined;

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly channel: TopicChannel,
    private readonly intervalMs: number,
    private readonly logger: AppDeps["logger"],
    private readonly minRestMs: number = MIN_REST_MS,
  ) {
    void this.run();
  }

  close(): void {
    this.controller.abort();
  }

  /** A second subscriber is told the latest reading rather than waiting for the next. */
  replay(): readonly unknown[] {
    return this.latest === undefined ? [] : [this.latest];
  }

  private async run(): Promise<void> {
    const { signal } = this.controller;
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        const value = await this.read(signal);
        if (!signal.aborted) {
          this.latest = value;
          this.channel.publish(value);
        }
      } catch (error) {
        if (!signal.aborted) {
          this.logger.warn({ err: error }, "Could not read metrics");
        }
      }
      await sleep(Math.max(this.minRestMs, this.intervalMs - (Date.now() - startedAt)), signal);
    }
  }
}

export function createMetricsProvider(
  deps: Pick<AppDeps, "docker" | "logger" | "now" | "db">,
  options: { intervalMs?: number } = {},
): TopicProvider {
  const intervalMs = options.intervalMs ?? METRICS_INTERVAL_MS;
  return {
    matches: (topic) => topic === servicesMetricsTopic || topic.startsWith(TOPIC_PREFIX),
    open(topic: string, channel: TopicChannel): TopicFeed {
      if (topic === servicesMetricsTopic) {
        return new PollingFeed((signal) => readAllServices(deps, signal), channel, intervalMs, deps.logger);
      }
      const target = parseServiceTopic(topic, TOPIC_PREFIX);
      if (target === null) {
        throw new Error(`Invalid metrics topic: ${topic}`);
      }
      return new PollingFeed(
        (signal) => readServiceMetrics(deps, target, signal),
        channel,
        intervalMs,
        deps.logger,
      );
    },
  };
}
