import { createRoute } from "@hono/zod-openapi";
import { consoleInfo, logSearchQuery, logSearchResult, servicePath } from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { forbidden, notFound } from "../../core/errors";
import { errorResponse, jsonResponse } from "../../core/openapi";
import { isComposeTarget, searchComposeLogs } from "../compose/runtime";
import { createTerminalRoute, endAbandonedConsoles, getConsoleInfo } from "./console";
import { createLogsProvider, searchServiceLogs } from "./logs";
import { createMetricsProvider } from "./metrics";
import { type ServiceRef, serviceExists } from "./repo";

/** A daemon that answers a ping and then stalls can't be allowed to keep the panel from starting. */
const SWEEP_DEADLINE_MS = 10_000;

const PATH = "/api/v1/projects/{project}/services/{service}";
const tags = ["Service runtime"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const missing = errorResponse("No such service.");

const consoleRoute = createRoute({
  method: "get",
  path: `${PATH}/console`,
  tags,
  description: "What the console can open. The terminal itself is a WebSocket at /api/v1/terminal/.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(consoleInfo, "Running tasks, programs and scripts."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const searchRoute = createRoute({
  method: "get",
  path: `${PATH}/logs/search`,
  tags,
  description: "Searches the logs Docker still holds for this service. Live logs use the realtime hub.",
  request: { params: servicePath, query: logSearchQuery },
  responses: {
    200: jsonResponse(logSearchResult, "The newest matching lines, oldest first."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const target = (params: { project: string; service: string }): ServiceRef => ({
  projectName: params.project,
  serviceName: params.service,
});

/** Logs, console and metrics. They work for any type of service, keyed on project and service. */
export const feature: Feature = {
  async boot(deps) {
    // Before anything is served, so that a session opened now can't be taken for a left-over one.
    await Promise.race([
      endAbandonedConsoles(deps),
      new Promise((resolve) => setTimeout(resolve, SWEEP_DEADLINE_MS).unref()),
    ]);
  },

  register(app, deps) {
    deps.realtime.route(createTerminalRoute(deps));
    deps.realtime.provide(createLogsProvider(deps));
    deps.realtime.provide(createMetricsProvider(deps));

    app.openapi(consoleRoute, async (c) => {
      if (requirePrincipal(c).user.role !== "admin") {
        throw forbidden("admin_required", "Only an administrator can open a console.");
      }
      const service = target(c.req.valid("param"));
      if (!serviceExists(deps.db, service)) {
        throw notFound("This service does not exist.");
      }
      return c.json(await getConsoleInfo(deps, service), 200);
    });

    app.openapi(searchRoute, async (c) => {
      const service = target(c.req.valid("param"));
      if (!serviceExists(deps.db, service)) {
        throw notFound("This service does not exist.");
      }
      if (isComposeTarget(deps, service)) {
        return c.json(await searchComposeLogs(deps, service, c.req.valid("query"), c.req.raw.signal), 200);
      }
      return c.json(await searchServiceLogs(deps, service, c.req.valid("query"), c.req.raw.signal), 200);
    });
  },
};
