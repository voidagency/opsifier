import { type ChangePasswordRequest, databaseActionTypes } from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { badRequest, conflict } from "../../core/errors";
import { refreshEnabledCompanions } from "../service-tabs/companions/service";
import { qualifiedName } from "../services/compile";
import { listServiceRecords, saveServiceSpec } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { type OpsCredentials, type OpsTarget, opsFor } from "./engine-ops";
import { type ExecPlan, redactSecrets, runInDatabase } from "./exec";
import { rolloutDatabase } from "./rollout";
import {
  type DatabaseRecord,
  isDatabaseRecord,
  requireDatabase,
  sealSecrets,
  unsealSecrets,
} from "./service";
import type { StoredDatabase, StoredRotation } from "./spec";

function saveDatabase(deps: AppDeps, target: ServiceTarget, change: Partial<StoredDatabase>): void {
  const record = requireDatabase(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, database: { ...record.spec.database, ...change } },
    new Date(deps.now()),
  );
}

const opsTargetOf = (target: ServiceTarget, database: StoredDatabase): OpsTarget => ({
  host: qualifiedName(target.projectName, target.serviceName),
  user: database.user,
  databaseName: database.databaseName,
});

const secretsList = (...credentials: readonly OpsCredentials[]): string[] =>
  credentials
    .flatMap(({ password, rootPassword }) => [password, rootPassword])
    .filter((value): value is string => value !== null);

/** The client's own words, with the passwords taken out, for the Action log and its error. */
function describeFailure(output: string, secrets: readonly string[]): string {
  return (
    redactSecrets(output, secrets)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "The database did not explain why."
  );
}

/** Runs one script and throws, with whatever the client said, when it does not finish cleanly. */
async function execute(
  deps: AppDeps,
  target: ServiceTarget,
  plan: ExecPlan,
  secrets: readonly string[],
  ctx: ActionContext,
): Promise<void> {
  const service = qualifiedName(target.projectName, target.serviceName);
  const outcome = await runInDatabase(deps, service, plan, { signal: ctx.signal });
  if (!outcome.ok) {
    throw new Error(describeFailure(outcome.output, secrets));
  }
}

/**
 * Connects as every account, each with its password. The answer comes from the engine itself. A
 * task that cannot run the check counts as a failed check, not as a reason to give up on the rest.
 */
async function probeCredentials(
  deps: AppDeps,
  target: ServiceTarget,
  database: StoredDatabase,
  credentials: OpsCredentials,
  ctx: ActionContext,
): Promise<boolean> {
  const service = qualifiedName(target.projectName, target.serviceName);
  for (const plan of opsFor(database.engine).probe(opsTargetOf(target, database), credentials)) {
    try {
      const outcome = await runInDatabase(deps, service, plan, { signal: ctx.signal });
      if (!outcome.ok) {
        ctx.log(`A check failed: ${describeFailure(outcome.output, secretsList(credentials))}`);
        return false;
      }
    } catch (error) {
      ctx.log(`A check could not run: ${(error as Error).message}`);
      return false;
    }
  }
  return true;
}

function sealedRotation(deps: AppDeps, from: OpsCredentials, to: OpsCredentials): StoredRotation {
  return { from: sealSecrets(deps, from), to: sealSecrets(deps, to) };
}

/** Makes `credentials` what the panel holds. A rotation record stays only if `keepRotation` says so. */
function recordCredentials(
  deps: AppDeps,
  target: ServiceTarget,
  credentials: OpsCredentials,
  rotation: StoredRotation | null,
): void {
  saveDatabase(deps, target, { ...sealSecrets(deps, credentials), rotation });
}

async function changeLiveCredentials(
  deps: AppDeps,
  target: ServiceTarget,
  database: StoredDatabase,
  from: OpsCredentials,
  to: OpsCredentials,
  ctx: ActionContext,
): Promise<void> {
  const ops = opsFor(database.engine);
  const opsTarget = opsTargetOf(target, database);
  const secrets = secretsList(from, to);
  const change = ops.change;
  if (change === null) {
    throw new Error("This engine has no live password change.");
  }

  try {
    ctx.log("Changing the password inside the running database");
    await execute(deps, target, change(opsTarget, from, to), secrets, ctx);
    ctx.log("Checking that the new password is accepted");
    if (!(await probeCredentials(deps, target, database, to, ctx))) {
      throw new Error("The database did not accept the new password afterwards.");
    }
  } catch (error) {
    const reason = (error as Error).message;
    ctx.log(`The change did not go through: ${reason}`);
    if (error instanceof DockerDriverError) {
      // Docker never started the script: there is nothing to undo.
      saveDatabase(deps, target, { rotation: null });
      throw new Error(`The password was not changed: ${reason}`);
    }
    const restored = await restoreCredentials(deps, target, database, from, to, ctx);
    if (restored === "new") {
      // Undoing failed, but the new password works: agreeing on it is all that matters.
      recordCredentials(deps, target, to, null);
      ctx.log("The database is using the new password, so the panel keeps it.");
      return;
    }
    if (restored === "unknown") {
      throw new Error(
        "The password change failed and could not be undone. The database may be using either " +
          `password: ${reason}`,
      );
    }
    saveDatabase(deps, target, { rotation: null });
    throw new Error(`The password was not changed: ${reason}`);
  }

  recordCredentials(deps, target, to, null);
  ctx.log("The new password is in effect and saved");
}

/** Works out where the database stands after a failed change, undoing it if it got that far. */
async function restoreCredentials(
  deps: AppDeps,
  target: ServiceTarget,
  database: StoredDatabase,
  from: OpsCredentials,
  to: OpsCredentials,
  ctx: ActionContext,
): Promise<"old" | "new" | "unknown"> {
  const change = opsFor(database.engine).change;
  const opsTarget = opsTargetOf(target, database);
  if (change !== null) {
    // Either login may be the one that still works, depending on how far the failed change got.
    for (const login of [to, from]) {
      const undo = await runInDatabase(
        deps,
        qualifiedName(target.projectName, target.serviceName),
        change(opsTarget, login, from),
        { signal: ctx.signal },
      ).catch(() => ({ ok: false, output: "" }));
      if (undo.ok) {
        break;
      }
    }
  }
  if (await probeCredentials(deps, target, database, from, ctx)) {
    return "old";
  }
  return (await probeCredentials(deps, target, database, to, ctx)) ? "new" : "unknown";
}

/** Redis reads its password from the environment, so the new one only exists after a new task. */
async function changeCredentialsByRollout(
  deps: AppDeps,
  target: ServiceTarget,
  database: StoredDatabase,
  from: OpsCredentials,
  to: OpsCredentials,
  rotation: StoredRotation,
  ctx: ActionContext,
): Promise<void> {
  recordCredentials(deps, target, to, rotation);
  try {
    await rolloutDatabase(deps, target, ctx);
    ctx.log("Checking that the new password is accepted");
    if (!(await probeCredentials(deps, target, database, to, ctx))) {
      throw new Error("The database did not accept the new password afterwards.");
    }
  } catch (error) {
    const reason = (error as Error).message;
    ctx.log(`The change did not go through: ${reason}`);
    recordCredentials(deps, target, from, rotation);
    try {
      await rolloutDatabase(deps, target, ctx);
    } catch (restoreError) {
      throw new Error(
        `The password change failed and the previous password could not be restored: ${reason}. ` +
          (restoreError as Error).message,
      );
    }
    if (!(await probeCredentials(deps, target, database, from, ctx))) {
      throw new Error(
        `The password change failed and the previous password could not be confirmed: ${reason}`,
      );
    }
    saveDatabase(deps, target, { rotation: null });
    throw new Error(`The password was not changed: ${reason}`);
  }
  saveDatabase(deps, target, { rotation: null });
  ctx.log("The new password is in effect and saved");
}

/** Decides which of a rotation's two credentials the database is really using, and records that. */
async function settleRotation(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  rotation: StoredRotation,
  ctx: ActionContext,
): Promise<void> {
  const { database } = record.spec;
  const to = unsealSecrets(deps, rotation.to);
  const from = unsealSecrets(deps, rotation.from);
  if (await probeCredentials(deps, target, database, to, ctx)) {
    recordCredentials(deps, target, to, null);
    ctx.log("The database is using the new password");
    return;
  }
  if (await probeCredentials(deps, target, database, from, ctx)) {
    recordCredentials(deps, target, from, null);
    ctx.log("The database is still using the old password");
    return;
  }
  throw new Error(
    "Neither password could be confirmed. Make sure the database is running, then check again.",
  );
}

async function runPasswordChange(
  deps: AppDeps,
  target: ServiceTarget,
  request: ChangePasswordRequest,
  ctx: ActionContext,
): Promise<void> {
  let record = requireDatabase(deps, target);
  if (record.spec.database.rotation !== null) {
    ctx.log("An earlier password change did not finish. Checking where it stands first");
    await settleRotation(deps, target, record, record.spec.database.rotation, ctx);
    record = requireDatabase(deps, target);
  }
  const { database } = record.spec;
  const from = unsealSecrets(deps, database);
  const to: OpsCredentials = {
    password: request.password ?? from.password,
    rootPassword: request.rootPassword ?? from.rootPassword,
  };
  if (to.password === from.password && to.rootPassword === from.rootPassword) {
    ctx.log("Nothing to change: this is already the password in use.");
    return;
  }

  const rotation = sealedRotation(deps, from, to);
  saveDatabase(deps, target, { rotation });

  if (opsFor(database.engine).change === null) {
    await changeCredentialsByRollout(deps, target, database, from, to, rotation, ctx);
  } else {
    await changeLiveCredentials(deps, target, database, from, to, ctx);
    try {
      await rolloutDatabase(deps, target, ctx);
    } catch (error) {
      throw new Error(
        "The new password is active and saved, but restarting the service failed: " +
          `${(error as Error).message}. Deploy it again to finish.`,
      );
    }
  }

  await refreshEnabledCompanions(deps, target, ctx);
  ctx.log("Password changed");
}

/** Validates a change and queues it. Nothing touches the database until the Action runs. */
export function enqueuePasswordChange(
  deps: AppDeps,
  target: ServiceTarget,
  request: ChangePasswordRequest,
  actorEmail: string | undefined,
): ActionRow {
  const record = requireDatabase(deps, target);
  const { database, stopped } = record.spec;
  if (request.rootPassword !== undefined && database.sealedRootPassword === null) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      rootPassword: "This engine has no separate root account",
    });
  }
  if (request.password === undefined && database.sealedRootPassword === null) {
    throw badRequest("validation_failed", "Some fields need attention.", { password: "Required" });
  }
  if (stopped) {
    throw conflict("service_stopped", "Start this database before changing its password.");
  }
  return deps.actions.enqueue({
    type: databaseActionTypes.password,
    title: `Change the password of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: (ctx) => runPasswordChange(deps, target, request, ctx),
  });
}

function enqueueRecovery(deps: AppDeps, target: ServiceTarget, actorEmail: string | undefined): ActionRow {
  return deps.actions.enqueue({
    type: databaseActionTypes.passwordRecovery,
    title: `Check the password of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: async (ctx) => {
      const record = requireDatabase(deps, target);
      if (record.spec.database.rotation === null) {
        ctx.log("Nothing is left to check.");
        return;
      }
      await settleRotation(deps, target, record, record.spec.database.rotation, ctx);
    },
  });
}

/** For a change the panel lost track of, from the Credentials tab. */
export function enqueueRotationCheck(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): ActionRow {
  const record = requireDatabase(deps, target);
  if (record.spec.database.rotation === null) {
    throw conflict("nothing_to_check", "This database has no password change to check.");
  }
  return enqueueRecovery(deps, target, actorEmail);
}

/** At boot: a change the panel died in the middle of is resolved before anyone relies on it. */
export function recoverInterruptedRotations(deps: AppDeps): void {
  for (const record of listServiceRecords(deps.db)) {
    if (isDatabaseRecord(record) && record.spec.database.rotation !== null) {
      deps.logger.warn(
        { project: record.projectName, service: record.name },
        "A password change was interrupted. Checking which password the database uses",
      );
      enqueueRecovery(deps, { projectName: record.projectName, serviceName: record.name }, undefined);
    }
  }
}
