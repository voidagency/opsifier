import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { serviceReleases } from "../../core/db/schema";

export type ReleaseRow = typeof serviceReleases.$inferSelect;

/** Newest first. */
export function listReleaseRows(db: DbHandle, serviceId: string): ReleaseRow[] {
  return db
    .select()
    .from(serviceReleases)
    .where(eq(serviceReleases.serviceId, serviceId))
    .orderBy(desc(serviceReleases.number))
    .all();
}

export function findReleaseRow(db: DbHandle, serviceId: string, number: number): ReleaseRow | undefined {
  return db
    .select()
    .from(serviceReleases)
    .where(and(eq(serviceReleases.serviceId, serviceId), eq(serviceReleases.number, number)))
    .get();
}

export function nextReleaseNumber(db: DbHandle, serviceId: string): number {
  const last = db
    .select({ number: max(serviceReleases.number) })
    .from(serviceReleases)
    .where(eq(serviceReleases.serviceId, serviceId))
    .get()?.number;
  return (last ?? 0) + 1;
}

export function insertReleaseRow(db: DbHandle, row: ReleaseRow): void {
  db.insert(serviceReleases).values(row).run();
}

export function deleteReleaseRows(db: DbHandle, serviceId: string, numbers: readonly number[]): void {
  db.delete(serviceReleases)
    .where(and(eq(serviceReleases.serviceId, serviceId), inArray(serviceReleases.number, [...numbers])))
    .run();
}

/** Every kept version on this server, for what must know which images are spoken for. */
export function listAllReleaseKeys(db: DbHandle): Array<Pick<ReleaseRow, "serviceId" | "number">> {
  return db
    .select({ serviceId: serviceReleases.serviceId, number: serviceReleases.number })
    .from(serviceReleases)
    .all();
}
