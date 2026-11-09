import type {
  MetricsHistory,
  MetricsPoint,
  MetricsRange,
  MetricsStep,
  MetricsStoreStats,
} from "@opsifier/contract";
import { metricsDurationMs } from "@opsifier/contract";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { metricSamples } from "../../core/db/schema";

/** `resolution` of a raw reading. The others are roll-ups, in seconds. */
export const RAW_RESOLUTION = 0;
const ROLLUPS = [60, 300, 3600] as const;

/** How long each resolution is kept at most, whatever is configured, so raw readings never pile up. */
const RESOLUTION_LIMIT_MS: Record<number, number> = {
  [RAW_RESOLUTION]: 24 * 3600 * 1000,
  60: 7 * 24 * 3600 * 1000,
  300: 31 * 24 * 3600 * 1000,
  3600: 2 * 366 * 24 * 3600 * 1000,
};

/** A generous figure for what one row costs on disk, indexes included. */
const APPROXIMATE_ROW_BYTES = 128;
const MAX_POINTS = 1500;
const PRUNE_BATCH_ROWS = 50_000;

export interface MetricReading {
  scope: string;
  at: number;
  cpu: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  rx: number | null;
  tx: number | null;
}

export interface MetricsRetention {
  retention: number;
  unit: "days" | "gb";
}

export function insertReading(db: DbHandle, reading: MetricReading): void {
  db.insert(metricSamples)
    .values({ ...reading, resolution: RAW_RESOLUTION, readings: 1 })
    .onConflictDoUpdate({
      target: [metricSamples.scope, metricSamples.resolution, metricSamples.at],
      set: {
        cpu: reading.cpu,
        memoryUsed: reading.memoryUsed,
        memoryTotal: reading.memoryTotal,
        diskUsed: reading.diskUsed,
        diskTotal: reading.diskTotal,
        rx: reading.rx,
        tx: reading.tx,
      },
    })
    .run();
}

/** Each column averaged over its buckets, weighted by how many readings went into each. */
const weighted = (column: string) =>
  `SUM(${column} * readings) * 1.0 / NULLIF(SUM(CASE WHEN ${column} IS NULL THEN 0 ELSE readings END), 0)`;

/**
 * Downsamples recent buckets of each resolution into the next coarser one. It recomputes the last few
 * buckets every time, so a late reading or a restart between two roll-ups loses nothing.
 */
export function rollUp(db: Db): void {
  const levels: readonly number[] = [RAW_RESOLUTION, ...ROLLUPS];
  for (let index = 1; index < levels.length; index += 1) {
    const source = levels[index - 1] as number;
    const target = levels[index] as number;
    const width = target * 1000;
    // From the newest bucket already rolled up, so a restart after an outage catches up by itself.
    const newest = db
      .select({ at: sql<number | null>`max(${metricSamples.at})` })
      .from(metricSamples)
      .where(eq(metricSamples.resolution, target))
      .get()?.at;
    const since =
      newest === null || newest === undefined ? 0 : Math.floor(Number(newest) / width) * width - width;
    db.run(
      sql.raw(`
      INSERT OR REPLACE INTO metric_samples
        (scope, resolution, at, cpu, memory_used, memory_total, disk_used, disk_total, rx, tx, readings)
      SELECT scope, ${target}, (at / ${width}) * ${width} AS bucket,
        ${weighted("cpu")}, ${weighted("memory_used")}, ${weighted("memory_total")},
        ${weighted("disk_used")}, ${weighted("disk_total")}, ${weighted("rx")}, ${weighted("tx")}, SUM(readings)
      FROM metric_samples
      WHERE resolution = ${source} AND at >= ${since}
      GROUP BY scope, bucket
    `),
    );
  }
}

function retentionMs(retention: MetricsRetention): number {
  return retention.unit === "days"
    ? retention.retention * 24 * 3600 * 1000
    : (RESOLUTION_LIMIT_MS[3600] as number);
}

/** Deletes in batches and yields between them, so a big clear-out can't hold up the panel. */
export function pruneMetrics(db: Db, retention: MetricsRetention, now: number): number {
  const limit = retentionMs(retention);
  let removed = 0;
  for (const level of [RAW_RESOLUTION, ...ROLLUPS]) {
    const keep = Math.min(limit, RESOLUTION_LIMIT_MS[level] as number);
    const result = db
      .delete(metricSamples)
      .where(and(eq(metricSamples.resolution, level), lt(metricSamples.at, now - keep)))
      .run();
    removed += Number(result.changes);
  }

  if (retention.unit === "gb") {
    const maxBytes = retention.retention * 1024 ** 3;
    removed += pruneToSize(db, maxBytes);
  }
  return removed;
}

function countRows(db: DbHandle): number {
  return Number(db.select({ rows: sql<number>`count(*)` }).from(metricSamples).get()?.rows ?? 0);
}

/** Finest resolutions go first: losing old detail costs less than losing the long view. */
function pruneToSize(db: Db, maxBytes: number): number {
  let removed = 0;
  for (const level of [RAW_RESOLUTION, ...ROLLUPS]) {
    while (countRows(db) * APPROXIMATE_ROW_BYTES > maxBytes) {
      const oldest = db
        .select({ at: metricSamples.at })
        .from(metricSamples)
        .where(eq(metricSamples.resolution, level))
        .orderBy(metricSamples.at)
        .limit(1)
        .offset(PRUNE_BATCH_ROWS)
        .get();
      const cutoff = oldest?.at ?? Number.MAX_SAFE_INTEGER;
      const result = db
        .delete(metricSamples)
        .where(and(eq(metricSamples.resolution, level), lt(metricSamples.at, cutoff)))
        .run();
      removed += Number(result.changes);
      if (Number(result.changes) === 0) {
        break;
      }
    }
  }
  return removed;
}

export function metricsStoreStats(db: DbHandle): MetricsStoreStats {
  const row = db
    .select({
      rows: sql<number>`count(*)`,
      oldest: sql<number | null>`min(${metricSamples.at})`,
      newest: sql<number | null>`max(${metricSamples.at})`,
    })
    .from(metricSamples)
    .get();
  const rows = Number(row?.rows ?? 0);
  return {
    rows,
    approximateBytes: rows * APPROXIMATE_ROW_BYTES,
    oldestAt:
      row?.oldest === null || row?.oldest === undefined ? null : new Date(Number(row.oldest)).toISOString(),
    newestAt:
      row?.newest === null || row?.newest === undefined ? null : new Date(Number(row.newest)).toISOString(),
  };
}

/** The finest resolution that still covers the range, and is not finer than the step needs. */
function chooseResolution(rangeMs: number, stepSeconds: number, retention: MetricsRetention): number {
  const limit = retentionMs(retention);
  const candidates = [...ROLLUPS].reverse().concat([RAW_RESOLUTION as never]) as number[];
  const covering = candidates.filter(
    (level) => Math.min(limit, RESOLUTION_LIMIT_MS[level] as number) >= rangeMs,
  );
  return (
    covering.find((level) => level * 1000 <= stepSeconds * 1000 && level !== RAW_RESOLUTION) ??
    covering.find((level) => level === RAW_RESOLUTION) ??
    (covering.at(-1) as number) ??
    ROLLUPS[0]
  );
}

interface BucketRow {
  bucket: number;
  cpu: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  rx: number | null;
  tx: number | null;
}

export function queryHistory(
  db: Db,
  scope: string,
  range: MetricsRange,
  step: MetricsStep,
  retention: MetricsRetention,
  now: number,
): Omit<MetricsHistory, "origin" | "scope" | "units"> {
  const rangeMs = metricsDurationMs(range);
  const stepSeconds = Math.max(metricsDurationMs(step) / 1000, Math.ceil(rangeMs / 1000 / MAX_POINTS));
  const resolution = chooseResolution(rangeMs, stepSeconds, retention);
  const width = stepSeconds * 1000;
  const from = Math.floor((now - rangeMs) / width) * width;

  const rows = db.all<BucketRow>(
    sql.raw(`
    SELECT (at / ${width}) * ${width} AS bucket,
      ${weighted("cpu")} AS cpu, ${weighted("memory_used")} AS memoryUsed, ${weighted("memory_total")} AS memoryTotal,
      ${weighted("disk_used")} AS diskUsed, ${weighted("disk_total")} AS diskTotal, ${weighted("rx")} AS rx, ${weighted("tx")} AS tx
    FROM metric_samples
    WHERE scope = '${scope.replaceAll("'", "''")}' AND resolution = ${resolution} AND at >= ${from}
    GROUP BY bucket ORDER BY bucket
  `),
  );

  const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));
  const points: MetricsPoint[] = [];
  for (let at = from; at <= now; at += width) {
    const row = byBucket.get(at);
    points.push({
      at: new Date(at).toISOString(),
      cpu: row?.cpu ?? null,
      memoryUsed: row?.memoryUsed ?? null,
      memoryTotal: row?.memoryTotal ?? null,
      diskUsed: row?.diskUsed ?? null,
      diskTotal: row?.diskTotal ?? null,
      rx: row?.rx ?? null,
      tx: row?.tx ?? null,
    });
  }
  return { range, step, stepSeconds, points };
}

/** The newest reading on record for this scope, at any resolution. */
export function latestReadingAt(db: DbHandle, scope: string): string | null {
  const newest = db
    .select({ at: sql<number | null>`max(${metricSamples.at})` })
    .from(metricSamples)
    .where(eq(metricSamples.scope, scope))
    .get()?.at;
  return newest === null || newest === undefined ? null : new Date(Number(newest)).toISOString();
}

/** The newest reading of any service, which is the last time Docker told the panel anything about one. */
export function latestServiceReadingAt(db: DbHandle): string | null {
  const newest = db
    .select({ at: sql<number | null>`max(${metricSamples.at})` })
    .from(metricSamples)
    .where(and(eq(metricSamples.resolution, RAW_RESOLUTION), sql`${metricSamples.scope} <> 'system'`))
    .get()?.at;
  return newest === null || newest === undefined ? null : new Date(Number(newest)).toISOString();
}

export const TREND_STEP_SECONDS = 60;

/** The last hour of CPU, per service, for the table's small trends. */
export function queryTrends(
  db: DbHandle,
  now: number,
  sinceMs = 60 * 60 * 1000,
): { from: number; trends: Record<string, Array<number | null>> } {
  const width = TREND_STEP_SECONDS * 1000;
  const from = Math.floor((now - sinceMs) / width) * width;
  const rows = db
    .select({ scope: metricSamples.scope, at: metricSamples.at, cpu: metricSamples.cpu })
    .from(metricSamples)
    .where(and(eq(metricSamples.resolution, 60), gte(metricSamples.at, from)))
    .all();
  const buckets = Math.floor((now - from) / width) + 1;
  const trends: Record<string, Array<number | null>> = {};
  for (const row of rows) {
    if (row.scope === "system") {
      continue;
    }
    let series = trends[row.scope];
    if (series === undefined) {
      series = Array.from({ length: buckets }, () => null);
      trends[row.scope] = series;
    }
    const index = Math.floor((row.at - from) / width);
    if (index >= 0 && index < series.length) {
      series[index] = row.cpu;
    }
  }
  return { from, trends };
}

export function deleteServiceMetrics(db: DbHandle, scope: string): void {
  db.delete(metricSamples).where(eq(metricSamples.scope, scope)).run();
}
