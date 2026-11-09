import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  DEPLOY_TRIGGER_PATH,
  deploymentActionTypes,
  deploymentPage,
  deploymentTrigger,
  deployTriggerSkipped,
  issuedDeploymentTrigger,
  issuedDeploymentWebhook,
  listDeploymentsQuery,
  servicePath,
} from "@opsifier/contract";
import type { Context } from "hono";
import { runAs, toActionEntry } from "../../../core/actions";
import { requestScheme, requirePrincipal } from "../../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../../core/context";
import { AppError, badRequest, conflict, notFound, unauthorized } from "../../../core/errors";
import { errorResponse, jsonResponse } from "../../../core/openapi";
import { listActions } from "../../actions/repo";
import { enqueueDeploy } from "../../services/lifecycle";
import type { ServiceRecord } from "../../services/repo";
import { requireService } from "../../services/service";
import { type GitIdentity, githubRepositoryKey, gitSourceOf, tryRepositoryKey } from "../source/identity";
import { WEBHOOK_SECRET_CONTEXT } from "../source/stored";
import { confirmDelivery, type DeliveryKey, findDelivery, releaseDelivery, reserveDelivery } from "./repo";
import {
  deployTriggerStatus,
  emailOfIssuer,
  findServiceByToken,
  findServiceByWebhook,
  isPushToRef,
  issueDeployToken,
  isValidHubSignature,
  revokeDeployToken,
} from "./trigger";
import { upgradeDeploymentAuthority } from "./upgrade";
import { issueWebhook, removeWebhook, type StoredWebhook } from "./webhook";

const tags = ["Service deployments"];
const PUBLIC_PREFIX = `${DEPLOY_TRIGGER_PATH}/`;
const BEARER = /^Bearer\s+(\S+)$/i;
/** GitHub caps a delivery at 25 MB. */
const MAX_HOOK_BYTES = 26 * 1024 * 1024;
/** A delivery id is only a label, so one that is not label-sized is not one. */
const MAX_DELIVERY_ID_CHARS = 128;
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NO_COMMIT = /^0+$/;

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/deployments",
  tags,
  request: { params: servicePath, query: listDeploymentsQuery },
  responses: {
    200: jsonResponse(deploymentPage, "The service's deployments, newest first."),
    400: errorResponse("The request failed validation."),
    401: errorResponse("Not signed in."),
    404: errorResponse("No such service."),
  },
});

const triggerResponses = {
  400: errorResponse("The request failed validation."),
  401: errorResponse("Not signed in."),
  404: errorResponse("No such service."),
  502: errorResponse("GitHub could not be reached."),
};

const getTriggerRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/deployments/trigger",
  tags,
  description: "Whether a token and a webhook exist. Their secrets are never part of this answer.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(deploymentTrigger, "What exists, without any secret."),
    ...triggerResponses,
  },
});

const rotateTriggerRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services/{service}/deployments/trigger/rotate",
  tags,
  description: "Issues a token, replacing any earlier one, which stops working at once. Shown once, here.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(issuedDeploymentTrigger, "The new token, shown this once."),
    ...triggerResponses,
  },
});

const revokeTriggerRoute = createRoute({
  method: "delete",
  path: "/api/v1/projects/{project}/services/{service}/deployments/trigger",
  tags,
  description: "Removes the token. Whoever holds it can no longer start a deployment.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(deploymentTrigger, "The token is gone."),
    ...triggerResponses,
  },
});

const rotateWebhookRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services/{service}/deployments/webhook/rotate",
  tags,
  description:
    "Creates the push webhook, or gives it a new secret bound to the current repository and branch, which also lifts a pause. A secret for a webhook added by hand is shown once, here.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(issuedDeploymentWebhook, "The webhook, and its new secret if it is added by hand."),
    ...triggerResponses,
  },
});

const removeWebhookRoute = createRoute({
  method: "delete",
  path: "/api/v1/projects/{project}/services/{service}/deployments/webhook",
  tags,
  description: "Removes the webhook. A delivery signed with its secret is no longer accepted.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(deploymentTrigger, "The webhook is gone."),
    ...triggerResponses,
  },
});

const deployResponses = {
  200: jsonResponse(deployTriggerSkipped, "Accepted, but this delivery does not call for a deployment."),
  202: jsonResponse(actionEntry, "The Action that is doing the work."),
  400: errorResponse("The delivery is not a push the panel can read."),
  401: errorResponse("The token or the delivery's signature is not valid."),
  404: errorResponse("No such trigger."),
  409: errorResponse("The service has no source to deploy, or this webhook is paused."),
  413: errorResponse("The delivery is too large."),
};

const deployRoute = createRoute({
  method: "post",
  path: DEPLOY_TRIGGER_PATH,
  tags,
  description:
    "Starts a deployment of the service the token in the `Authorization: Bearer` header belongs to. Add `?forceRebuild` to skip the build cache.",
  responses: deployResponses,
});

const hookRoute = createRoute({
  method: "post",
  path: `${DEPLOY_TRIGGER_PATH}/hook/{id}`,
  tags,
  description:
    "A push webhook, signed with its own secret in `X-Hub-Signature-256`. Only a push to the repository and branch it was issued for deploys, and only once per delivery.",
  request: { params: z.object({ id: z.string() }) },
  responses: deployResponses,
});

const legacyRoute = (method: "get" | "post") =>
  createRoute({
    method,
    path: `${DEPLOY_TRIGGER_PATH}/{token}`,
    tags,
    deprecated: true,
    description:
      "Tokens issued before version 2 can still be used in the URL, until they are replaced. Anything claiming to be from a Git host must be signed.",
    request: { params: z.object({ token: z.string() }) },
    responses: deployResponses,
  });

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const targetOf = (record: ServiceRecord) => ({ projectName: record.projectName, serviceName: record.name });

function wantsForceRebuild(value: string | undefined): boolean {
  return value !== undefined && value !== "0" && value !== "false";
}

/** The address this panel was reached on, as far as it can be believed. */
function panelOrigin(c: Context<AppEnv>, deps: AppDeps): string {
  return `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

async function readDelivery(request: Request): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_HOOK_BYTES) {
    throw new AppError(413, "payload_too_large", "The request body is too large.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
    if (done) {
      break;
    }
    total += value.length;
    if (total > MAX_HOOK_BYTES) {
      throw new AppError(413, "payload_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

interface PushPayload {
  ref?: unknown;
  deleted?: unknown;
  after?: unknown;
  repository?: Record<string, unknown> | null;
  sender?: { login?: unknown } | null;
}

function invalidDelivery(): AppError {
  return badRequest("invalid_delivery", "This delivery is not a push the panel can read.");
}

/** GitHub's hook settings offer JSON or a form field holding the same JSON. */
function parsePayload(body: Buffer, contentType: string | undefined): PushPayload {
  const text = body.toString("utf8");
  const json = contentType?.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(text).get("payload")
    : text;
  try {
    const parsed: unknown = JSON.parse(json ?? "");
    if (typeof parsed !== "object" || parsed === null) {
      throw invalidDelivery();
    }
    return parsed as PushPayload;
  } catch {
    throw invalidDelivery();
  }
}

/** Whether the push is to the repository this service was set up for. */
function namesRepository(payload: PushPayload, identity: GitIdentity): boolean {
  const { repository } = payload;
  if (typeof repository !== "object" || repository === null) {
    return false;
  }
  if (identity.github) {
    const fullName = repository.full_name;
    return typeof fullName === "string" && githubRepositoryKey(fullName) === identity.repository;
  }
  return [repository.clone_url, repository.ssh_url, repository.git_url, repository.html_url].some(
    (address) => tryRepositoryKey(address) === identity.repository,
  );
}

function deliveryDetail(identity: GitIdentity, commit: string, payload: PushPayload): string {
  const login = payload.sender?.login;
  const by = typeof login === "string" ? ` by ${login.slice(0, 64)}` : "";
  return `Push to ${identity.ref} at ${commit.slice(0, 12)}${by}`;
}

export const feature: Feature = {
  isPublicPath: (path) => path === DEPLOY_TRIGGER_PATH || path.startsWith(PUBLIC_PREFIX),
  // A deployment token arrives as a bearer token and is not an API key, which the middleware would refuse.
  readsOwnBearer: (path) => path === DEPLOY_TRIGGER_PATH || path.startsWith(PUBLIC_PREFIX),
  // GitHub's deliveries can be bigger than the API's general limit.
  readsOwnBody: (path) => path.startsWith(PUBLIC_PREFIX),

  /** Everything readable that the current rules say must not be is dealt with before serving. */
  boot: (deps) => upgradeDeploymentAuthority(deps),

  register(app, deps) {
    app.openapi(listRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const { createdAt } = requireService(deps, { projectName: project, serviceName: service });
      const query = c.req.valid("query");
      const { rows, hasMore } = listActions(
        deps.db,
        { ...query, projectName: project, serviceName: service, types: deploymentActionTypes },
        createdAt,
      );
      const last = rows.at(-1);
      return c.json(
        {
          items: rows.map((row) => ({
            ...toActionEntry(deps.actions.current(row)),
            deployment: row.deployment,
          })),
          nextCursor: hasMore && last !== undefined ? String(last.seq) : null,
        },
        200,
      );
    });

    app.openapi(getTriggerRoute, (c) => c.json(deployTriggerStatus(deps, target(c.req.valid("param"))), 200));

    app.openapi(rotateTriggerRoute, async (c) => {
      const { user } = requirePrincipal(c);
      const issued = await issueDeployToken(
        deps,
        target(c.req.valid("param")),
        user.id,
        panelOrigin(c, deps),
        user.email,
      );
      return c.json(issued, 200);
    });

    app.openapi(revokeTriggerRoute, async (c) => {
      const { user } = requirePrincipal(c);
      return c.json(
        await revokeDeployToken(
          deps,
          target(c.req.valid("param")),
          user.id,
          panelOrigin(c, deps),
          user.email,
        ),
        200,
      );
    });

    app.openapi(rotateWebhookRoute, async (c) => {
      const { user } = requirePrincipal(c);
      return c.json(
        await issueWebhook(deps, target(c.req.valid("param")), user.id, panelOrigin(c, deps), user.email),
        200,
      );
    });

    app.openapi(removeWebhookRoute, async (c) => {
      const params = target(c.req.valid("param"));
      await removeWebhook(deps, params, requirePrincipal(c).user.email);
      return c.json(deployTriggerStatus(deps, params), 200);
    });

    /** Deploys what the token's service is set up to deploy, once the caller has proved it holds one. */
    const deployWithToken = (c: Context<AppEnv>, record: ServiceRecord) => {
      const action = runAs(
        {
          origin: "trigger",
          actorEmail: emailOfIssuer(deps, record.spec.build.deployToken?.createdBy ?? null),
        },
        () =>
          enqueueDeploy(deps, targetOf(record), undefined, {
            force: wantsForceRebuild(c.req.query("forceRebuild")),
          }),
      );
      return c.json(toActionEntry(action), 202);
    };

    const skipped = (
      c: Context<AppEnv>,
      reason: (typeof deployTriggerSkipped)["_output"]["reason"],
      actionId?: string | null,
    ) => c.json({ deployed: false as const, reason, ...(actionId ? { actionId } : {}) }, 200);

    /** A delivery earns nothing until its signature, over the bytes that arrived, has been checked. */
    const receiveDelivery = async (
      c: Context<AppEnv>,
      record: ServiceRecord,
      hook: StoredWebhook | null,
      secret: string,
    ) => {
      const body = await readDelivery(c.req.raw);
      if (!isValidHubSignature(c.req.header("x-hub-signature-256"), body, secret)) {
        throw new AppError(401, "invalid_signature", "This delivery's signature does not match.");
      }
      if (hook === null || hook.paused) {
        throw conflict(
          "webhook_paused",
          "The repository or branch of this service changed, or its issuer lost access. Rotate the webhook's secret to resume.",
        );
      }
      if (c.req.header("x-github-event") !== "push") {
        return skipped(c, "not_a_push");
      }

      const identity = gitSourceOf(record.spec);
      if (identity === null) {
        return skipped(c, "no_repository");
      }
      const payload = parsePayload(body, c.req.header("content-type"));
      if (!namesRepository(payload, identity)) {
        return skipped(c, "other_repository");
      }
      if (payload.deleted === true || (typeof payload.after === "string" && NO_COMMIT.test(payload.after))) {
        return skipped(c, "branch_deleted");
      }
      if (!isPushToRef(payload.ref, identity.ref)) {
        return skipped(c, "other_branch");
      }
      if (typeof payload.after !== "string" || !COMMIT_SHA.test(payload.after)) {
        throw invalidDelivery();
      }
      const commit = payload.after;

      const deliveryId = c.req.header("x-github-delivery");
      const key: DeliveryKey = {
        hookId: hook.id,
        deliveryId:
          deliveryId !== undefined && deliveryId.length <= MAX_DELIVERY_ID_CHARS ? deliveryId : null,
        bodyHash: createHash("sha256").update(body).digest("hex"),
      };
      // Nothing below awaits, so of two copies arriving together one reserves it and the other sees that.
      if (!reserveDelivery(deps.db, key, deps.now())) {
        return skipped(c, "duplicate", findDelivery(deps.db, key)?.actionId);
      }
      try {
        const action = runAs(
          {
            origin: "webhook",
            actorEmail: emailOfIssuer(deps, hook.createdBy),
            detail: deliveryDetail(identity, commit, payload),
          },
          () => enqueueDeploy(deps, targetOf(record), undefined, { commit }),
        );
        confirmDelivery(deps.db, key, action.id);
        return c.json(toActionEntry(action), 202);
      } catch (error) {
        // Refused, by a destroy in progress for one: nothing started, so a later copy still can.
        releaseDelivery(deps.db, key);
        throw error;
      }
    };

    app.openapi(deployRoute, (c) => {
      const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
      const record = token === undefined ? undefined : findServiceByToken(deps, token);
      if (record === undefined) {
        throw unauthorized("invalid_token", "This deployment token is not valid.");
      }
      return deployWithToken(c, record);
    });

    app.openapi(hookRoute, async (c) => {
      const { id } = c.req.valid("param");
      const record = findServiceByWebhook(deps, id);
      const hook = record?.spec.build.webhook;
      // A webhook from before webhooks had a secret is only reachable through its old URL.
      if (record === undefined || hook === undefined || hook === null || hook.sealedSecret === null) {
        throw notFound("This webhook does not exist.");
      }
      return receiveDelivery(c, record, hook, deps.secrets.unseal(hook.sealedSecret, WEBHOOK_SECRET_CONTEXT));
    });

    const legacy = (c: Context<AppEnv>, token: string) => {
      const record = findServiceByToken(deps, token);
      const grant = record?.spec.build.deployToken;
      if (record === undefined || grant === null || grant === undefined || !grant.legacyUrl) {
        throw notFound("This deployment trigger does not exist.");
      }
      // Anything calling itself GitHub must prove it, even at a URL that already holds a token.
      return c.req.header("x-github-event") === undefined
        ? deployWithToken(c, record)
        : receiveDelivery(c, record, record.spec.build.webhook, token);
    };

    app.openapi(legacyRoute("post"), (c) => legacy(c, c.req.valid("param").token));
    app.openapi(legacyRoute("get"), (c) => legacy(c, c.req.valid("param").token));
  },
};
