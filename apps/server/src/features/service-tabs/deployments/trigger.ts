import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deployTriggerPath } from "@opsifier/contract";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../../../core/context";
import { services } from "../../../core/db/schema";
import { updateHook } from "../../github/client";
import { githubFailure, requireGithubToken } from "../../github/service";
import { findService, type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { DEPLOY_TOKEN_CONTEXT } from "../source/stored";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function storeToken(deps: AppDeps, target: ServiceTarget, token: string): void {
  const record = requireService(deps, target);
  const deployToken = { hash: hashToken(token), sealed: deps.secrets.seal(token, DEPLOY_TOKEN_CONTEXT) };
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, build: { ...record.spec.build, deployToken } },
    new Date(deps.now()),
  );
}

const newToken = () => randomBytes(24).toString("hex");

/** The service's trigger token. It comes into being the first time someone asks to see it. */
export function ensureDeployToken(deps: AppDeps, target: ServiceTarget): string {
  const existing = requireService(deps, target).spec.build.deployToken;
  if (existing !== null) {
    return deps.secrets.unseal(existing.sealed, DEPLOY_TOKEN_CONTEXT);
  }
  const token = newToken();
  storeToken(deps, target, token);
  return token;
}

/**
 * Replaces the token, which immediately invalidates the old URL. A push webhook is pointed at the new
 * one first, so a refusal from GitHub leaves everything as it was.
 */
export async function rotateDeployToken(
  deps: AppDeps,
  target: ServiceTarget,
  origin: string,
): Promise<string> {
  const { source } = requireService(deps, target).spec;
  const token = newToken();
  if (source?.type === "github" && source.webhookId !== null) {
    try {
      await updateHook(requireGithubToken(deps), source.repository, source.webhookId, {
        url: `${origin}${deployTriggerPath(token)}`,
        secret: token,
      });
    } catch (error) {
      throw githubFailure(error);
    }
  }
  storeToken(deps, target, token);
  return token;
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

/** Checks the signature GitHub sends when the webhook has a secret. A hook made by hand may have none. */
export function isValidHubSignature(signature: string | undefined, body: Buffer, secret: string): boolean {
  if (signature === undefined) {
    return true;
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
