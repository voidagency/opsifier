import { and, asc, eq } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { gitKnownHosts } from "../../core/db/schema";

export type KnownHostRow = typeof gitKnownHosts.$inferSelect;

export const listHostRows = (db: Db): KnownHostRow[] =>
  db.select().from(gitKnownHosts).orderBy(asc(gitKnownHosts.host), asc(gitKnownHosts.port)).all();

export const findHostRows = (db: DbHandle, host: string, port: number): KnownHostRow[] =>
  db
    .select()
    .from(gitKnownHosts)
    .where(and(eq(gitKnownHosts.host, host), eq(gitKnownHosts.port, port)))
    .all();

/** False when that key of that host is already on the list. */
export function insertHostRow(db: DbHandle, row: KnownHostRow): boolean {
  return db.insert(gitKnownHosts).values(row).onConflictDoNothing().run().changes === 1;
}

export function findHostRow(db: DbHandle, id: string): KnownHostRow | undefined {
  return db.select().from(gitKnownHosts).where(eq(gitKnownHosts.id, id)).get();
}

export function deleteHostRow(db: DbHandle, id: string): void {
  db.delete(gitKnownHosts).where(eq(gitKnownHosts.id, id)).run();
}
