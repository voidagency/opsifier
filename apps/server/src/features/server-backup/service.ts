import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  backupActionTypes,
  type SaveServerBackupRequest,
  type ServerBackupRun,
  type ServerBackupSaved,
  type ServerBackupSnapshots,
  type ServerBackupState,
  serverRestore,
} from "@opsifier/contract";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { badRequest, conflict } from "../../core/errors";
import { Redactor, ToolNotFoundError } from "../../core/tools";
import { exportInstanceToFile } from "../backups/run";
import { isDatabaseRecord } from "../databases/service";
import { listServiceRecords } from "../services/repo";
import { findProviderRow, listProviderRows, type ProviderRow } from "../storage-providers/repo";
import { type ResticTarget, resticTargetFor } from "../storage-providers/service";
import { getSetting, putSetting } from "../system/repo";

const SETTINGS_KEY = "server_backup";
const KEY_CONTEXT = "server-backup-key";
/** Where the repository lives on a destination, under its own prefix. */
export const REPOSITORY_FOLDER = "opsifier-server";
const TAG = "opsifier";
const RESTIC_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const QUICK_TIMEOUT_MS = 2 * 60 * 1000;
const PRUNE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

const stored = z.object({
  enabled: z.boolean().default(false),
  providerId: z.string().nullable().default(null),
  time: z.string().default("02:30"),
  keepDaily: z.number().int().default(14),
  keepWeekly: z.number().int().default(8),
  keepMonthly: z.number().int().default(6),
  /** The restic password, sealed: the recovery key. */
  sealedKey: z.string().nullable().default(null),
  /** The repository that key opens. Another destination needs a repository, and a key, of its own. */
  repository: z.string().nullable().default(null),
  lastRun: z
    .object({
      actionId: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      snapshotId: z.string().nullable(),
      addedBytes: z.number().int().nullable(),
      processedBytes: z.number().int().nullable(),
      error: z.string().nullable(),
    })
    .nullable()
    .default(null),
  lastPruneAt: z.string().nullable().default(null),
  /** The restore that brought this server back, when it was. */
  restore: serverRestore.nullable().default(null),
});
type Stored = z.infer<typeof stored>;

function read(deps: Pick<AppDeps, "db">): Stored {
  return stored.parse(getSetting(deps.db, SETTINGS_KEY) ?? {});
}

function write(deps: Pick<AppDeps, "db" | "now">, changes: Partial<Stored>): Stored {
  const next = { ...read(deps), ...changes };
  putSetting(deps.db, SETTINGS_KEY, next, new Date(deps.now()));
  return next;
}

export const readServerBackup = read;
export const writeServerBackup = write;

/** While a restore runs, a backup would only copy a server half put back. */
const restoring = (settings: Stored): boolean => settings.restore?.status === "running";

/**
 * At boot, before anything runs: a run the last process left `running` was cut short by its end,
 * and would otherwise hold the schedule back for good.
 */
export function settleInterruptedRun(deps: AppDeps): void {
  const { lastRun } = read(deps);
  if (lastRun?.status === "running") {
    write(deps, {
      lastRun: {
        ...lastRun,
        status: "failed",
        finishedAt: new Date(deps.now()).toISOString(),
        error: "The panel restarted during this backup.",
      },
    });
  }
}

/** The next time the daily run is due, in UTC, after `now`. */
export function nextRunAt(time: string, now: number): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const day = new Date(now);
  const due = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes);
  return due > now ? due : due + 24 * 60 * 60 * 1000;
}

function usableTarget(deps: AppDeps, provider: ProviderRow): ResticTarget | null {
  return resticTargetFor(deps, provider, REPOSITORY_FOLDER);
}

export function serverBackupState(deps: AppDeps): ServerBackupState {
  const settings = read(deps);
  return {
    enabled: settings.enabled,
    providerId: settings.providerId,
    time: settings.time,
    keepDaily: settings.keepDaily,
    keepWeekly: settings.keepWeekly,
    keepMonthly: settings.keepMonthly,
    keyCreated: settings.sealedKey !== null,
    lastRun: settings.lastRun,
    nextRunAt: settings.enabled ? new Date(nextRunAt(settings.time, deps.now())).toISOString() : null,
    destinations: listProviderRows(deps.db).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      usable: row.connected && usableTarget(deps, row) !== null,
    })),
    repository: settings.sealedKey === null ? null : settings.repository,
    restore: settings.restore,
  };
}

interface Restic {
  run(
    args: readonly string[],
    options?: { ctx?: ActionContext; timeoutMs?: number; quiet?: boolean },
  ): Promise<string[]>;
}

/** restic, pointed at one repository with one key. Every line of its output passes through the redactor. */
function resticFor(deps: AppDeps, target: ResticTarget, password: string): Restic {
  const redact = new Redactor();
  for (const secret of [password, ...target.secrets]) {
    if (secret !== "") {
      redact.add(secret);
    }
  }
  const cacheDir = join(deps.config.dataDir, "server-backup", "cache");
  return {
    async run(args, options = {}) {
      const lines: string[] = [];
      let result: Awaited<ReturnType<AppDeps["tools"]["run"]>>;
      try {
        result = await deps.tools.run({
          command: "restic",
          args,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: cacheDir,
            RESTIC_CACHE_DIR: cacheDir,
            RESTIC_REPOSITORY: target.repository,
            RESTIC_PASSWORD: password,
            ...target.env,
          },
          redact,
          signal: options.ctx?.signal,
          timeoutMs: options.timeoutMs ?? QUICK_TIMEOUT_MS,
          onLine: (line) => {
            lines.push(line);
          },
        });
      } catch (error) {
        if (error instanceof ToolNotFoundError) {
          throw new Error("restic is not installed in this panel's image.");
        }
        throw error;
      }
      if (result.exitCode !== 0) {
        const detail =
          result.tail.filter((line) => !line.startsWith("{")).at(-1) ?? `exit code ${result.exitCode}`;
        throw new Error(`restic ${args[0]} failed: ${detail}`);
      }
      return lines;
    },
  };
}

function requireDestination(
  deps: AppDeps,
  providerId: string | null,
): { provider: ProviderRow; target: ResticTarget } {
  const provider = providerId === null ? undefined : findProviderRow(deps.db, providerId);
  if (provider === undefined) {
    throw badRequest("destination_missing", "Pick a destination for the backup.", { providerId: "Required" });
  }
  if (!provider.connected) {
    throw conflict("destination_not_connected", "This destination is not connected. Connect it in Settings.");
  }
  const target = usableTarget(deps, provider);
  if (target === null) {
    throw badRequest(
      "destination_unsupported",
      "A server backup can go to an S3-compatible destination or to this server's disk for now.",
      { providerId: "Not supported yet" },
    );
  }
  return { provider, target };
}

function keyOf(deps: AppDeps, settings: Stored): string {
  if (settings.sealedKey === null) {
    throw conflict("backup_not_set_up", "Save the backup's settings first: that creates its repository.");
  }
  return deps.secrets.unseal(settings.sealedKey, KEY_CONTEXT);
}

/**
 * Saves the settings. The first time a destination is chosen, the panel creates the repository there
 * and its recovery key, which this answer is the only one to carry.
 */
export async function saveServerBackup(
  deps: AppDeps,
  input: SaveServerBackupRequest,
  actorEmail: string | undefined,
): Promise<ServerBackupSaved> {
  let recoveryKey: string | null = null;
  const current = read(deps);
  const changes: Partial<Stored> = {
    enabled: input.enabled,
    providerId: input.providerId,
    time: input.time,
    keepDaily: input.keepDaily,
    keepWeekly: input.keepWeekly,
    keepMonthly: input.keepMonthly,
  };
  if (input.enabled || input.providerId !== null) {
    const { target } = requireDestination(deps, input.providerId);
    if (current.sealedKey === null || current.repository !== target.repository) {
      recoveryKey = randomBytes(32).toString("base64url");
      try {
        await resticFor(deps, target, recoveryKey).run(["init"]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already (exists|initialized)|config file already exists/i.test(message)) {
          throw conflict(
            "repository_exists",
            "A backup repository is already at this destination. Pick another destination or prefix.",
          );
        }
        throw badRequest("repository_failed", `The repository could not be created there: ${message}`);
      }
      changes.sealedKey = deps.secrets.seal(recoveryKey, KEY_CONTEXT);
      changes.repository = target.repository;
    }
  }
  write(deps, changes);
  deps.actions.record({
    type: backupActionTypes.config,
    title:
      recoveryKey === null ? "Changed the server backup" : "Set up the server backup and its recovery key",
    actorEmail,
  });
  return { ...serverBackupState(deps), recoveryKey };
}

export function revealRecoveryKey(deps: AppDeps): string {
  return keyOf(deps, read(deps));
}

const humanSize = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name backups are kept under: the server's own, from its Swarm node. restic forgets old backups
 * name by name, and the container's name, which a process sees as its host name, changes with every
 * update of the panel: each update would start a series that retention never reaches again.
 */
async function serverName(deps: AppDeps): Promise<string> {
  try {
    const [swarm, nodes] = await Promise.all([deps.docker.swarmInfo(), deps.docker.listNodes()]);
    const self = nodes.find((node) => node.id === swarm.nodeId);
    if (self !== undefined && self.hostname !== "") {
      return self.hostname;
    }
  } catch {
    // Docker could not say: the container's name is better than none.
  }
  return hostname();
}

/** Everything a server backup holds, gathered, then handed to restic, then forgotten by retention. */
async function runServerBackup(deps: AppDeps, ctx: ActionContext): Promise<void> {
  const settings = read(deps);
  const { provider, target } = requireDestination(deps, settings.providerId);
  if (settings.repository !== target.repository) {
    throw conflict("backup_not_set_up", "The destination changed: save the backup's settings again.");
  }
  const restic = resticFor(deps, target, keyOf(deps, settings));
  const startedAt = new Date(deps.now()).toISOString();
  const run = (changes: Partial<ServerBackupRun>): void => {
    const base: ServerBackupRun = read(deps).lastRun ?? {
      actionId: ctx.id,
      status: "running",
      startedAt,
      finishedAt: null,
      snapshotId: null,
      addedBytes: null,
      processedBytes: null,
      error: null,
    };
    write(deps, { lastRun: { ...base, actionId: ctx.id, ...changes } });
  };
  run({
    status: "running",
    startedAt,
    finishedAt: null,
    snapshotId: null,
    addedBytes: null,
    processedBytes: null,
    error: null,
  });

  const { dataDir } = deps.config;
  const staging = join(dataDir, "server-backup", "staging");
  try {
    ctx.log(`Destination: ${provider.name}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(staging, "dumps"), { recursive: true, mode: 0o700 });

    ctx.phase("export");
    // `VACUUM INTO` is one consistent copy, however busy the database is.
    const copy = join(staging, "state", "opsifier.db");
    deps.db.run(sql.raw(`VACUUM INTO '${copy.replaceAll("'", "''")}'`));
    await copyFile(deps.config.secretKeyFile, join(staging, "state", "secret.key"));
    const setupState = join(dataDir, "setup-state.json");
    if (await exists(setupState)) {
      await copyFile(setupState, join(staging, "state", "setup-state.json"));
    }
    ctx.log("Panel state copied: its database, its key and its setup record.");

    let skipped = 0;
    for (const record of listServiceRecords(deps.db).filter(isDatabaseRecord)) {
      const label = `${record.projectName}/${record.name}`;
      const folder = join(staging, "dumps", record.projectName);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try {
        const dumped = await exportInstanceToFile(
          deps,
          { projectName: record.projectName, serviceName: record.name },
          folder,
          ctx,
        );
        ctx.log(
          dumped === null
            ? `${label}: nothing to export for this engine.`
            : `${label}: ${humanSize(dumped.bytes)} exported.`,
        );
      } catch (error) {
        skipped += 1;
        ctx.log(`${label}: not exported, ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    ctx.phase("upload");
    // The Action logs too: without them, every entry under Activity would have lost its output.
    const paths = [staging, join(dataDir, "traefik"), join(dataDir, "projects"), deps.config.actionsDir];
    const present: string[] = [];
    for (const path of paths) {
      if (await exists(path)) {
        present.push(path);
      }
    }
    const host = await serverName(deps);
    const lines = await restic.run(
      ["backup", "--json", "--tag", TAG, "--host", host, "--exclude-caches", ...present],
      { ctx, timeoutMs: RESTIC_TIMEOUT_MS },
    );
    const summary = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((message) => message?.message_type === "summary");
    const snapshotId = typeof summary?.snapshot_id === "string" ? summary.snapshot_id : null;
    const addedBytes =
      typeof summary?.data_added_packed === "number"
        ? summary.data_added_packed
        : typeof summary?.data_added === "number"
          ? summary.data_added
          : null;
    const processedBytes =
      typeof summary?.total_bytes_processed === "number" ? summary.total_bytes_processed : null;
    ctx.log(
      `Snapshot ${snapshotId?.slice(0, 8) ?? "?"}: ${processedBytes === null ? "?" : humanSize(processedBytes)} read, ${addedBytes === null ? "?" : humanSize(addedBytes)} added.`,
    );

    ctx.phase("retention");
    const keep = [
      "--keep-daily",
      String(settings.keepDaily),
      "--keep-weekly",
      String(settings.keepWeekly),
      "--keep-monthly",
      String(settings.keepMonthly),
    ];
    const prune =
      settings.lastPruneAt === null || deps.now() - Date.parse(settings.lastPruneAt) >= PRUNE_EVERY_MS;
    if (settings.keepDaily + settings.keepWeekly + settings.keepMonthly > 0) {
      await restic.run(["forget", "--tag", TAG, ...keep, ...(prune ? ["--prune"] : [])], {
        ctx,
        timeoutMs: RESTIC_TIMEOUT_MS,
      });
      if (prune) {
        write(deps, { lastPruneAt: new Date(deps.now()).toISOString() });
      }
      ctx.log(prune ? "Old snapshots forgotten and their data removed." : "Old snapshots forgotten.");
    }

    run({
      status: "succeeded",
      finishedAt: new Date(deps.now()).toISOString(),
      snapshotId,
      addedBytes,
      processedBytes,
      error: skipped === 0 ? null : `${skipped} database(s) could not be exported: see the log.`,
    });
  } catch (error) {
    run({
      status: "failed",
      finishedAt: new Date(deps.now()).toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function startServerBackup(deps: AppDeps, actorEmail: string | undefined) {
  const settings = read(deps);
  if (restoring(settings)) {
    throw conflict(
      "restore_running",
      "This server is being brought back from a backup. Back it up once that is done.",
    );
  }
  requireDestination(deps, settings.providerId);
  keyOf(deps, settings);
  return deps.actions.enqueue({
    type: backupActionTypes.server,
    title: "Back up the server",
    actorEmail,
    run: (ctx) => runServerBackup(deps, ctx),
  });
}

export async function listServerSnapshots(deps: AppDeps): Promise<ServerBackupSnapshots> {
  const settings = read(deps);
  const { target } = requireDestination(deps, settings.providerId);
  const lines = await resticFor(deps, target, keyOf(deps, settings)).run([
    "snapshots",
    "--json",
    "--tag",
    TAG,
  ]);
  const parsed = JSON.parse(lines.join("\n") || "[]") as Array<{
    id: string;
    time: string;
    hostname: string;
    summary?: { data_added_packed?: number; data_added?: number; total_bytes_processed?: number };
  }>;
  return {
    snapshots: parsed
      .map((snapshot) => ({
        id: snapshot.id,
        time: snapshot.time,
        hostname: snapshot.hostname,
        addedBytes: snapshot.summary?.data_added_packed ?? snapshot.summary?.data_added ?? null,
        totalBytes: snapshot.summary?.total_bytes_processed ?? null,
      }))
      .sort((a, b) => b.time.localeCompare(a.time)),
  };
}

/**
 * Runs the daily backup when it is due: once a day, at its time, or at the first tick after it when the
 * panel was down then. A run started by hand after that time counts as the day's.
 */
export function startServerBackupSchedule(deps: AppDeps): () => void {
  const timer = setInterval(() => {
    const settings = read(deps);
    if (!settings.enabled || settings.sealedKey === null || restoring(settings)) {
      return;
    }
    const now = deps.now();
    // The last time the schedule came round, at or before now.
    const lastDue = nextRunAt(settings.time, now) - 24 * 60 * 60 * 1000;
    const lastStart = settings.lastRun === null ? 0 : Date.parse(settings.lastRun.startedAt);
    if (lastStart < lastDue && settings.lastRun?.status !== "running") {
      try {
        startServerBackup(deps, undefined);
      } catch (error) {
        deps.logger.warn(
          `The scheduled server backup could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
