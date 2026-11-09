import type { DeploymentRecord, ListActionsQuery } from "@opsifier/contract";
import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import type { ActionRow } from "../../core/actions";
import type { DbHandle } from "../../core/db";
import { actions } from "../../core/db/schema";

export function findAction(db: DbHandle, id: string): ActionRow | undefined {
  return db.select().from(actions).where(eq(actions.id, id)).get();
}

/** Newest first, using one extra row to learn whether another page exists. */
export function listActions(
  db: DbHandle,
  query: ListActionsQuery & { types?: readonly string[] },
  /** Leaves out anything older, such as what happened to a destroyed service of the same name. */
  since?: Date,
): { rows: ActionRow[]; hasMore: boolean } {
  const conditions: SQL[] = [];
  if (since !== undefined) {
    conditions.push(gte(actions.createdAt, since));
  }
  if (query.cursor !== undefined) {
    conditions.push(lt(actions.seq, Number(query.cursor)));
  }
  if (query.projectName !== undefined) {
    conditions.push(eq(actions.projectName, query.projectName));
  }
  if (query.serviceName !== undefined) {
    conditions.push(eq(actions.serviceName, query.serviceName));
  }
  if (query.type !== undefined) {
    conditions.push(eq(actions.type, query.type));
  }
  if (query.types !== undefined) {
    conditions.push(inArray(actions.type, [...query.types]));
  }
  if (query.status !== undefined) {
    conditions.push(eq(actions.status, query.status));
  }

  const rows = db
    .select()
    .from(actions)
    .where(and(...conditions))
    .orderBy(desc(actions.seq))
    .limit(query.limit + 1)
    .all();

  return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

const NO_DEPLOYMENT_RECORD: DeploymentRecord = {
  requestedRef: null,
  builtCommit: null,
  ociRevision: null,
  image: null,
  imageId: null,
  digest: null,
  release: null,
  rollbackOf: null,
  answering: null,
  runningTasks: null,
  desiredTasks: null,
};

/** Adds to what a deployment has established about itself: written as it goes, so a failure keeps it. */
export function noteDeployment(db: DbHandle, id: string, facts: Partial<DeploymentRecord>): void {
  const known = db.select({ deployment: actions.deployment }).from(actions).where(eq(actions.id, id)).get();
  db.update(actions)
    .set({ deployment: { ...NO_DEPLOYMENT_RECORD, ...known?.deployment, ...facts } })
    .where(eq(actions.id, id))
    .run();
}
