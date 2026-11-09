import { z } from "zod";
import { digitsToNumber, resourceName } from "./common";
import { cronProblem } from "./cron";
import { databaseEngine } from "./databases";
import { servicePath } from "./services";

export const backupKinds = ["database", "volume"] as const;
export const backupKind = z.enum(backupKinds);
export type BackupKind = z.infer<typeof backupKind>;

/** Who asked for a backup. Retention only ever touches `schedule`. */
export const backupOrigins = ["manual", "schedule", "safety"] as const;
export const backupOrigin = z.enum(backupOrigins);
export type BackupOrigin = z.infer<typeof backupOrigin>;

export const backupRunStatuses = ["running", "succeeded", "failed", "cancelled"] as const;
export const backupRunStatus = z.enum(backupRunStatuses);
export type BackupRunStatus = z.infer<typeof backupRunStatus>;

/** A named, versioned format: what a backup is, independent of what its file is called. */
export const backupFormats = [
  "postgres-sql-gz-v1",
  "postgres-instance-sql-gz-v1",
  "postgres-accounts-sql-gz-v1",
  "mysql-sql-gz-v1",
  "mysql-instance-sql-gz-v1",
  "mysql-accounts-sql-gz-v1",
  "mariadb-sql-gz-v1",
  "mariadb-instance-sql-gz-v1",
  "mariadb-accounts-sql-gz-v1",
  "mongo-archive-v1",
  "mongo-instance-archive-v1",
  "mongo-accounts-jsonl-gz-v1",
  "volume-tar-gz-v1",
] as const;
export const backupFormat = z.enum(backupFormats);
export type BackupFormat = z.infer<typeof backupFormat>;

/**
 * What a backup holds, and nothing else: `database` is one database and no accounts, `instance` is
 * every database of the server with its accounts, `accounts` is users and roles alone, `volume` is
 * one named volume. The panel's own account is never put back by a restore, because the panel holds
 * its password itself.
 */
export const backupScopes = ["database", "instance", "accounts", "volume"] as const;
export const backupScope = z.enum(backupScopes);
export type BackupScope = z.infer<typeof backupScope>;

export const databaseBackupScopes = ["database", "instance", "accounts"] as const;
export const databaseBackupScope = z.enum(databaseBackupScopes);
export type DatabaseBackupScope = z.infer<typeof databaseBackupScope>;

export const backupActionTypes = {
  database: "backup.database",
  volume: "backup.volume",
  restoreDatabase: "backup.restore-database",
  restoreVolume: "backup.restore-volume",
  remove: "backup.delete",
  config: "backup.config",
  download: "backup.download",
} as const;

export const backupSchedulePresets = [
  { key: "everyMinute", cron: "* * * * *" },
  { key: "everyHour", cron: "0 * * * *" },
  { key: "every6Hours", cron: "0 */6 * * *" },
  { key: "daily2", cron: "0 2 * * *" },
  { key: "daily0", cron: "0 0 * * *" },
] as const;
export type BackupPresetKey = (typeof backupSchedulePresets)[number]["key"];

export const DEFAULT_BACKUP_CRON = "0 2 * * *";

/** The preset an expression corresponds to, or null for anything else. */
export function presetOfCron(cron: string): BackupPresetKey | null {
  const normalized = cron.trim().replace(/\s+/g, " ");
  return backupSchedulePresets.find((preset) => preset.cron === normalized)?.key ?? null;
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const cronExpression = z
  .string("Required")
  .trim()
  .min(1, "Required")
  .max(128, "This is too long")
  .superRefine((value, ctx) => {
    if (value === "") {
      return;
    }
    const problem = cronProblem(value);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", message: problem });
    }
  });

/** Letters, digits, dashes, dots and underscores, in plain folder steps. */
export const backupPathRule =
  "Use letters, digits, dashes, dots, underscores and slashes, with no empty or dot-only folder";

/** A folder inside a storage provider. Leading and trailing slashes do not matter. */
export const backupPath = z
  .string("Required")
  .trim()
  .min(1, "Required")
  .max(512, "This is too long")
  .regex(/^[A-Za-z0-9._/-]+$/, backupPathRule)
  .refine((value) => {
    const folders = value.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
    return folders.every((folder) => folder !== "" && folder !== "." && folder !== "..");
  }, backupPathRule)
  .transform((value) => value.replace(/^\/+/, "").replace(/\/+$/, ""));

/**
 * Names may contain dots and dashes, but never anything a client could read as an option or as a
 * connection string, such as `=`, a leading dash, a slash or a space.
 */
export const backupDatabaseName = z
  .string("Required")
  .trim()
  .min(1, "Required")
  .max(128, "This is too long")
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "Use letters, digits, dashes, dots and underscores");

export const retentionCount = z.preprocess(
  (value) => (blank(value) === undefined || value === null ? null : value),
  z.preprocess(
    digitsToNumber,
    z
      .number("Must be a number")
      .int("Must be a whole number")
      .min(1, "Keep at least one")
      .max(10_000, "Must be at most 10,000")
      .nullable(),
  ),
);

const storageProviderId = z.string("Required").trim().min(1, "Required").max(64, "Required");

const baseConfig = {
  enabled: z.boolean().default(true),
  schedule: cronExpression,
  retention: retentionCount,
  storageProviderId,
  path: backupPath,
};

/** Which database to export: only one scope has a choice to make. */
const databaseConfig = z
  .object({
    kind: z.literal("database"),
    ...baseConfig,
    scope: databaseBackupScope.default("database"),
    databaseName: z.preprocess(blank, backupDatabaseName.optional()),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "database" && value.databaseName === undefined) {
      ctx.addIssue({ code: "custom", path: ["databaseName"], message: "Required" });
    }
  });

/** POST and PUT of a backup configuration. The kind has to match the service. */
export const saveBackupConfigRequest = z.discriminatedUnion("kind", [
  databaseConfig,
  z.object({ kind: z.literal("volume"), ...baseConfig, volumeName: resourceName }),
]);
export type SaveBackupConfigRequest = z.input<typeof saveBackupConfigRequest>;
export type SaveBackupConfigFields = z.output<typeof saveBackupConfigRequest>;

/** POST .../backups/configs/{id}/run. The name only labels the run. */
export const runBackupRequest = z.object({
  name: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .max(80, "This is too long")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
      .regex(/^[^\u0000-\u001f\u007f]*$/, "Must not contain control characters")
      .optional(),
  ),
});
export type RunBackupRequest = z.input<typeof runBackupRequest>;

/** Exactly what is about to be replaced, typed by a person and checked again on the server. */
const confirmation = z.string("Required").min(1, "Required").max(256);

/** POST .../backups/{id}/restore: put one recorded backup back. */
export const restoreBackupRequest = z.object({
  confirm: confirmation,
  /** Only for databases: load into another database of this service. Defaults to the original. */
  databaseName: z.preprocess(blank, backupDatabaseName.optional()),
});
export type RestoreBackupRequest = z.input<typeof restoreBackupRequest>;

/** POST .../backups/restore: a file named directly, for a backup the panel has no record of. */
export const restoreFromPathRequest = z.object({
  storageProviderId,
  /** The file itself, inside the provider. */
  path: z
    .string("Required")
    .trim()
    .min(1, "Required")
    .max(1024, "This is too long")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
    .regex(/^[^\u0000-\u001f\u007f\\]*$/, "Must not contain control characters")
    .refine(
      (value) =>
        value
          .replace(/^\/+/, "")
          .split("/")
          .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
      "Use the path of a file, with no . or .. in it",
    )
    .transform((value) => value.replace(/^\/+/, "")),
  /** For a database, what the file is expected to hold. It has to agree with the file's manifest. */
  scope: databaseBackupScope.optional(),
  /** For a database, which one to restore into. For a service with volumes, which volume. */
  databaseName: z.preprocess(blank, backupDatabaseName.optional()),
  confirm: confirmation,
});
export type RestoreFromPathRequest = z.input<typeof restoreFromPathRequest>;
export type RestoreFromPathFields = z.output<typeof restoreFromPathRequest>;

export const resolveRestoreRequest = z.object({ confirm: confirmation });
export type ResolveRestoreRequest = z.input<typeof resolveRestoreRequest>;

export const backupConfigPath = servicePath.extend({ config: z.string().min(1).max(64) });
export const backupRecordPath = servicePath.extend({ backup: z.string().min(1).max(64) });
export const restoreRecordPath = servicePath.extend({ restore: z.string().min(1).max(64) });

const iso = z.iso.datetime();

/** One saved configuration. It can run on a schedule, by hand, or both. */
export const backupConfigEntry = z.object({
  id: z.string(),
  kind: backupKind,
  scope: backupScope,
  enabled: z.boolean(),
  schedule: z.string(),
  /** Scheduled runs kept. Null means all of them. Manual and safety backups never count. */
  retention: z.number().int().nullable(),
  /** Null when the scope is not one database. */
  databaseName: z.string().nullable(),
  volumeName: z.string().nullable(),
  /** Null once the provider has been deleted: the configuration stops running until edited. */
  storageProviderId: z.string().nullable(),
  storageProviderName: z.string().nullable(),
  /** The destination exists and is connected. */
  destinationReady: z.boolean(),
  path: z.string(),
  /** When it next runs. Null while disabled. Survives restarts. */
  nextRunAt: iso.nullable(),
  lastRun: z.object({ status: backupRunStatus, finishedAt: iso.nullable(), backupId: z.string() }).nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type BackupConfigEntry = z.infer<typeof backupConfigEntry>;

export const backupEntry = z.object({
  id: z.string(),
  kind: backupKind,
  origin: backupOrigin,
  /** The label a person gave the run. */
  name: z.string().nullable(),
  configId: z.string().nullable(),
  status: backupRunStatus,
  databaseName: z.string().nullable(),
  volumeName: z.string().nullable(),
  engine: databaseEngine.nullable(),
  engineVersion: z.string().nullable(),
  format: backupFormat.nullable(),
  scope: backupScope,
  storageProviderId: z.string().nullable(),
  storageProviderName: z.string(),
  /** The file inside the provider. */
  path: z.string(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  actionId: z.string().nullable(),
  error: z.string().nullable(),
  /** Old copies could not be cleared. The backup itself still succeeded. */
  cleanupError: z.string().nullable(),
  /** Removed by retention or by hand. Only the record of it remains. */
  deletedAt: iso.nullable(),
  /** Whether a restore can be started from this row right now. */
  restorable: z.boolean(),
  createdAt: iso,
  finishedAt: iso.nullable(),
});
export type BackupEntry = z.infer<typeof backupEntry>;

export const restorePhases = [
  "verifying",
  "safety",
  "importing",
  "checking",
  "staging",
  "swapping",
  "starting",
  "done",
] as const;
export const restorePhase = z.enum(restorePhases);
export type RestorePhase = z.infer<typeof restorePhase>;

export const restoreEntry = z.object({
  id: z.string(),
  kind: backupKind,
  scope: backupScope,
  backupId: z.string().nullable(),
  /** The file it came from, inside its provider. */
  sourcePath: z.string(),
  storageProviderName: z.string(),
  databaseName: z.string().nullable(),
  volumeName: z.string().nullable(),
  status: backupRunStatus,
  phase: restorePhase,
  safetyBackupId: z.string().nullable(),
  /** Set after a volume restore: the folder holding what the volume contained before. */
  earlierCopy: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actionId: z.string().nullable(),
  error: z.string().nullable(),
  /** The panel could not tell how it ended. Data operations stay refused until someone checks. */
  unresolved: z.boolean(),
  createdAt: iso,
  finishedAt: iso.nullable(),
});
export type RestoreEntry = z.infer<typeof restoreEntry>;

/** GET .../backups: everything the Backups tab and the volume backups section show. */
export const backupsDocument = z.object({
  /** The IANA zone schedules run in: the server's own. */
  timezone: z.string(),
  configs: z.array(backupConfigEntry),
  backups: z.array(backupEntry),
  restores: z.array(restoreEntry),
  /** The service's own database, to prefill the form. Null for an App service. */
  defaultDatabase: z.string().nullable(),
  /** Named volumes this service mounts. Empty for a database. */
  volumes: z.array(z.string()),
});
export type BackupsDocument = z.infer<typeof backupsDocument>;

export const databaseNameList = z.object({ databases: z.array(z.string()) });
export type DatabaseNameList = z.infer<typeof databaseNameList>;

/**
 * Written next to every backup file, as `<file>.manifest.json`. It says what the file is and proves it
 * is intact, so a file can be restored by a panel that has no record of it, such as after a total loss.
 */
export const backupManifest = z.object({
  opsifierBackup: z.literal(1),
  id: z.string(),
  kind: backupKind,
  format: backupFormat,
  scope: backupScope,
  engine: databaseEngine.nullable(),
  engineVersion: z.string().nullable(),
  databaseName: z.string().nullable(),
  volumeName: z.string().nullable(),
  source: z.object({ project: z.string(), service: z.string() }),
  createdAt: iso,
  sizeBytes: z.number().int().min(0),
  /** What it takes on disk once unpacked. Null when the format's tool doesn't say. */
  uncompressedBytes: z.number().int().min(0).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  panelVersion: z.string(),
});
export type BackupManifest = z.infer<typeof backupManifest>;
