import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { retainedVolumes } from "../../core/db/schema";

export type RetainedVolumeRow = typeof retainedVolumes.$inferSelect;

/** A service with the same name can have kept this volume before, so the newer record wins. */
export function saveRetainedVolume(db: DbHandle, row: RetainedVolumeRow): void {
  db.insert(retainedVolumes)
    .values(row)
    .onConflictDoUpdate({
      target: retainedVolumes.name,
      set: {
        projectName: row.projectName,
        serviceName: row.serviceName,
        kind: row.kind,
        retainedAt: row.retainedAt,
      },
    })
    .run();
}

export function listRetainedVolumes(db: DbHandle): RetainedVolumeRow[] {
  return db.select().from(retainedVolumes).orderBy(asc(retainedVolumes.name)).all();
}

export function findRetainedVolume(db: DbHandle, name: string): RetainedVolumeRow | undefined {
  return db.select().from(retainedVolumes).where(eq(retainedVolumes.name, name)).get();
}

export function deleteRetainedVolume(db: DbHandle, name: string): void {
  db.delete(retainedVolumes).where(eq(retainedVolumes.name, name)).run();
}
