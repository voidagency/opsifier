import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import {
  actions,
  type DeployedImage,
  domains,
  type RuntimeUncertainty,
  services,
} from "../../core/db/schema";
import { moveBackupRecords } from "../backups/repo";
import { moveScriptRecords } from "../service-tabs/scripts/repo";
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

/** What it takes to work out who answers to which address, without reading any spec. */
export function listServiceIdentities(
  db: DbHandle,
): Array<Pick<ServiceRow, "projectName" | "name" | "type">> {
  return db
    .select({ projectName: services.projectName, name: services.name, type: services.type })
    .from(services)
    .all();
}

export function countServices(db: DbHandle, project: string): number {
  return Number(
    db.select({ count: sql<number>`count(*)` }).from(services).where(eq(services.projectName, project)).get()
      ?.count ?? 0,
  );
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
    .values({ id: randomUUID(), projectName: project, name, type, spec, createdAt: now, updatedAt: now })
    .run();
}

/** Services made before identifiers existed get theirs here. Run once at boot. */
export function assignMissingServiceIds(db: Db): void {
  const missing = db
    .select({ projectName: services.projectName, name: services.name })
    .from(services)
    .where(isNull(services.id))
    .all();
  for (const row of missing) {
    db.update(services)
      .set({ id: randomUUID() })
      .where(and(eq(services.projectName, row.projectName), eq(services.name, row.name)))
      .run();
  }
}

/**
 * Replaces the spec. Saving a setting never changes what is running: only a deploy does. Whoever
 * writes must have read the row in this same tick: a spec read before an `await` is stale by the time
 * it is written back, and whatever was saved in between would quietly be undone.
 */
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

/** Records what a deployment put in place. Never touches the saved settings. */
export function saveApplied(
  db: DbHandle,
  project: string,
  name: string,
  applied: { sealed: string; answering: boolean | null },
): void {
  db.update(services)
    .set({ applied: applied.sealed, answering: applied.answering })
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .run();
}

/** What a successful deployment really ran. Never touches the saved settings. */
export function saveDeployed(db: DbHandle, project: string, name: string, deployed: DeployedImage): void {
  db.update(services)
    .set({ deployed })
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .run();
}

export function saveRuntimeUncertain(
  db: DbHandle,
  project: string,
  name: string,
  value: RuntimeUncertainty | null,
): void {
  db.update(services)
    .set({ runtimeUncertain: value })
    .where(and(eq(services.projectName, project), eq(services.name, name)))
    .run();
}

/** Whether this Action is still in progress in this process's database. */
export function isActionRunning(db: DbHandle, id: string): boolean {
  return (
    db.select({ status: actions.status }).from(actions).where(eq(actions.id, id)).get()?.status === "running"
  );
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
/**
 * What a project's people were handed for a service, which works without signing in: its deployment
 * token, a webhook secret one of them made, and its IDE token. They keep those when the service moves
 * to another project, whose people did not hand them out, so none of it works there.
 */
function withoutHandedOutAccess(spec: AppServiceSpec): AppServiceSpec {
  const { build } = spec;
  // A secret the panel gave straight to GitHub was never in anyone's hands.
  const managed = spec.source?.type === "github" && spec.source.webhookId !== null;
  return {
    ...spec,
    build: {
      ...build,
      deployToken: null,
      webhook: build.webhook === null || managed ? build.webhook : { ...build.webhook, paused: true },
    },
    box: spec.box === null ? null : { ...spec.box, ide: { ...spec.box.ide, token: null } },
  };
}

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
    const spec =
      from.project === to.project ? row.spec : withoutHandedOutAccess(appServiceSpec.parse(row.spec));
    // What was deployed under the old name is gone, so nothing has been applied under the new one.
    tx.insert(services)
      .values({
        ...row,
        id: null,
        projectName: to.project,
        name: to.name,
        spec,
        updatedAt: now,
        applied: null,
        deployed: null,
      })
      .run();
    tx.update(domains)
      .set({ projectName: to.project, serviceName: to.name })
      .where(and(eq(domains.projectName, from.project), eq(domains.serviceName, from.name)))
      .run();
    moveBackupRecords(tx, from, to);
    moveScriptRecords(tx, from, to);
    tx.delete(services)
      .where(and(eq(services.projectName, from.project), eq(services.name, from.name)))
      .run();
    // Only once the old row is gone: the identifier is unique, and it is what stays the same.
    tx.update(services)
      .set({ id: row.id })
      .where(and(eq(services.projectName, to.project), eq(services.name, to.name)))
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
  "id" | "type" | "status" | "projectName" | "serviceName"
>;

/** Every queued or running action that belongs to a service, oldest first. */
export function listActiveServiceActions(db: DbHandle): ActiveActionRow[] {
  return db
    .select({
      id: actions.id,
      type: actions.type,
      status: actions.status,
      projectName: actions.projectName,
      serviceName: actions.serviceName,
    })
    .from(actions)
    .where(and(inArray(actions.status, ACTIVE_STATUSES), isNotNull(actions.serviceName)))
    .orderBy(asc(actions.seq))
    .all();
}

export type DeploymentRow = Pick<typeof actions.$inferSelect, "id" | "status" | "createdAt">;

/**
 * The most recent deployments of one service, newest first. A row older than the service belongs
 * to a destroyed service that had the same name.
 */
export function listRecentDeployments(
  db: DbHandle,
  types: readonly string[],
  service: Pick<ServiceRecord, "projectName" | "name" | "createdAt">,
  limit: number,
): DeploymentRow[] {
  return db
    .select({ id: actions.id, status: actions.status, createdAt: actions.createdAt })
    .from(actions)
    .where(
      and(
        inArray(actions.type, [...types]),
        eq(actions.projectName, service.projectName),
        eq(actions.serviceName, service.name),
        gte(actions.createdAt, service.createdAt),
      ),
    )
    .orderBy(desc(actions.seq))
    .limit(limit)
    .all();
}
