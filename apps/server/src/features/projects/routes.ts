import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  createProjectRequest,
  destroyRequest,
  envDocument,
  projectList,
  projectPath,
  projectSchemaDocument,
  projectSummary,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  createProject,
  enqueueProjectDestroy,
  exportProjectSchema,
  getProjectEnv,
  getProjectSummary,
  listProjectSummaries,
  saveProjectEnv,
} from "./service";

const tags = ["Projects"];
const PATH = "/api/v1/projects/{project}";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project.");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/projects",
  tags,
  responses: { 200: jsonResponse(projectList, "Every project and its services."), 401: denied },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/api/v1/projects",
  tags,
  request: { body: jsonBody(createProjectRequest) },
  responses: {
    201: jsonResponse(projectSummary, "The new project."),
    400: invalid,
    401: denied,
    409: errorResponse("A project with this name already exists."),
    502: errorResponse("Docker refused to create the network."),
  },
});

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: projectPath },
  responses: { 200: jsonResponse(projectSummary, "The project."), 400: invalid, 401: denied, 404: missing },
});

const getEnvRoute = createRoute({
  method: "get",
  path: `${PATH}/env`,
  tags,
  request: { params: projectPath },
  responses: {
    200: jsonResponse(envDocument, "The project's variables."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putEnvRoute = createRoute({
  method: "put",
  path: `${PATH}/env`,
  tags,
  request: { params: projectPath, body: jsonBody(envDocument) },
  responses: {
    200: jsonResponse(envDocument, "Saved. Running services keep the old values until redeployed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const schemaRoute = createRoute({
  method: "get",
  path: `${PATH}/schema`,
  tags,
  request: { params: projectPath },
  responses: {
    200: jsonResponse(projectSchemaDocument, "The project as a portable document."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const destroyRoute = createRoute({
  method: "delete",
  path: PATH,
  tags,
  request: { params: projectPath, body: jsonBody(destroyRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The name does not match, or work is still running."),
  },
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(listRoute, async (c) => c.json(await listProjectSummaries(deps), 200));

    app.openapi(createProjectRoute, async (c) =>
      c.json(await createProject(deps, c.req.valid("json"), actorEmailOf(requirePrincipal(c))), 201),
    );

    app.openapi(getRoute, async (c) =>
      c.json(await getProjectSummary(deps, c.req.valid("param").project), 200),
    );

    app.openapi(getEnvRoute, (c) => c.json(getProjectEnv(deps, c.req.valid("param").project), 200));

    app.openapi(putEnvRoute, (c) =>
      c.json(
        saveProjectEnv(
          deps,
          c.req.valid("param").project,
          c.req.valid("json").env,
          actorEmailOf(requirePrincipal(c)),
        ),
        200,
      ),
    );

    app.openapi(schemaRoute, (c) => c.json(exportProjectSchema(deps, c.req.valid("param").project), 200));

    app.openapi(destroyRoute, (c) =>
      c.json(
        toActionEntry(
          enqueueProjectDestroy(
            deps,
            c.req.valid("param").project,
            c.req.valid("json").confirm,
            actorEmailOf(requirePrincipal(c)),
          ),
        ),
        202,
      ),
    );
  },
};
