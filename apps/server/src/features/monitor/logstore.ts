import type {
  LogSearchQuery,
  LogSearchResult,
  LogStoreStats,
  MonitoringSettings,
  ServiceLogLine,
} from "@opsifier/contract";
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { logCursors, logEntries } from "../../core/db/schema";
import { DockerDriverError, type LogLine } from "../../core/docker";
import { detectLevel, redactLogEntries } from "../service-runtime/logs";
import type { ServiceRef } from "../service-runtime/repo";
import { qualifiedName } from "../services/compile";
import { serviceRedactor } from "../services/masking";
import { listServiceRecords } from "../services/repo";
import { readMonitoringSettings } from "./settings";

const COLLECT_INTERVAL_MS = 30_000;
const MAX_LINES_PER_PASS = 5000;
const MAX_LINE_CHARS = 16 * 1024;
/** What one row costs beyond its text: its other columns and its share of the indexes. */
const ROW_OVERHEAD_BYTES = 48;
/** How many rows one round of trimming looks at, so a big clear-out comes in bites. */
const TRIM_BATCH_ROWS = 10_000;
/** Measuring means reading every row, so it waits until this share of the limit has arrived. */
const MEASURE_AFTER_SHARE = 0.1;

/** Bytes, not characters: a limit on disk use has to count what is on the disk. */
const lineBytes = sql<number>`octet_length(${logEntries.line}) + ${sql.raw(String(ROW_OVERHEAD_BYTES))}`;

const ms = (timestamp: string | undefined, fallback: number): number => {
  const parsed = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isNaN(parsed) ? fallback : parsed;
};

/** Docker trims trailing zeros, so timestamps only compare as text once they are the same width. */
function comparable(at: string): string {
  const [seconds = "", fraction = ""] = at.replace(/Z$/, "").split(".");
  return `${seconds}.${fraction.padEnd(9, "0")}`;
}

function limitBytes(logs: MonitoringSettings["logs"]): number {
  return logs.maxSizeMb * 1024 * 1024;
}

/** Keeps each service's lines in the database while log storage is on, within its limits. */
export class LogStore {
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private collecting = false;
  /** Bytes stored since the store was last measured. */
  private added = 0;

  constructor(private readonly deps: AppDeps) {}

  start(): void {
    this.stopped = false;
    // A restart answers to the limits before anything new arrives.
    try {
      this.prune();
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not prune stored logs");
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), COLLECT_INTERVAL_MS);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const { logs } = readMonitoringSettings(this.deps);
      if (logs.enabled) {
        await this.collectAndTrim();
      } else {
        this.removeExpired(logs);
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not store service logs");
    } finally {
      this.schedule();
    }
  }

  /** One pass, then the limits: age every time, since it costs nothing, and size once enough has arrived. */
  async collectAndTrim(): Promise<number> {
    const stored = await this.collect();
    const { logs } = readMonitoringSettings(this.deps);
    this.removeExpired(logs);
    if (this.added >= limitBytes(logs) * MEASURE_AFTER_SHARE) {
      this.trim(limitBytes(logs));
      this.added = 0;
    }
    return stored;
  }

  /** One pass over every service: what each has printed since the last pass. */
  async collect(): Promise<number> {
    if (this.collecting) {
      return 0;
    }
    this.collecting = true;
    try {
      let stored = 0;
      for (const record of listServiceRecords(this.deps.db)) {
        stored += await this.collectService({ projectName: record.projectName, serviceName: record.name });
      }
      return stored;
    } finally {
      this.collecting = false;
    }
  }

  private async collectService(target: ServiceRef): Promise<number> {
    const { deps } = this;
    const last = resumePoint(deps.db, target);
    const entries: LogLine[] = [];
    try {
      for await (const entry of deps.docker.serviceLogs(
        qualifiedName(target.projectName, target.serviceName),
        {
          timestamps: true,
          tail: MAX_LINES_PER_PASS,
          since: last === undefined ? undefined : Math.floor(Date.parse(last) / 1000),
        },
      )) {
        if (
          entry.timestamp !== undefined &&
          (last === undefined || comparable(entry.timestamp) > comparable(last))
        ) {
          entries.push(entry);
        }
      }
    } catch (error) {
      if (error instanceof DockerDriverError) {
        return 0;
      }
      throw error;
    }

    if (entries.length === 0) {
      return 0;
    }
    entries.sort((a, b) => comparable(a.timestamp ?? "").localeCompare(comparable(b.timestamp ?? "")));
    const newest = entries.at(-1)?.timestamp as string;
    // Before anything is written: what a store keeps must not be what it would have to hide.
    const clean = redactLogEntries(serviceRedactor(deps, target, await appliedEnv(deps, target)), entries);

    const now = deps.now();
    // The lines and where they end are one write, so a panel dying at any moment can't repeat or lose them.
    deps.db.transaction((tx) => {
      for (const entry of clean) {
        const line =
          entry.line.length > MAX_LINE_CHARS ? `${entry.line.slice(0, MAX_LINE_CHARS)}…` : entry.line;
        const level = detectLevel(line);
        this.added += Buffer.byteLength(line) + ROW_OVERHEAD_BYTES;
        tx.insert(logEntries)
          .values({
            projectName: target.projectName,
            serviceName: target.serviceName,
            at: ms(entry.timestamp, now),
            stream: entry.stream,
            level: level === "any" ? "none" : level,
            line,
          })
          .run();
      }
      tx.insert(logCursors)
        .values({ projectName: target.projectName, serviceName: target.serviceName, lastAt: newest })
        .onConflictDoUpdate({
          target: [logCursors.projectName, logCursors.serviceName],
          set: { lastAt: newest },
        })
        .run();
    });
    return entries.length;
  }

  /** Removes what is past its age or past the disk limit, oldest first, and measures the store to do it. */
  prune(): void {
    const { logs } = readMonitoringSettings(this.deps);
    this.removeExpired(logs);
    this.trim(limitBytes(logs));
    this.added = 0;
  }

  private removeExpired(logs: MonitoringSettings["logs"]): void {
    const unit = logs.retentionUnit === "hours" ? 3600 * 1000 : 24 * 3600 * 1000;
    this.deps.db
      .delete(logEntries)
      .where(lt(logEntries.at, this.deps.now() - logs.retention * unit))
      .run();
  }

  /** Over the limit, the lines printed longest ago go first, and only as many as it takes. */
  private trim(maxBytes: number): void {
    const { db } = this.deps;
    let excess = approximateBytes(db) - maxBytes;
    while (excess > 0) {
      const oldest = db
        .select({ id: logEntries.id, at: logEntries.at, bytes: lineBytes })
        .from(logEntries)
        .orderBy(logEntries.at, logEntries.id)
        .limit(TRIM_BATCH_ROWS)
        .all();
      let cut: (typeof oldest)[number] | undefined;
      for (const row of oldest) {
        cut = row;
        excess -= Number(row.bytes);
        if (excess <= 0) {
          break;
        }
      }
      if (cut === undefined) {
        return;
      }
      db.delete(logEntries)
        .where(or(lt(logEntries.at, cut.at), and(eq(logEntries.at, cut.at), lte(logEntries.id, cut.id))))
        .run();
    }
  }
}

/** What the running container was started with. Not knowing it can't cost the lines already read. */
async function appliedEnv(deps: Pick<AppDeps, "docker">, target: ServiceRef): Promise<readonly string[]> {
  try {
    const service = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
    return service?.spec.TaskTemplate.ContainerSpec.Env ?? [];
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return [];
    }
    throw error;
  }
}

/**
 * Where a pass starts for this service. A store from before cursors has rows and no record of where they
 * end, so it starts just after its newest row rather than storing everything Docker still holds again.
 */
function resumePoint(db: DbHandle, target: ServiceRef): string | undefined {
  const scope = (table: typeof logEntries | typeof logCursors) =>
    and(eq(table.projectName, target.projectName), eq(table.serviceName, target.serviceName));
  const saved = db.select({ lastAt: logCursors.lastAt }).from(logCursors).where(scope(logCursors)).get();
  if (saved !== undefined) {
    return saved.lastAt;
  }
  const newest = db
    .select({ at: sql<number | null>`max(${logEntries.at})` })
    .from(logEntries)
    .where(scope(logEntries))
    .get()?.at;
  return newest === null || newest === undefined ? undefined : new Date(Number(newest) + 1).toISOString();
}

function approximateBytes(db: DbHandle): number {
  const row = db
    .select({ bytes: sql<number>`coalesce(sum(${lineBytes}), 0)` })
    .from(logEntries)
    .get();
  return Number(row?.bytes ?? 0);
}

export function logStoreStats(db: DbHandle): LogStoreStats {
  const row = db
    .select({
      rows: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${lineBytes}), 0)`,
      oldest: sql<number | null>`min(${logEntries.at})`,
      newest: sql<number | null>`max(${logEntries.at})`,
    })
    .from(logEntries)
    .get();
  return {
    rows: Number(row?.rows ?? 0),
    approximateBytes: Number(row?.bytes ?? 0),
    oldestAt:
      row?.oldest === null || row?.oldest === undefined ? null : new Date(Number(row.oldest)).toISOString(),
    newestAt:
      row?.newest === null || row?.newest === undefined ? null : new Date(Number(row.newest)).toISOString(),
  };
}

/** Searches the stored lines. Used in place of Docker's own history when storage is on. */
export function searchStoredLogs(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceRef,
  query: LogSearchQuery,
): LogSearchResult {
  const conditions = [
    eq(logEntries.projectName, target.projectName),
    eq(logEntries.serviceName, target.serviceName),
  ];
  if (query.stream !== "all") {
    conditions.push(eq(logEntries.stream, query.stream));
  }
  if (query.level !== "any") {
    conditions.push(eq(logEntries.level, query.level));
  }
  if (query.since !== undefined) {
    conditions.push(gte(logEntries.at, deps.now() - query.since * 1000));
  }
  if (query.q !== "") {
    const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(sql`${logEntries.line} LIKE ${pattern} ESCAPE '\\'`);
  }
  const rows = deps.db
    .select()
    .from(logEntries)
    .where(and(...conditions))
    .orderBy(desc(logEntries.at), desc(logEntries.id))
    .limit(query.limit + 1)
    .all();
  const lines: ServiceLogLine[] = rows
    .slice(0, query.limit)
    .reverse()
    .map((row, index) => ({
      seq: index,
      stream: row.stream as ServiceLogLine["stream"],
      line: row.line,
      at: new Date(row.at).toISOString(),
    }));
  return { lines, scanned: rows.length, truncated: rows.length > query.limit };
}

const stores = new WeakMap<AppDeps, LogStore>();

export function logStoreFor(deps: AppDeps): LogStore {
  let store = stores.get(deps);
  if (store === undefined) {
    store = new LogStore(deps);
    stores.set(deps, store);
  }
  return store;
}
