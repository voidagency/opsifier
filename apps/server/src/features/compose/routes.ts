import { createRoute } from "@hono/zod-openapi";
import {
  acknowledgeComposeRequest,
  composeDetail,
  composeEnvFileSettings,
  composeRuntime,
  createComposeRequest,
  projectPath,
  saveComposeSourceRequest,
  serviceDetail,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess, requireHostAccess } from "../access/guard";
import { installComposeSimulation } from "./fake";
import { createComposeLogsProvider, createComposeMetricsProvider } from "./feeds";
import {
  acknowledgeCompose,
  createCompose,
  getComposeDetail,
  getComposeRuntime,
  saveComposeSource,
  setComposeEnvFile,
} from "./service";

const tags = ["Compose"];
const BASE = "/api/v1/projects/{project}/services/{service}/compose";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project or stack.");
const detail = jsonResponse(composeDetail, "The stack's file, what is wrong with it, and what it defines.");

const createStackRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/compose",
  tags,
  description: "Creates an empty stack. Nothing runs until a Compose file is saved and deployed.",
  request: { params: projectPath, body: jsonBody(createComposeRequest) },
  responses: {
    201: jsonResponse(serviceDetail, "The new stack."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("A service with this name already exists."),
  },
});

const getRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: { 200: detail, 400: invalid, 401: denied, 404: missing },
});

const saveSourceRoute = createRoute({
  method: "put",
  path: `${BASE}/source`,
  tags,
  description: "Saves the Compose file or its Git address. Containers change only at the next deploy.",
  request: { params: servicePath, body: jsonBody(saveComposeSourceRequest) },
  responses: {
    200: detail,
    400: invalid,
    401: denied,
    404: missing,
    503: errorResponse("git is not available on this server."),
  },
});

const acknowledgeRoute = createRoute({
  method: "post",
  path: `${BASE}/acknowledge`,
  tags,
  description: "Confirms that this exact file may reach the host, such as through the Docker socket.",
  request: { params: servicePath, body: jsonBody(acknowledgeComposeRequest) },
  responses: {
    200: detail,
    400: invalid,
    401: denied,
    403: errorResponse("Only an administrator can let a stack reach the server."),
    404: missing,
    409: errorResponse("The file has changed since it was read."),
  },
});

const envFileRoute = createRoute({
  method: "put",
  path: `${BASE}/env-file`,
  tags,
  request: { params: servicePath, body: jsonBody(composeEnvFileSettings) },
  responses: { 200: detail, 400: invalid, 401: denied, 404: missing },
});

const runtimeRoute = createRoute({
  method: "get",
  path: `${BASE}/children`,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(composeRuntime, "What each child of the stack is doing right now."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

/** Compose stacks: a service whose containers are started by the Docker Compose CLI. */
export const feature: Feature = {
  boot(deps) {
    installComposeSimulation(deps);
  },

  register(app, deps) {
    deps.realtime.provide(createComposeLogsProvider(deps));
    deps.realtime.provide(createComposeMetricsProvider(deps));

    app.openapi(createStackRoute, async (c) =>
      c.json(
        await createCompose(
          deps,
          c.req.valid("param").project,
          c.req.valid("json"),
          actorEmailOf(requirePrincipal(c)),
        ),
        201,
      ),
    );

    app.openapi(getRoute, async (c) =>
      c.json(await getComposeDetail(deps, target(c.req.valid("param"))), 200),
    );

    app.openapi(saveSourceRoute, async (c) =>
      c.json(
        await saveComposeSource(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json"),
          actorEmailOf(requirePrincipal(c)),
        ),
        200,
      ),
    );

    app.openapi(acknowledgeRoute, async (c) => {
      requireHostAccess(requestAccess(deps, c));
      return c.json(
        await acknowledgeCompose(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json").content,
          actorEmailOf(requirePrincipal(c)),
        ),
        200,
      );
    });

    app.openapi(envFileRoute, async (c) =>
      c.json(await setComposeEnvFile(deps, target(c.req.valid("param")), c.req.valid("json").enabled), 200),
    );

    app.openapi(runtimeRoute, async (c) =>
      c.json(await getComposeRuntime(deps, target(c.req.valid("param"))), 200),
    );
  },
};
