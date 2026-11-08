import { createRoute } from "@hono/zod-openapi";
import { mountItemPath, mountSpec, servicePath, storageDocument } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { AppDeps, Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import type { ServiceTarget } from "../../services/service";
import { addMount, getStorage, removeMount, updateMount } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/storage";
const tags = ["Service storage"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or mount.");
const taken = errorResponse("Another mount already uses this path.");
const document = jsonResponse(storageDocument, "The service's mounts.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: { 200: document, 400: invalid, 401: denied, 404: missing },
});

const addRoute = createRoute({
  method: "post",
  path: `${PATH}/mounts`,
  tags,
  request: { params: servicePath, body: jsonBody(mountSpec) },
  responses: { 201: document, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const updateRoute = createRoute({
  method: "put",
  path: `${PATH}/mounts/{index}`,
  tags,
  request: { params: mountItemPath, body: jsonBody(mountSpec) },
  responses: { 200: document, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const removeRoute = createRoute({
  method: "delete",
  path: `${PATH}/mounts/{index}`,
  tags,
  request: { params: mountItemPath },
  responses: { 200: document, 400: invalid, 401: denied, 404: missing },
});

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

function recordChange(deps: AppDeps, serviceTarget: ServiceTarget, actorEmail: string | undefined): void {
  deps.actions.record({
    type: "service.mounts",
    title: `Update the mounts of ${serviceTarget.projectName}/${serviceTarget.serviceName}`,
    ...serviceTarget,
    actorEmail,
  });
}

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getStorage(deps, target(c.req.valid("param"))), 200));

    app.openapi(addRoute, (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const storage = addMount(deps, serviceTarget, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json(storage, 201);
    });

    app.openapi(updateRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const storage = updateMount(deps, serviceTarget, params.index, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json(storage, 200);
    });

    app.openapi(removeRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const storage = removeMount(deps, serviceTarget, params.index);
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json(storage, 200);
    });
  },
};
