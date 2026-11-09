import { createRoute } from "@hono/zod-openapi";
import { exposeSettings, exposeState, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { publishedPort, requireDatabase } from "../../databases/service";
import { saveExpose } from "./service";

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
    200: jsonResponse(exposeState, "The saved public port, zero if none, and what is published right now."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Saves a host port for the database, or none with 0. It is published at the next deployment.",
  request: { params: servicePath, body: jsonBody(exposeSettings) },
  responses: {
    200: jsonResponse(exposeSettings, "Saved."),
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
    app.openapi(getRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { exposedPort: port } = requireDatabase(deps, service).spec.database;
      return c.json({ port, publishedPort: await publishedPort(deps, service) }, 200);
    });

    app.openapi(putRoute, async (c) => {
      const principal = requirePrincipal(c);
      return c.json(
        await saveExpose(
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
