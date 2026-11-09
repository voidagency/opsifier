import { z } from "zod";

export const metricsRanges = ["4h", "12h", "24h", "48h", "7d"] as const;
export const metricsRange = z.enum(metricsRanges);
export type MetricsRange = z.infer<typeof metricsRange>;

export const metricsSteps = ["1m", "5m", "15m", "30m", "1h"] as const;
export const metricsStep = z.enum(metricsSteps);
export type MetricsStep = z.infer<typeof metricsStep>;

const durationSeconds: Record<MetricsRange | MetricsStep, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 4 * 3600,
  "12h": 12 * 3600,
  "24h": 24 * 3600,
  "48h": 48 * 3600,
  "7d": 7 * 24 * 3600,
};

export const metricsDurationMs = (value: MetricsRange | MetricsStep): number => durationSeconds[value] * 1000;

/** What a reading covers, so a figure always says what it measures. */
export const metricScope = z.enum(["host", "containers", "service"]);
export type MetricScope = z.infer<typeof metricScope>;

/** Where a figure was read: the panel's own machine, Docker's per-container statistics, or the fake driver. */
export const metricOrigin = z.enum(["host", "docker", "simulated"]);
export type MetricOrigin = z.infer<typeof metricOrigin>;

/** The unit of each series, which a history's short field names don't say by themselves. */
export const METRIC_UNITS = {
  cpu: "percent",
  memory: "bytes",
  disk: "bytes",
  network: "bytes-per-second",
} as const;
export const metricUnits = z.object({
  cpu: z.literal(METRIC_UNITS.cpu),
  memory: z.literal(METRIC_UNITS.memory),
  disk: z.literal(METRIC_UNITS.disk),
  network: z.literal(METRIC_UNITS.network),
});

const percent = z.number().min(0);
const bytes = z.number().min(0);
const rate = z.number().min(0);

/** GET /api/v1/monitor/system: one reading of the server. Null means this figure is unavailable. */
export const systemMetrics = z.object({
  readAt: z.iso.datetime(),
  /** What the CPU, memory and disk readings below were taken from, and what they cover. */
  origin: metricOrigin,
  scope: metricScope.default("host"),
  cpu: z.object({
    percent: percent.nullable(),
    cores: z.number().int().min(0).nullable(),
    /** One, five and fifteen minutes. Null where the platform has no such thing. */
    load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  }),
  memory: z.object({
    usedBytes: bytes.nullable(),
    totalBytes: bytes.nullable(),
    percent: percent.nullable(),
  }),
  disk: z.object({
    usedBytes: bytes.nullable(),
    totalBytes: bytes.nullable(),
    percent: percent.nullable(),
    /** The filesystem measured: where the panel keeps its data. */
    path: z.string(),
  }),
  network: z.object({
    scope: metricScope,
    origin: metricOrigin,
    /** Null until two readings have been taken, or while Docker is away for the `containers` scope. */
    rxBytesPerSecond: rate.nullable(),
    txBytesPerSecond: rate.nullable(),
  }),
  docker: z.object({
    available: z.boolean(),
    /** When Docker last answered. Null if it has not since the panel started. */
    lastSeenAt: z.iso.datetime().nullable(),
  }),
});
export type SystemMetrics = z.infer<typeof systemMetrics>;

/** GET /api/v1/monitor/system/history and the same for one service. */
export const metricsHistoryQuery = z.strictObject({
  range: metricsRange.default("24h"),
  step: metricsStep.default("5m"),
});
export type MetricsHistoryQuery = z.infer<typeof metricsHistoryQuery>;

/** One bucket. A bucket nothing was recorded for is null, never zero. */
export const metricsPoint = z.object({
  at: z.iso.datetime(),
  cpu: percent.nullable(),
  memoryUsed: bytes.nullable(),
  memoryTotal: bytes.nullable(),
  diskUsed: bytes.nullable(),
  diskTotal: bytes.nullable(),
  rx: rate.nullable(),
  tx: rate.nullable(),
});
export type MetricsPoint = z.infer<typeof metricsPoint>;

export const metricsHistory = z.object({
  range: metricsRange,
  step: metricsStep,
  /** The bucket width actually returned, which can be coarser than `step` when the range is long. */
  stepSeconds: z.number().int().positive(),
  /** Where these figures came from, what they cover and in what unit. */
  origin: metricOrigin.default("host"),
  scope: metricScope.default("host"),
  units: metricUnits.default(METRIC_UNITS),
  points: z.array(metricsPoint),
});
export type MetricsHistory = z.infer<typeof metricsHistory>;

/** GET /api/v1/monitor/services/trends: a short CPU series per `<project>/<service>`. */
export const servicesTrends = z.object({
  trends: z.record(z.string(), z.array(z.number().nullable())),
  /** The time of each series' first point, and how far apart they are. */
  from: z.iso.datetime().optional(),
  stepSeconds: z.number().int().positive().default(60),
  unit: z.literal(METRIC_UNITS.cpu).default(METRIC_UNITS.cpu),
  origin: metricOrigin.default("docker"),
  scope: metricScope.default("service"),
});
export type ServicesTrends = z.infer<typeof servicesTrends>;

/** One event from the Docker daemon, as the Monitor page shows it. */
export const dockerEvent = z.object({
  /** Increases within one feed. */
  seq: z.number().int().min(0),
  type: z.string(),
  action: z.string(),
  actorId: z.string(),
  attributes: z.record(z.string(), z.string()),
  scope: z.string().nullable(),
  at: z.iso.datetime(),
});
export type DockerEvent = z.infer<typeof dockerEvent>;

export const dockerEventsTopic = "docker-events";

/** Frames of {@link dockerEventsTopic}. A new subscriber starts with a `snapshot`. */
export const dockerEventFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), available: z.boolean(), events: z.array(dockerEvent) }),
  z.object({ kind: z.literal("event"), event: dockerEvent }),
  z.object({ kind: z.literal("state"), available: z.boolean() }),
]);
export type DockerEventFrame = z.infer<typeof dockerEventFrame>;

/** What Docker itself holds, by kind, for the Storage tab. Bytes from `docker system df`. */
export const dockerDiskUsage = z.object({
  imagesBytes: bytes,
  containersBytes: bytes,
  volumesBytes: bytes,
  buildCacheBytes: bytes,
});
export type DockerDiskUsage = z.infer<typeof dockerDiskUsage>;

/** GET /api/v1/monitor/storage */
export const storageReport = z.object({
  /** Null until the first scan of the data directory has finished. */
  scannedAt: z.iso.datetime().nullable(),
  scanning: z.boolean(),
  disk: z.object({
    usedBytes: bytes.nullable(),
    totalBytes: bytes.nullable(),
    path: z.string(),
  }),
  /** Null while Docker is not answering. */
  docker: dockerDiskUsage.nullable(),
  /**
   * The filesystem Docker itself lives on, measured on the host. It need not be the disk above. Null
   * when it can't be measured from here.
   */
  dockerDisk: z
    .object({
      usedBytes: bytes,
      totalBytes: bytes,
      freeBytes: bytes,
      path: z.string(),
    })
    .nullable(),
  services: z.array(
    z.object({
      projectName: z.string(),
      serviceName: z.string(),
      /** Null until a scan has measured it: not knowing is not the same as empty. */
      sizeBytes: bytes.nullable(),
      path: z.string(),
    }),
  ),
});
export type StorageReport = z.infer<typeof storageReport>;

export const metricsRetentionUnit = z.enum(["days", "gb"]);
export const logsRetentionUnit = z.enum(["days", "hours"]);

export const scrapeIntervals = [5, 10, 15, 30, 60, 300] as const;

/** PUT /api/v1/monitor/settings */
export const monitoringSettings = z.strictObject({
  metrics: z.strictObject({
    enabled: z.boolean(),
    retention: z.number().min(0.1, "Must be more than zero").max(3650, "That is too much"),
    retentionUnit: metricsRetentionUnit,
    scrapeSeconds: z.union(scrapeIntervals.map((value) => z.literal(value))),
  }),
  logs: z.strictObject({
    enabled: z.boolean(),
    retention: z.number().min(0.1, "Must be more than zero").max(3650, "That is too much"),
    retentionUnit: logsRetentionUnit,
    /** The most the stored logs may take up, whatever the retention says. */
    maxSizeMb: z
      .number()
      .int()
      .min(10, "At least 10 MB")
      .max(1024 * 1024, "That is too much"),
  }),
});
export type MonitoringSettings = z.infer<typeof monitoringSettings>;

/** GET /api/v1/monitor/store: what the history itself costs. */
export const metricsStoreStats = z.object({
  rows: z.number().int().min(0),
  approximateBytes: bytes,
  oldestAt: z.iso.datetime().nullable(),
  newestAt: z.iso.datetime().nullable(),
});
export type MetricsStoreStats = z.infer<typeof metricsStoreStats>;

export const logStoreStats = z.object({
  rows: z.number().int().min(0),
  approximateBytes: bytes,
  oldestAt: z.iso.datetime().nullable(),
  newestAt: z.iso.datetime().nullable(),
});
export type LogStoreStats = z.infer<typeof logStoreStats>;

export const monitoringOverview = monitoringSettings.extend({
  store: metricsStoreStats,
  logStore: logStoreStats,
});
export type MonitoringOverview = z.infer<typeof monitoringOverview>;
