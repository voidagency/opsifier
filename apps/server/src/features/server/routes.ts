import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  cleanupPreview,
  confirmedRequest,
  diskUsageListing,
  diskUsageQuery,
  dockerCleanupPath,
  dockerEngine,
  dockerUpdateCheck,
  letsEncryptEmail,
  panelDomainSettings,
  proxyCustomConfig,
  proxyDashboard,
  proxyDashboardStatus,
  proxyEnvironment,
  proxyEnvironmentSummary,
  runCleanupRequest,
  saveDailyCleanupRequest,
  savePanelDomainRequest,
  saveReleasesKeptRequest,
  saveServiceDomainRequest,
  serverConfirmWords,
  serverOverview,
  serviceDomainSettings,
  swarmNodeList,
  trustedProxiesSettings,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { conflict } from "../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { releasesKept, saveReleasesKept } from "../releases/service";
import { ensureServerIp } from "../system/service";
import { checkDockerUpdate, enqueueCleanup, previewCleanup, readDockerEngine } from "./docker-admin";
import {
  concludeReboots,
  concludeRestarts,
  createHostConsoleRoute,
  enqueuePanelRestart,
  finishInterruptedReboots,
  getServerOverview,
  readDiskUsage,
  rebootHost,
  refreshServerIp,
} from "./host";
import { listSwarmNodes } from "./nodes";
import {
  closeProxyDashboard,
  enqueueProxyRestart,
  getCustomConfig,
  getDashboardStatus,
  getProxyEnvironment,
  getTrustedProxies,
  openProxyDashboard,
  revealProxyEnvironment,
  saveCustomConfig,
  saveProxyEnvironment,
  saveTrustedProxies,
} from "./proxy";
import { createDailyCleanupRunner, createPanelLogsProvider } from "./runtime";
import {
  getDailyCleanup,
  getLetsEncryptEmail,
  getPanelDomainSettings,
  getServiceDomainSettings,
  saveDailyCleanup,
  saveLetsEncryptEmail,
  savePanelDomain,
  saveServiceDomain,
  writePanelRoutes,
} from "./settings";

const tags = ["Server"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const clash = errorResponse("The request conflicts with the current state.");
const accepted = jsonResponse(actionEntry, "The Action doing the work.");
const PREFIX = "/api/v1/server";

const route = <const R extends Parameters<typeof createRoute>[0]>(definition: R) =>
  createRoute({ tags, ...definition });

const emptyResponses = { 400: invalid, 401: denied, 403: refused } as const;

const overviewRoute = route({
  method: "get",
  path: `${PREFIX}/overview`,
  summary: "The server's uptime and the state of its parts",
  responses: { 200: jsonResponse(serverOverview, "The server."), 401: denied, 403: refused },
});

const nodesRoute = route({
  method: "get",
  path: `${PREFIX}/nodes`,
  summary: "List the swarm's nodes",
  description:
    "Every server of the Docker Swarm the panel runs, with its role, its state, its resources and how many service containers run on it. Read only for now.",
  responses: {
    200: jsonResponse(swarmNodeList, "Managers first, the leader at the top."),
    401: denied,
    403: refused,
  },
});

const releasesKeptRoute = route({
  method: "put",
  path: `${PREFIX}/releases-kept`,
  summary: "Set how many versions of each service are kept for going back to",
  request: { body: jsonBody(saveReleasesKeptRequest) },
  responses: { 200: jsonResponse(saveReleasesKeptRequest, "Saved."), ...emptyResponses },
});

const dailyCleanupRoute = route({
  method: "put",
  path: `${PREFIX}/daily-cleanup`,
  summary: "Turn the daily Docker cleanup on or off",
  request: { body: jsonBody(saveDailyCleanupRequest) },
  responses: { 200: jsonResponse(saveDailyCleanupRequest, "Saved."), ...emptyResponses },
});

const getPanelDomainRoute = route({
  method: "get",
  path: `${PREFIX}/panel-domain`,
  summary: "The panel's domains",
  responses: { 200: jsonResponse(panelDomainSettings, "The domains."), 401: denied, 403: refused },
});

const putPanelDomainRoute = route({
  method: "put",
  path: `${PREFIX}/panel-domain`,
  summary: "Change the panel's domain",
  description: "The server itself can always reach the panel on localhost, whatever this says.",
  request: { body: jsonBody(savePanelDomainRequest) },
  responses: { 200: jsonResponse(panelDomainSettings, "The domains."), ...emptyResponses },
});

const getServiceDomainRoute = route({
  method: "get",
  path: `${PREFIX}/service-domain`,
  summary: "The base domain for new services",
  responses: { 200: jsonResponse(serviceDomainSettings, "The base domain."), 401: denied, 403: refused },
});

const putServiceDomainRoute = route({
  method: "put",
  path: `${PREFIX}/service-domain`,
  summary: "Change the base domain for new services",
  request: { body: jsonBody(saveServiceDomainRequest) },
  responses: { 200: jsonResponse(serviceDomainSettings, "The base domain."), ...emptyResponses },
});

const getEmailRoute = route({
  method: "get",
  path: `${PREFIX}/letsencrypt-email`,
  summary: "The contact email for certificates",
  responses: { 200: jsonResponse(z.object({ email: z.string() }), "The email."), 401: denied, 403: refused },
});

const putEmailRoute = route({
  method: "put",
  path: `${PREFIX}/letsencrypt-email`,
  summary: "Change the contact email for certificates",
  description: "Applied the next time the proxy restarts.",
  request: { body: jsonBody(letsEncryptEmail) },
  responses: { 200: jsonResponse(letsEncryptEmail, "Saved."), ...emptyResponses },
});

const restartPanelRoute = route({
  method: "post",
  path: `${PREFIX}/panel/restart`,
  summary: "Restart the panel",
  request: { body: jsonBody(confirmedRequest) },
  responses: { 202: accepted, ...emptyResponses, 409: clash },
});

const refreshIpRoute = route({
  method: "post",
  path: `${PREFIX}/panel/refresh-ip`,
  summary: "Look up the server's address again",
  description: "Generated hostnames follow the new address. Custom ones are not touched.",
  responses: {
    200: jsonResponse(actionEntry, "The entry recording the result."),
    401: denied,
    403: refused,
    409: clash,
  },
});

const rebootRoute = route({
  method: "post",
  path: `${PREFIX}/reboot`,
  summary: "Reboot the server",
  request: { body: jsonBody(confirmedRequest) },
  responses: {
    200: jsonResponse(actionEntry, "The entry recording the reboot."),
    ...emptyResponses,
    409: clash,
  },
});

const diskRoute = route({
  method: "get",
  path: `${PREFIX}/disk`,
  summary: "Sizes of a folder's contents",
  request: { query: diskUsageQuery },
  responses: { 200: jsonResponse(diskUsageListing, "The folder."), ...emptyResponses, 409: clash },
});

const dockerRoute = route({
  method: "get",
  path: `${PREFIX}/docker`,
  summary: "The Docker engine's version and state",
  responses: { 200: jsonResponse(dockerEngine, "The engine."), 401: denied, 403: refused },
});

const dockerUpdateRoute = route({
  method: "get",
  path: `${PREFIX}/docker/update`,
  summary: "Whether a newer Docker engine exists",
  responses: { 200: jsonResponse(dockerUpdateCheck, "The result of the check."), 401: denied, 403: refused },
});

const previewCleanupRoute = route({
  method: "get",
  path: `${PREFIX}/docker/cleanup/{kind}`,
  summary: "What a cleanup would remove",
  request: { params: dockerCleanupPath },
  responses: { 200: jsonResponse(cleanupPreview, "Exactly what is eligible."), ...emptyResponses },
});

const runCleanupRoute = route({
  method: "post",
  path: `${PREFIX}/docker/cleanup/{kind}`,
  summary: "Run a cleanup",
  description: "Removes only the selected items that are still eligible when it runs. Never a volume.",
  request: { params: dockerCleanupPath, body: jsonBody(runCleanupRequest) },
  responses: { 202: accepted, ...emptyResponses, 409: clash },
});

const getTrustedRoute = route({
  method: "get",
  path: `${PREFIX}/proxy/trusted-proxies`,
  summary: "Who the proxy believes forwarded headers from",
  responses: { 200: jsonResponse(trustedProxiesSettings, "The settings."), 401: denied, 403: refused },
});

const putTrustedRoute = route({
  method: "put",
  path: `${PREFIX}/proxy/trusted-proxies`,
  summary: "Change the proxy's trusted addresses, and restart it",
  request: { body: jsonBody(trustedProxiesSettings) },
  responses: { 202: accepted, ...emptyResponses, 409: clash },
});

const getCustomRoute = route({
  method: "get",
  path: `${PREFIX}/proxy/custom-config`,
  summary: "The proxy's custom configuration",
  responses: { 200: jsonResponse(proxyCustomConfig, "The YAML."), 401: denied, 403: refused },
});

const putCustomRoute = route({
  method: "put",
  path: `${PREFIX}/proxy/custom-config`,
  summary: "Change the proxy's custom configuration",
  description:
    "Applies at once through the file provider. Invalid YAML is refused and never reaches the proxy.",
  request: { body: jsonBody(proxyCustomConfig) },
  responses: { 200: jsonResponse(proxyCustomConfig, "Saved."), ...emptyResponses },
});

const getEnvRoute = route({
  method: "get",
  path: `${PREFIX}/proxy/environment`,
  summary: "The names of the proxy's environment variables",
  responses: { 200: jsonResponse(proxyEnvironmentSummary, "Names only."), 401: denied, 403: refused },
});

const putEnvRoute = route({
  method: "put",
  path: `${PREFIX}/proxy/environment`,
  summary: "Change the proxy's environment",
  description: "Applied the next time the proxy restarts.",
  request: { body: jsonBody(proxyEnvironment) },
  responses: { 200: jsonResponse(proxyEnvironmentSummary, "Saved."), ...emptyResponses },
});

const revealEnvRoute = route({
  method: "post",
  path: `${PREFIX}/proxy/environment/reveal`,
  summary: "Read the proxy's environment, values included",
  responses: { 200: jsonResponse(proxyEnvironment, "The text."), 401: denied, 403: refused },
});

const restartProxyRoute = route({
  method: "post",
  path: `${PREFIX}/proxy/restart`,
  summary: "Rewrite the proxy's configuration and restart it",
  request: { body: jsonBody(confirmedRequest) },
  responses: { 202: accepted, ...emptyResponses, 409: clash },
});

const dashboardStatusRoute = route({
  method: "get",
  path: `${PREFIX}/proxy/dashboard`,
  summary: "Whether the proxy dashboard is open",
  responses: { 200: jsonResponse(proxyDashboardStatus, "Its state."), 401: denied, 403: refused },
});

const openDashboardRoute = route({
  method: "post",
  path: `${PREFIX}/proxy/dashboard`,
  summary: "Open the proxy dashboard",
  responses: {
    200: jsonResponse(proxyDashboard, "Where it is, and its password, shown this once."),
    401: denied,
    403: refused,
    409: clash,
  },
});

const closeDashboardRoute = route({
  method: "delete",
  path: `${PREFIX}/proxy/dashboard`,
  summary: "Close the proxy dashboard",
  responses: { 200: jsonResponse(z.object({ ok: z.literal(true) }), "Closed."), 401: denied, 403: refused },
});

export const feature: Feature = {
  async boot(deps) {
    // Features boot in name order, and on a first boot nothing has worked out the address yet.
    await ensureServerIp(deps);
    await writePanelRoutes(deps);
    concludeRestarts(deps);
    await finishInterruptedReboots(deps);
    if (deps.config.environment !== "test") {
      createDailyCleanupRunner(deps).start();
    }
  },

  shutdown(deps) {
    createDailyCleanupRunner(deps).stop();
  },

  register(app, deps) {
    concludeReboots(deps);
    deps.realtime.route(createHostConsoleRoute(deps));
    deps.realtime.provide(createPanelLogsProvider(deps));

    const actor = (c: Parameters<typeof requireSessionPrincipal>[0]) => requireSessionPrincipal(c).user.email;

    app.openapi(overviewRoute, async (c) => c.json(await getServerOverview(deps), 200));
    app.openapi(nodesRoute, async (c) => c.json(await listSwarmNodes(deps), 200));

    app.openapi(releasesKeptRoute, (c) => {
      const { keep } = c.req.valid("json");
      saveReleasesKept(deps, keep, actor(c));
      return c.json({ keep: releasesKept(deps) }, 200);
    });

    app.openapi(dailyCleanupRoute, (c) => {
      const { enabled } = c.req.valid("json");
      saveDailyCleanup(deps, enabled, actor(c));
      return c.json({ enabled: getDailyCleanup(deps) }, 200);
    });

    app.openapi(getPanelDomainRoute, (c) => c.json(getPanelDomainSettings(deps), 200));

    app.openapi(putPanelDomainRoute, async (c) =>
      c.json(await savePanelDomain(deps, c.req.valid("json"), actor(c)), 200),
    );

    app.openapi(getServiceDomainRoute, (c) => c.json(getServiceDomainSettings(deps), 200));

    app.openapi(putServiceDomainRoute, (c) =>
      c.json(saveServiceDomain(deps, c.req.valid("json").customDomain, actor(c)), 200),
    );

    app.openapi(getEmailRoute, (c) => c.json({ email: getLetsEncryptEmail(deps) ?? "" }, 200));

    app.openapi(putEmailRoute, (c) => {
      const { email } = c.req.valid("json");
      saveLetsEncryptEmail(deps, email, actor(c));
      return c.json({ email }, 200);
    });

    app.openapi(restartPanelRoute, async (c) =>
      c.json(toActionEntry(await enqueuePanelRestart(deps, c.req.valid("json").confirm, actor(c))), 202),
    );

    app.openapi(refreshIpRoute, async (c) => c.json(await refreshServerIp(deps, actor(c)), 200));

    app.openapi(rebootRoute, async (c) =>
      c.json(await rebootHost(deps, c.req.valid("json").confirm, actor(c)), 200),
    );

    app.openapi(diskRoute, async (c) => c.json(await readDiskUsage(deps, c.req.valid("query").path), 200));

    app.openapi(dockerRoute, async (c) => c.json(await readDockerEngine(deps), 200));

    app.openapi(dockerUpdateRoute, async (c) => c.json(await checkDockerUpdate(deps), 200));

    app.openapi(previewCleanupRoute, async (c) =>
      c.json(await previewCleanup(deps, c.req.valid("param").kind), 200),
    );

    app.openapi(runCleanupRoute, (c) => {
      const { confirm, items } = c.req.valid("json");
      return c.json(
        toActionEntry(enqueueCleanup(deps, c.req.valid("param").kind, items, confirm, actor(c))),
        202,
      );
    });

    app.openapi(getTrustedRoute, (c) => c.json(getTrustedProxies(deps), 200));

    app.openapi(putTrustedRoute, (c) => {
      const body = c.req.valid("json");
      saveTrustedProxies(deps, body, actor(c));
      return c.json(
        toActionEntry(enqueueProxyRestart(deps, actor(c), "changing its trusted addresses")),
        202,
      );
    });

    app.openapi(getCustomRoute, (c) => c.json(getCustomConfig(deps), 200));

    app.openapi(putCustomRoute, async (c) => {
      const { yaml } = c.req.valid("json");
      await saveCustomConfig(deps, yaml, actor(c));
      return c.json({ yaml }, 200);
    });

    app.openapi(getEnvRoute, (c) => c.json(getProxyEnvironment(deps), 200));

    app.openapi(putEnvRoute, (c) =>
      c.json(saveProxyEnvironment(deps, c.req.valid("json").env, actor(c)), 200),
    );

    app.openapi(revealEnvRoute, (c) => {
      deps.actions.record({
        type: "proxy.environment",
        title: "Read the proxy's environment",
        actorEmail: actor(c),
      });
      return c.json(revealProxyEnvironment(deps), 200);
    });

    app.openapi(restartProxyRoute, (c) => {
      if (c.req.valid("json").confirm !== serverConfirmWords.proxyRestart) {
        throw conflict("confirmation_mismatch", `Type ${serverConfirmWords.proxyRestart} to confirm.`, {
          confirm: "Does not match",
        });
      }
      return c.json(toActionEntry(enqueueProxyRestart(deps, actor(c), "requested by hand")), 202);
    });

    app.openapi(dashboardStatusRoute, (c) => c.json(getDashboardStatus(deps), 200));

    app.openapi(openDashboardRoute, async (c) => c.json(await openProxyDashboard(deps, actor(c)), 200));

    app.openapi(closeDashboardRoute, async (c) => {
      await closeProxyDashboard(deps, actor(c));
      return c.json({ ok: true as const }, 200);
    });
  },
};
