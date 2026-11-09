import { type BoxBuildEntry, type BoxManifest, boxModuleIssues } from "@opsifier/contract";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { findAction } from "../actions/repo";
import { builtImageName } from "../services/compile/names";
import { type DeployOptions, runDeploy } from "../services/lifecycle";
import { saveServiceSpec } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { renderBoxDockerfile } from "./dockerfile";
import { boxBuildReason, boxChanges, boxManifestOf } from "./manifest";
import { requireBox } from "./service";
import { BOX_HOOK_FAILED_EXIT, BOX_INSTALL_DIR, BOX_START_GRACE_SECONDS } from "./supervisor";

const MAX_HISTORY = 50;
/** A start hook is allowed to take this long, plus time for the task to come up around it. */
const ROLLOUT_TIMEOUT_MS = (BOX_START_GRACE_SECONDS + 60) * 1000;

const BUILD_HOOK_STEP = `${BOX_INSTALL_DIR}/hooks/build`;
const START_HOOK_FAILED = new RegExp(`non-zero exit \\(${BOX_HOOK_FAILED_EXIT}\\)\\.?`);

function logChanges(ctx: ActionContext, entry: Pick<BoxBuildEntry, "reason" | "changes">): void {
  ctx.log(`Building this box because: ${entry.reason}`);
  for (const change of entry.changes) {
    const detail =
      change.from === null && change.to === null
        ? ""
        : `: ${change.from ?? "none"} -> ${change.to ?? "none"}`;
    ctx.log(`  ${change.kind} ${change.subject}${detail}`);
  }
}

function recordBuild(
  deps: AppDeps,
  target: ServiceTarget,
  entry: BoxBuildEntry,
  built: BoxManifest | undefined,
): void {
  const record = requireBox(deps, target);
  const { box } = record.spec;
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      box: { ...box, built: built ?? box.built, history: [entry, ...box.history].slice(0, MAX_HISTORY) },
    },
    new Date(deps.now()),
  );
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Says what went wrong in terms of the box, rather than of the image or the task it happened to. */
function explain(error: unknown, buildHookFailed: boolean): Error {
  const message = describe(error);
  if (buildHookFailed) {
    return new Error(`The build hook failed, so nothing was replaced. ${message}`, { cause: error });
  }
  const startHookFailed = START_HOOK_FAILED.test(message);
  return startHookFailed
    ? new Error(`The start hook failed: its output is in the service's logs. ${message}`, { cause: error })
    : error instanceof Error
      ? error
      : new Error(message);
}

/**
 * A deployment of a box: the ordinary one, around a build that can say why it happened. Anything the
 * matrix does not allow stops here, before an image is built or anything running is touched.
 */
export async function deployBox(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  request: DeployOptions,
): Promise<void> {
  const record = requireBox(deps, target);
  const { box } = record.spec;
  const issues = boxModuleIssues(box.modules);
  if (issues.length > 0) {
    throw conflict(
      "box_modules_invalid",
      `Nothing was replaced. ${issues.map(({ message }) => message).join(" ")}`,
    );
  }

  // The matrix may have moved under a saved box since it was last saved.
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, source: { type: "dockerfile", dockerfile: renderBoxDockerfile(box) } },
    new Date(deps.now()),
  );

  const desired = boxManifestOf(box);
  const changes = boxChanges(box.built, desired);
  const reason = boxBuildReason(box.built, changes, request.force === true);
  logChanges(ctx, { reason, changes });

  const entry = (
    status: BoxBuildEntry["status"],
    imageId: string | null,
    error: string | null,
  ): BoxBuildEntry => ({
    actionId: ctx.id,
    at: new Date(deps.now()).toISOString(),
    status,
    reason,
    changes,
    matrixRevision: desired.matrixRevision,
    imageId,
    actorEmail: findAction(deps.db, ctx.id)?.actorEmail ?? null,
    error,
  });

  let buildHookFailed = false;
  const log = (line: string) => {
    if (line.includes(BUILD_HOOK_STEP) && line.includes("did not complete successfully")) {
      buildHookFailed = true;
    }
    ctx.log(line);
  };

  try {
    await runDeploy(
      {
        ...deps,
        rollout: { ...deps.rollout, timeoutMs: Math.max(deps.rollout.timeoutMs, ROLLOUT_TIMEOUT_MS) },
      },
      target,
      { ...ctx, log },
      request,
    );
  } catch (error) {
    const explained = explain(error, buildHookFailed);
    recordBuild(
      deps,
      target,
      entry(ctx.signal.aborted ? "cancelled" : "failed", null, explained.message),
      undefined,
    );
    throw explained;
  }

  const image = await deps.docker.inspectImage(builtImageName(target.projectName, target.serviceName));
  recordBuild(deps, target, entry("succeeded", image?.id ?? null, null), desired);
}
