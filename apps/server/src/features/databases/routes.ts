import { createRoute } from "@hono/zod-openapi";
import {
  databaseAvailability as availabilitySchema,
  createDatabaseRequest,
  databaseDetail,
  projectPath,
  serviceDetail,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { recoverInterruptedRotations } from "./rotation";
import { createDatabase, databaseAvailability, requireDatabase, databaseDetail as toDetail } from "./service";

const tags = ["Databases"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project or service.");

const createDatabaseRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{project}/databases",
  tags,
  description: "Creates a database service and starts deploying it at once.",
  request: { params: projectPath, body: jsonBody(createDatabaseRequest) },
  responses: {
    201: jsonResponse(serviceDetail, "The service. Its deploy is under way as `activeAction`."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("A service with this name already exists."),
  },
});

const getDatabaseRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/database",
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(databaseDetail, "What is specific to this database."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const availabilityRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/database/availability",
  tags,
  description:
    "Whether a task is running and, separately, whether the engine accepts the panel's credentials right now.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(availabilitySchema, "What the process and the engine answered."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

export const feature: Feature = {
  boot(deps) {
    recoverInterruptedRotations(deps);
  },

  register(app, deps) {
    app.openapi(createDatabaseRoute, async (c) => {
      const principal = requirePrincipal(c);
      return c.json(
        await createDatabase(
          deps,
          c.req.valid("param").project,
          c.req.valid("json"),
          principal.kind === "session" ? principal.user.email : undefined,
        ),
        201,
      );
    });

    app.openapi(availabilityRoute, async (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(
        await databaseAvailability(deps, { projectName: project, serviceName: service }, c.req.raw.signal),
        200,
      );
    });

    app.openapi(getDatabaseRoute, (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(toDetail(requireDatabase(deps, { projectName: project, serviceName: service })), 200);
    });
  },
};
