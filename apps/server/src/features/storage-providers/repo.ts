import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { backupConfigs, storageProviders } from "../../core/db/schema";

export type ProviderRow = typeof storageProviders.$inferSelect;
export type NewProviderRow = typeof storageProviders.$inferInsert;

export function listProviderRows(db: DbHandle): ProviderRow[] {
  return db
    .select()
    .from(storageProviders)
    .orderBy(sql`${storageProviders.builtIn} DESC`, storageProviders.name)
    .all();
}

export function findProviderRow(db: DbHandle, id: string): ProviderRow | undefined {
  return db.select().from(storageProviders).where(eq(storageProviders.id, id)).get();
}

export function findProviderRowByName(db: DbHandle, name: string): ProviderRow | undefined {
  return db.select().from(storageProviders).where(eq(storageProviders.name, name)).get();
}

export function insertProviderRow(db: DbHandle, row: NewProviderRow): ProviderRow {
  return db.insert(storageProviders).values(row).returning().get();
}

export function updateProviderRow(
  db: DbHandle,
  id: string,
  change: Partial<Omit<NewProviderRow, "id">>,
): ProviderRow | undefined {
  return db.update(storageProviders).set(change).where(eq(storageProviders.id, id)).returning().get();
}

export function deleteProviderRow(db: DbHandle, id: string): void {
  db.delete(storageProviders).where(eq(storageProviders.id, id)).run();
}

/** How many configurations send their files to each provider. */
export function providerUsageCounts(db: DbHandle): Map<string, number> {
  const rows = db
    .select({ id: backupConfigs.storageProviderId, count: sql<number>`count(*)` })
    .from(backupConfigs)
    .where(isNotNull(backupConfigs.storageProviderId))
    .groupBy(backupConfigs.storageProviderId)
    .all();
  return new Map(rows.flatMap((row) => (row.id === null ? [] : [[row.id, row.count] as const])));
}

/** A deleted provider leaves its configurations with nowhere to go, so they stop running. */
export function detachConfigsFromProvider(db: Db, ids: readonly string[], now: Date): void {
  if (ids.length === 0) {
    return;
  }
  db.update(backupConfigs)
    .set({ enabled: false, nextRunAt: null, updatedAt: now })
    .where(inArray(backupConfigs.storageProviderId, [...ids]))
    .run();
}
