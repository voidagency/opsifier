import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  deployActionType,
  deploymentPage,
  deploymentTrigger,
  deployTriggerPath,
  deployTriggerSkipped,
  listDeploymentsQuery,
  servicePath,
} from "@opsifier/contract";
import type { Context } from "hono";
import { toActionEntry } from "../../../core/actions";
import { requestScheme, requirePrincipal } from "../../../core/auth";
import type { AppEnv, Feature } from "../../../core/context";
import { AppError, notFound } from "../../../core/errors";
import { errorResponse, jsonResponse } from "../../../core/openapi";
import { listActions } from "../../actions/repo";
import { enqueueDeploy } from "../../services/lifecycle";
import { requireService } from "../../services/service";
import {
  ensureDeployToken,
  findServiceByToken,
  isPushToRef,
  isValidHubSignature,
  rotateDeployToken,
} from "./trigger";

const tags = ["Service deployments"];
const DEPLOY_PATH = "/api/v1/deploy/{token}";
const PUBLIC_PREFIX = "/api/v1/deploy/";
/** GitHub caps a delivery at 25 MB. */
const MAX_HOOK_BYTES = 26 * 1024 * 1024;

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
  200: jsonResponse(deploymentTrigger, "The trigger URL's path. The token is the only credential it needs."),
  400: errorResponse("The request failed validation."),
  401: errorResponse("Not signed in."),
  404: errorResponse("No such service."),
  502: errorResponse("GitHub could not be reached."),
};

const getTriggerRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/deployments/trigger",
  tags,
  request: { params: servicePath },
  responses: triggerResponses,
});

const rotateTriggerRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services/{service}/deployments/trigger/rotate",
  tags,
  description: "Replaces the token. The previous URL stops working at once.",
  request: { params: servicePath },
  responses: triggerResponses,
});

const deployRoute = (method: "get" | "post") =>
  createRoute({
    method,
    path: DEPLOY_PATH,
    tags,
    description:
      "Starts a deployment. Add `?forceRebuild` to skip the build cache. A GitHub push only deploys the configured branch.",
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: jsonResponse(deployTriggerSkipped, "Accepted, but this delivery does not call for a deployment."),
      202: jsonResponse(actionEntry, "The Action that is doing the work."),
      401: errorResponse("The webhook signature does not match."),
      404: errorResponse("No such trigger."),
      409: errorResponse("The service has no source to deploy."),
      413: errorResponse("The delivery is too large."),
    },
  });

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

function wantsForceRebuild(value: string | undefined): boolean {
  return value !== undefined && value !== "0" && value !== "false";
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

type SkipReason = (typeof deployTriggerSkipped)["_output"]["reason"];

/** A GitHub delivery either leads to a deployment or says why not. Anyone else's call always deploys. */
async function inspectGithubDelivery(
  c: Context<AppEnv>,
  token: string,
  ref: string | null,
): Promise<SkipReason | null> {
  const event = c.req.header("x-github-event");
  if (event === undefined || c.req.method !== "POST") {
    return null;
  }
  const body = await readDelivery(c.req.raw);
  if (!isValidHubSignature(c.req.header("x-hub-signature-256"), body, token)) {
    throw new AppError(401, "invalid_signature", "This delivery's signature does not match.");
  }
  if (event !== "push") {
    return "not_a_push";
  }
  if (ref === null) {
    return null;
  }
  const payload = JSON.parse(body.toString("utf8")) as { ref?: unknown; deleted?: unknown };
  if (payload.deleted === true) {
    return "branch_deleted";
  }
  return isPushToRef(payload.ref, ref) ? null : "other_branch";
}

export const feature: Feature = {
  isPublicPath: (path) => path.startsWith(PUBLIC_PREFIX),
  // GitHub's deliveries can be bigger than the API's general limit.
  readsOwnBody: (path) => path.startsWith(PUBLIC_PREFIX),

  register(app, deps) {
    app.openapi(listRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const { createdAt } = requireService(deps, { projectName: project, serviceName: service });
      const query = c.req.valid("query");
      const { rows, hasMore } = listActions(
        deps.db,
        { ...query, projectName: project, serviceName: service, type: deployActionType },
        createdAt,
      );
      const last = rows.at(-1);
      return c.json(
        {
          items: rows.map(toActionEntry),
          nextCursor: hasMore && last !== undefined ? String(last.seq) : null,
        },
        200,
      );
    });

    app.openapi(getTriggerRoute, (c) => {
      requirePrincipal(c);
      return c.json({ path: deployTriggerPath(ensureDeployToken(deps, target(c.req.valid("param")))) }, 200);
    });

    app.openapi(rotateTriggerRoute, async (c) => {
      requirePrincipal(c);
      const origin = `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
      const token = await rotateDeployToken(deps, target(c.req.valid("param")), origin);
      return c.json({ path: deployTriggerPath(token) }, 200);
    });

    const deploy = async (c: Context<AppEnv>, token: string) => {
      const record = findServiceByToken(deps, token);
      if (record === undefined) {
        throw notFound("This deployment trigger does not exist.");
      }
      const { source } = record.spec;
      const ref = source?.type === "git" || source?.type === "github" ? source.ref : null;
      const skip = await inspectGithubDelivery(c, token, ref);
      if (skip !== null) {
        return c.json({ deployed: false as const, reason: skip }, 200);
      }
      const action = enqueueDeploy(
        deps,
        { projectName: record.projectName, serviceName: record.name },
        undefined,
        {
          force: wantsForceRebuild(c.req.query("forceRebuild")),
        },
      );
      return c.json(toActionEntry(action), 202);
    };

    app.openapi(deployRoute("post"), (c) => deploy(c, c.req.valid("param").token));
    app.openapi(deployRoute("get"), (c) => deploy(c, c.req.valid("param").token));
  },
};
