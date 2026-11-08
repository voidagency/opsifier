import { createRoute } from "@hono/zod-openapi";
import { actionEntry, databaseAdvancedSettings, servicePath } from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
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
  description: "Saves and applies at once, which restarts a running database.",
  request: { params: servicePath, body: jsonBody(databaseAdvancedSettings) },
  responses: {
    202: jsonResponse(actionEntry, "The Action applying them."),
    400: invalid,
    401: denied,
    404: missing,
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
        toActionEntry(
          saveAdvanced(
            deps,
            target(c.req.valid("param")),
            c.req.valid("json"),
            principal.kind === "session" ? principal.user.email : undefined,
          ),
        ),
        202,
      );
    });
  },
};
