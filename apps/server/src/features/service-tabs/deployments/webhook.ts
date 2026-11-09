import { randomBytes } from "node:crypto";
import {
  type DeploymentWebhook,
  type IssuedDeploymentWebhook,
  webhookDeliveryPath,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest } from "../../../core/errors";
import { updateHook } from "../../github/client";
import { deleteRepositoryHook } from "../../github/hooks";
import { githubFailure, requireTokenFor } from "../../github/service";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { gitSourceOf } from "../source/identity";
import { type StoredBuildState, type StoredGithubSource, WEBHOOK_SECRET_CONTEXT } from "../source/stored";

export type StoredWebhook = NonNullable<StoredBuildState["webhook"]>;

export const newHookId = (): string => randomBytes(16).toString("hex");

const isManaged = (
  source: ServiceRecord["spec"]["source"],
): source is StoredGithubSource & { webhookId: number } =>
  source?.type === "github" && source.webhookId !== null;

export function toWebhookStatus(spec: ServiceRecord["spec"]): DeploymentWebhook | null {
  const hook = spec.build.webhook;
  return hook === null
    ? null
    : {
        path: webhookDeliveryPath(hook.id),
        managed: isManaged(spec.source),
        repository: hook.repository,
        ref: hook.ref,
        paused: hook.paused,
        legacy: hook.sealedSecret === null,
        createdAt: hook.createdAt,
      };
}

function requireGitSource(spec: ServiceRecord["spec"]) {
  const identity = gitSourceOf(spec);
  if (identity === null) {
    throw badRequest("webhook_needs_git_source", "A webhook needs a Git source.");
  }
  return identity;
}

export interface RenewedWebhook {
  webhook: StoredWebhook;
  /** Null when the panel gave it straight to GitHub, so that nobody ever has to see it. */
  secret: string | null;
}

/**
 * A new secret, bound to what the service builds from now. A webhook the panel installed is told first,
 * so a refusal from GitHub leaves everything as it was.
 */
export async function renewWebhook(
  deps: AppDeps,
  record: ServiceRecord,
  issuerId: string | null,
  origin: string,
): Promise<RenewedWebhook> {
  const { source, build } = record.spec;
  const identity = requireGitSource(record.spec);
  const id = build.webhook?.id ?? newHookId();
  const secret = randomBytes(32).toString("hex");
  if (isManaged(source)) {
    try {
      await updateHook(requireTokenFor(deps, source), source.repository, source.webhookId, {
        url: `${origin}${webhookDeliveryPath(id)}`,
        secret,
      });
    } catch (error) {
      throw githubFailure(error);
    }
  }
  return {
    webhook: {
      id,
      sealedSecret: deps.secrets.seal(secret, WEBHOOK_SECRET_CONTEXT),
      repository: identity.repository,
      ref: identity.ref,
      paused: false,
      createdBy: issuerId,
      createdAt: new Date(deps.now()).toISOString(),
    },
    secret: isManaged(source) ? null : secret,
  };
}

/** Creates the webhook, or replaces its secret and lifts a pause. The secret is shown here and nowhere else. */
export async function issueWebhook(
  deps: AppDeps,
  target: ServiceTarget,
  issuerId: string,
  origin: string,
  actorEmail: string | undefined,
): Promise<IssuedDeploymentWebhook> {
  const renewed = await renewWebhook(deps, requireService(deps, target), issuerId, origin);
  // Read again: GitHub may have taken a while, and nothing else's edit may be lost.
  const record = requireService(deps, target);
  const spec = { ...record.spec, build: { ...record.spec.build, webhook: renewed.webhook } };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  deps.actions.record({
    type: "service.trigger",
    title: `Issue a webhook secret for ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return { webhook: toWebhookStatus(spec) as DeploymentWebhook, secret: renewed.secret };
}

/**
 * Removes the webhook. Whatever still holds its secret stops being accepted from here on, so a Git host
 * that cannot be reached right now only delays cleaning up there.
 */
export async function removeWebhook(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<void> {
  const { source } = requireService(deps, target).spec;
  if (isManaged(source)) {
    await deleteRepositoryHook(deps, source.repository, source.webhookId);
  }
  const record = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      source:
        record.spec.source?.type === "github"
          ? { ...record.spec.source, webhookId: null }
          : record.spec.source,
      build: { ...record.spec.build, webhook: null },
    },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "service.trigger",
    title: `Remove the webhook of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
}
