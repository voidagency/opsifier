import { isMajorVersionChange } from "@opsifier/contract";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { SwarmServiceSpec } from "../../core/docker/driver";
import { effectiveOf, recordApplied } from "../services/applied";
import { qualifiedName } from "../services/compile";
import { runDeploy, writeMountFiles } from "../services/lifecycle";
import { inspectOwnedService } from "../services/ownership";
import type { ServiceTarget } from "../services/service";
import { compileDatabaseRecord, requireDatabase } from "./service";

const withImage = (spec: SwarmServiceSpec, image: string): SwarmServiceSpec => ({
  ...spec,
  TaskTemplate: { ...spec.TaskTemplate, ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Image: image } },
});

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
  const existing = await inspectOwnedService(deps, target);
  if (existing === null) {
    ctx.log("Nothing is deployed yet, so these settings apply at the first start.");
    return;
  }
  const forceUpdate = existing.spec.TaskTemplate.ForceUpdate ?? 0;
  const compiled = compileDatabaseRecord(deps, target, record, forceUpdate, { stopped: true });
  await writeMountFiles(compiled.files);
  if (compiled.swarmSpec !== null) {
    const deployed = existing.spec.TaskTemplate.ContainerSpec.Image;
    if (isMajorVersionChange(deployed, compiled.swarmSpec.TaskTemplate.ContainerSpec.Image)) {
      // A start only scales what is there, so it must not find a version nobody has taken a copy for.
      await deps.docker.updateService(name, withImage(compiled.swarmSpec, deployed));
      ctx.log(`Stopped. It stays on ${deployed} until a deployment moves it to another major version.`);
      return;
    }
    await deps.docker.updateService(name, compiled.swarmSpec);
    recordApplied(deps, target, effectiveOf(deps, target, record));
  }
  ctx.log("Stopped, so these settings will apply when it next starts.");
}
