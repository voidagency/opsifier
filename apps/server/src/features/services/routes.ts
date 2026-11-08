import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  createServiceRequest,
  deployRequest,
  destroyRequest,
  projectPath,
  renameServiceRequest,
  serviceDetail,
  servicePath,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  enqueueDeploy,
  enqueueDestroy,
  enqueueRestart,
  enqueueStart,
  enqueueStop,
  renameService,
} from "./lifecycle";
import { createService, getServiceDetail } from "./service";

const tags = ["Services"];
const PATH = "/api/v1/projects/{project}/services/{service}";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project or service.");
const refused = errorResponse("The service is not in a state that allows this.");
const accepted = jsonResponse(actionEntry, "The Action that is doing the work.");
const detail = jsonResponse(serviceDetail, "The service.");

const createServiceRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services",
  tags,
  request: { params: projectPath, body: jsonBody(createServiceRequest) },
  responses: {
    201: detail,
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("A service with this name already exists."),
  },
});

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: { 200: detail, 400: invalid, 401: denied, 404: missing },
});

const lifecycleRoute = (path: string, description: string) =>
  createRoute({
    method: "post",
    path: `${PATH}/${path}`,
    tags,
    description,
    request: { params: servicePath },
    responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
  });

const deployRoute = createRoute({
  method: "post",
  path: `${PATH}/deploy`,
  tags,
  request: {
    params: servicePath,
    body: { required: false, content: { "application/json": { schema: deployRequest } } },
  },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});
const stopRoute = lifecycleRoute("stop", "Scales the service to zero. Its domains answer 503.");
const startRoute = lifecycleRoute("start", "Restores the service's replicas and routes.");
const restartRoute = lifecycleRoute("restart", "Replaces the tasks through Swarm's force-update counter.");

const destroyRoute = createRoute({
  method: "delete",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(destroyRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const renameRoute = createRoute({
  method: "post",
  path: `${PATH}/rename`,
  tags,
  request: { params: servicePath, body: jsonBody(renameServiceRequest) },
  responses: {
    200: detail,
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The service must be stopped, or the new name is taken."),
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** API tokens are not people, so an Action started by one has no actor to show. */
const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(createServiceRoute, async (c) =>
      c.json(
        await createService(
          deps,
          c.req.valid("param").project,
          c.req.valid("json"),
          actorEmailOf(requirePrincipal(c)),
        ),
        201,
      ),
    );

    app.openapi(getRoute, async (c) =>
      c.json(await getServiceDetail(deps, target(c.req.valid("param"))), 200),
    );

    app.openapi(deployRoute, (c) =>
      c.json(
        toActionEntry(
          enqueueDeploy(deps, target(c.req.valid("param")), actorEmailOf(requirePrincipal(c)), {
            force: c.req.valid("json").force === true,
          }),
        ),
        202,
      ),
    );

    app.openapi(stopRoute, async (c) =>
      c.json(
        toActionEntry(
          await enqueueStop(deps, target(c.req.valid("param")), actorEmailOf(requirePrincipal(c))),
        ),
        202,
      ),
    );

    app.openapi(startRoute, async (c) =>
      c.json(
        toActionEntry(
          await enqueueStart(deps, target(c.req.valid("param")), actorEmailOf(requirePrincipal(c))),
        ),
        202,
      ),
    );

    app.openapi(restartRoute, async (c) =>
      c.json(
        toActionEntry(
          await enqueueRestart(deps, target(c.req.valid("param")), actorEmailOf(requirePrincipal(c))),
        ),
        202,
      ),
    );

    app.openapi(destroyRoute, (c) =>
      c.json(
        toActionEntry(
          enqueueDestroy(
            deps,
            target(c.req.valid("param")),
            c.req.valid("json").confirm,
            actorEmailOf(requirePrincipal(c)),
          ),
        ),
        202,
      ),
    );

    app.openapi(renameRoute, async (c) => {
      const to = await renameService(
        deps,
        target(c.req.valid("param")),
        c.req.valid("json"),
        actorEmailOf(requirePrincipal(c)),
      );
      return c.json(await getServiceDetail(deps, to), 200);
    });
  },
};
