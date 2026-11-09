import {
  type ListScriptRunsQuery,
  SCRIPT_RUNS_KEPT,
  SCRIPT_SKIPS_KEPT,
  type ScriptRunStatus,
} from "@opsifier/contract";
import { and, desc, eq, inArray, lt, lte, ne, notInArray, type SQL } from "drizzle-orm";
import type { DbHandle } from "../../../core/db";
import { scriptRuns, scriptSchedules } from "../../../core/db/schema";
import type { ServiceTarget } from "../../services/service";

export type ScriptRunRow = typeof scriptRuns.$inferSelect;
export type NewScriptRun = typeof scriptRuns.$inferInsert;

/** What overlap protection looks at: a run that has not finished, whoever's panel started it. */
const ACTIVE_STATUSES: ScriptRunStatus[] = ["queued", "running"];

const isService = (target: ServiceTarget): SQL | undefined =>
  and(eq(scriptRuns.projectName, target.projectName), eq(scriptRuns.serviceName, target.serviceName));

export function insertRun(db: DbHandle, values: NewScriptRun): ScriptRunRow {
  return db.insert(scriptRuns).values(values).returning().get();
}

export function updateRun(db: DbHandle, id: string, changes: Partial<NewScriptRun>): void {
  db.update(scriptRuns).set(changes).where(eq(scriptRuns.id, id)).run();
}

export function findRun(db: DbHandle, target: ServiceTarget, id: string): ScriptRunRow | undefined {
  return db
    .select()
    .from(scriptRuns)
    .where(and(isService(target), eq(scriptRuns.id, id)))
    .get();
}

export function findRunById(db: DbHandle, id: string): ScriptRunRow | undefined {
  return db.select().from(scriptRuns).where(eq(scriptRuns.id, id)).get();
}

/** Overlap protection stays in force across a restart simply because this reads rows, not memory. */
export function activeRunOf(
  db: DbHandle,
  target: ServiceTarget,
  scriptName: string,
): ScriptRunRow | undefined {
  return db
    .select()
    .from(scriptRuns)
    .where(
      and(
        isService(target),
        eq(scriptRuns.scriptName, scriptName),
        inArray(scriptRuns.status, ACTIVE_STATUSES),
      ),
    )
    .get();
}

export const listRunsInStatus = (db: DbHandle, status: "queued" | "running"): ScriptRunRow[] =>
  db.select().from(scriptRuns).where(eq(scriptRuns.status, status)).all();

export function latestRunOf(
  db: DbHandle,
  target: ServiceTarget,
  scriptName: string,
): ScriptRunRow | undefined {
  return db
    .select()
    .from(scriptRuns)
    .where(and(isService(target), eq(scriptRuns.scriptName, scriptName)))
    .orderBy(desc(scriptRuns.seq))
    .limit(1)
    .get();
}

/** Newest first. One more row is fetched than asked for, to tell whether there is another page. */
export function listRuns(
  db: DbHandle,
  target: ServiceTarget,
  query: Pick<ListScriptRunsQuery, "limit" | "cursor" | "script">,
): { rows: ScriptRunRow[]; hasMore: boolean } {
  const rows = db
    .select()
    .from(scriptRuns)
    .where(
      and(
        isService(target),
        query.script === undefined ? undefined : eq(scriptRuns.scriptName, query.script),
        query.cursor === undefined ? undefined : lt(scriptRuns.seq, Number(query.cursor)),
      ),
    )
    .orderBy(desc(scriptRuns.seq))
    .limit(query.limit + 1)
    .all();
  return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

function pruneKind(
  db: DbHandle,
  target: ServiceTarget,
  scriptName: string,
  kind: "runs" | "skips",
  keep: number,
): void {
  const matches = and(
    isService(target),
    eq(scriptRuns.scriptName, scriptName),
    kind === "skips" ? eq(scriptRuns.status, "skipped") : ne(scriptRuns.status, "skipped"),
    notInArray(scriptRuns.status, ACTIVE_STATUSES),
  );
  const oldestKept = db
    .select({ seq: scriptRuns.seq })
    .from(scriptRuns)
    .where(matches)
    .orderBy(desc(scriptRuns.seq))
    .limit(1)
    .offset(keep - 1)
    .get();
  if (oldestKept !== undefined) {
    db.delete(scriptRuns)
      .where(and(matches, lt(scriptRuns.seq, oldestKept.seq)))
      .run();
  }
}

/** Keeps a script's history bounded. Skips are counted apart, so they can't push real runs out. */
export function pruneRuns(db: DbHandle, target: ServiceTarget, scriptName: string): void {
  pruneKind(db, target, scriptName, "runs", SCRIPT_RUNS_KEPT);
  pruneKind(db, target, scriptName, "skips", SCRIPT_SKIPS_KEPT);
}

/** A renamed script keeps its past, and a run still waiting finds it under its new name. */
export function renameRuns(db: DbHandle, target: ServiceTarget, from: string, to: string): void {
  db.update(scriptRuns)
    .set({ scriptName: to })
    .where(and(isService(target), eq(scriptRuns.scriptName, from)))
    .run();
}

export type ScriptScheduleRow = typeof scriptSchedules.$inferSelect;

const isScheduleOf = (target: ServiceTarget, scriptName: string): SQL | undefined =>
  and(
    eq(scriptSchedules.projectName, target.projectName),
    eq(scriptSchedules.serviceName, target.serviceName),
    eq(scriptSchedules.scriptName, scriptName),
  );

export function listSchedulesOf(db: DbHandle, target: ServiceTarget): ScriptScheduleRow[] {
  return db
    .select()
    .from(scriptSchedules)
    .where(
      and(
        eq(scriptSchedules.projectName, target.projectName),
        eq(scriptSchedules.serviceName, target.serviceName),
      ),
    )
    .all();
}

export function saveSchedule(db: DbHandle, target: ServiceTarget, scriptName: string, nextRunAt: Date): void {
  db.insert(scriptSchedules)
    .values({ ...target, scriptName, nextRunAt })
    .onConflictDoUpdate({
      target: [scriptSchedules.projectName, scriptSchedules.serviceName, scriptSchedules.scriptName],
      set: { nextRunAt },
    })
    .run();
}

export function deleteSchedule(db: DbHandle, target: ServiceTarget, scriptName: string): void {
  db.delete(scriptSchedules).where(isScheduleOf(target, scriptName)).run();
}

export function listDueSchedules(db: DbHandle, now: Date): ScriptScheduleRow[] {
  return db.select().from(scriptSchedules).where(lte(scriptSchedules.nextRunAt, now)).all();
}

export function moveScriptRecords(
  db: DbHandle,
  from: { project: string; name: string },
  to: { project: string; name: string },
): void {
  db.update(scriptSchedules)
    .set({ projectName: to.project, serviceName: to.name })
    .where(and(eq(scriptSchedules.projectName, from.project), eq(scriptSchedules.serviceName, from.name)))
    .run();
  db.update(scriptRuns)
    .set({ projectName: to.project, serviceName: to.name })
    .where(and(eq(scriptRuns.projectName, from.project), eq(scriptRuns.serviceName, from.name)))
    .run();
}
