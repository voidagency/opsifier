import { createRoute } from "@hono/zod-openapi";
import { callerIdentity } from "@opsifier/contract";
import type { ApiApp, Feature } from "../../core/context";
import { errorResponse, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { describeCaller, type RouteRef } from "./service";

const route = createRoute({
  method: "get",
  path: "/api/v1/auth/identity",
  tags: ["Authentication"],
  summary: "Who this credential speaks for, and what it may do",
  description:
    "Answers for the credential of the request, judged by the same rules every route applies. It grants nothing: a request is still checked when it is made.",
  responses: {
    200: jsonResponse(callerIdentity, "The caller and what it reaches right now."),
    401: errorResponse("Not signed in, or the key is not valid."),
  },
});

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** Every route of the API, from the same registry the OpenAPI document is built from. */
function apiRoutes(app: ApiApp): RouteRef[] {
  return app.openAPIRegistry.definitions.flatMap((definition) =>
    definition.type === "route" && METHODS.has(definition.route.method)
      ? [
          {
            method: definition.route.method.toUpperCase() as RouteRef["method"],
            path: definition.route.path,
          },
        ]
      : [],
  );
}

export const feature: Feature = {
  register(app, deps) {
    app.openapi(route, (c) => c.json(describeCaller(deps, requestAccess(deps, c), apiRoutes(app)), 200));
  },
};
