import { createRoute } from "@hono/zod-openapi";
import { actionEntry, exposeSettings, servicePath } from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { requireDatabase } from "../../databases/service";
import { enqueueExpose } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/expose";
const tags = ["Service expose"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such database.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(exposeSettings, "The public port. Zero means not exposed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Publishes the database on a host port, or removes it with 0. Restarts the database.",
  request: { params: servicePath, body: jsonBody(exposeSettings) },
  responses: {
    202: jsonResponse(actionEntry, "The Action applying it."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("That port is taken or reserved."),
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) =>
      c.json({ port: requireDatabase(deps, target(c.req.valid("param"))).spec.database.exposedPort }, 200),
    );

    app.openapi(putRoute, async (c) => {
      const principal = requirePrincipal(c);
      return c.json(
        toActionEntry(
          await enqueueExpose(
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
