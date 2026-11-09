import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  applyPanelUpdateRequest,
  panelUpdateStatus,
  rollbackPanelRequest,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { AppDeps, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { panelUpdates } from "./service";

const tags = ["System"];
const PATH = "/api/v1/system/update";
const HEALTH_PATH = "/api/v1/health";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const forbidden = errorResponse("Only an administrator can do this.");
const refused = errorResponse("Something else is in progress, or nothing can be done now.");
const accepted = jsonResponse(
  actionEntry,
  "The Action doing the work, which finishes after the panel has restarted.",
);
const status = jsonResponse(panelUpdateStatus, "What the panel knows about its own version.");

const statusRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  responses: { 200: status, 401: denied, 403: forbidden },
});

const checkRoute = createRoute({
  method: "post",
  path: `${PATH}/check`,
  tags,
  description: "Looks at the release feed and changes nothing else.",
  responses: { 200: status, 401: denied, 403: forbidden },
});

const applyRoute = createRoute({
  method: "post",
  path: PATH,
  tags,
  request: { body: jsonBody(applyPanelUpdateRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 403: forbidden, 409: refused, 503: refused },
});

const rollbackRoute = createRoute({
  method: "post",
  path: `${PATH}/rollback`,
  tags,
  request: { body: jsonBody(rollbackPanelRequest) },
  responses: { 202: accepted, 400: invalid, 401: denied, 403: forbidden, 409: refused, 503: refused },
});

const healthRoute = createRoute({
  method: "get",
  path: HEALTH_PATH,
  tags,
  description: "For the container's health check. Says only whether the panel is up.",
  responses: { 200: jsonResponse(z.object({ status: z.literal("ok") }), "The panel is serving.") },
});

function actorOf(principal: ReturnType<typeof requirePrincipal>): string {
  return principal.user.email;
}

export const feature: Feature = {
  publicPaths: [HEALTH_PATH],

  boot: (deps: AppDeps) => panelUpdates(deps).boot(),
  shutdown: (deps: AppDeps) => panelUpdates(deps).shutdown(),

  register(app, deps) {
    const updates = panelUpdates(deps);

    app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));
    app.openapi(statusRoute, async (c) => c.json(await updates.status(), 200));
    app.openapi(checkRoute, async (c) => {
      await updates.check();
      return c.json(await updates.status(), 200);
    });
    app.openapi(applyRoute, async (c) =>
      c.json(toActionEntry(await updates.apply(c.req.valid("json"), actorOf(requirePrincipal(c)))), 202),
    );
    app.openapi(rollbackRoute, async (c) =>
      c.json(toActionEntry(await updates.rollback(c.req.valid("json"), actorOf(requirePrincipal(c)))), 202),
    );
  },
};
