import { createRoute } from "@hono/zod-openapi";
import { databaseAdvancedSettings, saveDatabaseAdvancedRequest, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { getAdvanced, saveAdvanced } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/database-advanced";
const tags = ["Service advanced"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such database.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(databaseAdvancedSettings, "Image, command, environment and config file."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description:
    "Saves the settings, which reach the database at its next deployment. A move to another major version must name the service in `confirm`.",
  request: { params: servicePath, body: jsonBody(saveDatabaseAdvancedRequest) },
  responses: {
    200: jsonResponse(databaseAdvancedSettings, "Saved."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The new image needs a confirmation, or the database is not in a state to take it."),
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getAdvanced(deps, target(c.req.valid("param"))), 200));

    app.openapi(putRoute, (c) => {
      const principal = requirePrincipal(c);
      return c.json(
        saveAdvanced(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json"),
          principal.kind === "session" ? principal.user.email : undefined,
        ),
        200,
      );
    });
  },
};
