import { deployTriggerPath, type ServiceSource } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest } from "../../../core/errors";
import { createHook, deleteHook } from "../../github/client";
import { githubFailure, requireGithubToken } from "../../github/service";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { ensureDeployToken } from "../deployments/trigger";
import { toPublicSource } from "./public";

/**
 * Turns a push webhook on the repository on or off. The hook calls the service's trigger URL and
 * is signed with its token, so rotating that token is enough to replace it.
 */
export async function setAutoDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  enabled: boolean,
  origin: string,
  actorEmail: string | undefined,
): Promise<ServiceSource> {
  const { source } = requireService(deps, target).spec;
  if (source?.type !== "github") {
    throw badRequest("source_not_github", "Auto-deploy needs a GitHub source.");
  }
  if (enabled === (source.webhookId !== null)) {
    return toPublicSource(source);
  }

  const token = requireGithubToken(deps);
  let webhookId: number | null = null;
  try {
    if (enabled) {
      const deployToken = ensureDeployToken(deps, target);
      webhookId = await createHook(token, source.repository, {
        url: `${origin}${deployTriggerPath(deployToken)}`,
        secret: deployToken,
      });
    } else if (source.webhookId !== null) {
      await deleteHook(token, source.repository, source.webhookId);
    }
  } catch (error) {
    throw githubFailure(error);
  }

  const record = requireService(deps, target);
  const next = record.spec.source?.type === "github" ? { ...record.spec.source, webhookId } : source;
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, source: next },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "service.source",
    title: `${enabled ? "Enable" : "Disable"} auto-deploy of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return toPublicSource(next);
}
