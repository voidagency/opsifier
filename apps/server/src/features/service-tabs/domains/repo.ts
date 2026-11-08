import { and, asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../../../core/db";
import { domains } from "../../../core/db/schema";

export type DomainRow = typeof domains.$inferSelect;

/** Oldest first, insertion order breaking ties: a domain's position gives its router numbers. */
export function listServiceDomains(db: DbHandle, project: string, service: string): DomainRow[] {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.projectName, project), eq(domains.serviceName, service)))
    .orderBy(asc(domains.createdAt), sql`rowid`)
    .all();
}

/** Whether a plain (not wildcard) address is free, for the default name of a new service. */
export function isHostAvailable(db: DbHandle, host: string, path: string): boolean {
  return findDomainByRoute(db, host, path, false) === undefined;
}

/** The domain already answering on an address, whichever service it belongs to. */
export function findDomainByRoute(
  db: DbHandle,
  host: string,
  path: string,
  wildcard: boolean,
): DomainRow | undefined {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.host, host), eq(domains.path, path), eq(domains.wildcard, wildcard)))
    .get();
}

export function findDomain(db: DbHandle, id: string): DomainRow | undefined {
  return db.select().from(domains).where(eq(domains.id, id)).get();
}

export function insertDomain(db: DbHandle, row: typeof domains.$inferInsert): void {
  db.insert(domains).values(row).run();
}

export function updateDomain(db: DbHandle, id: string, changes: Partial<typeof domains.$inferInsert>): void {
  db.update(domains).set(changes).where(eq(domains.id, id)).run();
}

export function deleteDomain(db: DbHandle, id: string): void {
  db.delete(domains).where(eq(domains.id, id)).run();
}

/** Clears the old primary first, so the "one primary per service" index never sees two. */
export function setPrimaryDomain(db: DbHandle, row: DomainRow, now: Date): void {
  db.update(domains)
    .set({ isPrimary: false, updatedAt: now })
    .where(
      and(
        eq(domains.projectName, row.projectName),
        eq(domains.serviceName, row.serviceName),
        eq(domains.isPrimary, true),
      ),
    )
    .run();
  db.update(domains).set({ isPrimary: true, updatedAt: now }).where(eq(domains.id, row.id)).run();
}
