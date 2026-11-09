import type { ServiceLogEvent, ServiceLogLine, ServiceMetrics, TaskMetrics } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../core/context";
import { type ComposeContainerInfo, DockerDriverError, type LogLine } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";
import type { Redactor } from "../../core/tools";
import { comparable, RedactedLogStreams, redactLogEntries, toLogLine } from "../service-runtime/logs";
import {
  METRICS_INTERVAL_MS,
  PollingFeed,
  serviceReading,
  unavailableReading,
} from "../service-runtime/metrics";
import { sleep } from "../service-runtime/timing";
import { parseServiceTopic } from "../service-runtime/topics";
import { serviceRedactor } from "../services/masking";
import { findService } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { composeProject } from "./names";

const LOGS_PREFIX = "service-logs:";
const METRICS_PREFIX = "service-metrics:";

const RING_LINES = 1000;
/** Each container's share of a new follow. */
const TAIL_LINES = 200;
/** After a follow ended by itself: read everything since the last line, in practice very little. */
const RESUME_TAIL_LINES = 10_000;
const FLUSH_MS = 150;
const RETRY_MS = 2000;
const MAX_BATCH_LINES = 500;
/** The shortest gap between two full batches, which is what caps the rate of a runaway log. */
const PACE_MS = 200;

/** Compose services only: everything else goes to the generic provider, which comes later in the list. */
function composeTarget(deps: Pick<AppDeps, "db">, topic: string, prefix: string): ServiceTarget | null {
  const target = parseServiceTopic(topic, prefix);
  if (target === null) {
    return null;
  }
  const record = findService(deps.db, target.projectName, target.serviceName);
  return record?.spec.compose === null || record === undefined ? null : target;
}

/** A child's own stream of a stack's lines: `<child>-<replica> | <text>`, the way Compose names them. */
const childPrefix = (container: ComposeContainerInfo) => `${container.child}-${container.number}`;

/**
 * Follows every child of a stack, one container at a time, through Docker's own log stream: it is the only
 * place that still says which lines were standard error, since `docker compose logs` runs both together.
 * Containers come and go, so they are looked up again for as long as someone is listening.
 */
class ComposeLogFeed implements TopicFeed {
  private readonly id = nanoid(8);
  private readonly controller = new AbortController();
  private ring: ServiceLogLine[] = [];
  private batch: ServiceLogLine[] = [];
  private state: "connecting" | "waiting" | "streaming" | "error" = "connecting";
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Per container, the newest line seen, so a follow that starts again repeats nothing. */
  private readonly lastSeen = new Map<string, { at: string; seconds: number }>();
  private readonly following = new Set<string>();
  /** Stopped containers already read to the end. */
  private readonly finished = new Set<string>();
  /** Each container's output is its own, so a secret split over its lines can be put back together. */
  private readonly clean = new Map<string, RedactedLogStreams<LogLine>>();
  private redactor: Redactor;

  constructor(
    private readonly deps: Pick<AppDeps, "db" | "docker" | "logger" | "secrets">,
    private readonly target: ServiceTarget,
    private readonly channel: TopicChannel,
  ) {
    this.redactor = serviceRedactor(deps, target);
    void this.run();
  }

  close(): void {
    this.controller.abort();
    clearTimeout(this.timer);
    for (const streams of this.clean.values()) {
      streams.flush();
    }
  }

  replay(): ServiceLogEvent[] {
    return [
      {
        kind: "snapshot",
        feed: this.id,
        state: this.state,
        lines: [...this.ring],
        tailLines: TAIL_LINES,
        ringLines: RING_LINES,
      },
    ];
  }

  private setState(state: typeof this.state): void {
    if (state !== this.state) {
      this.state = state;
      this.publish({ kind: "state", feed: this.id, state });
    }
  }

  private publish(event: ServiceLogEvent): void {
    if (!this.controller.signal.aborted) {
      this.channel.publish(event);
    }
  }

  private async run(): Promise<void> {
    const { deps, target } = this;
    const { signal } = this.controller;
    while (!signal.aborted) {
      try {
        const containers = await deps.docker.listComposeContainers(composeProject(target));
        this.setState(
          containers.some((container) => container.state === "running") ? "streaming" : "waiting",
        );
        this.redactor = serviceRedactor(deps, target);
        for (const streams of this.clean.values()) {
          streams.use(this.redactor);
        }
        for (const container of containers) {
          this.startFollowing(container);
        }
      } catch {
        if (signal.aborted) {
          return;
        }
        this.setState("error");
      }
      await sleep(RETRY_MS, signal);
    }
  }

  /** A running child is followed. One that stopped is read once, so that its last words are not missed. */
  private startFollowing(container: ComposeContainerInfo): void {
    const running = container.state === "running";
    if (this.following.has(container.id) || (!running && this.finished.has(container.id))) {
      return;
    }
    this.following.add(container.id);
    void this.follow(container, running).finally(() => this.following.delete(container.id));
  }

  private async follow(container: ComposeContainerInfo, running: boolean): Promise<void> {
    const { signal } = this.controller;
    const resume = this.lastSeen.get(container.id);
    try {
      for await (const entry of this.deps.docker.containerLogs(container.id, {
        follow: running,
        timestamps: true,
        tail: resume === undefined ? TAIL_LINES : RESUME_TAIL_LINES,
        since: resume?.seconds,
        signal,
      })) {
        // Only a follow that starts again can repeat a line: identical lines in one stream are all real.
        if (
          resume !== undefined &&
          entry.timestamp !== undefined &&
          comparable(entry.timestamp) <= resume.at
        ) {
          continue;
        }
        this.accept(container, entry);
        if (this.batch.length >= MAX_BATCH_LINES) {
          this.flush();
          await sleep(PACE_MS, signal);
        }
      }
      if (!running) {
        this.finished.add(container.id);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.deps.logger.debug({ err: error }, "Could not read a Compose container's logs");
      }
    }
  }

  private accept(container: ComposeContainerInfo, entry: LogLine): void {
    if (entry.timestamp !== undefined) {
      const at = comparable(entry.timestamp);
      const seen = this.lastSeen.get(container.id);
      if (seen === undefined || at > seen.at) {
        this.lastSeen.set(container.id, { at, seconds: Math.floor(Date.parse(entry.timestamp) / 1000) });
      }
    }
    this.streamsOf(container).write(entry, entry);
  }

  private streamsOf(container: ComposeContainerInfo): RedactedLogStreams<LogLine> {
    let streams = this.clean.get(container.id);
    if (streams === undefined) {
      streams = new RedactedLogStreams(this.redactor, (text, entry) => this.admit(container, text, entry));
      this.clean.set(container.id, streams);
    }
    return streams;
  }

  private admit(container: ComposeContainerInfo, text: string, entry: LogLine): void {
    const line = toLogLine({ ...entry, line: text }, 0);
    this.batch.push({ ...line, line: `${childPrefix(container)} | ${line.line}` });
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, FLUSH_MS);
    }
  }

  private flush(): void {
    if (this.batch.length === 0) {
      return;
    }
    // Numbered after sorting: a client keeps only what increases, so anything else would vanish.
    const lines = this.batch
      .sort((a, b) => comparable(a.at).localeCompare(comparable(b.at)))
      .map((line) => {
        const numbered = { ...line, seq: this.seq };
        this.seq += 1;
        return numbered;
      });
    this.batch = [];
    this.ring = [...this.ring, ...lines].slice(-RING_LINES);
    this.publish({ kind: "lines", feed: this.id, lines });
  }
}

export function createComposeLogsProvider(
  deps: Pick<AppDeps, "db" | "docker" | "logger" | "secrets">,
): TopicProvider {
  return {
    matches: (topic) => topic.startsWith(LOGS_PREFIX) && composeTarget(deps, topic, LOGS_PREFIX) !== null,
    open(topic: string, channel: TopicChannel): TopicFeed {
      const target = composeTarget(deps, topic, LOGS_PREFIX);
      if (target === null) {
        throw new Error(`Invalid Compose log topic: ${topic}`);
      }
      const feed = new ComposeLogFeed(deps, target, channel);
      return { close: () => feed.close(), replay: () => feed.replay() };
    },
  };
}

/** One reading of a stack: the sum of every running child, the same shape a Swarm service reports. */
export async function readComposeMetrics(
  deps: Pick<AppDeps, "docker" | "db">,
  target: ServiceTarget,
  signal?: AbortSignal,
): Promise<ServiceMetrics> {
  try {
    const containers = await deps.docker.listComposeContainers(composeProject(target));
    const samples = await Promise.all(
      containers
        .filter((container) => container.state === "running")
        .map((container) => deps.docker.containerStats(container.id, { signal })),
    );
    return serviceReading(
      deps,
      target,
      samples.filter((sample) => sample !== null),
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return unavailableReading(deps, target);
    }
    throw error;
  }
}

export type { TaskMetrics };

export function createComposeMetricsProvider(deps: Pick<AppDeps, "db" | "docker" | "logger">): TopicProvider {
  return {
    matches: (topic) =>
      topic.startsWith(METRICS_PREFIX) && composeTarget(deps, topic, METRICS_PREFIX) !== null,
    open(topic: string, channel: TopicChannel): TopicFeed {
      const target = composeTarget(deps, topic, METRICS_PREFIX);
      if (target === null) {
        throw new Error(`Invalid Compose metrics topic: ${topic}`);
      }
      return new PollingFeed(
        (signal) => readComposeMetrics(deps, target, signal),
        channel,
        METRICS_INTERVAL_MS,
        deps.logger,
      );
    },
  };
}

/** Reads what Docker still holds of a stack's children, oldest first. Each child is read up to `tail` lines. */
export async function readComposeLogs(
  deps: Pick<AppDeps, "db" | "docker" | "logger" | "secrets">,
  target: ServiceTarget,
  options: { tail: number; since?: number; signal?: AbortSignal },
): Promise<ServiceLogLine[]> {
  const redactor = serviceRedactor(deps, target);
  const containers = await deps.docker.listComposeContainers(composeProject(target));
  const perChild = await Promise.all(
    containers.map(async (container) => {
      const entries: LogLine[] = [];
      for await (const entry of deps.docker.containerLogs(container.id, {
        timestamps: true,
        tail: options.tail,
        since: options.since,
        signal: options.signal,
      })) {
        entries.push(entry);
      }
      return redactLogEntries(redactor, entries).map((entry) => {
        const line = toLogLine(entry, 0);
        return { ...line, line: `${childPrefix(container)} | ${line.line}` };
      });
    }),
  );
  return perChild
    .flat()
    .sort((a, b) => comparable(a.at).localeCompare(comparable(b.at)))
    .slice(-options.tail)
    .map((line, seq) => ({ ...line, seq }));
}
