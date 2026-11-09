import { and, eq, lt, or } from "drizzle-orm";
import type { DbHandle } from "../../../core/db";
import { webhookDeliveries } from "../../../core/db/schema";

/** How long a consumed delivery is remembered. Replaying one needs a capture of the original. */
const RETAINED_MS = 365 * 24 * 60 * 60 * 1000;

export interface DeliveryKey {
  hookId: string;
  deliveryId: string | null;
  bodyHash: string;
}

const matches = ({ hookId, deliveryId, bodyHash }: DeliveryKey) =>
  and(
    eq(webhookDeliveries.hookId, hookId),
    deliveryId === null
      ? eq(webhookDeliveries.bodyHash, bodyHash)
      : or(eq(webhookDeliveries.deliveryId, deliveryId), eq(webhookDeliveries.bodyHash, bodyHash)),
  );

export function findDelivery(db: DbHandle, key: DeliveryKey): { actionId: string | null } | undefined {
  return db
    .select({ actionId: webhookDeliveries.actionId })
    .from(webhookDeliveries)
    .where(matches(key))
    .get();
}

/**
 * Takes the delivery before anything is done with it. Of two copies arriving together, one wins.
 * False means someone already holds it.
 */
export function reserveDelivery(db: DbHandle, key: DeliveryKey, now: number): boolean {
  db.delete(webhookDeliveries)
    .where(lt(webhookDeliveries.createdAt, new Date(now - RETAINED_MS)))
    .run();
  const inserted = db
    .insert(webhookDeliveries)
    .values({ ...key, actionId: null, createdAt: new Date(now) })
    .onConflictDoNothing()
    .run();
  return inserted.changes === 1;
}

export function confirmDelivery(db: DbHandle, key: DeliveryKey, actionId: string): void {
  db.update(webhookDeliveries).set({ actionId }).where(matches(key)).run();
}

/** A delivery that started nothing was not consumed: a later copy of it can still deploy. */
export function releaseDelivery(db: DbHandle, key: DeliveryKey): void {
  db.delete(webhookDeliveries).where(matches(key)).run();
}
