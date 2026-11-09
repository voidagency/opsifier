import type {
  LogFeedState,
  LogSearchQuery,
  LogSearchResult,
  ServiceLogEvent,
  ServiceLogLine,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../core/context";
import { type DockerDriver, DockerDriverError, type LogLine } from "../../core/docker";
import type { TopicChannel, TopicFeed, TopicProvider } from "../../core/realtime";
import { LineRedactor, Redactor } from "../../core/tools";
import { searchStoredLogs } from "../monitor/logstore";
import { readMonitoringSettings } from "../monitor/settings";
import { qualifiedName } from "../services/compile";
import { serviceRedactor } from "../services/masking";
import { type ServiceRef, serviceExists } from "./repo";
import { sleep } from "./timing";
import { parseServiceTopic } from "./topics";

const TOPIC_PREFIX = "service-logs:";

/** Swarm applies this to each task it still knows, so a service can answer several times as many. */
const TAIL_LINES = 200;
/** After a follow ended by itself: read everything since the last line, in practice very little. */
const RESUME_TAIL_LINES = 10_000;
/** After skipping ahead, how far back the fresh follow starts, so nothing of the present is missed. */
const SKIP_AHEAD_MARGIN_SECONDS = 1;
const MAX_LINE_CHARS = 16 * 1024;
const MAX_FEEDS = 32;

const MAX_SCAN_LINES = 50_000;

export interface LogFeedTiming {
  /** How long lines may wait before going out. */
  flushMs: number;
  /** How long the first lines are held back, so history from several tasks can be put in order. */
  settleMs: number;
  /** How often the service is checked while it is being followed. */
  watchMs: number;
  /** How long to wait before looking again for a service that is not there. */
  retryMs: number;
  /** The shortest gap between two full batches, which is what caps the rate of a runaway log. */
  paceMs: number;
  /** How long one stuck subscriber can hold up all the others. */
  pressureWaitMs: number;
  /** How far behind the live output the feed may read before it drops what Docker has queued. */
  behindMs: number;
}

const DEFAULT_TIMING: LogFeedTiming = {
  flushMs: 100,
  settleMs: 200,
  watchMs: 3000,
  retryMs: 2000,
  paceMs: 200,
  pressureWaitMs: 5000,
  behindMs: 5000,
};

export interface LogFeedLimits {
  ringLines: number;
  ringBytes: number;
  batchLines: number;
  batchBytes: number;
  /** Bytes queued for a subscriber before the feed stops reading from Docker. */
  highWaterBytes: number;
}

const DEFAULT_LIMITS: LogFeedLimits = {
  ringLines: 1000,
  ringBytes: 1024 * 1024,
  batchLines: 250,
  batchBytes: 128 * 1024,
  highWaterBytes: 1024 * 1024,
};

const PRESSURE_POLL_MS = 25;

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what removes them
const ANSI_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\^_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is what removes them
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Colours and cursor movement mean nothing in a log view, and a line must not be able to send them. */
export function plainText(text: string): string {
  return text.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
}

/**
 * The lines of one service with its secrets removed, each stream on its own so that one split over
 * several lines can be put back together. Docker cuts a long line into pieces too.
 */
export class RedactedLogStreams<M> {
  private readonly streams: Record<LogLine["stream"], LineRedactor<M>>;

  constructor(redactor: Redactor, emit: (line: string, meta: M) => void, holdMs?: number | null) {
    this.streams = {
      stdout: new LineRedactor(redactor, emit, holdMs),
      stderr: new LineRedactor(redactor, emit, holdMs),
    };
  }

  use(redactor: Redactor): void {
    this.streams.stdout.use(redactor);
    this.streams.stderr.use(redactor);
  }

  write(entry: LogLine, meta: M): void {
    this.streams[entry.stream].write(plainText(entry.line), meta);
  }

  flush(): void {
    this.streams.stdout.flush();
    this.streams.stderr.flush();
  }
}

/** A finished batch of lines with its secrets removed, in the order they came. */
export function redactLogEntries(redactor: Redactor, entries: readonly LogLine[]): LogLine[] {
  const redacted = [...entries];
  const streams = new RedactedLogStreams<number>(
    redactor,
    (line, index) => {
      redacted[index] = { ...(entries[index] as LogLine), line };
    },
    null,
  );
  entries.forEach((entry, index) => {
    streams.write(entry, index);
  });
  streams.flush();
  return redacted;
}

/** Docker trims trailing zeros, so timestamps only compare as text once they are the same width. */
export function comparable(at: string | null): string {
  if (at === null) {
    return "";
  }
  const [seconds = "", fraction = ""] = at.replace(/Z$/, "").split(".");
  return `${seconds}.${fraction.padEnd(9, "0")}`;
}

export function toLogLine(entry: LogLine, seq: number): ServiceLogLine {
  const text = plainText(entry.line);
  return {
    seq,
    stream: entry.stream,
    line: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
    at: entry.timestamp ?? null,
  };
}

interface LagGauge {
  /** When this follow began, on our clock. Lines stamped earlier are history. */
  startedAt: number;
  /** The smallest age seen so far, which is as close as this can get to Docker's clock. */
  freshest: number;
}

interface LogFeedOptions {
  docker: DockerDriver;
  logger: AppDeps["logger"];
  /** The Swarm service to follow. */
  name: string;
  channel: TopicChannel;
  /** What to hide, given what the running container was started with. Asked again as things change. */
  redactor?: (applied: readonly string[]) => Redactor;
  timing?: Partial<LogFeedTiming>;
  limits?: Partial<LogFeedLimits>;
}

/**
 * Follows one service's logs for as long as someone is subscribed.
 *
 * Memory is bounded twice over: the lines kept for late subscribers live in a ring, and the lines on
 * their way out in a batch that is only allowed to fill up. Once it is full nothing more is read from
 * Docker until the batch has left and the slowest subscriber has caught up, so an endless log slows
 * down the follow instead of piling up here.
 *
 * Slowing down only moves the pile, though: Swarm queues a follow's lines without limit, so a service
 * that prints a lot at every start leaves a backlog that outlives the burst and grows with each restart.
 * Once the lines being read are more than a few seconds old the rest of the queue is not worth reading,
 * so the follow is dropped, which discards it, and a new one starts from the present.
 */
export class LogFeed implements TopicFeed {
  private readonly id = nanoid(8);
  private readonly controller = new AbortController();
  private readonly timing: LogFeedTiming;
  private readonly limits: LogFeedLimits;
  private state: LogFeedState = "connecting";
  private ring: ServiceLogLine[] = [];
  private ringBytes = 0;
  private batch: ServiceLogLine[] = [];
  private batchBytes = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private settlesAt = 0;
  private seq = 0;
  /** Set by skipping ahead: seconds since the epoch where the next follow starts instead. */
  private skipTo: number | undefined;
  /** Where to pick up after a follow that ended by itself. Comparable form of the last timestamp. */
  private lastSeen: string | null = null;
  private lastSeenSeconds: number | undefined;
  private readonly clean: RedactedLogStreams<LogLine>;

  constructor(private readonly options: LogFeedOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.settlesAt = Date.now() + this.timing.settleMs;
    this.clean = new RedactedLogStreams(this.redactorFor([]), (line, entry) => this.admit(line, entry));
    void this.run().catch((error: unknown) => {
      options.logger.error({ err: error, service: options.name }, "A log feed stopped unexpectedly");
    });
  }

  close(): void {
    this.clean.flush();
    this.controller.abort();
    clearTimeout(this.flushTimer);
  }

  /** Failing to work this out must leave the patterns in force, not stop the log. */
  private redactorFor(applied: readonly string[]): Redactor {
    try {
      return this.options.redactor?.(applied) ?? new Redactor();
    } catch (error) {
      this.options.logger.warn({ err: error, service: this.options.name }, "Could not read what to hide");
      return new Redactor();
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
        ringLines: this.limits.ringLines,
      },
    ];
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private async run(): Promise<void> {
    const { docker, logger, name } = this.options;
    while (!this.signal.aborted) {
      try {
        const service = await docker.inspectService(name);
        if (service === null) {
          this.setState("waiting");
          await sleep(this.timing.retryMs, this.signal);
          continue;
        }
        this.clean.use(this.redactorFor(service.spec.TaskTemplate.ContainerSpec.Env ?? []));
        await this.follow(service.id);
      } catch (error) {
        if (!this.signal.aborted) {
          logger.warn({ err: error, service: name }, "Could not read a service's logs");
          this.setState("error");
          await sleep(this.timing.retryMs, this.signal);
        }
      }
    }
  }

  /** Follows until the service is replaced, the stream ends or nobody is listening any more. */
  private async follow(serviceId: string): Promise<void> {
    const { docker, name } = this.options;
    const stream = new AbortController();
    const stop = () => stream.abort();
    this.signal.addEventListener("abort", stop, { once: true });
    const watcher = setInterval(() => void this.watch(serviceId, stream), this.timing.watchMs);
    void this.watch(serviceId, stream);

    const resuming = this.lastSeenSeconds !== undefined;
    const skipped = this.skipTo;
    this.skipTo = undefined;
    const startedAt = Date.now();
    const lag: LagGauge = { startedAt, freshest: Number.POSITIVE_INFINITY };
    let skippingAhead = false;
    try {
      for await (const entry of docker.serviceLogs(name, {
        follow: true,
        timestamps: true,
        tail: skipped !== undefined || !resuming ? TAIL_LINES : RESUME_TAIL_LINES,
        since: skipped ?? (resuming ? this.lastSeenSeconds : undefined),
        signal: stream.signal,
      })) {
        if (stream.signal.aborted) {
          break;
        }
        if (resuming && this.isAlreadySeen(entry)) {
          continue;
        }
        this.accept(entry);
        if (this.isBatchFull()) {
          if (this.isFarBehind(entry, lag)) {
            skippingAhead = true;
            break;
          }
          await this.drain();
        }
      }
    } finally {
      clearInterval(watcher);
      this.signal.removeEventListener("abort", stop);
      stream.abort();
      this.clean.flush();
      this.flush();
    }

    if (skippingAhead) {
      this.markGap();
      this.skipTo = Math.floor(Date.now() / 1000) - SKIP_AHEAD_MARGIN_SECONDS;
      return;
    }

    // Docker keeps a follow open across restarts, so one that ends means the daemon went away.
    if (!this.signal.aborted) {
      await sleep(this.timing.retryMs, this.signal);
    }
  }

  /**
   * Whether the line just read is old news. History from before this follow says nothing about that, and
   * the Docker host's clock may differ from ours, so an age only counts beyond the freshest one seen.
   */
  private isFarBehind(entry: LogLine, lag: LagGauge): boolean {
    if (entry.timestamp === undefined) {
      return false;
    }
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at) || at < lag.startedAt) {
      return false;
    }
    const age = Date.now() - at;
    lag.freshest = Math.min(lag.freshest, age);
    return age - lag.freshest > this.timing.behindMs;
  }

  /** Tells whoever is reading that this is not where the last line left off. */
  private markGap(): void {
    const line: ServiceLogLine = {
      seq: this.seq,
      stream: "stdout",
      line: "",
      at: new Date().toISOString(),
      gap: true,
    };
    this.seq += 1;
    this.remember([line]);
    this.publish({ kind: "lines", feed: this.id, lines: [line] });
  }

  /** Docker keeps a follow open after its service is removed, so this is how that gets noticed. */
  private async watch(serviceId: string, stream: AbortController): Promise<void> {
    const { docker, logger, name } = this.options;
    try {
      const [service, tasks] = await Promise.all([
        docker.inspectService(name),
        docker.listTasks({ service: name }),
      ]);
      if (service?.id !== serviceId) {
        stream.abort();
        return;
      }
      this.clean.use(this.redactorFor(service.spec.TaskTemplate.ContainerSpec.Env ?? []));
      this.setState(tasks.some((task) => task.desiredState === "running") ? "streaming" : "waiting");
    } catch (error) {
      logger.debug({ err: error, service: name }, "Could not check on a service's tasks");
    }
  }

  private isAlreadySeen(entry: LogLine): boolean {
    return (
      this.lastSeen !== null && entry.timestamp !== undefined && comparable(entry.timestamp) <= this.lastSeen
    );
  }

  private accept(entry: LogLine): void {
    this.clean.write(entry, entry);
  }

  private admit(text: string, entry: LogLine): void {
    const line = toLogLine({ ...entry, line: text }, 0);
    this.batch.push(line);
    this.batchBytes += line.line.length;
    if (line.at !== null) {
      const seen = comparable(line.at);
      if (this.lastSeen === null || seen > this.lastSeen) {
        this.lastSeen = seen;
        this.lastSeenSeconds = Math.floor(Date.parse(line.at) / 1000);
      }
    }
    if (this.flushTimer === undefined && !this.isBatchFull()) {
      this.flushTimer = setTimeout(
        () => {
          this.flushTimer = undefined;
          this.flush();
        },
        Math.max(this.timing.flushMs, this.settlesAt - Date.now()),
      );
    }
  }

  private isBatchFull(): boolean {
    return this.batch.length >= this.limits.batchLines || this.batchBytes >= this.limits.batchBytes;
  }

  /** Sends what is waiting and returns once the subscribers can take more. */
  private async drain(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();

    const deadline = Date.now() + this.timing.pressureWaitMs;
    while (
      !this.signal.aborted &&
      this.options.channel.pressure() > this.limits.highWaterBytes &&
      Date.now() < deadline
    ) {
      await sleep(PRESSURE_POLL_MS, this.signal);
    }
    await sleep(this.timing.paceMs, this.signal);
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
    this.batchBytes = 0;
    this.remember(lines);
    this.publish({ kind: "lines", feed: this.id, lines });
  }

  private remember(lines: readonly ServiceLogLine[]): void {
    this.ring.push(...lines);
    this.ringBytes += lines.reduce((total, line) => total + line.line.length, 0);
    let excess = 0;
    while (
      excess < this.ring.length &&
      (this.ring.length - excess > this.limits.ringLines || this.ringBytes > this.limits.ringBytes)
    ) {
      this.ringBytes -= this.ring[excess]?.line.length ?? 0;
      excess += 1;
    }
    if (excess > 0) {
      this.ring = this.ring.slice(excess);
    }
  }

  private setState(state: LogFeedState): void {
    if (state !== this.state) {
      this.state = state;
      this.publish({ kind: "state", feed: this.id, state });
    }
  }

  private publish(event: ServiceLogEvent): void {
    if (!this.signal.aborted) {
      this.options.channel.publish(event);
    }
  }
}

export interface LogsProvider extends TopicProvider {
  /** How many feeds are open. */
  openFeeds(): number;
}

function refusedFeed(state: LogFeedState): TopicFeed {
  const snapshot: ServiceLogEvent = { kind: "snapshot", feed: "none", state, lines: [] };
  return { close: () => {}, replay: () => [snapshot] };
}

export function createLogsProvider(
  deps: Pick<AppDeps, "db" | "docker" | "logger" | "secrets">,
  options: { timing?: Partial<LogFeedTiming>; limits?: Partial<LogFeedLimits> } = {},
): LogsProvider {
  let open = 0;
  return {
    matches: (topic) => topic.startsWith(TOPIC_PREFIX),
    openFeeds: () => open,
    open(topic: string, channel: TopicChannel): TopicFeed {
      const target = parseServiceTopic(topic, TOPIC_PREFIX);
      if (target === null || !serviceExists(deps.db, target) || open >= MAX_FEEDS) {
        return refusedFeed("error");
      }
      open += 1;
      const feed = new LogFeed({
        docker: deps.docker,
        logger: deps.logger,
        name: qualifiedName(target.projectName, target.serviceName),
        channel,
        redactor: (applied) => serviceRedactor(deps, target, applied),
        ...options,
      });
      return {
        close() {
          open -= 1;
          feed.close();
        },
        replay: () => feed.replay(),
      };
    },
  };
}

const LEVELS: ReadonlyArray<readonly [Exclude<LogSearchQuery["level"], "any">, RegExp]> = [
  ["error", /\b(?:fatal|panic|emerg|alert|crit(?:ical)?|severe|err(?:or)?)\b/i],
  ["warn", /\bwarn(?:ing)?\b/i],
  ["info", /\b(?:info|notice)\b/i],
  ["debug", /\b(?:debug|trace|verbose)\b/i],
];

/** The level a line is about. Whichever word comes first wins, the way log formats put it first. */
export function detectLevel(line: string): LogSearchQuery["level"] {
  let found: LogSearchQuery["level"] = "any";
  let earliest = Number.POSITIVE_INFINITY;
  for (const [level, pattern] of LEVELS) {
    const position = line.search(pattern);
    if (position !== -1 && position < earliest) {
      earliest = position;
      found = level;
    }
  }
  return found;
}

function matches(line: ServiceLogLine, query: LogSearchQuery, needle: string): boolean {
  return (
    (query.stream === "all" || line.stream === query.stream) &&
    (needle === "" || line.line.toLowerCase().includes(needle)) &&
    (query.level === "any" || detectLevel(line.line) === query.level)
  );
}

/**
 * Searches what Docker still holds for a service. It reads a bounded number of lines and keeps only
 * the newest matches, so a huge log costs time but never memory.
 */
export async function searchServiceLogs(
  deps: Pick<AppDeps, "docker" | "now"> & Partial<Pick<AppDeps, "db" | "secrets" | "logger">>,
  target: ServiceRef,
  query: LogSearchQuery,
  signal?: AbortSignal,
): Promise<LogSearchResult> {
  const { db, secrets, logger } = deps;
  const redactor =
    db !== undefined && secrets !== undefined && logger !== undefined
      ? serviceRedactor({ db, secrets, logger }, target)
      : new Redactor();
  if (db !== undefined && readMonitoringSettings({ db }).logs.enabled) {
    const stored = searchStoredLogs({ db, now: deps.now }, target, query);
    return { ...stored, lines: stored.lines.map((line) => ({ ...line, line: redactor.apply(line.line) })) };
  }
  const needle = query.q.toLowerCase();
  const found: ServiceLogLine[] = [];
  let scanned = 0;
  let truncated = false;
  const keep = new RedactedLogStreams<LogLine>(
    redactor,
    (text, entry) => {
      const line = toLogLine({ ...entry, line: text }, scanned);
      if (matches(line, query, needle)) {
        found.push(line);
        if (found.length > query.limit) {
          found.shift();
          truncated = true;
        }
      }
    },
    null,
  );

  try {
    for await (const entry of deps.docker.serviceLogs(qualifiedName(target.projectName, target.serviceName), {
      timestamps: true,
      tail: MAX_SCAN_LINES,
      since: query.since === undefined ? undefined : Math.floor(deps.now() / 1000) - query.since,
      signal,
    })) {
      if (scanned >= MAX_SCAN_LINES) {
        truncated = true;
        break;
      }
      keep.write(entry, entry);
      scanned += 1;
    }
  } catch (error) {
    // A service that has never been deployed simply has nothing to search.
    if (!(error instanceof DockerDriverError && error.statusCode === 404)) {
      throw error;
    }
  }
  keep.flush();

  found.sort((a, b) => comparable(a.at).localeCompare(comparable(b.at)));
  return { lines: found, scanned, truncated };
}
