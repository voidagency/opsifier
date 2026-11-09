import { createRoute } from "@hono/zod-openapi";
import {
  applyBoxPresetRequest,
  boxDetail,
  createBoxRequest,
  projectPath,
  serviceDetail,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { listServiceRecords } from "../services/repo";
import { installBoxSimulation } from "./fake";
import { applyBoxPreset, createBox, getBoxDetail, refreshBoxDockerfiles } from "./service";

const tags = ["Box"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project or box.");
const detail = jsonResponse(boxDetail, "This box's modules, processes, hooks and build history.");

const createBoxRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/box",
  tags,
  description:
    "Creates a box, optionally from a preset. Nothing runs and nothing is built until it is deployed.",
  request: { params: projectPath, body: jsonBody(createBoxRequest) },
  responses: {
    201: jsonResponse(serviceDetail, "The new box."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("A service with this name already exists."),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/box",
  tags,
  request: { params: servicePath },
  responses: { 200: detail, 400: invalid, 401: denied, 404: missing },
});

const presetRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/services/{service}/box/preset",
  tags,
  description:
    "Replaces this box's modules, processes and hooks with a preset's. No file in its workspace is changed or removed: only files that don't exist yet are added. Takes effect at the next deploy.",
  request: { params: servicePath, body: jsonBody(applyBoxPresetRequest) },
  responses: { 200: detail, 400: invalid, 401: denied, 404: missing },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

/** A box is an App whose image is generated from its modules. Its tabs live under `service-tabs/box-*`. */
export const feature: Feature = {
  boot(deps) {
    installBoxSimulation(deps);
    refreshBoxDockerfiles(deps, listServiceRecords(deps.db));
  },

  register(app, deps) {
    app.openapi(createBoxRoute, async (c) =>
      c.json(
        await createBox(
          deps,
          c.req.valid("param").project,
          c.req.valid("json"),
          actorEmailOf(requirePrincipal(c)),
        ),
        201,
      ),
    );

    app.openapi(getRoute, (c) => c.json(getBoxDetail(deps, target(c.req.valid("param"))), 200));

    app.openapi(presetRoute, async (c) =>
      c.json(
        await applyBoxPreset(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json").preset,
          actorEmailOf(requirePrincipal(c)),
        ),
        200,
      ),
    );
  },
};
