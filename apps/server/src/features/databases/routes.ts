import { createRoute } from "@hono/zod-openapi";
import {
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
import { createDatabase, requireDatabase, databaseDetail as toDetail } from "./service";

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

    app.openapi(getDatabaseRoute, (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(toDetail(requireDatabase(deps, { projectName: project, serviceName: service })), 200);
    });
  },
};
