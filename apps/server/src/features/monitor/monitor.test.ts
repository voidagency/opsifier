import type {
  DockerEventFrame,
  MetricsHistory,
  MonitoringOverview,
  ServicesMetrics,
  ServicesTrends,
  StorageReport,
  SystemMetrics,
} from "@opsifier/contract";
import { dockerEventsTopic } from "@opsifier/contract";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logEntries, metricSamples } from "../../core/db/schema";
import type { TaskStats } from "../../core/docker";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";
import { engineFor, NetworkRate } from "./engine";
import { createEventsProvider } from "./events";
import { LogStore, logStoreFor, logStoreStats, searchStoredLogs } from "./logstore";
import { saveMonitoringSettings } from "./settings";
import {
  insertReading,
  metricsStoreStats,
  pruneMetrics,
  queryHistory,
  RAW_RESOLUTION,
  rollUp,
} from "./store";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

const reading = (at: number, values: Partial<Parameters<typeof insertReading>[1]> = {}) => ({
  scope: "system",
  at,
  cpu: 50,
  memoryUsed: 2,
  memoryTotal: 4,
  diskUsed: 1,
  diskTotal: 2,
  rx: 10,
  tx: 20,
  ...values,
});

describe("the metrics store", () => {
  const retention = { retention: 7, unit: "days" as const };

  it("rolls raw readings up into coarser buckets, weighted by how many readings each holds", () => {
    const { db } = context.deps;
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    insertReading(db, reading(start, { cpu: 10 }));
    insertReading(db, reading(start + 15_000, { cpu: 30 }));
    insertReading(db, reading(start + 30_000, { cpu: null }));
    rollUp(db);

    const minute = db.select().from(metricSamples).where(sql`${metricSamples.resolution} = 60`).all();
    expect(minute).toHaveLength(1);
    expect(minute[0]?.cpu).toBeCloseTo(20);
    expect(minute[0]?.readings).toBe(3);
    expect(minute[0]?.at).toBe(start);
  });

  it("returns a bucket with nothing recorded as null, never as zero", () => {
    const { db } = context.deps;
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    insertReading(db, reading(now - 2 * 3600 * 1000, { cpu: 80 }));
    rollUp(db);

    const history = queryHistory(db, "system", "4h", "1h", retention, now);
    expect(history.points.some((point) => point.cpu === 80)).toBe(true);
    expect(history.points.some((point) => point.cpu === null && point.rx === null)).toBe(true);
    expect(history.points.every((point) => point.cpu !== 0)).toBe(true);
  });

  it("keeps raw readings for a day, and drops what is older than the retention", () => {
    const { db } = context.deps;
    const now = Date.UTC(2026, 0, 10);
    insertReading(db, reading(now - 2 * 24 * 3600 * 1000));
    insertReading(db, reading(now - 60_000));
    pruneMetrics(db, retention, now);
    const raw = db
      .select({ at: metricSamples.at })
      .from(metricSamples)
      .where(sql`${metricSamples.resolution} = ${RAW_RESOLUTION}`)
      .all();
    expect(raw.map((row) => row.at)).toEqual([now - 60_000]);

    db.insert(metricSamples)
      .values({ ...reading(now - 40 * 24 * 3600 * 1000), resolution: 3600 })
      .run();
    pruneMetrics(db, retention, now);
    expect(metricsStoreStats(db).rows).toBe(1);
  });

  it("stays within a size limit by removing the oldest fine-grained rows first", () => {
    const { db } = context.deps;
    const now = Date.UTC(2026, 0, 10);
    for (let index = 0; index < 400; index += 1) {
      insertReading(db, reading(now - 86_000_000 + index * 15_000));
    }
    expect(metricsStoreStats(db).approximateBytes).toBeGreaterThan(1024);
    pruneMetrics(db, { retention: (1024 * 10) / 1024 ** 3, unit: "gb" }, now);
    expect(metricsStoreStats(db).approximateBytes).toBeLessThanOrEqual(1024 * 10);
  });
});

describe("network rates", () => {
  const stats = (containerId: string, rx: number, tx: number): TaskStats => ({
    taskId: containerId,
    slot: 1,
    containerId,
    cpuPercent: 0,
    cpuCapacityPercent: 0,
    memoryUsedBytes: 0,
    memoryLimitBytes: 0,
    networkRxBytes: rx,
    networkTxBytes: tx,
    readAt: "",
  });

  it("is unknown for the first reading, and survives a counter reset", () => {
    const rate = new NetworkRate();
    expect(rate.rate([stats("a", 1000, 2000)], 0)).toBeNull();
    expect(rate.rate([stats("a", 3000, 2000)], 2000)).toEqual({ rx: 1000, tx: 0 });
    // The container restarted, so this interval has no meaning.
    expect(rate.rate([stats("a", 10, 10)], 4000)).toBeNull();
  });

  it("leaves out a container whose counters Docker didn't report", () => {
    const rate = new NetworkRate();
    const unread: TaskStats = { ...stats("a", 0, 0), networkRxBytes: null, networkTxBytes: null };

    expect(rate.rate([unread], 0)).toBeNull();
    expect(rate.rate([stats("a", 1000, 0)], 1000)).toBeNull();
    expect(rate.rate([stats("a", 3000, 0)], 2000)).toEqual({ rx: 2000, tx: 0 });
  });
});

describe("the first reading of a server", () => {
  it("has no network rate yet, and records none rather than zero", async () => {
    await context.docker.createService({
      Name: "shop_web",
      TaskTemplate: { ContainerSpec: { Image: "nginx:1" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    context.docker.advance(10);

    await engineFor(context.deps).scrape();

    const row = context.deps.db
      .select()
      .from(metricSamples)
      .where(sql`${metricSamples.scope} = 'system' AND ${metricSamples.resolution} = ${RAW_RESOLUTION}`)
      .get();
    expect(row?.rx).toBeNull();
    expect(row?.tx).toBeNull();
    const current = await call<SystemMetrics>(context.app, "/api/v1/monitor/system", { cookie });
    expect(current.body.network.rxBytesPerSecond).toBeNull();
  });
});

describe("the monitor API", () => {
  it("reports the server with real figures and a scope for each", async () => {
    const result = await call<SystemMetrics>(context.app, "/api/v1/monitor/system", { cookie });
    expect(result.status).toBe(200);
    expect(result.body.memory.totalBytes).toBeGreaterThan(0);
    expect(result.body.cpu.cores).toBeGreaterThan(0);
    expect(result.body.disk.percent).toBeGreaterThan(0);
    expect(result.body.network.scope).toBe("containers");
    expect(result.body.docker.available).toBe(true);
    expect(result.body.origin).toBe("host");
    expect(result.body.network.origin).toBe("simulated");
  });

  it("says Docker is away rather than inventing a figure", async () => {
    context.docker.failNext("ping");
    const result = await call<SystemMetrics>(context.app, "/api/v1/monitor/system", { cookie });
    expect(result.body.docker.available).toBe(false);
    expect(result.body.network.rxBytesPerSecond).toBeNull();
  });

  it("dates Docker's absence from the record when this run hasn't seen it yet", async () => {
    const at = Date.UTC(2026, 0, 1, 8, 0, 0);
    insertReading(context.deps.db, reading(at, { scope: "shop/web" }));
    context.docker.failNext("ping");

    const result = await call<SystemMetrics>(context.app, "/api/v1/monitor/system", { cookie });

    expect(result.body.docker).toEqual({ available: false, lastSeenAt: new Date(at).toISOString() });
  });

  it("records a scrape and serves it back as history", async () => {
    await engineFor(context.deps).scrape();
    rollUp(context.deps.db);
    const result = await call<MetricsHistory>(
      context.app,
      "/api/v1/monitor/system/history?range=4h&step=1m",
      { cookie },
    );
    expect(result.status).toBe(200);
    expect(result.body.points.some((point) => point.memoryTotal !== null)).toBe(true);
    expect(result.body).toMatchObject({
      origin: "host",
      scope: "host",
      units: { cpu: "percent", memory: "bytes", disk: "bytes", network: "bytes-per-second" },
    });
  });

  it("says what a service's history covers and where it came from", async () => {
    await call(context.app, "/api/v1/projects", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "shop" },
    });
    await call(context.app, "/api/v1/projects/shop/services", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "web" },
    });

    const result = await call<MetricsHistory>(
      context.app,
      "/api/v1/projects/shop/services/web/metrics/history?range=4h&step=1m",
      { cookie },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ origin: "simulated", scope: "service" });
    expect(result.body.units.network).toBe("bytes-per-second");
  });

  it("says when and how a service's short trend was taken", async () => {
    const result = await call<ServicesTrends>(context.app, "/api/v1/monitor/services/trends", { cookie });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ unit: "percent", scope: "service", stepSeconds: 60 });
    expect(Date.parse(result.body.from as string)).toBeGreaterThan(0);
  });

  it("does not report a size for a service no scan has measured yet", async () => {
    await call(context.app, "/api/v1/projects", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "shop" },
    });
    await call(context.app, "/api/v1/monitor/storage", { cookie });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The scan has finished, and this service did not exist when it ran.
    await call(context.app, "/api/v1/projects/shop/services", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "late" },
    });

    const report = await call<StorageReport>(context.app, "/api/v1/monitor/storage", { cookie });

    expect(report.body.services.find((service) => service.serviceName === "late")?.sizeBytes).toBeNull();
  });

  it("rejects an unknown range", async () => {
    const result = await call(context.app, "/api/v1/monitor/system/history?range=9000h", { cookie });
    expect(result.status).toBe(400);
  });

  it("reports storage per service and by Docker kind", async () => {
    await call(context.app, "/api/v1/projects", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "shop" },
    });
    await call(context.app, "/api/v1/projects/shop/services", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: "web" },
    });
    context.docker.disk = {
      imagesBytes: 100,
      containersBytes: 10,
      volumesBytes: 5,
      buildCacheBytes: 1,
      buildCache: [],
    };
    const first = await call<StorageReport>(context.app, "/api/v1/monitor/storage", { cookie });
    expect(first.status).toBe(200);
    expect(first.body.services[0]).toMatchObject({ projectName: "shop", serviceName: "web" });
    expect(first.body.docker).toMatchObject({ imagesBytes: 100, buildCacheBytes: 1 });
  });

  it("says Docker's disk can't be read when there is nothing to read it with", async () => {
    const report = await call<StorageReport>(context.app, "/api/v1/monitor/storage", { cookie });
    expect(report.body.disk.totalBytes).toBeGreaterThan(0);
    expect(report.body.dockerDisk).toBeNull();
  });

  it("measures Docker's own disk, separately from the panel's, through a helper", async () => {
    const helped = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
    const session = await setupAdmin(helped.app);
    helped.docker.engine = { ...helped.docker.engine, rootDir: "/mnt/docker-data" };
    helped.docker.helperResult = () => ({
      exitCode: 0,
      stdout:
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 1000 400 600 40% /host/mnt\n",
      stderr: "",
    });

    const report = await call<StorageReport>(helped.app, "/api/v1/monitor/storage", { cookie: session });

    expect(report.body.dockerDisk).toEqual({
      usedBytes: 400 * 1024,
      freeBytes: 600 * 1024,
      totalBytes: 1000 * 1024,
      path: "/mnt/docker-data",
    });
    expect(helped.docker.helpers[0]).toMatchObject({
      command: ["df", "-k", "-P", "--", "/host/mnt/docker-data"],
      binds: ["/:/host:ro"],
    });
    await helped.close();
  });

  it("reports Docker's disk as unknown when the helper can't read it", async () => {
    const helped = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
    const session = await setupAdmin(helped.app);
    helped.docker.helperResult = () => ({ exitCode: 1, stdout: "", stderr: "df: not found" });

    const report = await call<StorageReport>(helped.app, "/api/v1/monitor/storage", { cookie: session });

    expect(report.status).toBe(200);
    expect(report.body.dockerDisk).toBeNull();
    await helped.close();
  });

  it("saves bounded settings", async () => {
    const before = await call<MonitoringOverview>(context.app, "/api/v1/settings/monitoring", { cookie });
    expect(before.body.metrics).toMatchObject({ retention: 7, retentionUnit: "days", scrapeSeconds: 15 });

    const saved = await call<MonitoringOverview>(context.app, "/api/v1/settings/monitoring", {
      method: "PUT",
      cookie,
      origin: TEST_ORIGIN,
      body: {
        metrics: { enabled: true, retention: 1, retentionUnit: "gb", scrapeSeconds: 30 },
        logs: { enabled: true, retention: 12, retentionUnit: "hours", maxSizeMb: 100 },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.logs.retentionUnit).toBe("hours");

    const invalid = await call(context.app, "/api/v1/settings/monitoring", {
      method: "PUT",
      cookie,
      origin: TEST_ORIGIN,
      body: {
        metrics: { enabled: true, retention: -1, retentionUnit: "days", scrapeSeconds: 7 },
        logs: { enabled: false, retention: 1, retentionUnit: "days", maxSizeMb: 100 },
      },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("docker events", () => {
  it("replays recent events to a new subscriber and streams the rest", async () => {
    const published: unknown[] = [];
    const channel = { publish: (payload: unknown) => published.push(payload), pressure: () => 0 };
    const provider = createEventsProvider(context.deps);
    expect(provider.matches(dockerEventsTopic)).toBe(true);
    const feed = provider.open(dockerEventsTopic, channel);
    await new Promise((resolve) => setTimeout(resolve, 10));

    context.docker.emitEvent({ type: "container", action: "start", actorId: "abc" });
    context.docker.emitEvent({ type: "container", action: "exec_start", actorId: "abc" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((published[0] as DockerEventFrame).kind).toBe("event");
    expect(published).toHaveLength(1);
    const snapshot = feed.replay?.()[0] as Extract<DockerEventFrame, { kind: "snapshot" }>;
    expect(snapshot.events.map((event) => event.action)).toEqual(["start"]);
    feed.close();
  });
});

describe("log storage", () => {
  /** A deployed service, with what it printed while starting already behind it. */
  async function runningService(project: string, service: string): Promise<string> {
    await call(context.app, "/api/v1/projects", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: project },
    });
    await call(context.app, `/api/v1/projects/${project}/services`, {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { name: service },
    });
    const name = `${project}_${service}`;
    await context.docker.createService({
      Name: name,
      TaskTemplate: { ContainerSpec: { Image: "nginx:1" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    // Up and running, so that it has nothing more to say about starting.
    context.docker.advance(10);
    return name;
  }

  const storedLines = () =>
    context.deps.db.select({ line: logEntries.line }).from(logEntries).orderBy(logEntries.id).all();

  const logLimits = (logs: { retention?: number; retentionUnit?: "days" | "hours"; maxSizeMb?: number }) =>
    saveMonitoringSettings(context.deps, {
      metrics: { enabled: true, retention: 7, retentionUnit: "days", scrapeSeconds: 15 },
      logs: { enabled: true, retention: 7, retentionUnit: "days", maxSizeMb: 1024, ...logs },
    });

  /** Rows that were printed at known times, as a store that has been running for a while holds them. */
  function storedRows(...rows: Array<{ at: number; line: string; service?: string }>) {
    context.deps.db
      .insert(logEntries)
      .values(
        rows.map(({ at, line, service = "web" }) => ({
          projectName: "shop",
          serviceName: service,
          at,
          stream: "stdout" as const,
          level: "none" as const,
          line,
        })),
      )
      .run();
  }

  it("stores what a service printed, once, and searches it", async () => {
    await runningService("shop", "web");
    context.docker.writeLog("shop_web", "error: something broke");
    context.docker.writeLog("shop_web", "all fine");

    const store = logStoreFor(context.deps);
    const stored = await store.collect();
    expect(stored).toBeGreaterThanOrEqual(2);
    expect(await store.collect()).toBe(0);

    const target = { projectName: "shop", serviceName: "web" };
    const errors = searchStoredLogs(context.deps, target, {
      q: "",
      stream: "all",
      level: "error",
      limit: 50,
    });
    expect(errors.lines.map((line) => line.line)).toEqual(["error: something broke"]);
    const text = searchStoredLogs(context.deps, target, {
      q: "fine",
      stream: "all",
      level: "any",
      limit: 50,
    });
    expect(text.lines).toHaveLength(1);
  });

  it("finds a percent sign or an underscore as itself, not as a wildcard", async () => {
    storedRows(
      { at: context.deps.now(), line: "disk at 100% used" },
      { at: context.deps.now(), line: "disk at 100 used" },
      { at: context.deps.now(), line: "user_id missing" },
      { at: context.deps.now(), line: "userXid missing" },
    );
    const target = { projectName: "shop", serviceName: "web" };
    const search = (q: string) =>
      searchStoredLogs(context.deps, target, { q, stream: "all", level: "any", limit: 50 }).lines.map(
        (line) => line.line,
      );

    expect(search("100%")).toEqual(["disk at 100% used"]);
    expect(search("user_id")).toEqual(["user_id missing"]);
  });

  describe("across a restart", () => {
    it("stores nothing twice, and what came after it exactly once", async () => {
      await runningService("shop", "web");
      context.docker.writeLog("shop_web", "printed before the restart");
      expect(await logStoreFor(context.deps).collect()).toBeGreaterThanOrEqual(1);
      const before = storedLines();

      const restarted = await context.restart();
      const store = logStoreFor(restarted.deps);

      expect(await store.collect()).toBe(0);
      expect(storedLines()).toEqual(before);

      context.docker.writeLog("shop_web", "printed after the restart");
      expect(await store.collect()).toBe(1);
      expect(storedLines().map((row) => row.line)).toEqual([
        ...before.map((row) => row.line),
        "printed after the restart",
      ]);
    });

    it("picks up from a store that has no cursor yet, without storing it all again", async () => {
      await runningService("shop", "web");
      context.docker.writeLog("shop_web", "already stored");
      const first = logStoreFor(context.deps);
      await first.collect();
      const rows = storedLines().length;

      // What a panel upgraded from before cursors finds: rows, and nothing saying where they end.
      context.deps.db.run(sql`DELETE FROM log_cursors`);
      expect(await new LogStore(context.deps).collect()).toBe(0);
      expect(storedLines()).toHaveLength(rows);
    });

    it("answers to its limits as soon as the collector starts, before anything new arrives", async () => {
      const now = context.deps.now();
      const hour = 3600 * 1000;
      logLimits({ retention: 12, retentionUnit: "hours", maxSizeMb: 10 });
      storedRows(
        ...Array.from({ length: 1000 }, (_, index) => ({
          at: now - hour + index,
          line: `${index} ${"x".repeat(16 * 1024)}`,
        })),
        { at: now - 13 * hour, line: "past its age" },
      );

      const store = new LogStore(context.deps);
      store.start();
      store.stop();

      const stats = logStoreStats(context.deps.db);
      expect(stats.approximateBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
      expect(stats.oldestAt === null ? 0 : Date.parse(stats.oldestAt)).toBeGreaterThan(now - 12 * hour);
      expect(storedLines().map((row) => row.line)).not.toContain("past its age");
      expect(stats.rows).toBeGreaterThan(0);
    });
  });

  describe("the disk limit", () => {
    it("removes the oldest lines, and only as many as it takes, when there are few rows", async () => {
      const now = context.deps.now();
      logLimits({ maxSizeMb: 10 });
      // Well under the 10,000 rows that used to decide how much went: 800 lines of 16 KB is 12.5 MB.
      storedRows(
        ...Array.from({ length: 800 }, (_, index) => ({
          at: now - 800_000 + index * 1000,
          line: `${index} ${"x".repeat(16 * 1024 - 8)}`,
        })),
      );

      logStoreFor(context.deps).prune();

      const kept = storedLines().map((row) => Number(row.line.split(" ")[0]));
      expect(kept.length).toBeGreaterThan(600);
      expect(kept.length).toBeLessThan(800);
      // Only the newest survive, with nothing missing among them.
      expect(kept.at(-1)).toBe(799);
      expect(kept).toEqual(Array.from({ length: kept.length }, (_, index) => 800 - kept.length + index));
      expect(logStoreStats(context.deps.db).approximateBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    });

    it("goes by when a line was printed, not by when it reached the store", async () => {
      const now = context.deps.now();
      logLimits({ maxSizeMb: 10 });
      // The older half reached the store last, as when a service is picked up with history behind it.
      storedRows(
        ...Array.from({ length: 400 }, (_, index) => ({
          at: now - 1000 + index,
          line: `new ${"x".repeat(16 * 1024)}`,
        })),
        ...Array.from({ length: 400 }, (_, index) => ({
          at: now - 900_000 + index,
          line: `old ${"x".repeat(16 * 1024)}`,
        })),
      );

      logStoreFor(context.deps).prune();

      const kept = storedLines().map((row) => row.line.slice(0, 3));
      expect(kept.filter((tag) => tag === "new")).toHaveLength(400);
      expect(kept.filter((tag) => tag === "old").length).toBeLessThan(400);
    });

    it("counts bytes as stored, not characters", async () => {
      const line = "é".repeat(1000);
      storedRows({ at: context.deps.now(), line });

      expect(logStoreStats(context.deps.db).approximateBytes).toBeGreaterThanOrEqual(2000);
    });

    it("applies a lowered limit as soon as it is saved", async () => {
      const now = context.deps.now();
      storedRows(
        ...Array.from({ length: 800 }, (_, index) => ({
          at: now - 800_000 + index * 1000,
          line: `${index} ${"x".repeat(16 * 1024)}`,
        })),
      );

      const saved = await call<MonitoringOverview>(context.app, "/api/v1/settings/monitoring", {
        method: "PUT",
        cookie,
        origin: TEST_ORIGIN,
        body: {
          metrics: { enabled: true, retention: 7, retentionUnit: "days", scrapeSeconds: 15 },
          logs: { enabled: true, retention: 7, retentionUnit: "days", maxSizeMb: 10 },
        },
      });

      expect(saved.status).toBe(200);
      expect(saved.body.logStore.approximateBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
      expect(saved.body.logStore.rows).toBeGreaterThan(0);
    });

    it("keeps within the limit through a burst, without waiting for the next clean-up", async () => {
      await runningService("shop", "web");
      logLimits({ maxSizeMb: 10 });
      const store = logStoreFor(context.deps);
      store.prune();

      for (let burst = 0; burst < 3; burst += 1) {
        for (let index = 0; index < 400; index += 1) {
          context.docker.writeLog("shop_web", `${burst}.${index} ${"x".repeat(16 * 1024)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        await store.collectAndTrim();
      }

      // One pass can land before the check that follows it, and a tenth of the limit before that.
      expect(logStoreStats(context.deps.db).approximateBytes).toBeLessThanOrEqual(11.5 * 1024 * 1024);
    });
  });

  describe("past its age", () => {
    it("removes what is older than the retention and keeps the rest", async () => {
      const now = context.deps.now();
      const hour = 3600 * 1000;
      logLimits({ retention: 2, retentionUnit: "hours" });
      storedRows({ at: now - 3 * hour, line: "too old" }, { at: now - hour, line: "still wanted" });

      logStoreFor(context.deps).prune();

      expect(storedLines().map((row) => row.line)).toEqual(["still wanted"]);
    });

    it("moves with the clock", async () => {
      const now = context.deps.now();
      const hour = 3600 * 1000;
      logLimits({ retention: 2, retentionUnit: "hours" });
      storedRows({ at: now - hour, line: "ages out" });

      logStoreFor(context.deps).prune();
      expect(storedLines()).toHaveLength(1);

      context.advance(2 * hour);
      logStoreFor(context.deps).prune();
      expect(storedLines()).toHaveLength(0);
    });
  });

  it("keeps identifiable lines of two services apart", async () => {
    await runningService("shop", "web");
    await runningService("shop", "api");
    // The same service name in another project must not bleed in either.
    await runningService("blog", "web");
    context.docker.writeLog("shop_web", "marker-shop-web");
    context.docker.writeLog("shop_api", "marker-shop-api");
    context.docker.writeLog("blog_web", "marker-blog-web");

    await logStoreFor(context.deps).collect();

    const matches = (projectName: string, serviceName: string) =>
      searchStoredLogs(
        context.deps,
        { projectName, serviceName },
        { q: "marker-", stream: "all", level: "any", limit: 50 },
      ).lines.map((line) => line.line);
    expect(matches("shop", "web")).toEqual(["marker-shop-web"]);
    expect(matches("shop", "api")).toEqual(["marker-shop-api"]);
    expect(matches("blog", "web")).toEqual(["marker-blog-web"]);
  });
});

export type { ServicesMetrics };
