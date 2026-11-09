import { createRoute } from "@hono/zod-openapi";
import {
  opsifierAddressState,
  releaseOpsifierAddressRequest,
  requestOpsifierAddressRequest,
} from "@opsifier/contract";
import { requireSessionPrincipal } from "../../core/auth";
import type { AppDeps, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  cancelAddressRequest,
  checkAddressRequest,
  getAddressState,
  reconcileAddress,
  releaseAddress,
  requestAddress,
  sendDueHeartbeat,
} from "./service";

const tags = ["Server"];
const PATH = "/api/v1/server/opsifier-address";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const clash = errorResponse("The change does not apply to the current state.");
const failed = errorResponse("The address service could not be used, and nothing changed.");
const state = jsonResponse(opsifierAddressState, "This server's address.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  summary: "This server's opsifier.dev address and its state",
  responses: { 200: state, 401: denied, 403: refused },
});

const requestRoute = createRoute({
  method: "post",
  path: `${PATH}/request`,
  tags,
  summary: "Ask for an address for this server, which someone then approves or refuses",
  request: { body: jsonBody(requestOpsifierAddressRequest) },
  responses: { 200: state, 400: invalid, 401: denied, 403: refused, 409: clash, 502: failed },
});

const cancelRequestRoute = createRoute({
  method: "delete",
  path: `${PATH}/request`,
  tags,
  summary: "Withdraw a request that is still waiting for an answer",
  responses: { 200: state, 401: denied, 403: refused, 409: clash },
});

const releaseRoute = createRoute({
  method: "delete",
  path: PATH,
  tags,
  summary: "Give up this server's address and go back to generated names",
  request: { body: jsonBody(releaseOpsifierAddressRequest) },
  responses: { 200: state, 400: invalid, 401: denied, 403: refused, 409: clash },
});

const HOUR_MS = 60 * 60 * 1000;
/** How long an approval can take to reach a server. Only a server with a request waiting calls this often. */
const REQUEST_CHECK_MS = 5 * 60 * 1000;
/** Spread out, so a fleet restarted together doesn't all call at the same moment. */
const FIRST_HEARTBEAT_JITTER_MS = 5 * 60 * 1000;

const timers = new WeakMap<AppDeps, NodeJS.Timeout[]>();

function startHeartbeat(deps: AppDeps): void {
  const beat = (minimumGapMs?: number) =>
    sendDueHeartbeat(deps, minimumGapMs).catch((error: unknown) => {
      deps.logger.warn({ err: error }, "Could not send the address heartbeat");
    });
  const check = () =>
    checkAddressRequest(deps).catch((error: unknown) => {
      deps.logger.warn({ err: error }, "Could not check on the address request");
    });
  // After a restart an hour is enough: the server may have come back on a different address.
  const first = setTimeout(() => {
    void beat(HOUR_MS);
    void check();
  }, Math.random() * FIRST_HEARTBEAT_JITTER_MS);
  const daily = setInterval(() => void beat(), HOUR_MS);
  const requests = setInterval(() => void check(), REQUEST_CHECK_MS);
  first.unref();
  daily.unref();
  requests.unref();
  timers.set(deps, [first, daily, requests]);
}

export const feature: Feature = {
  async boot(deps) {
    await reconcileAddress(deps);
    if (deps.config.environment !== "test") {
      startHeartbeat(deps);
    }
  },

  shutdown(deps) {
    for (const timer of timers.get(deps) ?? []) {
      clearTimeout(timer);
    }
  },

  register(app, deps) {
    const actor = (c: Parameters<typeof requireSessionPrincipal>[0]) => requireSessionPrincipal(c).user.email;

    app.openapi(getRoute, async (c) => c.json(await getAddressState(deps), 200));

    app.openapi(requestRoute, async (c) =>
      c.json(await requestAddress(deps, c.req.valid("json"), actor(c)), 200),
    );

    app.openapi(cancelRequestRoute, async (c) => c.json(await cancelAddressRequest(deps, actor(c)), 200));

    app.openapi(releaseRoute, async (c) =>
      c.json(await releaseAddress(deps, c.req.valid("json").confirm, actor(c)), 200),
    );
  },
};
