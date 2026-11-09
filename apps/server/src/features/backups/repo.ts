import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { backupConfigs, backupRestores, backups, storageProviders } from "../../core/db/schema";

export type BackupConfigRow = typeof backupConfigs.$inferSelect;
export type NewBackupConfigRow = typeof backupConfigs.$inferInsert;
export type BackupRow = typeof backups.$inferSelect;
export type NewBackupRow = typeof backups.$inferInsert;
export type RestoreRow = typeof backupRestores.$inferSelect;
export type NewRestoreRow = typeof backupRestores.$inferInsert;

/** The newest records a page lists. Plenty for a service, and it keeps responses small. */
const LISTED_RECORDS = 100;

export function listConfigs(db: DbHandle, project: string, service: string): BackupConfigRow[] {
  return db
    .select()
    .from(backupConfigs)
    .where(and(eq(backupConfigs.projectName, project), eq(backupConfigs.serviceName, service)))
    .orderBy(backupConfigs.createdAt)
    .all();
}

export function findConfig(db: DbHandle, id: string): BackupConfigRow | undefined {
  return db.select().from(backupConfigs).where(eq(backupConfigs.id, id)).get();
}

export function insertConfig(db: DbHandle, row: NewBackupConfigRow): BackupConfigRow {
  return db.insert(backupConfigs).values(row).returning().get();
}

export function updateConfig(
  db: DbHandle,
  id: string,
  change: Partial<Omit<NewBackupConfigRow, "id">>,
): BackupConfigRow | undefined {
  return db.update(backupConfigs).set(change).where(eq(backupConfigs.id, id)).returning().get();
}

export function deleteConfig(db: DbHandle, id: string): void {
  db.delete(backupConfigs).where(eq(backupConfigs.id, id)).run();
}

/** Every enabled configuration whose next run has come. */
export function listDueConfigs(db: DbHandle, now: Date): BackupConfigRow[] {
  return db
    .select()
    .from(backupConfigs)
    .where(
      and(
        eq(backupConfigs.enabled, true),
        isNotNull(backupConfigs.nextRunAt),
        lte(backupConfigs.nextRunAt, now),
      ),
    )
    .all();
}

export function listEnabledConfigs(db: DbHandle): BackupConfigRow[] {
  return db.select().from(backupConfigs).where(eq(backupConfigs.enabled, true)).all();
}

export function insertBackup(db: DbHandle, row: NewBackupRow): BackupRow {
  return db.insert(backups).values(row).returning().get();
}

export function updateBackup(
  db: DbHandle,
  id: string,
  change: Partial<Omit<NewBackupRow, "id" | "seq">>,
): BackupRow | undefined {
  return db.update(backups).set(change).where(eq(backups.id, id)).returning().get();
}

export function findBackup(db: DbHandle, id: string): BackupRow | undefined {
  return db.select().from(backups).where(eq(backups.id, id)).get();
}

/** The panel's own record of a stored file, which says whose it is whatever the file claims. */
export function findBackupOfFile(
  db: DbHandle,
  storageProviderId: string,
  path: string,
): BackupRow | undefined {
  return db
    .select()
    .from(backups)
    .where(and(eq(backups.storageProviderId, storageProviderId), eq(backups.path, path)))
    .orderBy(desc(backups.seq))
    .limit(1)
    .get();
}

/** Newest first, limited to what one page shows. Removed backups stay listed as history. */
export function listBackups(db: DbHandle, project: string, service: string, since: Date): BackupRow[] {
  return (
    db
      .select()
      .from(backups)
      // A row older than the service belongs to an earlier service that had the same name.
      .where(
        and(
          eq(backups.projectName, project),
          eq(backups.serviceName, service),
          gte(backups.createdAt, since),
        ),
      )
      .orderBy(desc(backups.seq))
      .limit(LISTED_RECORDS)
      .all()
  );
}

/** The rows a run must not be interrupted by: nothing else may delete or read them halfway. */
export function listRunningBackups(db: DbHandle): BackupRow[] {
  return db.select().from(backups).where(eq(backups.status, "running")).all();
}

export function latestBackupOfConfig(db: DbHandle, configId: string): BackupRow | undefined {
  return db
    .select()
    .from(backups)
    .where(and(eq(backups.configId, configId), isNull(backups.deletedAt)))
    .orderBy(desc(backups.seq))
    .limit(1)
    .get();
}

/** Successful, still-stored scheduled backups of one configuration, newest first. */
export function listRetentionCandidates(db: DbHandle, configId: string): BackupRow[] {
  return db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.configId, configId),
        eq(backups.status, "succeeded"),
        eq(backups.origin, "schedule"),
        isNull(backups.deletedAt),
      ),
    )
    .orderBy(desc(backups.seq))
    .all();
}

export function insertRestore(db: DbHandle, row: NewRestoreRow): RestoreRow {
  return db.insert(backupRestores).values(row).returning().get();
}

export function updateRestore(
  db: DbHandle,
  id: string,
  change: Partial<Omit<NewRestoreRow, "id" | "seq">>,
): RestoreRow | undefined {
  return db.update(backupRestores).set(change).where(eq(backupRestores.id, id)).returning().get();
}

export function findRestore(db: DbHandle, id: string): RestoreRow | undefined {
  return db.select().from(backupRestores).where(eq(backupRestores.id, id)).get();
}

export function listRestores(db: DbHandle, project: string, service: string, since: Date): RestoreRow[] {
  return db
    .select()
    .from(backupRestores)
    .where(
      and(
        eq(backupRestores.projectName, project),
        eq(backupRestores.serviceName, service),
        gte(backupRestores.createdAt, since),
      ),
    )
    .orderBy(desc(backupRestores.seq))
    .limit(LISTED_RECORDS)
    .all();
}

export function listRunningRestores(db: DbHandle): RestoreRow[] {
  return db.select().from(backupRestores).where(eq(backupRestores.status, "running")).all();
}

/** A restore that ended in a state only a person can sort out. Nothing may touch the data until then. */
export function findUnresolvedRestore(
  db: DbHandle,
  project: string,
  service: string,
): RestoreRow | undefined {
  return db
    .select()
    .from(backupRestores)
    .where(
      and(
        eq(backupRestores.projectName, project),
        eq(backupRestores.serviceName, service),
        eq(backupRestores.unresolved, true),
      ),
    )
    .orderBy(desc(backupRestores.seq))
    .limit(1)
    .get();
}

/** Whether a restore of this backup file is in progress right now. */
export function isBackupBeingRestored(db: DbHandle, backupId: string): boolean {
  return (
    db
      .select({ id: backupRestores.id })
      .from(backupRestores)
      .where(and(eq(backupRestores.backupId, backupId), eq(backupRestores.status, "running")))
      .get() !== undefined
  );
}

/** Applies a rename to every record of a service, so its history and schedules follow it. */
export function moveBackupRecords(
  db: DbHandle,
  from: { project: string; name: string },
  to: { project: string; name: string },
): void {
  db.update(backupConfigs)
    .set({ projectName: to.project, serviceName: to.name })
    .where(and(eq(backupConfigs.projectName, from.project), eq(backupConfigs.serviceName, from.name)))
    .run();
  db.update(backups)
    .set({ projectName: to.project, serviceName: to.name })
    .where(and(eq(backups.projectName, from.project), eq(backups.serviceName, from.name)))
    .run();
  db.update(backupRestores)
    .set({ projectName: to.project, serviceName: to.name })
    .where(and(eq(backupRestores.projectName, from.project), eq(backupRestores.serviceName, from.name)))
    .run();
}

export function providerNameOf(db: DbHandle, id: string | null): string | null {
  if (id === null) {
    return null;
  }
  return (
    db.select({ name: storageProviders.name }).from(storageProviders).where(eq(storageProviders.id, id)).get()
      ?.name ?? null
  );
}

export function providerNames(
  db: DbHandle,
  ids: readonly string[],
): Map<string, { name: string; connected: boolean }> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = db
    .select({ id: storageProviders.id, name: storageProviders.name, connected: storageProviders.connected })
    .from(storageProviders)
    .where(inArray(storageProviders.id, [...new Set(ids)]))
    .all();
  return new Map(rows.map((row) => [row.id, { name: row.name, connected: row.connected }]));
}
