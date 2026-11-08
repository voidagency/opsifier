import { z } from "zod";

/** Live logs of one service, of any type. Published only while someone is subscribed. */
export const serviceLogsTopic = (project: string, service: string): string =>
  `service-logs:${project}/${service}`;

/** Live readings of one service, of any type. Sampled only while someone is subscribed. */
export const serviceMetricsTopic = (project: string, service: string): string =>
  `service-metrics:${project}/${service}`;

/** Live readings of every task on the server, for the Monitor page. */
export const servicesMetricsTopic = "metrics:services";

/** Terminals are binary, so they have a socket of their own instead of a topic. */
export const terminalPath = (project: string, service: string): string =>
  `/api/v1/terminal/${project}/${service}`;

/** `connecting` has not looked yet, `waiting` found nothing running, `error` could not read Docker. */
export const logFeedState = z.enum(["connecting", "waiting", "streaming", "error"]);
export type LogFeedState = z.infer<typeof logFeedState>;

export const serviceLogLine = z.object({
  /** Increases within one feed, so a client can tell what it has already shown. */
  seq: z.number().int().min(0),
  stream: z.enum(["stdout", "stderr"]),
  line: z.string(),
  /** RFC 3339. Null when Docker gave no timestamp. */
  at: z.string().nullable(),
});
export type ServiceLogLine = z.infer<typeof serviceLogLine>;

/** Frames of a `service-logs:` topic. A new subscriber always starts with a `snapshot`. */
export const serviceLogEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    feed: z.string(),
    state: logFeedState,
    lines: z.array(serviceLogLine),
  }),
  z.object({ kind: z.literal("lines"), feed: z.string(), lines: z.array(serviceLogLine) }),
  z.object({ kind: z.literal("state"), feed: z.string(), state: logFeedState }),
]);
export type ServiceLogEvent = z.infer<typeof serviceLogEvent>;

export const logLevelFilter = z.enum(["any", "error", "warn", "info", "debug"]);
export type LogLevelFilter = z.infer<typeof logLevelFilter>;

export const logStreamFilter = z.enum(["all", "stdout", "stderr"]);
export type LogStreamFilter = z.infer<typeof logStreamFilter>;

/** GET /api/v1/projects/{project}/services/{service}/logs/search */
export const logSearchQuery = z.object({
  q: z.string().trim().max(256, "This is too long").default(""),
  stream: logStreamFilter.default("all"),
  level: logLevelFilter.default("any"),
  /** How many seconds back to look. Leaving it out searches everything Docker still holds. */
  since: z.coerce
    .number()
    .int()
    .min(1)
    .max(366 * 24 * 3600)
    .optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export type LogSearchQuery = z.infer<typeof logSearchQuery>;

export const logSearchResult = z.object({
  lines: z.array(serviceLogLine),
  /** How many lines were read. */
  scanned: z.number().int().min(0),
  /** True when there was more to read or more matches than the limit. */
  truncated: z.boolean(),
});
export type LogSearchResult = z.infer<typeof logSearchResult>;

export const consoleProgram = z.enum(["sh", "bash"]);
export type ConsoleProgram = z.infer<typeof consoleProgram>;

export const consoleTask = z.object({
  id: z.string(),
  slot: z.number().int().nullable(),
  /** `<project>_<service>.<slot>.<task id>`, as Docker names the container. */
  name: z.string(),
});
export type ConsoleTask = z.infer<typeof consoleTask>;

/** GET /api/v1/projects/{project}/services/{service}/console. Administrators only. */
export const consoleInfo = z.object({
  tasks: z.array(consoleTask),
  programs: z.array(consoleProgram),
  scripts: z.array(z.string()),
});
export type ConsoleInfo = z.infer<typeof consoleInfo>;

const terminalDimension = z.coerce.number().int().min(1).max(1000);

/** The query string of a terminal socket: which task, and what to run in it. */
export const terminalQuery = z
  .object({
    task: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid task"),
    program: consoleProgram.optional(),
    script: z.string().min(1).max(64).optional(),
    cols: terminalDimension.default(80),
    rows: terminalDimension.default(24),
  })
  .refine((query) => (query.program === undefined) !== (query.script === undefined), {
    message: "Choose a program or a script",
  });
export type TerminalQuery = z.infer<typeof terminalQuery>;

/**
 * Text frames a terminal client sends. Binary frames are keystrokes. `pause` and `resume` let the
 * browser hold the output back while xterm is still drawing what it already received.
 */
export const terminalClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("resize"), cols: terminalDimension, rows: terminalDimension }),
  z.object({ t: z.literal("pause") }),
  z.object({ t: z.literal("resume") }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrame>;

/** Text frames a terminal server sends. Binary frames are the program's output. */
export const terminalServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready") }),
  z.object({ t: z.literal("exit"), code: z.number().int().nullable() }),
  z.object({ t: z.literal("error"), message: z.string() }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrame>;

/** Sent as the WebSocket close code when the panel refuses to keep a terminal open. */
export const TERMINAL_CLOSE_REFUSED = 4403;

export const taskMetrics = z.object({
  taskId: z.string(),
  slot: z.number().int().nullable(),
  cpuPercent: z.number().min(0),
  memoryUsedBytes: z.number().int().min(0),
  memoryLimitBytes: z.number().int().min(0),
  memoryPercent: z.number().min(0),
  networkRxBytes: z.number().int().min(0),
  networkTxBytes: z.number().int().min(0),
});
export type TaskMetrics = z.infer<typeof taskMetrics>;

/** One frame of the {@link servicesMetricsTopic} topic. */
export const servicesMetrics = z.object({
  /** False when Docker did not answer, in which case the previous readings no longer hold. */
  available: z.boolean(),
  readAt: z.iso.datetime().nullable(),
  services: z.array(
    z.object({
      projectName: z.string(),
      serviceName: z.string(),
      tasks: z.array(taskMetrics),
    }),
  ),
});
export type ServicesMetrics = z.infer<typeof servicesMetrics>;
