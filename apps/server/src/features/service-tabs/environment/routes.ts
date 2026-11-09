import { createRoute } from "@hono/zod-openapi";
import {
  buildEnvironment,
  buildSecretPath,
  buildVariablesDocument,
  saveBuildSecretRequest,
  saveServiceEnvironment,
  serviceEnvironment,
  serviceEnvironmentText,
  servicePath,
} from "@opsifier/contract";
import type { Context } from "hono";
import { requirePrincipal } from "../../../core/auth";
import type { AppEnv, Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import {
  deleteBuildSecret,
  getBuildEnvironment,
  getEnvironment,
  revealBuildVariables,
  revealEnvironment,
  saveBuildSecret,
  saveBuildVariables,
  saveEnvironment,
  stopInheritingRuntime,
} from "./service";
import { keepExistingInterpolation } from "./upgrade";

const PATH = "/api/v1/projects/{project}/services/{service}/environment";
const BUILD = `${PATH}/build`;
const tags = ["Service environment"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service.");
const refused = errorResponse("Too many build secrets.");
const standard = { 400: invalid, 401: denied, 404: missing };

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  description: "The names of the service's variables. The values take a reveal.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(serviceEnvironment, "What the variables are called."), ...standard },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(saveServiceEnvironment) },
  responses: {
    200: jsonResponse(serviceEnvironment, "Saved. Takes effect at the next deploy."),
    ...standard,
  },
});

const revealRoute = createRoute({
  method: "post",
  path: `${PATH}/reveal`,
  tags,
  description: "Returns the values and records who asked for them in the activity log.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(serviceEnvironmentText, "The variables as text."), ...standard },
});

const getBuildRoute = createRoute({
  method: "get",
  path: BUILD,
  tags,
  description: "What the next build is given, by name. Runtime variables are not on this list.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(buildEnvironment, "Build variables and secrets, by name."), ...standard },
});

const putBuildRoute = createRoute({
  method: "put",
  path: BUILD,
  tags,
  description: "Build arguments. They can end up in the image: secrets belong in a build secret.",
  request: { params: servicePath, body: jsonBody(buildVariablesDocument) },
  responses: { 200: jsonResponse(buildEnvironment, "Saved. Used by the next build."), ...standard },
});

const revealBuildRoute = createRoute({
  method: "post",
  path: `${BUILD}/reveal`,
  tags,
  description: "Returns the build variables and records who asked for them in the activity log.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(buildVariablesDocument, "The build variables as text."), ...standard },
});

const stopInheritingRoute = createRoute({
  method: "delete",
  path: `${BUILD}/inherited`,
  tags,
  description:
    "Stops passing runtime variables to this service's builds, as it has done since before build variables existed.",
  request: { params: servicePath },
  responses: { 200: jsonResponse(buildEnvironment, "Stopped. There is no way back."), ...standard },
});

const putSecretRoute = createRoute({
  method: "put",
  path: `${BUILD}/secrets/{name}`,
  tags,
  description: "Sets a build secret. It can be replaced or removed, and never read back.",
  request: { params: buildSecretPath, body: jsonBody(saveBuildSecretRequest) },
  responses: { 200: jsonResponse(buildEnvironment, "Saved."), ...standard, 409: refused },
});

const deleteSecretRoute = createRoute({
  method: "delete",
  path: `${BUILD}/secrets/{name}`,
  tags,
  request: { params: buildSecretPath },
  responses: { 200: jsonResponse(buildEnvironment, "Removed."), ...standard },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** The person behind the request, including whoever owns an API key. */
const actor = (c: Context<AppEnv>) => requirePrincipal(c).user.email;

export const feature: Feature = {
  boot: keepExistingInterpolation,

  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getEnvironment(deps, target(c.req.valid("param"))), 200));

    app.openapi(putRoute, (c) =>
      c.json(saveEnvironment(deps, target(c.req.valid("param")), c.req.valid("json"), actor(c)), 200),
    );

    app.openapi(revealRoute, (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(revealEnvironment(deps, target(c.req.valid("param")), actor(c)), 200);
    });

    app.openapi(getBuildRoute, (c) => c.json(getBuildEnvironment(deps, target(c.req.valid("param"))), 200));

    app.openapi(putBuildRoute, (c) =>
      c.json(saveBuildVariables(deps, target(c.req.valid("param")), c.req.valid("json").env, actor(c)), 200),
    );

    app.openapi(revealBuildRoute, (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(revealBuildVariables(deps, target(c.req.valid("param")), actor(c)), 200);
    });

    app.openapi(stopInheritingRoute, (c) =>
      c.json(stopInheritingRuntime(deps, target(c.req.valid("param")), actor(c)), 200),
    );

    app.openapi(putSecretRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        saveBuildSecret(deps, target(params), params.name, c.req.valid("json").value, actor(c)),
        200,
      );
    });

    app.openapi(deleteSecretRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(deleteBuildSecret(deps, target(params), params.name, actor(c)), 200);
    });
  },
};
