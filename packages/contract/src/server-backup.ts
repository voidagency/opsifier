import { z } from "zod";

/**
 * A backup of the whole server: the panel's own state, a dump of every database and the files of
 * every volume, kept with restic in a storage destination. Encrypted with a recovery key the panel
 * shows once: without it, a backup cannot be read.
 */

const hourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, in UTC");
const keep = z.number().int().min(0).max(365);

/** PUT /api/v1/server/backup */
export const saveServerBackupRequest = z.strictObject({
  enabled: z.boolean(),
  /** A storage destination this kind of backup can use: S3-compatible or the server's own disk. */
  providerId: z.string().min(1).max(64).nullable(),
  /** Every day at this time, in UTC. */
  time: hourMinute,
  keepDaily: keep,
  keepWeekly: keep,
  keepMonthly: keep,
});
export type SaveServerBackupRequest = z.infer<typeof saveServerBackupRequest>;

export const serverBackupRun = z.object({
  actionId: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  snapshotId: z.string().nullable(),
  /** What this run added to the repository, compressed and deduplicated. */
  addedBytes: z.number().int().nullable(),
  /** The size of what this run read. */
  processedBytes: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type ServerBackupRun = z.infer<typeof serverBackupRun>;

export const serverBackupDestination = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  /** False for a destination this backup cannot write to yet: SFTP, FTP, Dropbox, Google Drive. */
  usable: z.boolean(),
});

/**
 * A server brought back from a backup: `install.sh --restore` puts the panel's state and the volumes
 * back, then the panel imports each database's export and redeploys what was running.
 */
export const serverRestore = z.object({
  status: z.enum(["running", "succeeded", "failed"]),
  actionId: z.string().nullable(),
  snapshotId: z.string(),
  /** When the backup was taken, and on which server. */
  snapshotTime: z.string(),
  hostname: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** What did not come back, one sentence each: a database that could not be imported, a failed deployment. */
  problems: z.array(z.string()),
});
export type ServerRestore = z.infer<typeof serverRestore>;

/** GET /api/v1/server/backup */
export const serverBackupState = z.object({
  enabled: z.boolean(),
  providerId: z.string().nullable(),
  time: z.string(),
  keepDaily: z.number().int(),
  keepWeekly: z.number().int(),
  keepMonthly: z.number().int(),
  /** Whether the recovery key exists: it is created with the repository, the first time. */
  keyCreated: z.boolean(),
  lastRun: serverBackupRun.nullable(),
  nextRunAt: z.string().nullable(),
  destinations: z.array(serverBackupDestination),
  /**
   * Where the backups are, as restic names it, with no secret in it. A restore on another server
   * needs this, the recovery key and the destination's own access keys.
   */
  repository: z.string().nullable(),
  /** The restore that brought this server back, when it was. */
  restore: serverRestore.nullable(),
});
export type ServerBackupState = z.infer<typeof serverBackupState>;

/** PUT /api/v1/server/backup. The recovery key comes back only when this save created it. */
export const serverBackupSaved = serverBackupState.extend({
  recoveryKey: z.string().nullable(),
});
export type ServerBackupSaved = z.infer<typeof serverBackupSaved>;

/** GET /api/v1/server/backup/snapshots */
export const serverBackupSnapshots = z.object({
  snapshots: z.array(
    z.object({
      id: z.string(),
      time: z.string(),
      hostname: z.string(),
      /** What this snapshot added to the repository, when restic says so. */
      addedBytes: z.number().int().nullable(),
      /** The size of the files it holds, when restic says so. */
      totalBytes: z.number().int().nullable(),
    }),
  ),
});
export type ServerBackupSnapshots = z.infer<typeof serverBackupSnapshots>;

/** POST /api/v1/server/backup/key. The owner proves who they are again: code if they have one, else password. */
export const revealServerBackupKeyRequest = z.strictObject({
  currentPassword: z.string().min(1).max(1024).optional(),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type RevealServerBackupKeyRequest = z.infer<typeof revealServerBackupKeyRequest>;

export const serverBackupKey = z.object({ recoveryKey: z.string() });
