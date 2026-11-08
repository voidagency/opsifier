import { createRoute } from "@hono/zod-openapi";
import { serviceEnvironment, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { saveServiceSpec } from "../../services/repo";
import { requireService } from "../../services/service";

const PATH = "/api/v1/projects/{project}/services/{service}/environment";
const tags = ["Service environment"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(serviceEnvironment, "The service's variables."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(serviceEnvironment) },
  responses: {
    200: jsonResponse(serviceEnvironment, "Saved. Takes effect at the next deploy."),
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
        { env: requireService(deps, { projectName: project, serviceName: service }).spec.env },
        200,
      );
    });

    app.openapi(putRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const target = { projectName: project, serviceName: service };
      const record = requireService(deps, target);
      const { env } = c.req.valid("json");
      saveServiceSpec(deps.db, project, service, { ...record.spec, env }, new Date(deps.now()));

      const principal = requirePrincipal(c);
      deps.actions.record({
        type: "service.env",
        title: `Update the environment of ${project}/${service}`,
        ...target,
        actorEmail: principal.kind === "session" ? principal.user.email : undefined,
      });
      return c.json({ env }, 200);
    });
  },
};
