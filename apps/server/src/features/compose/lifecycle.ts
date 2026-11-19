import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { deployActionType, firstInvalidEnvLine } from "@opsifier/contract";
import { type ActionContext, type ActionRow, RETAINED_ACTIONS } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { Redactor } from "../../core/tools";
import { assertProjectBoundaries } from "../projects/isolation";
import { releaseProxyFromProjectNetwork } from "../projects/network";
import { rememberBuildCache, snapshotBuildCache } from "../server/docker-admin";
import { effectiveOf, recordApplied } from "../services/applied";
import { deployRun, joinDeployRun } from "../services/deploy-request";
import { assertDeploySpace, stackDiskNeed } from "../services/disk-check";
import { openEnv, sealEnv } from "../services/env-store";
import {
  listRecentDeployments,
  type ServiceRecord,
  saveRuntimeUncertain,
  saveServiceSpec,
} from "../services/repo";
import { requireService, type ServiceTarget, writeProxyConfig } from "../services/service";
import { hasEntry, readPlainFile } from "./checkout";
import { deployStack, hashCompose, prepareStack, type StackDeployOptions, watchStack } from "./deploy";
import { hasHostAccess, stackChildren } from "./inspect";
import { composeCodeDir, composeProject } from "./names";
import { fileRefusal } from "./refusals";
import { assertComposeSucceeded, type ComposeFiles, runCompose } from "./run";
import { inspectStackFile, requireCompose, stackFileOf, unmarkedStackContainers } from "./service";
import type { StoredCompose } from "./spec";

function enqueueOn(
  deps: AppDeps,
  target: ServiceTarget,
  verb: { type: string; title: string },
  actorEmail: string | undefined,
  run: (ctx: ActionContext) => Promise<void>,
): ActionRow {
  return deps.actions.enqueue({
    type: verb.type,
    title: `${verb.title} ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run,
  });
}

/** Read here and not when the work began: whatever was saved in the meantime has to stay saved. */
function saveStopped(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  stopped: boolean,
  completedChildren?: readonly string[],
): ServiceRecord["spec"] {
  const record = requireService(deps, target);
  const compose = record.spec.compose;
  const spec: ServiceRecord["spec"] = {
    ...record.spec,
    stopped,
    ...(compose === null || completedChildren === undefined
      ? {}
      : { compose: { ...compose, completedChildren: [...completedChildren] } }),
  };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return spec;
}

/**
 * Compose acts on every container that carries the project's name, whoever started it. Containers
 * without the panel's marker are someone else's, unless this panel has deployed the stack before it
 * began marking them.
 */
async function stackIsOurs(
  deps: Pick<AppDeps, "db" | "docker">,
  target: ServiceTarget,
  record: ServiceRecord,
): Promise<boolean> {
  return (
    (await unmarkedStackContainers(deps, target)).length === 0 ||
    listRecentDeployments(deps.db, [deployActionType], record, RETAINED_ACTIONS).some(
      (deployment) => deployment.status === "succeeded",
    )
  );
}

async function assertStackOurs(deps: AppDeps, target: ServiceTarget, record: ServiceRecord): Promise<void> {
  if (!(await stackIsOurs(deps, target, record))) {
    throw conflict(
      "service_not_owned",
      "Containers of a Compose project with this name already run here, and this panel did not start them, so they were left alone.",
      { name: "Docker already runs something under this name" },
    );
  }
}

/** Reasons a deploy can be refused at the door. A Git file is only known once it has been fetched. */
function assertDeployable(deps: AppDeps, target: ServiceTarget, record: ServiceRecord): void {
  const compose = requireCompose(record);
  if (compose.source === null) {
    throw conflict("service_has_no_source", "Save a Compose file before deploying.");
  }
  if (compose.source.type === "inline") {
    assertFileAllowed(deps, target, compose.source.content, compose);
  }
}

/** What stops this file from running, in the words a person needs to fix it. */
function assertFileAllowed(
  deps: AppDeps,
  target: ServiceTarget,
  content: string,
  { acknowledgedHash, source }: StoredCompose,
): void {
  const inspection = inspectStackFile(deps, target, content, stackFileOf(source));
  if (inspection.parseError !== null) {
    throw conflict("compose_invalid", "This Compose file is not valid YAML. See the Source tab.");
  }
  // Another project's network first: its refusal offers the way to reach a database there.
  const blocking =
    inspection.issues.find((issue) => issue.code === "foreign_network") ??
    inspection.issues.find((issue) => issue.severity === "error");
  if (blocking !== undefined) {
    throw fileRefusal(blocking, composeProject(target));
  }
  if (hasHostAccess(inspection) && hashCompose(content) !== acknowledgedHash) {
    throw conflict(
      "compose_needs_confirmation",
      "This stack can reach the server itself. Review it on the Source tab and confirm before deploying.",
    );
  }
}

/** Starts or updates the stack with `docker compose up`, and waits until it has stayed up. */
export async function runComposeDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  options: StackDeployOptions = {},
): Promise<void> {
  const { projectName, serviceName } = target;
  const record = requireService(deps, target);
  await assertStackOurs(deps, target, record);
  const compose = requireCompose(record);
  const prepared = await prepareStack(deps, target, record, compose, ctx, options.commit);
  // A Git file arrives only now, so this is the first time anyone could look at it.
  assertFileAllowed(deps, target, prepared.content, compose);
  await assertProjectBoundaries(deps, target, requireService(deps, target));
  await assertDeploySpace(deps, await stackDiskNeed(deps, stackChildren(prepared.content)), ctx);

  const current =
    (await seedEnvFromExample(deps, target, record, prepared.files.projectDirectory, ctx)) ?? record;
  const effective = effectiveOf(deps, target, current);
  const uncertainBefore = requireService(deps, target).runtimeUncertain;
  const cacheBefore = await snapshotBuildCache(deps, ctx.signal);
  // Written first: should the panel die from here on, the flag outlives it and says so.
  saveRuntimeUncertain(deps.db, projectName, serviceName, {
    reason: uncertainBefore?.reason ?? "interrupted",
    actionId: ctx.id,
  });
  let completed: string[];
  try {
    completed = await deployStack(deps, target, current, requireCompose(current), prepared, ctx, options);
  } catch (error) {
    saveRuntimeUncertain(deps.db, projectName, serviceName, uncertainBefore);
    throw error;
  } finally {
    await rememberBuildCache(deps, cacheBefore);
  }
  await writeProxyConfig(deps, target, saveStopped(deps, target, false, completed));
  recordApplied(deps, target, effective);
  saveRuntimeUncertain(deps.db, projectName, serviceName, null);
  await releaseProxyFromProjectNetwork(deps.docker, projectName, ctx.log);
  ctx.log("Deployed");
}

/** As much as the editor takes for a service's variables. */
const MAX_ENV_EXAMPLE_BYTES = 128 * 1024;

/**
 * A repository that ships `.env.example` is telling you what it needs. On a stack with no variables
 * of its own yet, it fills the editor and turns the `.env` file on, once.
 */
async function seedEnvFromExample(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  projectDirectory: string,
  ctx: ActionContext,
): Promise<ServiceRecord | null> {
  const compose = requireCompose(record);
  if (
    compose.source?.type !== "git" ||
    compose.envFile ||
    openEnv(deps, record.spec.sealedEnv).trim() !== ""
  ) {
    return null;
  }
  // The stack writes its folder too, and a link it left there could point at another project's `.env`:
  // only a plain file of the repository's own counts, reached through folders alone.
  const code = await realpath(composeCodeDir(deps, target));
  const [example, existing] = await Promise.all([
    readPlainFile(code, join(projectDirectory, ".env.example"), MAX_ENV_EXAMPLE_BYTES),
    hasEntry(code, join(projectDirectory, ".env")),
  ]);
  if (example === null || existing || firstInvalidEnvLine(example) !== null) {
    return null;
  }
  // Fetching a repository takes a while, and someone may have typed their own variables since.
  const current = requireService(deps, target);
  if (openEnv(deps, current.spec.sealedEnv).trim() !== "") {
    return null;
  }
  ctx.log("Using the repository's .env.example as a starting point");
  const spec: ServiceRecord["spec"] = {
    ...current.spec,
    sealedEnv: sealEnv(deps, example),
    compose: { ...requireCompose(current), envFile: true },
  };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return requireService(deps, target);
}

export function enqueueComposeDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
  options: StackDeployOptions = {},
): ActionRow {
  const record = requireService(deps, target);
  assertDeployable(deps, target, record);
  const work = (request: StackDeployOptions, ctx: ActionContext) =>
    runComposeDeploy(deps, target, ctx, request);
  return deps.actions.enqueue({
    type: deployActionType,
    title: `Deploy ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: deployRun(options, work),
    join: (waiting) => joinDeployRun(waiting, options, work),
  });
}

/** Lifecycle commands name only the project, so they keep working when the files have gone. */
async function runStackCommand(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  what: string,
  args: readonly string[],
  files?: ComposeFiles,
): Promise<void> {
  assertComposeSucceeded(
    what,
    await runCompose(deps, target, args, {
      files,
      signal: ctx.signal,
      onLine: ctx.log,
      redact: new Redactor(),
    }),
  );
}

export function enqueueComposeStop(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): ActionRow {
  const record = requireService(deps, target);
  requireCompose(record);
  if (record.spec.stopped) {
    throw conflict("service_stopped", "This stack is already stopped.");
  }
  return enqueueOn(deps, target, { type: "service.stop", title: "Stop" }, actorEmail, async (ctx) => {
    await assertStackOurs(deps, target, record);
    ctx.log("Stopping the stack");
    await runStackCommand(deps, target, ctx, "Stopping the stack", ["stop", "--timeout", "10"]);
    await writeProxyConfig(deps, target, saveStopped(deps, target, true));
    ctx.log("Stopped");
  });
}

export function enqueueComposeStart(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): ActionRow {
  const record = requireService(deps, target);
  requireCompose(record);
  if (!record.spec.stopped) {
    throw conflict("service_running", "This stack is already running.");
  }
  return enqueueOn(deps, target, { type: "service.start", title: "Start" }, actorEmail, async (ctx) => {
    await assertStackOurs(deps, target, record);
    ctx.log("Starting the stack");
    await runStackCommand(deps, target, ctx, "Starting the stack", ["start"]);
    await writeProxyConfig(deps, target, saveStopped(deps, target, false));
    ctx.log("Waiting for the stack to settle");
    await watchStack(deps, target, ctx, new Redactor());
    ctx.log("Started");
  });
}

export function enqueueComposeRestart(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): ActionRow {
  const record = requireService(deps, target);
  requireCompose(record);
  if (record.spec.stopped) {
    throw conflict("service_stopped", "Start this stack first.");
  }
  return enqueueOn(deps, target, { type: "service.restart", title: "Restart" }, actorEmail, async (ctx) => {
    await assertStackOurs(deps, target, record);
    ctx.log("Restarting the stack");
    await runStackCommand(deps, target, ctx, "Restarting the stack", ["restart"]);
    ctx.log("Waiting for the stack to settle");
    await watchStack(deps, target, ctx, new Redactor());
    ctx.log("Restarted");
  });
}

/**
 * Takes the stack's containers and networks down. Named volumes are left alone: deleting a service
 * keeps its data unless somebody deletes that on purpose.
 */
export async function removeComposeStack(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  log: (line: string) => void,
): Promise<void> {
  if (!(await stackIsOurs(deps, target, record))) {
    log("Leaving the running containers of this name alone: this panel did not start them");
    return;
  }
  log("Taking the stack down");
  assertComposeSucceeded(
    "Taking the stack down",
    await runCompose(deps, target, ["down", "--remove-orphans", "--timeout", "10"], {
      onLine: log,
      redact: new Redactor(),
    }),
  );
}
