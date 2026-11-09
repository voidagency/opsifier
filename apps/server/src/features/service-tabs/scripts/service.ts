import { MAX_SCRIPTS, type ScriptEntry, type ScriptSpec } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { badRequest, conflict, notFound } from "../../../core/errors";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { deleteSchedule, latestRunOf, listSchedulesOf, renameRuns, saveSchedule } from "./repo";
import { toScriptRun } from "./run";
import { nextRunOf } from "./schedule";

function assertNameFree(scripts: readonly ScriptSpec[], name: string, except?: number): void {
  const taken = scripts.some(
    (script, index) => index !== except && script.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) {
    throw conflict("script_name_taken", "A script with this name already exists.", {
      name: "This name is already used",
    });
  }
}

const sameSchedule = (a: ScriptSpec, b: ScriptSpec): boolean =>
  a.schedule?.cron === b.schedule?.cron && a.schedule?.timeZone === b.schedule?.timeZone;

/** Keeps the due times in step with the scripts, in the same transaction that saves them. */
function syncSchedules(
  deps: AppDeps,
  db: DbHandle,
  target: ServiceTarget,
  before: readonly ScriptSpec[],
  after: readonly ScriptSpec[],
): void {
  for (const script of after) {
    if (script.schedule === null) {
      continue;
    }
    const known = before.find((candidate) => candidate.name === script.name);
    if (known === undefined || !sameSchedule(known, script)) {
      const next = nextRunOf(script.schedule, deps.now());
      if (next === null) {
        throw badRequest("schedule_never_happens", "This schedule never happens.", {
          schedule: "This schedule never happens",
        });
      }
      saveSchedule(db, target, script.name, new Date(next));
    }
  }
  const scheduled = new Set(after.filter((script) => script.schedule !== null).map((script) => script.name));
  for (const schedule of listSchedulesOf(db, target)) {
    if (!scheduled.has(schedule.scriptName)) {
      deleteSchedule(db, target, schedule.scriptName);
    }
  }
}

function save(
  deps: AppDeps,
  target: ServiceTarget,
  scripts: ScriptSpec[],
  rename?: { from: string; to: string },
): ScriptEntry[] {
  const record = requireService(deps, target);
  deps.db.transaction((tx) => {
    saveServiceSpec(
      tx,
      target.projectName,
      target.serviceName,
      { ...record.spec, scripts },
      new Date(deps.now()),
    );
    if (rename !== undefined && rename.from !== rename.to) {
      renameRuns(tx, target, rename.from, rename.to);
    }
    syncSchedules(deps, tx, target, record.spec.scripts, scripts);
  });
  return listScripts(deps, target);
}

/** Every script of the service with what it is doing: its next due time and its latest run. */
export function listScripts(deps: AppDeps, target: ServiceTarget): ScriptEntry[] {
  const { scripts } = requireService(deps, target).spec;
  const nextRuns = new Map(
    listSchedulesOf(deps.db, target).map((schedule) => [schedule.scriptName, schedule.nextRunAt]),
  );
  return scripts.map((script) => {
    const lastRun = latestRunOf(deps.db, target, script.name);
    return {
      ...script,
      nextRunAt: nextRuns.get(script.name)?.toISOString() ?? null,
      lastRun: lastRun === undefined ? null : toScriptRun(lastRun),
    };
  });
}

export function addScript(deps: AppDeps, target: ServiceTarget, script: ScriptSpec): ScriptEntry[] {
  const { scripts } = requireService(deps, target).spec;
  if (scripts.length >= MAX_SCRIPTS) {
    throw badRequest("too_many_scripts", "This service has as many scripts as it can hold.");
  }
  assertNameFree(scripts, script.name);
  return save(deps, target, [...scripts, script]);
}

export function updateScript(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  script: ScriptSpec,
): ScriptEntry[] {
  const { scripts } = requireService(deps, target).spec;
  const existing = scripts[index];
  if (existing === undefined) {
    throw notFound("This script does not exist.");
  }
  assertNameFree(scripts, script.name, index);
  return save(
    deps,
    target,
    scripts.map((item, position) => (position === index ? script : item)),
    { from: existing.name, to: script.name },
  );
}

export function removeScript(deps: AppDeps, target: ServiceTarget, index: number): ScriptEntry[] {
  const { scripts } = requireService(deps, target).spec;
  if (index >= scripts.length) {
    throw notFound("This script does not exist.");
  }
  return save(
    deps,
    target,
    scripts.filter((_, position) => position !== index),
  );
}
