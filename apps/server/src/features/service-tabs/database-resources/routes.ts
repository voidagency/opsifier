import { createRoute } from "@hono/zod-openapi";
import { actionEntry, deployActionType, resourcesSpec, servicePath } from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { rolloutDatabase } from "../../databases/rollout";
import { requireDatabase } from "../../databases/service";
import { saveServiceSpec } from "../../services/repo";

const PATH = "/api/v1/projects/{project}/services/{service}/database-resources";
const tags = ["Service resources"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such database.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(resourcesSpec, "Limits and reservations."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Saves limits and reservations and applies them at once, which restarts a running database.",
  request: { params: servicePath, body: jsonBody(resourcesSpec) },
  responses: {
    202: jsonResponse(actionEntry, "The Action applying them."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(
        requireDatabase(deps, { projectName: project, serviceName: service }).spec.resources,
        200,
      );
    });

    app.openapi(putRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const target = { projectName: project, serviceName: service };
      const record = requireDatabase(deps, target);
      saveServiceSpec(
        deps.db,
        project,
        service,
        { ...record.spec, resources: c.req.valid("json") },
        new Date(deps.now()),
      );
      const principal = requirePrincipal(c);
      return c.json(
        toActionEntry(
          deps.actions.enqueue({
            type: deployActionType,
            title: `Apply resource limits to ${project}/${service}`,
            projectName: project,
            serviceName: service,
            actorEmail: principal.kind === "session" ? principal.user.email : undefined,
            run: (ctx) => rolloutDatabase(deps, target, ctx),
          }),
        ),
        202,
      );
    });
  },
};
