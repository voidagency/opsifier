import { createRoute } from "@hono/zod-openapi";
import {
  advancedDocument,
  deploySettings,
  portItemPath,
  portList,
  portSpec,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { AppDeps, Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { requestAccess } from "../../access/guard";
import type { ServiceTarget } from "../../services/service";
import { addPort, getAdvanced, removeAllPorts, removePort, saveDeploySettings, updatePort } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/advanced";
const tags = ["Service advanced settings"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or port.");
const clash = errorResponse("The port is already published or reserved.");
const list = jsonResponse(portList, "The service's published ports.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(advancedDocument, "How the service runs and what it publishes."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const saveDeployRoute = createRoute({
  method: "put",
  path: `${PATH}/deploy`,
  tags,
  request: { params: servicePath, body: jsonBody(deploySettings) },
  responses: {
    200: jsonResponse(deploySettings, "Saved. Takes effect at the next deploy."),
    400: invalid,
    401: denied,
    403: errorResponse("Granting a new capability takes an administrator."),
    404: missing,
  },
});

const addPortRoute = createRoute({
  method: "post",
  path: `${PATH}/ports`,
  tags,
  request: { params: servicePath, body: jsonBody(portSpec) },
  responses: { 201: list, 400: invalid, 401: denied, 404: missing, 409: clash },
});

const updatePortRoute = createRoute({
  method: "put",
  path: `${PATH}/ports/{index}`,
  tags,
  request: { params: portItemPath, body: jsonBody(portSpec) },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing, 409: clash },
});

const removePortRoute = createRoute({
  method: "delete",
  path: `${PATH}/ports/{index}`,
  tags,
  request: { params: portItemPath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const removeAllPortsRoute = createRoute({
  method: "delete",
  path: `${PATH}/ports`,
  tags,
  request: { params: servicePath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

function record(
  deps: AppDeps,
  serviceTarget: ServiceTarget,
  kind: "ports" | "deploy-settings",
  principal: ReturnType<typeof requirePrincipal>,
): void {
  const what = kind === "ports" ? "published ports" : "deploy settings";
  deps.actions.record({
    type: `service.${kind}`,
    title: `Update the ${what} of ${serviceTarget.projectName}/${serviceTarget.serviceName}`,
    ...serviceTarget,
    actorEmail: principal.kind === "session" ? principal.user.email : undefined,
  });
}

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getAdvanced(deps, target(c.req.valid("param"))), 200));

    app.openapi(saveDeployRoute, (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const saved = saveDeploySettings(deps, serviceTarget, c.req.valid("json"), requestAccess(deps, c));
      record(deps, serviceTarget, "deploy-settings", requirePrincipal(c));
      return c.json(saved, 200);
    });

    app.openapi(addPortRoute, async (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const ports = await addPort(deps, serviceTarget, c.req.valid("json"));
      record(deps, serviceTarget, "ports", requirePrincipal(c));
      return c.json({ ports }, 201);
    });

    app.openapi(updatePortRoute, async (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const ports = await updatePort(deps, serviceTarget, params.index, c.req.valid("json"));
      record(deps, serviceTarget, "ports", requirePrincipal(c));
      return c.json({ ports }, 200);
    });

    app.openapi(removePortRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const ports = removePort(deps, serviceTarget, params.index);
      record(deps, serviceTarget, "ports", requirePrincipal(c));
      return c.json({ ports }, 200);
    });

    app.openapi(removeAllPortsRoute, (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const ports = removeAllPorts(deps, serviceTarget);
      record(deps, serviceTarget, "ports", requirePrincipal(c));
      return c.json({ ports }, 200);
    });
  },
};
