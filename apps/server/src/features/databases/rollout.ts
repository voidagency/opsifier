import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { qualifiedName } from "../services/compile";
import { runDeploy, writeMountFiles } from "../services/lifecycle";
import type { ServiceTarget } from "../services/service";
import { compileDatabaseRecord, requireDatabase } from "./service";

/**
 * Applies whatever is saved: a running database gets new tasks, and a stopped one gets its Swarm
 * spec brought up to date, so that the next start already has the new settings.
 */
export async function rolloutDatabase(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<void> {
  const record = requireDatabase(deps, target);
  if (!record.spec.stopped) {
    await runDeploy(deps, target, ctx);
    return;
  }
  const name = qualifiedName(target.projectName, target.serviceName);
  const existing = await deps.docker.inspectService(name);
  if (existing === null) {
    ctx.log("Nothing is deployed yet, so these settings apply at the first start.");
    return;
  }
  const forceUpdate = existing.spec.TaskTemplate.ForceUpdate ?? 0;
  const compiled = compileDatabaseRecord(deps, target, record, forceUpdate, { stopped: true });
  await writeMountFiles(compiled.files);
  if (compiled.swarmSpec !== null) {
    await deps.docker.updateService(name, compiled.swarmSpec);
  }
  ctx.log("Stopped, so these settings will apply when it next starts.");
}
