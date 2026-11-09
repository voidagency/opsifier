import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEPLOY_TRIGGER_PATH,
  type DeploymentTrigger,
  type IssuedDeploymentTrigger,
} from "@opsifier/contract";
import { eq, sql } from "drizzle-orm";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { services, users } from "../../../core/db/schema";
import { findService, listServiceRecords, type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { revokeBoxIdeTokensOfAccount } from "../box-ide/service";
import { gitSourceOf } from "../source/identity";
import { renewWebhook, toWebhookStatus } from "./webhook";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const newToken = () => randomBytes(24).toString("hex");

/** What the panel can say about a service's trigger and webhook. It holds no secret. */
export function deployTriggerStatus(deps: AppDeps, target: ServiceTarget): DeploymentTrigger {
  const { spec } = requireService(deps, target);
  const token = spec.build.deployToken;
  return {
    path: DEPLOY_TRIGGER_PATH,
    hasToken: token !== null,
    legacyUrl: token?.legacyUrl ?? false,
    createdAt: token?.createdAt ?? null,
    webhook: toWebhookStatus(spec),
    webhookAvailable: gitSourceOf(spec) !== null,
  };
}

/**
 * A webhook from before webhooks had a secret is signed with the old token, so an old token going
 * away takes that webhook with it. One the panel installed on GitHub is moved to a secret of its own
 * first, and a refusal from GitHub leaves everything as it was.
 */
async function withoutLegacyHook(
  deps: AppDeps,
  record: ServiceRecord,
  issuerId: string | null,
  origin: string,
): Promise<ServiceRecord["spec"]["build"]["webhook"]> {
  const hook = record.spec.build.webhook;
  if (hook === null || hook.sealedSecret !== null) {
    return hook;
  }
  const managed = record.spec.source?.type === "github" && record.spec.source.webhookId !== null;
  return managed ? (await renewWebhook(deps, record, issuerId, origin)).webhook : null;
}

/** Replaces the token, which invalidates the old one at once. The new one is shown here and nowhere else. */
export async function issueDeployToken(
  deps: AppDeps,
  target: ServiceTarget,
  issuerId: string,
  origin: string,
  actorEmail: string | undefined,
): Promise<IssuedDeploymentTrigger> {
  const webhook = await withoutLegacyHook(deps, requireService(deps, target), issuerId, origin);
  const token = newToken();
  // Read again: GitHub may have taken a while, and nothing else's edit may be lost.
  const record = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...record.spec,
      build: {
        ...record.spec.build,
        webhook,
        deployToken: {
          hash: hashToken(token),
          createdBy: issuerId,
          createdAt: new Date(deps.now()).toISOString(),
          legacyUrl: false,
        },
      },
    },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "service.trigger",
    title: `Issue a deployment token for ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return { ...deployTriggerStatus(deps, target), token };
}

/** Removes the token. Whoever holds it can no longer start anything. */
export async function revokeDeployToken(
  deps: AppDeps,
  target: ServiceTarget,
  issuerId: string,
  origin: string,
  actorEmail: string | undefined,
): Promise<DeploymentTrigger> {
  const webhook = await withoutLegacyHook(deps, requireService(deps, target), issuerId, origin);
  const record = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, build: { ...record.spec.build, webhook, deployToken: null } },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: "service.trigger",
    title: `Revoke the deployment token of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return deployTriggerStatus(deps, target);
}

/** Tokens are compared by hash, in the database, so a wrong guess learns nothing from timing. */
export function findServiceByToken(deps: Pick<AppDeps, "db">, token: string): ServiceRecord | undefined {
  const row = deps.db
    .select({ projectName: services.projectName, name: services.name })
    .from(services)
    .where(sql`json_extract(${services.spec}, '$.build.deployToken.hash') = ${hashToken(token)}`)
    .get();
  return row === undefined ? undefined : findService(deps.db, row.projectName, row.name);
}

/** The webhook named in a delivery's URL. The id only finds it: the signature is what proves anything. */
export function findServiceByWebhook(deps: Pick<AppDeps, "db">, id: string): ServiceRecord | undefined {
  const row = deps.db
    .select({ projectName: services.projectName, name: services.name })
    .from(services)
    .where(sql`json_extract(${services.spec}, '$.build.webhook.id') = ${id}`)
    .get();
  return row === undefined ? undefined : findService(deps.db, row.projectName, row.name);
}

/** The account a trigger or webhook was issued by, for the activity log. */
export function emailOfIssuer(deps: Pick<AppDeps, "db">, userId: string | null): string | undefined {
  return userId === null
    ? undefined
    : deps.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
}

/** A delivery is GitHub's only if it says so itself, computed over exactly the bytes that arrived. */
export function isValidHubSignature(signature: string | undefined, body: Buffer, secret: string): boolean {
  if (signature === undefined) {
    return false;
  }
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Whether a push to `pushed` is a push to what this source deploys. */
export function isPushToRef(pushed: unknown, configured: string): boolean {
  return (
    typeof pushed === "string" &&
    (pushed === configured || pushed === `refs/heads/${configured}` || pushed === `refs/tags/${configured}`)
  );
}

/**
 * Called inside the transaction that changes an account. Everything that account issued goes, since
 * it holds the secrets. So do tokens from before issuers were recorded that it could have read, as
 * they were readable by anyone who could operate the project, when its rights over them end.
 */
export function revokeTriggersOfAccount(
  db: DbHandle,
  userId: string,
  couldReadUnattributed: (project: string) => boolean,
  now: Date,
): void {
  for (const record of listServiceRecords(db)) {
    const { deployToken, webhook } = record.spec.build;
    const revokeToken =
      deployToken !== null &&
      (deployToken.createdBy === userId ||
        (deployToken.createdBy === null && couldReadUnattributed(record.projectName)));
    // A secret the panel gave straight to GitHub was never in anyone's hands, so only a hand-made one counts.
    const managed = record.spec.source?.type === "github" && record.spec.source.webhookId !== null;
    const revokeHook = webhook?.createdBy === userId && !managed && !webhook.paused;
    if (revokeToken || revokeHook) {
      saveServiceSpec(
        db,
        record.projectName,
        record.name,
        {
          ...record.spec,
          build: {
            ...record.spec.build,
            deployToken: revokeToken ? null : deployToken,
            webhook: revokeHook && webhook !== null ? { ...webhook, paused: true } : webhook,
          },
        },
        now,
      );
    }
  }
  revokeBoxIdeTokensOfAccount(db, userId, now);
}
