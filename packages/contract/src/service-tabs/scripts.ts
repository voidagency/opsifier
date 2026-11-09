import { z } from "zod";
import { actionEntry } from "../actions";
import { cronExpression } from "../backups";
import { digitsToNumber, wholeNumber } from "../common";
import { servicePath } from "../services";

export const MAX_SCRIPTS = 64;

/** Fits in one exec argument, which the kernel caps at 128 KiB. */
const MAX_SCRIPT_CHARS = 64 * 1024;

const SCRIPT_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u;

/** How long a script may run when nobody says otherwise. */
export const DEFAULT_SCRIPT_MAX_SECONDS = 60 * 60;
export const MAX_SCRIPT_MAX_SECONDS = 24 * 60 * 60;

/** What a run keeps of its output: the end, which is what says how it went. */
export const MAX_SCRIPT_OUTPUT_CHARS = 64 * 1024;

/** A run and its output stay in a script's history until this many newer ones have replaced it. */
export const SCRIPT_RUNS_KEPT = 50;
/** Far fewer skips are kept, so that a schedule outrunning itself cannot push real runs out. */
export const SCRIPT_SKIPS_KEPT = 20;

const scriptNameSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(64, "Must be at most 64 characters")
  .regex(SCRIPT_NAME, "Use letters, digits, spaces, dots, dashes and underscores");

const TIME_ZONE_PROBLEM = "Use a time zone name such as Europe/Paris or UTC";

/** Reports the name by which this runtime knows a zone, or null when it doesn't know it. */
function canonicalTimeZone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** An IANA time zone, stored under the name the runtime knows it by. */
export const timeZoneName = z
  .string("Required")
  .trim()
  .min(1, "Required")
  .max(64, TIME_ZONE_PROBLEM)
  .superRefine((value, ctx) => {
    if (value !== "" && canonicalTimeZone(value) === null) {
      ctx.addIssue({ code: "custom", message: TIME_ZONE_PROBLEM });
    }
  })
  .transform((value) => canonicalTimeZone(value) ?? value);

/** When a script runs by itself. The zone is always stated: nothing here follows the server's clock. */
export const scriptSchedule = z.object({
  cron: cronExpression,
  timeZone: timeZoneName,
});
export type ScriptSchedule = z.infer<typeof scriptSchedule>;

/**
 * A named shell snippet of a service. It can be run by hand, through the API, on a schedule, or after
 * every deployment, and each of those runs obeys the same limit and the same overlap policy.
 */
export const scriptSpec = z.object({
  name: scriptNameSchema,
  script: z.string().max(MAX_SCRIPT_CHARS, "This is too long").default(""),
  /** When the time is up the process is ended, whatever it is doing. */
  maxDurationSeconds: z
    .preprocess(
      digitsToNumber,
      z
        .number("Must be a whole number")
        .int("Must be a whole number")
        .min(1, "Must be at least one second")
        .max(MAX_SCRIPT_MAX_SECONDS, "Must be at most 24 hours"),
    )
    .default(DEFAULT_SCRIPT_MAX_SECONDS),
  schedule: scriptSchedule.nullable().default(null),
  /** A hook: also run once after every deployment of the service that succeeds. */
  runAfterDeploy: z.boolean().default(false),
});
export type ScriptSpec = z.infer<typeof scriptSpec>;

/** One script of a service, by its position in the list. */
export const scriptItemPath = servicePath.extend({ index: wholeNumber(0, 999) });

/** How a run came to be started. The console is the one way that runs in a terminal, not under watch. */
export const scriptRunOrigins = ["manual", "api", "schedule", "hook", "console"] as const;
export const scriptRunOrigin = z.enum(scriptRunOrigins);
export type ScriptRunOrigin = z.infer<typeof scriptRunOrigin>;

/**
 * `unknown` is a run the panel lost sight of with no way to tell how it ended, and `skipped` a due time
 * that found the previous run of the same script still in progress: nothing was started for it.
 */
export const scriptRunStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
  "unknown",
] as const;
export const scriptRunStatus = z.enum(scriptRunStatuses);
export type ScriptRunStatus = z.infer<typeof scriptRunStatus>;

/** Why a run is the way it is, as a code the interface can say in its own language. */
export const scriptRunNoteCodes = [
  "not_started",
  "no_running_task",
  "script_deleted",
  "start_failed",
  "connection_lost",
  "time_limit",
  "end_unconfirmed",
  "panel_restarted",
  "panel_restarted_running",
  "panel_restarted_finished",
  "panel_restarted_unknown",
  "console_output",
  "console_closed",
  "skipped_overlap",
  "skipped_refused",
] as const;
export const scriptRunNoteCode = z.enum(scriptRunNoteCodes);
export type ScriptRunNoteCode = z.infer<typeof scriptRunNoteCode>;

/**
 * What is known and what is not about how a run went, for when the plain outcome doesn't say it all.
 * `message` is in English. For `start_failed` and `skipped_refused` it is only the reason that was given.
 */
export const scriptRunNote = z.object({ code: scriptRunNoteCode, message: z.string() });
export type ScriptRunNote = z.infer<typeof scriptRunNote>;

/** One attempt to run a script, however it was started and however it turned out. */
export const scriptRun = z.object({
  /** Also the id of its Action, except for a skip, which started nothing. */
  id: z.string(),
  scriptName: z.string(),
  status: scriptRunStatus,
  origin: scriptRunOrigin,
  /** The account behind it: the one signed in, an API key's owner. Null for what the panel started itself. */
  actorEmail: z.string().nullable(),
  /** An API key's name. */
  originDetail: z.string().nullable(),
  /** As Docker reported it. Null when it never started, or when nobody could tell. */
  exitCode: z.number().int().nullable(),
  /** The task it ran in, once it found one. */
  task: z.object({ id: z.string(), slot: z.number().int().nullable() }).nullable(),
  maxDurationSeconds: z.number().int(),
  /** The occurrence of the schedule this run is for. Null for anything not started by a schedule. */
  dueAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  note: scriptRunNote.nullable(),
  /** False once output may be missing: the panel restarted during the run, or lost its connection to it. */
  outputComplete: z.boolean(),
  /** True when the run printed more than is kept, so only the end of it is here. */
  outputTruncated: z.boolean(),
});
export type ScriptRun = z.infer<typeof scriptRun>;

/** One run with what it printed. */
export const scriptRunDetail = scriptRun.extend({ output: z.string() });
export type ScriptRunDetail = z.infer<typeof scriptRunDetail>;

/** A script as the API shows it: its settings and what it is doing now. */
export const scriptEntry = scriptSpec.extend({
  /** The next occurrence of its schedule. Null when it has none. */
  nextRunAt: z.iso.datetime().nullable().default(null),
  /** Its most recent run, or null if it was never run. */
  lastRun: scriptRun.nullable().default(null),
});
export type ScriptEntry = z.infer<typeof scriptEntry>;

/** GET /api/v1/projects/{project}/services/{service}/scripts, and the answer to every change. */
export const scriptList = z.object({ scripts: z.array(scriptEntry) });
export type ScriptList = z.infer<typeof scriptList>;

/** A run of one service. Generated by the panel, so never anything that could leave the URL. */
export const scriptRunPath = servicePath.extend({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
});

/** POST /api/v1/projects/{project}/services/{service}/script-runs */
export const startScriptRunRequest = z.object({ script: scriptNameSchema });
export type StartScriptRunRequest = z.infer<typeof startScriptRunRequest>;

/** The Action doing the work, and the run it belongs to. */
export const startedScriptRun = actionEntry.extend({ run: scriptRun });
export type StartedScriptRun = z.infer<typeof startedScriptRun>;

/** GET /api/v1/projects/{project}/services/{service}/script-runs: newest first. */
export const listScriptRunsQuery = z.object({
  limit: wholeNumber(1, 100).default(25),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, "Invalid cursor")
    .optional(),
  script: scriptNameSchema.optional(),
});
export type ListScriptRunsQuery = z.infer<typeof listScriptRunsQuery>;

export const scriptRunPage = z.object({
  items: z.array(scriptRun),
  /** Pass as `cursor` to load the next page. Null when there is nothing more. */
  nextCursor: z.string().nullable(),
});
export type ScriptRunPage = z.infer<typeof scriptRunPage>;
