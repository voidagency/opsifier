import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type BackupConfigEntry,
  type BackupEntry,
  type BackupFormat,
  type BackupsDocument,
  backupActionTypes,
  type DatabaseBackupScope,
  type DatabaseEngine,
  type DatabaseNameList,
  isDatabaseEngine,
  nextCronOccurrence,
  parseCron,
  type RestoreEntry,
  type RestoreFromPathFields,
  type SaveBackupConfigFields,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { type AppError, badRequest, conflict, notFound } from "../../core/errors";
import { type Access, hasProjectLevel } from "../access/rules";
import { deployedVolumes } from "../services/applied";
import { qualifiedName } from "../services/compile";
import { inspectOwnedService } from "../services/ownership";
import { listActiveServiceActions, type ServiceRecord } from "../services/repo";
import { assertRuntimeCertain } from "../services/runtime-state";
import { requireService, type ServiceTarget } from "../services/service";
import { findProviderRow, type ProviderRow } from "../storage-providers/repo";
import { backendForProvider, safeStorageMessage, toStorageError } from "../storage-providers/service";
import { backupOpsFor, engineHasBackups, systemDatabaseFilter } from "./engines";
import {
  type BackupConfigRow,
  type BackupRow,
  deleteConfig as deleteConfigRow,
  findBackup,
  findConfig,
  findRestore,
  findUnresolvedRestore,
  insertConfig,
  isBackupBeingRestored,
  latestBackupOfConfig,
  listBackups,
  listConfigs,
  listRestores,
  providerNames,
  type RestoreRow,
  updateBackup,
  updateConfig,
  updateRestore,
} from "./repo";
import {
  type DatabaseRestoreRequest,
  performDatabaseRestore,
  performInstanceRestore,
  performVolumeRestore,
  type RestoreSource,
} from "./restore";
import {
  applyRetention,
  assertDisk,
  credentialsOf,
  describeScope,
  freeBytes,
  makeWorkDir,
  queryEngine,
  removeStoredFile,
  secretsOf,
  sha256Of,
  takeDatabaseBackup,
  takeVolumeBackup,
  volumeDirectory,
} from "./run";

/** The next time a schedule fires, strictly after `from`. The expression has been validated already. */
export function nextRunFrom(schedule: string, from: number): number {
  const next = nextCronOccurrence(parseCron(schedule), from);
  if (next === null) {
    throw new Error(`The schedule ${schedule} never happens.`);
  }
  return next;
}

const databaseOf = (record: ServiceRecord): string | null => record.spec.database?.databaseName ?? null;

/**
 * The volumes a backup can reach: the ones the deployed version really mounts. Saved mounts that were
 * never deployed do not exist yet, and removing one from the settings changes nothing until it is
 * deployed. A service with no record of what was deployed is judged by what is saved.
 */
function backupVolumes(
  deps: Pick<AppDeps, "secrets" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
) {
  return (
    deployedVolumes(deps, target, record) ??
    record.spec.mounts.flatMap((mount) => (mount.type === "volume" ? [mount.name] : []))
  );
}

function requireBackupable(record: ServiceRecord): "database" | "volume" {
  if (record.spec.database !== null) {
    if (!engineHasBackups(record.spec.database.engine)) {
      throw conflict("backups_not_available", "This engine has no backups.");
    }
    return "database";
  }
  return "volume";
}

export function assertNoUnresolvedRestore(deps: Pick<AppDeps, "db">, target: ServiceTarget): void {
  if (findUnresolvedRestore(deps.db, target.projectName, target.serviceName) !== undefined) {
    throw conflict(
      "restore_unresolved",
      "A restore on this service did not finish cleanly. Sort it out first: nothing else may touch its data until then.",
    );
  }
  assertRuntimeCertain(deps, target);
}

const hasActiveWork = (deps: Pick<AppDeps, "db">, target: ServiceTarget): boolean =>
  listActiveServiceActions(deps.db).some(
    (action) => action.projectName === target.projectName && action.serviceName === target.serviceName,
  );

function assertIdle(deps: Pick<AppDeps, "db">, target: ServiceTarget): void {
  if (hasActiveWork(deps, target)) {
    throw conflict(
      "service_busy",
      "Other work is in progress on this service. A restore can only start once it has finished.",
    );
  }
}

function requireReadyProvider(deps: Pick<AppDeps, "db">, id: string | null): ProviderRow {
  const provider = id === null ? undefined : findProviderRow(deps.db, id);
  if (provider === undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      storageProviderId: "This destination does not exist",
    });
  }
  if (!provider.connected) {
    throw badRequest(
      "provider_not_connected",
      "This destination is not connected. Connect it in Settings first.",
      {
        storageProviderId: "Connect this destination first",
      },
    );
  }
  return provider;
}

function toConfigEntry(deps: Pick<AppDeps, "db">, row: BackupConfigRow): BackupConfigEntry {
  const provider =
    row.storageProviderId === null ? undefined : findProviderRow(deps.db, row.storageProviderId);
  const last = latestBackupOfConfig(deps.db, row.id);
  return {
    id: row.id,
    kind: row.kind,
    scope: row.kind === "volume" ? "volume" : row.scope,
    enabled: row.enabled,
    schedule: row.schedule,
    retention: row.retention,
    databaseName: row.databaseName,
    volumeName: row.volumeName,
    storageProviderId: row.storageProviderId,
    storageProviderName: provider?.name ?? null,
    destinationReady: provider?.connected === true,
    path: row.path,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRun:
      last === undefined
        ? null
        : { status: last.status, finishedAt: last.finishedAt?.toISOString() ?? null, backupId: last.id },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBackupEntry(
  row: BackupRow,
  providers: ReadonlyMap<string, { name: string; connected: boolean }>,
): BackupEntry {
  const provider = row.storageProviderId === null ? undefined : providers.get(row.storageProviderId);
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    name: row.name,
    configId: row.configId,
    status: row.status,
    databaseName: row.databaseName,
    volumeName: row.volumeName,
    engine: row.engine === null ? null : isDatabaseEngine(row.engine) ? row.engine : null,
    engineVersion: row.engineVersion,
    format: row.format as BackupFormat | null,
    scope: row.scope,
    storageProviderId: row.storageProviderId,
    storageProviderName: provider?.name ?? row.storageProviderName,
    path: row.path,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    actionId: row.actionId,
    error: row.error,
    cleanupError: row.cleanupError,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    restorable: row.status === "succeeded" && row.deletedAt === null && provider?.connected === true,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toRestoreEntry(row: RestoreRow): RestoreEntry {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    backupId: row.backupId,
    sourcePath: row.sourcePath,
    storageProviderName: row.storageProviderName,
    databaseName: row.databaseName,
    volumeName: row.volumeName,
    status: row.status,
    phase: row.phase as RestoreEntry["phase"],
    safetyBackupId: row.safetyBackupId,
    earlierCopy: row.earlierCopy,
    actorEmail: row.actorEmail,
    actionId: row.actionId,
    error: row.error,
    unresolved: row.unresolved,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** The zone schedules are computed in. Stable across requests: it's the server's own. */
export const serverTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function getBackupsDocument(deps: AppDeps, target: ServiceTarget): BackupsDocument {
  const record = requireService(deps, target);
  const backups = listBackups(deps.db, target.projectName, target.serviceName, record.createdAt);
  const providers = providerNames(
    deps.db,
    backups.flatMap((row) => (row.storageProviderId === null ? [] : [row.storageProviderId])),
  );
  return {
    timezone: serverTimezone(),
    configs: listConfigs(deps.db, target.projectName, target.serviceName).map((row) =>
      toConfigEntry(deps, row),
    ),
    backups: backups.map((row) => toBackupEntry(row, providers)),
    restores: listRestores(deps.db, target.projectName, target.serviceName, record.createdAt).map(
      toRestoreEntry,
    ),
    defaultDatabase: databaseOf(record),
    volumes: backupVolumes(deps, target, record),
  };
}

function assertKindFits(
  deps: Pick<AppDeps, "secrets" | "logger">,
  target: ServiceTarget,
  record: ServiceRecord,
  request: SaveBackupConfigFields,
): void {
  const expected = requireBackupable(record);
  if (request.kind !== expected) {
    throw badRequest(
      "validation_failed",
      request.kind === "database"
        ? "This service is not a database."
        : "This service keeps its data in a database, not in named volumes.",
    );
  }
  if (request.kind === "volume" && !backupVolumes(deps, target, record).includes(request.volumeName)) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      volumeName: `This service has no volume named ${request.volumeName} deployed`,
    });
  }
}

export function saveConfig(
  deps: AppDeps,
  target: ServiceTarget,
  request: SaveBackupConfigFields,
  configId: string | null,
  actorEmail: string | undefined,
): BackupConfigEntry {
  const record = requireService(deps, target);
  assertKindFits(deps, target, record, request);
  const provider = requireReadyProvider(deps, request.storageProviderId);
  const now = new Date(deps.now());
  const nextRunAt = request.enabled ? new Date(nextRunFrom(request.schedule, deps.now())) : null;
  const fields = {
    enabled: request.enabled,
    scope: request.kind === "volume" ? ("volume" as const) : request.scope,
    schedule: request.schedule,
    retention: request.retention,
    databaseName:
      request.kind === "database" && request.scope === "database" ? (request.databaseName as string) : null,
    volumeName: request.kind === "volume" ? request.volumeName : null,
    storageProviderId: provider.id,
    path: request.path,
    nextRunAt,
    updatedAt: now,
  };

  let saved: BackupConfigRow;
  if (configId === null) {
    saved = insertConfig(deps.db, {
      id: nanoid(),
      projectName: target.projectName,
      serviceName: target.serviceName,
      kind: request.kind,
      createdAt: now,
      ...fields,
    });
  } else {
    requireConfig(deps, target, configId);
    saved = updateConfig(deps.db, configId, fields) as BackupConfigRow;
  }
  deps.actions.record({
    type: backupActionTypes.config,
    title: `${configId === null ? "Add" : "Update"} a backup configuration of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return toConfigEntry(deps, saved);
}

export function requireConfig(deps: Pick<AppDeps, "db">, target: ServiceTarget, id: string): BackupConfigRow {
  const config = findConfig(deps.db, id);
  if (
    config === undefined ||
    config.projectName !== target.projectName ||
    config.serviceName !== target.serviceName
  ) {
    throw notFound("This backup configuration does not exist.");
  }
  return config;
}

/** Stored files stay where they are: this only stops further backups from being made. */
export function deleteConfig(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  actorEmail: string | undefined,
): void {
  requireConfig(deps, target, id);
  deleteConfigRow(deps.db, id);
  deps.actions.record({
    type: backupActionTypes.config,
    title: `Remove a backup configuration of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
}

/**
 * A record by its id, when it is this service's. Rows outlive their service, and one older than the
 * service that has its name now was another's, maybe another project's: the listings leave it out,
 * and so does this.
 */
function ownRecord<T extends { projectName: string; serviceName: string; createdAt: Date }>(
  deps: Pick<AppDeps, "db">,
  target: ServiceTarget,
  row: T | undefined,
): T | undefined {
  if (row === undefined || row.projectName !== target.projectName || row.serviceName !== target.serviceName) {
    return undefined;
  }
  const service = requireService(deps, target);
  return row.createdAt.getTime() >= service.createdAt.getTime() ? row : undefined;
}

function requireBackup(deps: Pick<AppDeps, "db">, target: ServiceTarget, id: string): BackupRow {
  const backup = ownRecord(deps, target, findBackup(deps.db, id));
  if (backup === undefined) {
    throw notFound("This backup does not exist.");
  }
  return backup;
}

function requireRestore(deps: Pick<AppDeps, "db">, target: ServiceTarget, id: string): RestoreRow {
  const restore = ownRecord(deps, target, findRestore(deps.db, id));
  if (restore === undefined) {
    throw notFound("This restore does not exist.");
  }
  return restore;
}

export interface RunRequest {
  origin: "manual" | "schedule";
  name: string | null;
  actorEmail: string | undefined;
}

/** Starts one configured backup, on demand or from the scheduler. Retention runs after it succeeds. */
export function enqueueConfiguredBackup(
  deps: AppDeps,
  target: ServiceTarget,
  configId: string,
  request: RunRequest,
): ActionRow {
  const config = requireConfig(deps, target, configId);
  assertNoUnresolvedRestore(deps, target);
  const provider = findRunnableProvider(deps, config);

  const subject =
    config.kind === "volume"
      ? config.volumeName
      : config.scope === "database"
        ? config.databaseName
        : describeScope(config.scope as DatabaseBackupScope, config.databaseName);
  const suffix = request.name === null ? "" : `: ${request.name}`;
  return deps.actions.enqueue({
    type: config.kind === "database" ? backupActionTypes.database : backupActionTypes.volume,
    title: `Back up ${subject} of ${target.projectName}/${target.serviceName}${suffix}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail: request.actorEmail,
    run: (ctx) => runConfiguredBackup(deps, target, configId, provider.id, request, ctx),
  });
}

/** A provider removed or disconnected after a configuration was saved fails here, loudly. */
function findRunnableProvider(deps: Pick<AppDeps, "db">, config: BackupConfigRow): ProviderRow {
  const provider =
    config.storageProviderId === null ? undefined : findProviderRow(deps.db, config.storageProviderId);
  if (provider === undefined) {
    throw conflict(
      "provider_missing",
      "This backup's destination has been removed. Edit it and pick another.",
    );
  }
  if (!provider.connected) {
    throw conflict(
      "provider_not_connected",
      "This backup's destination is not connected. Connect it in Settings.",
    );
  }
  return provider;
}

async function runConfiguredBackup(
  deps: AppDeps,
  target: ServiceTarget,
  configId: string,
  providerId: string,
  request: RunRequest,
  ctx: ActionContext,
): Promise<void> {
  const config = requireConfig(deps, target, configId);
  // Queued behind a deployment that may have failed in a way that leaves the runtime in doubt.
  assertRuntimeCertain(deps, target);
  const provider = findRunnableProvider(deps, config);
  if (provider.id !== providerId) {
    ctx.log(`The destination changed to ${provider.name} since this was queued`);
  }
  const base = {
    target,
    provider,
    directory: config.path,
    origin: request.origin,
    configId: config.id,
    name: request.name,
  };
  const backup =
    config.kind === "database"
      ? await takeDatabaseBackup(
          deps,
          { ...base, scope: config.scope as DatabaseBackupScope, databaseName: config.databaseName },
          ctx,
        )
      : await takeVolumeBackup(deps, { ...base, volumeName: config.volumeName as string }, ctx);

  if (request.origin === "schedule" && config.retention !== null) {
    await applyRetention(deps, config, backup, ctx).catch((error: unknown) => {
      // A cleanup problem is the destination's, and reported on its own: the backup still happened.
      const message = error instanceof Error ? error.message : String(error);
      updateBackup(deps.db, backup.id, { cleanupError: message });
      ctx.log(`The backup succeeded, but cleaning up old copies failed: ${message}`);
    });
  }
  ctx.log("Success");
}

function assertConfirmation(confirm: string, expected: string): void {
  if (confirm !== expected) {
    throw conflict("confirmation_mismatch", "Type the exact name to confirm.", {
      confirm: "This does not match",
    });
  }
}

const recordedSource = (backup: BackupRow, provider: ProviderRow): RestoreSource => ({
  backupId: backup.id,
  provider,
  remotePath: backup.path,
  mayTakeFrom: null,
  recorded: {
    kind: backup.kind,
    format: backup.format as BackupFormat,
    scope: backup.scope,
    engine: backup.engine as DatabaseEngine | null,
    engineVersion: backup.engineVersion,
    databaseName: backup.databaseName,
    volumeName: backup.volumeName,
    sha256: backup.sha256 as string,
    sizeBytes: backup.sizeBytes as number,
    uncompressedBytes: null,
  },
});

/** A task that Docker reports as running, and that it means to keep running. */
export async function hasRunningTask(deps: Pick<AppDeps, "docker">, target: ServiceTarget): Promise<boolean> {
  const tasks = await deps.docker.listTasks({
    service: qualifiedName(target.projectName, target.serviceName),
  });
  return tasks.some((task) => task.state === "running" && task.desiredState === "running");
}

/**
 * Everything that must hold before a restore is even queued. The run checks all of it again. The
 * safety backup of an unresolved restore may always be restored: it is the way out of that state.
 */
async function assertRestoreAllowed(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  backupId: string | null = null,
): Promise<RestoreRow | null> {
  const unresolved = findUnresolvedRestore(deps.db, target.projectName, target.serviceName) ?? null;
  if (unresolved !== null && unresolved.safetyBackupId !== backupId) {
    throw conflict(
      "restore_unresolved",
      "A restore on this service did not finish cleanly. Sort it out first: nothing else may touch its data until then.",
    );
  }
  assertIdle(deps, target);
  assertRuntimeCertain(deps, target);
  await inspectOwnedService(deps, target);
  if (record.spec.database?.rotation != null) {
    throw conflict("rotation_unresolved", "A password change on this database has not been settled yet.");
  }
  const what = record.spec.database === null ? "service" : "database";
  if (record.spec.stopped) {
    throw conflict("service_stopped", `Start this ${what} before restoring into it.`);
  }
  if (!(await hasRunningTask(deps, target))) {
    throw conflict("service_not_running", `Deploy and start this ${what} before restoring into it.`);
  }
  return unresolved;
}

function enqueueInstanceRestore(
  deps: AppDeps,
  target: ServiceTarget,
  source: RestoreSource,
  actorEmail: string | undefined,
  resolves: RestoreRow | null = null,
): ActionRow {
  return deps.actions.enqueue({
    type: backupActionTypes.restoreDatabase,
    title: `Restore the whole server of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: async (ctx) => {
      await performInstanceRestore(deps, { target, source, actorEmail }, ctx);
      if (resolves !== null) {
        updateRestore(deps.db, resolves.id, { unresolved: false });
        ctx.log("The earlier unfinished restore is settled: the data now matches its safety backup.");
      }
    },
  });
}

function enqueueDatabaseRestore(
  deps: AppDeps,
  request: DatabaseRestoreRequest,
  resolves: RestoreRow | null = null,
): ActionRow {
  const { target, scope, databaseName, actorEmail } = request;
  return deps.actions.enqueue({
    type: backupActionTypes.restoreDatabase,
    title: `Restore ${scope === "database" ? databaseName : "the users and roles"} of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: async (ctx) => {
      await performDatabaseRestore(deps, request, ctx);
      if (resolves !== null) {
        updateRestore(deps.db, resolves.id, { unresolved: false });
        ctx.log("The earlier unfinished restore is settled: the data now matches its safety backup.");
      }
    },
  });
}

function enqueueVolumeRestore(
  deps: AppDeps,
  target: ServiceTarget,
  volumeName: string,
  source: RestoreSource,
  actorEmail: string | undefined,
): ActionRow {
  return deps.actions.enqueue({
    type: backupActionTypes.restoreVolume,
    title: `Restore volume ${volumeName} of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: (ctx) => performVolumeRestore(deps, { target, volumeName, source, actorEmail }, ctx),
  });
}

/** Restores a backup from this panel's records, which already say what it is and how big. */
export async function restoreFromBackup(
  deps: AppDeps,
  target: ServiceTarget,
  backupId: string,
  request: { confirm: string; databaseName?: string },
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const backup = requireBackup(deps, target, backupId);
  if (backup.status !== "succeeded" || backup.deletedAt !== null) {
    throw conflict(
      "backup_not_restorable",
      "Only a backup that finished and is still stored can be restored.",
    );
  }
  const provider = requireProviderOf(deps, backup);
  const record = requireService(deps, target);
  const resolves = await assertRestoreAllowed(deps, target, record, backup.id);

  if (backup.kind === "volume") {
    const volumeName = backup.volumeName as string;
    assertConfirmation(request.confirm, volumeName);
    if (!backupVolumes(deps, target, record).includes(volumeName)) {
      throw conflict("volume_missing", "This service no longer has this volume.");
    }
    return enqueueVolumeRestore(deps, target, volumeName, recordedSource(backup, provider), actorEmail);
  }

  if (record.spec.database === null) {
    throw conflict("not_a_database", "This service is not a database.");
  }
  const scope = backup.scope as DatabaseBackupScope;
  const source = recordedSource(backup, provider);
  if (scope !== "database") {
    assertConfirmation(request.confirm, target.serviceName);
    return scope === "instance"
      ? enqueueInstanceRestore(deps, target, source, actorEmail, resolves)
      : enqueueDatabaseRestore(deps, { target, scope, databaseName: null, source, actorEmail }, resolves);
  }
  const databaseName = request.databaseName ?? (backup.databaseName as string);
  assertConfirmation(request.confirm, databaseName);
  return enqueueDatabaseRestore(deps, { target, scope, databaseName, source, actorEmail }, resolves);
}

function requireProviderOf(deps: Pick<AppDeps, "db">, backup: BackupRow): ProviderRow {
  const provider =
    backup.storageProviderId === null ? undefined : findProviderRow(deps.db, backup.storageProviderId);
  if (provider === undefined) {
    throw conflict("provider_missing", "The destination this backup was sent to has been removed.");
  }
  if (!provider.connected) {
    throw conflict("provider_not_connected", "The destination this backup was sent to is not connected.");
  }
  return provider;
}

/**
 * Restores a file named by hand, known only through the manifest stored next to it. The target's
 * rights were checked on the route. Those on the source wait for the run, because only then is
 * the file known: the caller needs to be an operator of the project the file belongs to.
 */
export async function restoreFromPath(
  deps: AppDeps,
  target: ServiceTarget,
  request: RestoreFromPathFields,
  access: Access,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const provider = findProviderRow(deps.db, request.storageProviderId);
  if (provider === undefined || !provider.connected) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      storageProviderId: "Pick a connected destination",
    });
  }
  const record = requireService(deps, target);
  await assertRestoreAllowed(deps, target, record);
  const source: RestoreSource = {
    backupId: null,
    provider,
    remotePath: request.path,
    recorded: null,
    mayTakeFrom: access.projects === null ? null : (project) => hasProjectLevel(access, project, "operator"),
  };

  if (record.spec.database !== null) {
    const scope = request.scope ?? "database";
    if (scope !== "database") {
      assertConfirmation(request.confirm, target.serviceName);
      return scope === "instance"
        ? enqueueInstanceRestore(deps, target, source, actorEmail)
        : enqueueDatabaseRestore(deps, { target, scope, databaseName: null, source, actorEmail });
    }
    if (request.databaseName === undefined) {
      throw badRequest("validation_failed", "Some fields need attention.", { databaseName: "Required" });
    }
    assertConfirmation(request.confirm, request.databaseName);
    return enqueueDatabaseRestore(deps, {
      target,
      scope,
      databaseName: request.databaseName,
      source,
      actorEmail,
    });
  }

  const volume = request.databaseName;
  if (volume === undefined || !backupVolumes(deps, target, record).includes(volume)) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      databaseName: "Name one of this service's volumes",
    });
  }
  assertConfirmation(request.confirm, volume);
  return enqueueVolumeRestore(deps, target, volume, source, actorEmail);
}

/** Queues the removal of one stored backup. The record stays, marked as removed. */
export function enqueueDeleteBackup(
  deps: AppDeps,
  target: ServiceTarget,
  backupId: string,
  actorEmail: string | undefined,
): ActionRow {
  const backup = requireBackup(deps, target, backupId);
  if (backup.status === "running") {
    throw conflict("backup_running", "This backup has not finished.");
  }
  if (backup.deletedAt !== null) {
    throw conflict("backup_deleted", "This backup has already been removed.");
  }
  if (isBackupBeingRestored(deps.db, backup.id)) {
    throw conflict("backup_in_use", "This backup is being restored right now.");
  }
  return deps.actions.enqueue({
    type: backupActionTypes.remove,
    title: `Delete a backup of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: async (ctx) => {
      await removeStoredFile(deps, backup);
      updateBackup(deps.db, backup.id, { deletedAt: new Date(deps.now()) });
      ctx.log(`Deleted ${backup.path}`);
    },
  });
}

export interface BackupDownload {
  /** The verified file, in the panel's own working folder. */
  file: string;
  /** What a browser should call it: unique to this backup, whatever its label says. */
  fileName: string;
  sizeBytes: number;
  sha256: string;
  /** Removes the working folder. To be called once the file has been sent, or failed to be. */
  discard(): Promise<void>;
}

/** Everything is on one line in a header, so only what cannot be misread goes into the name. */
function downloadNameOf(backup: BackupRow): string {
  const stored = basename(backup.path);
  // The file is named after its date, which itself has a dot in it: the extension starts after the Z.
  const extension = stored.slice(stored.indexOf("Z.") + 1);
  const moment = backup.createdAt.toISOString().replaceAll(":", "-");
  const name = `${backup.projectName}-${backup.serviceName}-${moment}-${backup.id}${extension}`;
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Fetches one recorded backup into the panel's own space and proves it is the file that was stored,
 * so that what leaves the panel is exactly what its record says. Only a backup of this service can
 * be asked for, by its identifier: a path is never accepted here.
 */
export async function prepareBackupDownload(
  deps: AppDeps,
  target: ServiceTarget,
  backupId: string,
  actorEmail: string | undefined,
  signal?: AbortSignal,
): Promise<BackupDownload> {
  const backup = requireBackup(deps, target, backupId);
  if (backup.status !== "succeeded" || backup.deletedAt !== null) {
    throw conflict(
      "backup_not_downloadable",
      "Only a backup that finished and is still stored can be downloaded.",
    );
  }
  const provider = requireProviderOf(deps, backup);
  const backend = backendForProvider(deps, provider);
  const expected = { sizeBytes: backup.sizeBytes as number, sha256: backup.sha256 as string };

  const unreachable = (error: unknown): AppError =>
    conflict(
      "backup_unreachable",
      `Could not read the backup: ${safeStorageMessage(deps, provider, toStorageError(error))}`,
    );

  const present = await backend.stat(backup.path, signal).catch((error: unknown) => {
    throw unreachable(error);
  });
  if (present === null) {
    throw notFound("This backup's file no longer exists at its destination.");
  }
  if (present.size !== expected.sizeBytes) {
    throw conflict(
      "backup_corrupt",
      `The file at the destination is ${present.size} bytes, but ${expected.sizeBytes} were stored.`,
    );
  }

  const free = await freeBytes(deps.config.dataDir);
  assertDisk(expected.sizeBytes, free);

  const directory = await makeWorkDir(deps);
  const discard = () => rm(directory, { recursive: true, force: true });
  try {
    const file = join(directory, "backup");
    await backend.download(backup.path, file, { signal }).catch((error: unknown) => {
      throw unreachable(error);
    });
    const digest = await sha256Of(file, signal);
    if (digest !== expected.sha256) {
      throw conflict(
        "backup_corrupt",
        "The file at the destination no longer matches what was stored, so it was not sent.",
      );
    }
    deps.actions.record({
      type: backupActionTypes.download,
      title: `Download a backup of ${target.projectName}/${target.serviceName}: ${basename(backup.path)}`,
      ...target,
      actorEmail,
    });
    return { file, fileName: downloadNameOf(backup), ...expected, discard };
  } catch (error) {
    await discard().catch(() => {});
    throw error;
  }
}

/** Asks the running server which databases it holds, for the form's picker. */
export async function listDatabaseNames(deps: AppDeps, target: ServiceTarget): Promise<DatabaseNameList> {
  const record = requireService(deps, target);
  if (record.spec.database === null || !engineHasBackups(record.spec.database.engine)) {
    throw conflict("backups_not_available", "This service has no databases to list.");
  }
  const { engine } = record.spec.database;
  const ops = backupOpsFor(engine);
  if (ops === null) {
    throw conflict("backups_not_available", "This engine has no backups.");
  }
  const credentials = credentialsOf(deps, record as Parameters<typeof credentialsOf>[1]);
  const lines = await queryEngine(
    deps,
    qualifiedName(target.projectName, target.serviceName),
    ops.listDatabases(credentials),
    "Could not list the databases on this server",
    secretsOf(credentials),
  );
  return { databases: systemDatabaseFilter(engine, lines) };
}

/** Clears a blocked service once a person has looked at what the interrupted restore left behind. */
export function resolveRestore(
  deps: AppDeps,
  target: ServiceTarget,
  restoreId: string,
  confirm: string,
  actorEmail: string | undefined,
): RestoreRow {
  const restore = requireRestore(deps, target, restoreId);
  if (!restore.unresolved) {
    throw conflict("restore_settled", "This restore is already settled.");
  }
  assertConfirmation(confirm, restore.databaseName ?? restore.volumeName ?? target.serviceName);
  const updated = updateRestore(deps.db, restore.id, { unresolved: false }) as RestoreRow;
  deps.actions.record({
    type: backupActionTypes.config,
    title: `Mark an interrupted restore of ${target.projectName}/${target.serviceName} as checked`,
    ...target,
    actorEmail,
  });
  return updated;
}

/** Deletes the folder holding what a volume contained before a restore, once nobody needs it. */
export async function discardEarlierCopy(
  deps: AppDeps,
  target: ServiceTarget,
  restoreId: string,
  confirm: string,
  actorEmail: string | undefined,
): Promise<RestoreRow> {
  const restore = requireRestore(deps, target, restoreId);
  if (restore.kind !== "volume" || restore.earlierCopy === null || restore.volumeName === null) {
    throw conflict("no_earlier_copy", "This restore has no earlier copy to remove.");
  }
  assertConfirmation(confirm, restore.volumeName);
  const folder = join(dirname(volumeDirectory(deps, target, restore.volumeName)), restore.earlierCopy);
  await rm(folder, { recursive: true, force: true });
  const updated = updateRestore(deps.db, restore.id, { earlierCopy: null }) as RestoreRow;
  deps.actions.record({
    type: backupActionTypes.remove,
    title: `Remove the earlier copy of volume ${restore.volumeName} of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return updated;
}
