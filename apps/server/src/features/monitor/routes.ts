import { createRoute } from "@hono/zod-openapi";
import {
  METRIC_UNITS,
  type MetricsHistory,
  type MetricsHistoryQuery,
  metricsHistory,
  metricsHistoryQuery,
  monitoringOverview,
  monitoringSettings,
  servicePath,
  servicesTrends,
  storageReport,
  systemMetrics,
} from "@opsifier/contract";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { notFound } from "../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { metricOriginOf } from "../service-runtime/metrics";
import { serviceExists } from "../service-runtime/repo";
import { engineFor } from "./engine";
import { createEventsProvider } from "./events";
import { logStoreFor, logStoreStats } from "./logstore";
import { readMonitoringSettings, saveMonitoringSettings } from "./settings";
import { metricsStoreStats, queryHistory, queryTrends, TREND_STEP_SECONDS } from "./store";

const tags = ["Monitor"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const missing = errorResponse("No such service.");

const systemRoute = createRoute({
  method: "get",
  path: "/api/v1/monitor/system",
  tags,
  summary: "Current readings of the server",
  responses: { 200: jsonResponse(systemMetrics, "The latest readings."), 401: denied, 403: refused },
});

const systemHistoryRoute = createRoute({
  method: "get",
  path: "/api/v1/monitor/system/history",
  tags,
  summary: "Stored readings of the server",
  request: { query: metricsHistoryQuery },
  responses: {
    200: jsonResponse(metricsHistory, "One point per bucket; a bucket with no data is null, not zero."),
    400: invalid,
    401: denied,
    403: refused,
  },
});

const serviceHistoryRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{project}/services/{service}/metrics/history",
  tags: ["Service overview"],
  summary: "Stored readings of one service",
  request: { params: servicePath, query: metricsHistoryQuery },
  responses: {
    200: jsonResponse(metricsHistory, "One point per bucket; a bucket with no data is null, not zero."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const trendsRoute = createRoute({
  method: "get",
  path: "/api/v1/monitor/services/trends",
  tags,
  summary: "The last hour of CPU for every service",
  responses: {
    200: jsonResponse(servicesTrends, "One series per service."),
    401: denied,
    403: refused,
  },
});

const storageRoute = createRoute({
  method: "get",
  path: "/api/v1/monitor/storage",
  tags,
  summary: "What each service and Docker use on disk",
  responses: { 200: jsonResponse(storageReport, "The latest scan."), 401: denied, 403: refused },
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/settings/monitoring",
  tags,
  summary: "How long metrics and logs are kept",
  responses: {
    200: jsonResponse(monitoringOverview, "The settings and what the stores hold."),
    401: denied,
    403: refused,
  },
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/v1/settings/monitoring",
  tags,
  summary: "Change how long metrics and logs are kept",
  request: { body: jsonBody(monitoringSettings) },
  responses: {
    200: jsonResponse(monitoringOverview, "The settings and what the stores hold."),
    400: invalid,
    401: denied,
    403: refused,
  },
});

export const feature: Feature = {
  boot(deps) {
    if (deps.config.environment !== "test") {
      engineFor(deps).start();
      logStoreFor(deps).start();
    }
  },

  shutdown(deps) {
    engineFor(deps).stop();
    logStoreFor(deps).stop();
  },

  register(app, deps) {
    deps.realtime.provide(createEventsProvider(deps));

    const overview = () => {
      const settings = readMonitoringSettings(deps);
      return { ...settings, store: metricsStoreStats(deps.db), logStore: logStoreStats(deps.db) };
    };

    /** Every point of a history, with what it measures: stored rows carry only the figures. */
    const historyOf = (scope: string, { range, step }: MetricsHistoryQuery): MetricsHistory => {
      const { metrics } = readMonitoringSettings(deps);
      const retention = { retention: metrics.retention, unit: metrics.retentionUnit };
      return {
        ...queryHistory(deps.db, scope, range, step, retention, deps.now()),
        origin: scope === "system" ? "host" : metricOriginOf(deps),
        scope: scope === "system" ? "host" : "service",
        units: METRIC_UNITS,
      };
    };

    app.openapi(systemRoute, async (c) => c.json(await engineFor(deps).current(), 200));

    app.openapi(systemHistoryRoute, (c) => c.json(historyOf("system", c.req.valid("query")), 200));

    app.openapi(serviceHistoryRoute, (c) => {
      const { project, service } = c.req.valid("param");
      if (!serviceExists(deps.db, { projectName: project, serviceName: service })) {
        throw notFound("This service does not exist.");
      }
      return c.json(historyOf(`${project}/${service}`, c.req.valid("query")), 200);
    });

    app.openapi(trendsRoute, (c) => {
      const { from, trends } = queryTrends(deps.db, deps.now());
      return c.json(
        {
          trends,
          from: new Date(from).toISOString(),
          stepSeconds: TREND_STEP_SECONDS,
          unit: METRIC_UNITS.cpu,
          origin: metricOriginOf(deps),
          scope: "service" as const,
        },
        200,
      );
    });

    app.openapi(storageRoute, async (c) => c.json(await engineFor(deps).storage.report(), 200));

    app.openapi(getSettingsRoute, (c) => c.json(overview(), 200));

    app.openapi(putSettingsRoute, (c) => {
      saveMonitoringSettings(deps, c.req.valid("json"));
      // A lowered limit counts from now, rather than whenever the store is next looked at.
      logStoreFor(deps).prune();
      const principal = requirePrincipal(c);
      deps.actions.record({
        type: "server.monitoring",
        title: "Change the monitoring settings",
        actorEmail: principal.kind === "session" ? principal.user.email : undefined,
      });
      return c.json(overview(), 200);
    });
  },
};
