import { createRoute } from "@hono/zod-openapi";
import { maintenanceSettings, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { saveServiceSpec } from "../../services/repo";
import { requireService, writeProxyConfig } from "../../services/service";

const PATH = "/api/v1/projects/{project}/services/{service}/maintenance";
const tags = ["Service maintenance"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(maintenanceSettings, "The service's maintenance page."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Applies at once. The Docker service is not touched.",
  request: { params: servicePath, body: jsonBody(maintenanceSettings) },
  responses: {
    200: jsonResponse(maintenanceSettings, "Saved and applied."),
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
        requireService(deps, { projectName: project, serviceName: service }).spec.maintenance,
        200,
      );
    });

    app.openapi(putRoute, async (c) => {
      const { project, service } = c.req.valid("param");
      const target = { projectName: project, serviceName: service };
      const record = requireService(deps, target);
      const maintenance = c.req.valid("json");
      const spec = { ...record.spec, maintenance };
      saveServiceSpec(deps.db, project, service, spec, new Date(deps.now()));
      await writeProxyConfig(deps, target, spec);

      const principal = requirePrincipal(c);
      deps.actions.record({
        type: "service.maintenance",
        title: `${maintenance.enabled ? "Enable" : "Update"} the maintenance page of ${project}/${service}`,
        ...target,
        actorEmail: principal.kind === "session" ? principal.user.email : undefined,
      });
      return c.json(maintenance, 200);
    });
  },
};
