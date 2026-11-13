import { and, asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../../../core/db";
import { customDomains, domains, services } from "../../../core/db/schema";

export type DomainRow = typeof domains.$inferSelect;

/** What a route answers on. A wildcard covers the direct subdomains of its host and nothing else. */
export interface RouteClaim {
  host: string;
  path: string;
  wildcard: boolean;
}

/** A claim and who holds it. A custom destination belongs to no project, so its project is null. */
export interface HeldRoute extends RouteClaim {
  id: string;
  project: string | null;
  service: string | null;
}

const isUnder = (path: string, parent: string): boolean =>
  parent === "/" || path === parent || path.startsWith(`${parent}/`);

function hostsOverlap(a: RouteClaim, b: RouteClaim): boolean {
  if (a.wildcard === b.wildcard) {
    return a.host === b.host;
  }
  const [wildcard, exact] = a.wildcard ? [a, b] : [b, a];
  return exact.host.slice(exact.host.indexOf(".") + 1) === wildcard.host;
}

/** Whether some request could match both routes. */
export const routesOverlap = (a: RouteClaim, b: RouteClaim): boolean =>
  hostsOverlap(a, b) && (isUnder(a.path, b.path) || isUnder(b.path, a.path));

export const sameRoute = (a: RouteClaim, b: RouteClaim): boolean =>
  a.host === b.host && a.path === b.path && a.wildcard === b.wildcard;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The addresses the panel gives a database's web tools. They live with the database rather than among
 * domains, and are routes all the same: a claim over one would take the tool's traffic, and its
 * login with it.
 */
function toolRoutes(db: DbHandle): HeldRoute[] {
  const rows = db
    .select({ project: services.projectName, service: services.name, spec: services.spec })
    .from(services)
    .where(sql`json_extract(${services.spec}, '$.database.companions') IS NOT NULL`)
    .all();
  return rows.flatMap(({ project, service, spec }) => {
    const database = isRecord(spec) && isRecord(spec.database) ? spec.database : {};
    const companions = isRecord(database.companions) ? database.companions : {};
    return Object.entries(companions).flatMap(([tool, stored]) =>
      isRecord(stored) && typeof stored.host === "string"
        ? [
            {
              id: `tool:${project}/${service}/${tool}`,
              host: stored.host,
              path: "/",
              wildcard: false,
              project,
              service,
            },
          ]
        : [],
    );
  });
}

function heldRoutes(db: DbHandle): HeldRoute[] {
  const claim = { host: domains.host, path: domains.path, wildcard: domains.wildcard };
  const held = db
    .select({ ...claim, id: domains.id, project: domains.projectName, service: domains.serviceName })
    .from(domains)
    .all();
  const custom = db
    .select({
      id: customDomains.id,
      host: customDomains.host,
      path: customDomains.path,
      wildcard: customDomains.wildcard,
    })
    .from(customDomains)
    .all()
    .map((row) => ({ ...row, project: null, service: null }));
  return [...held, ...custom, ...toolRoutes(db)];
}

/** Every route some request could share with this claim, whoever holds it. */
export function overlappingRoutes(db: DbHandle, claim: RouteClaim): HeldRoute[] {
  return heldRoutes(db).filter((route) => routesOverlap(route, claim));
}

/**
 * What stands in the way of a claim made for a project, or for a custom destination when `project` is
 * null. An identical route is always refused. One that only overlaps is refused when someone else
 * holds it, because that is how one project would take another's traffic: a longer path on its host,
 * or a wildcard over its exact host and the reverse. Inside one project the same people run both
 * services, and sharing a host between them by path is what a path is for.
 */
export function findRouteConflict(
  db: DbHandle,
  claim: RouteClaim,
  project: string | null,
  ownId?: string,
): HeldRoute | undefined {
  return overlappingRoutes(db, claim).find(
    (route) => route.id !== ownId && (sameRoute(route, claim) || route.project !== project),
  );
}

/** Oldest first, insertion order breaking ties: a domain's position gives its router numbers. */
export function listServiceDomains(db: DbHandle, project: string, service: string): DomainRow[] {
  return db
    .select()
    .from(domains)
    .where(and(eq(domains.projectName, project), eq(domains.serviceName, service)))
    .orderBy(asc(domains.createdAt), sql`rowid`)
    .all();
}

/** Whether a plain (not wildcard) address is free for a project, for a name the panel generates. */
export function isHostAvailable(db: DbHandle, project: string, host: string, path: string): boolean {
  return findRouteConflict(db, { host, path, wildcard: false }, project) === undefined;
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
