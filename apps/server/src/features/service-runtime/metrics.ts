import type { ServiceMetrics, ServicesMetrics, TaskMetrics } from "@opsifier/contract";
import { servicesMetricsTopic } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError, type TaskStats } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";
import { qualifiedName } from "../services/compile";
import type { ServiceRef } from "./repo";
import { sleep } from "./timing";
import { parseServiceTopic } from "./topics";

const TOPIC_PREFIX = "service-metrics:";

export const METRICS_INTERVAL_MS = 3000;
/** Docker takes a second or two to sample a container, so the wait is measured from the start. */
const MIN_REST_MS = 200;
const MAX_CONCURRENT_SERVICES = 4;

/** Docker can leave out any figure while a container starts or dies. Nothing but a number gets past. */
const reading = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
const bytes = (value: number): number => Math.round(reading(value));

const NO_READINGS: ServiceMetrics = {
  cpuPercent: 0,
  memoryUsedBytes: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
  readAt: null,
};

/** Adds up the tasks of a service. */
export function sumTaskStats(samples: readonly TaskStats[]): ServiceMetrics {
  return samples.reduce<ServiceMetrics>(
    (total, sample) => ({
      cpuPercent: total.cpuPercent + reading(sample.cpuPercent),
      memoryUsedBytes: total.memoryUsedBytes + bytes(sample.memoryUsedBytes),
      networkRxBytes: total.networkRxBytes + bytes(sample.networkRxBytes),
      networkTxBytes: total.networkTxBytes + bytes(sample.networkTxBytes),
      readAt: sample.readAt,
    }),
    NO_READINGS,
  );
}

function toTaskMetrics(sample: TaskStats): TaskMetrics {
  const used = bytes(sample.memoryUsedBytes);
  const limit = bytes(sample.memoryLimitBytes);
  return {
    taskId: sample.taskId,
    slot: sample.slot,
    cpuPercent: reading(sample.cpuPercent),
    memoryUsedBytes: used,
    memoryLimitBytes: limit,
    memoryPercent: limit > 0 ? (used / limit) * 100 : 0,
    networkRxBytes: bytes(sample.networkRxBytes),
    networkTxBytes: bytes(sample.networkTxBytes),
  };
}

/** One reading of one service. A service with nothing running, or a daemon that is away, reads zero. */
export async function readServiceMetrics(
  deps: Pick<AppDeps, "docker">,
  target: ServiceRef,
  signal?: AbortSignal,
): Promise<ServiceMetrics> {
  try {
    return sumTaskStats(
      await deps.docker.serviceStats(qualifiedName(target.projectName, target.serviceName), { signal }),
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return NO_READINGS;
    }
    throw error;
  }
}

async function readAllServices(
  deps: Pick<AppDeps, "docker" | "now">,
  signal: AbortSignal,
): Promise<ServicesMetrics> {
  let names: string[];
  try {
    // Only names with an underscore are workloads. The panel and the proxy have none.
    names = (await deps.docker.listServices())
      .map((service) => service.name)
      .filter((name) => name.includes("_"));
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return { available: false, readAt: null, services: [] };
    }
    throw error;
  }

  const services: ServicesMetrics["services"] = [];
  for (let start = 0; start < names.length && !signal.aborted; start += MAX_CONCURRENT_SERVICES) {
    const readings = await Promise.all(
      names.slice(start, start + MAX_CONCURRENT_SERVICES).map(async (name) => {
        // Project names have no underscore, so the first one is always the separator.
        const separator = name.indexOf("_");
        const projectName = name.slice(0, separator);
        const serviceName = name.slice(separator + 1);
        const samples = await deps.docker.serviceStats(name, { signal }).catch(() => [] as TaskStats[]);
        return { projectName, serviceName, tasks: samples.map(toTaskMetrics) };
      }),
    );
    services.push(...readings.filter((service) => service.tasks.length > 0));
  }
  services.sort(
    (a, b) => a.projectName.localeCompare(b.projectName) || a.serviceName.localeCompare(b.serviceName),
  );
  return { available: true, readAt: new Date(deps.now()).toISOString(), services };
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
  deps: Pick<AppDeps, "docker" | "logger" | "now">,
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
