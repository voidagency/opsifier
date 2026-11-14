import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupActionTypes, type ServerRestore } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { findAction } from "../actions/repo";
import { backupOpsFor } from "../backups/engines";
import { importExportIntoVolume, pointDatabaseAtVolume, restoredVolumeName } from "../backups/restore";
import { instanceExportName } from "../backups/run";
import { isDatabaseRecord, requireDatabase } from "../databases/service";
import { saveRetainedVolume } from "../retained-volumes/repo";
import { enqueueDeploy } from "../services/lifecycle";
import { inspectOwnedService } from "../services/ownership";
import { listServiceRecords } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { type PendingRestore, pendingRestore, pendingRestoreFile, restoreDumpsDirectory } from "./pending";
import { readServerBackup, writeServerBackup } from "./service";

const FINISHED = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Resolves once the Action is over, however it ended. */
function waitForAction(deps: AppDeps, id: string, signal: AbortSignal): Promise<ActionRow> {
  return new Promise((resolve, reject) => {
    const settle = (row: ActionRow) => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      resolve(row);
    };
    const unsubscribe = deps.actions.onFinished((row) => {
      if (row.id === id) {
        settle(row);
      }
    });
    const abort = () => {
      unsubscribe();
      reject(signal.reason ?? new Error("Cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    const now = findAction(deps.db, id);
    if (now !== undefined && FINISHED.has(now.status)) {
      settle(now);
    }
  });
}

/** Deploys the way the panel always does, and waits. Null when it went well, else what went wrong. */
async function deployAndWait(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<string | null> {
  let row: ActionRow;
  try {
    row = enqueueDeploy(deps, target, undefined);
  } catch (error) {
    return `it could not be deployed: ${describe(error)}`;
  }
  const finished = await waitForAction(deps, row.id, ctx.signal);
  return finished.status === "succeeded"
    ? null
    : `its deployment ${finished.status === "failed" ? "failed" : `ended ${finished.status}`}: ${finished.error ?? "see its log"}`;
}

/**
 * One database: its export goes into a new volume, through a temporary server, then the service is
 * deployed onto it. A volume already there is never written to: the data goes into another one.
 */
async function bringDatabaseBack(
  deps: AppDeps,
  target: ServiceTarget,
  dumps: string,
  ctx: ActionContext,
): Promise<string | null> {
  const label = `${target.projectName}/${target.serviceName}`;
  const record = requireDatabase(deps, target);
  if (record.applied === null) {
    ctx.log(`${label}: never deployed, so left as it is.`);
    return null;
  }
  const ops = backupOpsFor(record.spec.database.engine);
  // Imported by this run, onto a volume the service may not be on yet: it has to be deployed again.
  let importedNow = false;
  if (ops === null) {
    ctx.log(`${label}: this engine has no export, so it starts empty.`);
  } else {
    const file = join(dumps, target.projectName, instanceExportName(target.serviceName, ops));
    const imported = `${file}.imported`;
    if (existsSync(imported)) {
      ctx.log(`${label}: imported before the panel restarted.`);
    } else if (!existsSync(file)) {
      return record.spec.stopped
        ? "it was stopped when the backup was taken, so the backup holds none of its data. It stays stopped."
        : "the backup holds no export of it, so it was not deployed.";
    } else {
      let volume = record.spec.database.volume;
      if ((await deps.docker.inspectVolume(volume)) !== null) {
        const fresh = restoredVolumeName(
          volume,
          nanoid(8)
            .toLowerCase()
            .replaceAll(/[^a-z0-9]/g, "0"),
        );
        saveRetainedVolume(deps.db, {
          name: volume,
          kind: "database",
          projectName: target.projectName,
          serviceName: target.serviceName,
          retainedAt: new Date(deps.now()),
        });
        pointDatabaseAtVolume(deps, target, fresh);
        ctx.log(
          `${label}: the volume ${volume} is already there, so it is kept, under Monitor, Storage, and the data goes into ${fresh}.`,
        );
        volume = fresh;
      }
      ctx.log(`${label}: importing its export`);
      const row = deps.actions.enqueue({
        type: backupActionTypes.restoreDatabase,
        title: `Restore ${label} from the server backup`,
        projectName: target.projectName,
        serviceName: target.serviceName,
        run: (inner) => importExportIntoVolume(deps, { target, file, volume }, inner),
      });
      const finished = await waitForAction(deps, row.id, ctx.signal);
      if (finished.status !== "succeeded") {
        return `the import failed (${finished.error ?? finished.status}), so it was not deployed. Its export stays in ${file}.`;
      }
      await writeFile(imported, "");
      importedNow = true;
    }
  }
  if (record.spec.stopped) {
    ctx.log(`${label}: stopped when the backup was taken, so it stays stopped.`);
    return null;
  }
  if (!importedNow && (await inspectOwnedService(deps, target)) !== null) {
    ctx.log(`${label}: already deployed.`);
    return null;
  }
  const problem = await deployAndWait(deps, target, ctx);
  if (problem === null) {
    ctx.log(`${label}: back`);
  }
  return problem;
}

/** Every application that was running, deployed again from its source; one more try for any that fails. */
async function bringApplicationsBack(deps: AppDeps, ctx: ActionContext): Promise<string[]> {
  const targets = listServiceRecords(deps.db)
    .filter((record) => !isDatabaseRecord(record) && record.applied !== null && !record.spec.stopped)
    .map((record) => ({ projectName: record.projectName, serviceName: record.name }));
  ctx.log(`${targets.length} application(s) to deploy`);
  let failing = targets;
  let problems: string[] = [];
  for (const attempt of [1, 2]) {
    if (failing.length === 0) {
      break;
    }
    if (attempt === 2) {
      ctx.log(`Deploying again what failed, now that the rest is up: ${failing.length} application(s)`);
    }
    const outcomes = await Promise.all(
      failing.map(async (target) => ({ target, problem: await deployAndWait(deps, target, ctx) })),
    );
    failing = outcomes.filter((outcome) => outcome.problem !== null).map((outcome) => outcome.target);
    problems = outcomes
      .filter((outcome) => outcome.problem !== null)
      .map((outcome) => `${outcome.target.projectName}/${outcome.target.serviceName}: ${outcome.problem}`);
  }
  ctx.log(`${targets.length - failing.length} of ${targets.length} application(s) deployed`);
  return problems;
}

async function runServerRestore(deps: AppDeps, pending: PendingRestore, ctx: ActionContext): Promise<void> {
  const { dataDir } = deps.config;
  const dumps = restoreDumpsDirectory(dataDir);
  const problems: string[] = [];
  const conclude = (status: ServerRestore["status"]) => {
    const current = readServerBackup(deps).restore;
    if (current !== null) {
      writeServerBackup(deps, {
        restore: { ...current, status, problems, finishedAt: new Date(deps.now()).toISOString() },
      });
    }
  };
  ctx.log(
    `Backup of ${pending.hostname}, taken ${pending.snapshotTime}, snapshot ${pending.snapshotId.slice(0, 8)}`,
  );
  try {
    ctx.phase("databases");
    for (const record of listServiceRecords(deps.db).filter(isDatabaseRecord)) {
      ctx.signal.throwIfAborted();
      const target = { projectName: record.projectName, serviceName: record.name };
      const problem = await bringDatabaseBack(deps, target, dumps, ctx);
      if (problem !== null) {
        problems.push(`${target.projectName}/${target.serviceName}: ${problem}`);
        ctx.log(`${target.projectName}/${target.serviceName}: ${problem}`);
      }
    }

    ctx.phase("applications");
    for (const problem of await bringApplicationsBack(deps, ctx)) {
      problems.push(problem);
      ctx.log(problem);
    }
  } catch (error) {
    if (deps.actions.isStopping()) {
      // The panel is going down: the next start carries on from here.
      throw error;
    }
    problems.push(ctx.signal.aborted ? "The restore was stopped before the end." : describe(error));
    await rm(pendingRestoreFile(dataDir), { force: true });
    conclude("failed");
    throw error;
  }

  // Past this point a restart has nothing to carry on, so the outcome is recorded straight after.
  await rm(pendingRestoreFile(dataDir), { force: true });
  conclude(problems.length === 0 ? "succeeded" : "failed");
  if (problems.length === 0) {
    await rm(dumps, { recursive: true, force: true });
    ctx.log("The server is back.");
    return;
  }
  throw new Error(`The server is back, except for ${problems.length} thing(s): ${problems.join(" ")}`);
}

/**
 * At boot. After `install.sh --restore`, the panel's state and the volumes are back, and this brings
 * back the rest: each database from its export, then every application that was running. A restore
 * the last process was in the middle of starts over; what it had finished is not done twice.
 */
export function resumeServerRestore(deps: AppDeps): void {
  try {
    carryOnRestore(deps);
  } catch (error) {
    // The panel has to come up whatever happens here: a restore can be carried on by hand.
    deps.logger.error(`The restore left by install.sh could not be carried on: ${describe(error)}`);
  }
}

function carryOnRestore(deps: AppDeps): void {
  const file = pendingRestoreFile(deps.config.dataDir);
  const current = readServerBackup(deps).restore;
  if (!existsSync(file)) {
    if (current?.status === "running") {
      writeServerBackup(deps, {
        restore: {
          ...current,
          status: "failed",
          finishedAt: new Date(deps.now()).toISOString(),
          problems: [...current.problems, "The panel restarted during the restore."],
        },
      });
    }
    return;
  }
  let pending: PendingRestore;
  try {
    pending = pendingRestore.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    deps.logger.warn(
      `The restore left by install.sh could not be read, so it was not carried on: ${describe(error)}`,
    );
    return;
  }
  const row = deps.actions.enqueue({
    type: backupActionTypes.restoreServer,
    title: `Bring the server back from the backup of ${pending.hostname}`,
    run: (ctx) => runServerRestore(deps, pending, ctx),
  });
  const resumed = current?.status === "running" && current.snapshotId === pending.snapshotId;
  writeServerBackup(deps, {
    restore: {
      status: "running",
      actionId: row.id,
      snapshotId: pending.snapshotId,
      snapshotTime: pending.snapshotTime,
      hostname: pending.hostname,
      startedAt: resumed ? current.startedAt : new Date(deps.now()).toISOString(),
      finishedAt: null,
      problems: [],
    },
  });
}
