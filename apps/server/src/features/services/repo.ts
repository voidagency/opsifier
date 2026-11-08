import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { actions, domains, services } from "../../core/db/schema";
import { type AppServiceSpec, appServiceSpec } from "./spec";

export type ServiceRow = typeof services.$inferSelect;

export interface ServiceRecord extends Omit<ServiceRow, "spec"> {
  spec: AppServiceSpec;
}

const toRecord = (row: ServiceRow): ServiceRecord => ({ ...row, spec: appServiceSpec.parse(row.spec) });

export function findService(db: DbHandle, project: string, name: string): ServiceRecord | undefined {
  const row = db
    .select()
    .from(services)
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .get();
  return row === undefined ? undefined : toRecord(row);
}

/** All services, or those of one project, in name order. */
export function listServiceRecords(db: DbHandle, project?: string): ServiceRecord[] {
  return db
    .select()
    .from(services)
    .where(project === undefined ? undefined : eq(services.projectName, project))
    .orderBy(asc(services.projectName), asc(services.name))
    .all()
    .map(toRecord);
}

export function insertService(
  db: DbHandle,
  project: string,
  name: string,
  type: string,
  spec: AppServiceSpec,
  now: Date,
): void {
  db.insert(services)
    .values({ projectName: project, name, type, spec, createdAt: now, updatedAt: now })
    .run();
}

/** Replaces the spec. Saving a setting never changes what is running: only a deploy does. */
export function saveServiceSpec(
  db: DbHandle,
  project: string,
  name: string,
  spec: AppServiceSpec,
  now: Date,
): void {
  db.update(services)
    .set({ spec, updatedAt: now })
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .run();
}

export function deleteServiceRow(db: DbHandle, project: string, name: string): void {
  db.delete(services)
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .run();
}

export interface ServiceKey {
  project: string;
  name: string;
}

/** A primary key cannot simply change while domains point at it, so the row moves in three steps. */
export function moveServiceRow(db: Db, from: ServiceKey, to: ServiceKey, now: Date): void {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(services)
      .where(and(eq(services.projectName, from.project), eq(services.name, from.name)))
      .get();
    if (row === undefined) {
      return;
    }
    tx.insert(services)
      .values({ ...row, projectName: to.project, name: to.name, updatedAt: now })
      .run();
    tx.update(domains)
      .set({ projectName: to.project, serviceName: to.name })
      .where(and(eq(domains.projectName, from.project), eq(domains.serviceName, from.name)))
      .run();
    tx.delete(services)
      .where(and(eq(services.projectName, from.project), eq(services.name, from.name)))
      .run();
    // History follows the service. Timestamps are left alone, so durations stay truthful.
    tx.update(actions)
      .set({ projectName: to.project, serviceName: to.name })
      .where(and(eq(actions.projectName, from.project), eq(actions.serviceName, from.name)))
      .run();
  });
}

const ACTIVE_STATUSES = ["queued", "running"] as const;

export type ActiveActionRow = Pick<
  typeof actions.$inferSelect,
  "id" | "type" | "projectName" | "serviceName"
>;

/** Every queued or running action that belongs to a service, oldest first. */
export function listActiveServiceActions(db: DbHandle): ActiveActionRow[] {
  return db
    .select({
      id: actions.id,
      type: actions.type,
      projectName: actions.projectName,
      serviceName: actions.serviceName,
    })
    .from(actions)
    .where(and(inArray(actions.status, ACTIVE_STATUSES), isNotNull(actions.serviceName)))
    .orderBy(asc(actions.seq))
    .all();
}

export interface DeploymentRow {
  status: string;
  createdAt: Date;
}

/**
 * The most recent deployments of one service, newest first. A row older than the service belongs
 * to a destroyed service that had the same name.
 */
export function listRecentDeployments(
  db: DbHandle,
  type: string,
  service: Pick<ServiceRecord, "projectName" | "name" | "createdAt">,
  limit: number,
): DeploymentRow[] {
  return db
    .select({ status: actions.status, createdAt: actions.createdAt })
    .from(actions)
    .where(
      and(
        eq(actions.type, type),
        eq(actions.projectName, service.projectName),
        eq(actions.serviceName, service.name),
        gte(actions.createdAt, service.createdAt),
      ),
    )
    .orderBy(desc(actions.seq))
    .limit(limit)
    .all();
}
