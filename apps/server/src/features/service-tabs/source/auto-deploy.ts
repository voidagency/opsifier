import { randomBytes } from "node:crypto";
import { type ServiceSource, webhookDeliveryPath } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest } from "../../../core/errors";
import { createHook, deleteHook } from "../../github/client";
import { githubFailure, requireTokenFor } from "../../github/service";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { newHookId } from "../deployments/webhook";
import { gitSourceOf } from "./identity";
import { toPublicSource } from "./public";
import { WEBHOOK_SECRET_CONTEXT } from "./stored";

/**
 * Turns a push webhook on the repository on or off. The hook has its own secret, sealed here and
 * given to GitHub, which is the only other place it ever exists.
 */
export async function setAutoDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  enabled: boolean,
  origin: string,
  issuer: { id: string; email: string } | undefined,
): Promise<ServiceSource> {
  const { source, build } = requireService(deps, target).spec;
  if (source?.type !== "github") {
    throw badRequest("source_not_github", "Auto-deploy needs a GitHub source.");
  }
  if (enabled === (source.webhookId !== null)) {
    return toPublicSource(source);
  }

  const token = requireTokenFor(deps, source);
  const identity = gitSourceOf({ source, compose: null });
  let webhookId: number | null = null;
  let webhook = build.webhook;
  try {
    if (enabled && identity !== null) {
      const id = newHookId();
      const secret = randomBytes(32).toString("hex");
      webhookId = await createHook(token, source.repository, {
        url: `${origin}${webhookDeliveryPath(id)}`,
        secret,
      });
      webhook = {
        id,
        sealedSecret: deps.secrets.seal(secret, WEBHOOK_SECRET_CONTEXT),
        repository: identity.repository,
        ref: identity.ref,
        paused: false,
        createdBy: issuer?.id ?? null,
        createdAt: new Date(deps.now()).toISOString(),
      };
    } else if (source.webhookId !== null) {
      await deleteHook(token, source.repository, source.webhookId);
      webhook = null;
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
    { ...record.spec, source: next, build: { ...record.spec.build, webhook } },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "service.source",
    title: `${enabled ? "Enable" : "Disable"} auto-deploy of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail: issuer?.email,
  });
  return toPublicSource(next);
}
