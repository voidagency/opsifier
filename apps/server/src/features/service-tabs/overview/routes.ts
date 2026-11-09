import { createRoute } from "@hono/zod-openapi";
import { serviceMetrics, serviceNotes, serviceNotesVisibility, servicePath } from "@opsifier/contract";
import type { Feature } from "../../../core/context";
import { conflict, notFound } from "../../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { readComposeMetrics } from "../../compose/feeds";
import { isComposeTarget } from "../../compose/runtime";
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

const notesVisibilityRoute = createRoute({
  method: "put",
  path: `${PATH}/notes/visibility`,
  tags,
  request: { params: servicePath, body: jsonBody(serviceNotesVisibility) },
  responses: {
    200: jsonResponse(serviceNotesVisibility, "Saved."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("There are no notes to hide."),
  },
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
      const reading = isComposeTarget(deps, target)
        ? await readComposeMetrics(deps, target)
        : await readServiceMetrics(deps, target);
      return c.json(reading, 200);
    });

    app.openapi(notesRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const record = requireService(deps, { projectName: project, serviceName: service });
      const { notes } = c.req.valid("json");
      // Clearing the notes leaves nothing to hide, so the next ones start out visible.
      const spec = { ...record.spec, notes, notesHidden: notes !== "" && record.spec.notesHidden };
      saveServiceSpec(deps.db, project, service, spec, new Date(deps.now()));
      return c.json({ notes }, 200);
    });

    app.openapi(notesVisibilityRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const record = requireService(deps, { projectName: project, serviceName: service });
      const { hidden } = c.req.valid("json");
      if (hidden && record.spec.notes === "") {
        throw conflict("notes_empty", "There are no notes to hide.");
      }
      saveServiceSpec(
        deps.db,
        project,
        service,
        { ...record.spec, notesHidden: hidden },
        new Date(deps.now()),
      );
      return c.json({ hidden }, 200);
    });
  },
};
