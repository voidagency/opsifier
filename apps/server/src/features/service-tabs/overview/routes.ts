import { createRoute } from "@hono/zod-openapi";
import { serviceMetrics, serviceNotes, servicePath } from "@opsifier/contract";
import type { Feature } from "../../../core/context";
import { notFound } from "../../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { readServiceMetrics } from "../../service-runtime/metrics";
import { serviceExists } from "../../service-runtime/repo";
import { saveServiceSpec } from "../../services/repo";
import { requireService } from "../../services/service";

const PATH = "/api/v1/projects/{project}/services/{service}";
const tags = ["Service overview"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service.");

const metricsRoute = createRoute({
  method: "get",
  path: `${PATH}/metrics`,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(serviceMetrics, "Latest readings, summed across running tasks."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const notesRoute = createRoute({
  method: "put",
  path: `${PATH}/notes`,
  tags,
  request: { params: servicePath, body: jsonBody(serviceNotes) },
  responses: { 200: jsonResponse(serviceNotes, "Saved."), 400: invalid, 401: denied, 404: missing },
});

export const feature: Feature = {
  register(app, deps) {
    // For any type of service: the readings only need it to exist, not to be an App.
    app.openapi(metricsRoute, async (c) => {
      const { project, service } = c.req.valid("param");
      const target = { projectName: project, serviceName: service };
      if (!serviceExists(deps.db, target)) {
        throw notFound("This service does not exist.");
      }
      return c.json(await readServiceMetrics(deps, target), 200);
    });

    app.openapi(notesRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const record = requireService(deps, { projectName: project, serviceName: service });
      const { notes } = c.req.valid("json");
      saveServiceSpec(deps.db, project, service, { ...record.spec, notes }, new Date(deps.now()));
      return c.json({ notes }, 200);
    });
  },
};
