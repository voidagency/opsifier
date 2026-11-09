import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { notificationChannels, notificationDeliveries } from "../../core/db/schema";

export type ChannelRow = typeof notificationChannels.$inferSelect;
export type DeliveryRow = typeof notificationDeliveries.$inferSelect;

const MAX_STORED_DELIVERIES = 500;

export function listChannels(db: DbHandle): ChannelRow[] {
  return db.select().from(notificationChannels).orderBy(asc(notificationChannels.createdAt)).all();
}

export function findChannel(db: DbHandle, id: string): ChannelRow | undefined {
  return db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
}

export function insertChannel(db: DbHandle, row: typeof notificationChannels.$inferInsert): void {
  db.insert(notificationChannels).values(row).run();
}

export function updateChannel(
  db: DbHandle,
  id: string,
  changes: Partial<typeof notificationChannels.$inferInsert>,
): void {
  db.update(notificationChannels).set(changes).where(eq(notificationChannels.id, id)).run();
}

export function deleteChannel(db: DbHandle, id: string): void {
  db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
}

export function insertDelivery(db: DbHandle, row: typeof notificationDeliveries.$inferInsert): boolean {
  const result = db.insert(notificationDeliveries).values(row).onConflictDoNothing().run();
  return Number(result.changes) > 0;
}

export function updateDelivery(
  db: DbHandle,
  id: string,
  changes: Partial<typeof notificationDeliveries.$inferInsert>,
): void {
  db.update(notificationDeliveries).set(changes).where(eq(notificationDeliveries.id, id)).run();
}

export function findDelivery(db: DbHandle, id: string): DeliveryRow | undefined {
  return db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)).get();
}

export function listDeliveries(db: DbHandle, limit = 100): DeliveryRow[] {
  return db
    .select()
    .from(notificationDeliveries)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit)
    .all();
}

export function lastDeliveryOf(db: DbHandle, channelId: string): DeliveryRow | undefined {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(1)
    .get();
}

/** The record is bounded: the newest deliveries are kept, older ones have done their job. */
export function pruneDeliveries(db: Db): void {
  const cutoff = db
    .select({ createdAt: notificationDeliveries.createdAt })
    .from(notificationDeliveries)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(1)
    .offset(MAX_STORED_DELIVERIES)
    .get();
  if (cutoff !== undefined) {
    db.run(sqlDeleteOlderThan(cutoff.createdAt));
  }
}

function sqlDeleteOlderThan(when: Date) {
  return sql`DELETE FROM notification_deliveries WHERE created_at < ${when.getTime()}`;
}
