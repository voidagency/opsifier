import { createRoute } from "@hono/zod-openapi";
import { scriptItemPath, scriptList, scriptSpec, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { AppDeps, Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import type { ServiceTarget } from "../../services/service";
import { addScript, listScripts, removeScript, updateScript } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/scripts";
const tags = ["Service scripts"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or script.");
const taken = errorResponse("A script with this name already exists.");
const list = jsonResponse(scriptList, "The service's scripts.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const addRoute = createRoute({
  method: "post",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(scriptSpec) },
  responses: { 201: list, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const updateRoute = createRoute({
  method: "put",
  path: `${PATH}/{index}`,
  tags,
  request: { params: scriptItemPath, body: jsonBody(scriptSpec) },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const removeRoute = createRoute({
  method: "delete",
  path: `${PATH}/{index}`,
  tags,
  request: { params: scriptItemPath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

function recordChange(deps: AppDeps, serviceTarget: ServiceTarget, actorEmail: string | undefined): void {
  deps.actions.record({
    type: "service.scripts",
    title: `Update the scripts of ${serviceTarget.projectName}/${serviceTarget.serviceName}`,
    ...serviceTarget,
    actorEmail,
  });
}

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => c.json({ scripts: listScripts(deps, target(c.req.valid("param"))) }, 200));

    app.openapi(addRoute, (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const scripts = addScript(deps, serviceTarget, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 201);
    });

    app.openapi(updateRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const scripts = updateScript(deps, serviceTarget, params.index, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 200);
    });

    app.openapi(removeRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const scripts = removeScript(deps, serviceTarget, params.index);
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 200);
    });
  },
};
