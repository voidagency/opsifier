import { createRoute } from "@hono/zod-openapi";
import {
  allowlistEntry,
  allowlistEntryPath,
  allowlistState,
  createAllowlistEntryRequest,
  createProtectionUserRequest,
  deletedProtectionItem,
  isProtectedPurpose,
  protectionUserList,
  protectionUserPath,
  protectionUserResult,
  serverPurposeState,
  setServerPurposeRequest,
  setServerPurposeResult,
  updateProtectionUserRequest,
} from "@opsifier/contract";
import type { Context, MiddlewareHandler } from "hono";
import { requirePrincipal } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { roleInProject } from "../access/rules";
import { ROBOTS_TAG, ROBOTS_TXT, ROBOTS_TXT_PATH } from "../services/compile/protection";
import { readProtection } from "./repo";
import {
  addAllowlistEntry,
  addProtectionUser,
  getAllowlist,
  getServerPurposeState,
  listProtectionUsers,
  reconcileProtection,
  removeAllowlistEntry,
  removeProtectionUser,
  setServerPurpose,
  updateProtectionUser,
} from "./service";

const tags = ["Server purpose"];
const BASE = "/api/v1/server-purpose";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const notAdmin = errorResponse("Only an administrator can do this.");
const missing = errorResponse("No such entry.");
const refused = errorResponse("The confirmation did not match, or the change is not allowed.");
const notApplied = errorResponse("The proxy's files could not be written, so nothing changed.");

const stateRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  description: "What this server is for, and how many domains the proxy really protects.",
  responses: { 200: jsonResponse(serverPurposeState, "The purpose and the protection."), 401: denied },
});

const setPurposeRoute = createRoute({
  method: "put",
  path: BASE,
  tags,
  description: "Changes the purpose, across every routing file at once or not at all.",
  request: { body: jsonBody(setServerPurposeRequest) },
  responses: {
    200: jsonResponse(
      setServerPurposeResult,
      "The new state. Credentials appear once, if they were generated.",
    ),
    400: invalid,
    401: denied,
    403: notAdmin,
    409: refused,
    500: notApplied,
  },
});

const usersRoute = createRoute({
  method: "get",
  path: `${BASE}/users`,
  tags,
  responses: {
    200: jsonResponse(protectionUserList, "Who can pass. Passwords and hashes are never sent back."),
    401: denied,
    403: notAdmin,
  },
});

const createUserRoute = createRoute({
  method: "post",
  path: `${BASE}/users`,
  tags,
  description: "Adds a user. With no password one is generated, and returned this once only.",
  request: { body: jsonBody(createProtectionUserRequest) },
  responses: {
    201: jsonResponse(protectionUserResult, "The new user."),
    400: invalid,
    401: denied,
    403: notAdmin,
    409: refused,
    500: notApplied,
  },
});

const updateUserRoute = createRoute({
  method: "put",
  path: `${BASE}/users/{id}`,
  tags,
  description: "Changes a password. With none given one is generated, and returned this once only.",
  request: { params: protectionUserPath, body: jsonBody(updateProtectionUserRequest) },
  responses: {
    200: jsonResponse(protectionUserResult, "The user."),
    400: invalid,
    401: denied,
    403: notAdmin,
    404: missing,
    500: notApplied,
  },
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: `${BASE}/users/{id}`,
  tags,
  description: "Removes a user. A protected server always keeps at least one.",
  request: { params: protectionUserPath },
  responses: {
    200: jsonResponse(deletedProtectionItem, "Removed."),
    400: invalid,
    401: denied,
    403: notAdmin,
    404: missing,
    409: refused,
    500: notApplied,
  },
});

const allowlistRoute = createRoute({
  method: "get",
  path: `${BASE}/allowlist`,
  tags,
  responses: {
    200: jsonResponse(allowlistState, "Paths and addresses exempt from the protection."),
    401: denied,
    403: notAdmin,
  },
});

const createAllowlistRoute = createRoute({
  method: "post",
  path: `${BASE}/allowlist`,
  tags,
  description: "Exempts one path or address range of one service. Recorded in the Activity log.",
  request: { body: jsonBody(createAllowlistEntryRequest) },
  responses: {
    201: jsonResponse(allowlistEntry, "The new exemption."),
    400: invalid,
    401: denied,
    403: notAdmin,
    404: missing,
    409: refused,
    500: notApplied,
  },
});

const deleteAllowlistRoute = createRoute({
  method: "delete",
  path: `${BASE}/allowlist/{id}`,
  tags,
  request: { params: allowlistEntryPath },
  responses: {
    200: jsonResponse(deletedProtectionItem, "Removed."),
    400: invalid,
    401: denied,
    403: notAdmin,
    404: missing,
    500: notApplied,
  },
});

const actorOf = (c: Context<AppEnv>): string | undefined => {
  const principal = requirePrincipal(c);
  return principal.kind === "session" ? principal.user.email : undefined;
};

/**
 * The panel's own answers, reached directly or through the proxy, carry the same rule as everything
 * else on a non-production server.
 */
export function noindexPanelResponses(deps: Pick<AppDeps, "db">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (isProtectedPurpose(readProtection(deps.db).purpose)) {
      c.header("X-Robots-Tag", ROBOTS_TAG);
    }
  };
}

export const feature: Feature = {
  boot: reconcileProtection,

  register(app, deps) {
    // What the proxy answers on /robots.txt of every host, and the panel's own too.
    app.all(ROBOTS_TXT_PATH, (c) => {
      c.header("Cache-Control", "no-store");
      c.header("Content-Type", "text/plain; charset=UTF-8");
      return c.body(ROBOTS_TXT, 200);
    });
    app.get("/robots.txt", async (c, next) => {
      if (!isProtectedPurpose(readProtection(deps.db).purpose)) {
        return next();
      }
      c.header("Content-Type", "text/plain; charset=UTF-8");
      return c.body(ROBOTS_TXT, 200);
    });

    app.openapi(stateRoute, async (c) => {
      const state = await getServerPurposeState(deps);
      const access = requestAccess(deps, c);
      const visible = (project: string) =>
        project === "" ? access.admin && !access.scoped : roleInProject(access, project) !== null;
      return c.json({ ...state, domains: state.domains.filter((domain) => visible(domain.project)) }, 200);
    });

    app.openapi(setPurposeRoute, async (c) =>
      c.json(await setServerPurpose(deps, c.req.valid("json"), actorOf(c)), 200),
    );

    app.openapi(usersRoute, (c) => c.json({ users: listProtectionUsers(deps) }, 200));

    app.openapi(createUserRoute, async (c) =>
      c.json(await addProtectionUser(deps, c.req.valid("json"), actorOf(c)), 201),
    );

    app.openapi(updateUserRoute, async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await updateProtectionUser(deps, id, c.req.valid("json"), actorOf(c)), 200);
    });

    app.openapi(deleteUserRoute, async (c) => {
      const { id } = c.req.valid("param");
      await removeProtectionUser(deps, id, actorOf(c));
      return c.json({ id }, 200);
    });

    app.openapi(allowlistRoute, (c) => c.json(getAllowlist(deps), 200));

    app.openapi(createAllowlistRoute, async (c) =>
      c.json(await addAllowlistEntry(deps, c.req.valid("json"), actorOf(c)), 201),
    );

    app.openapi(deleteAllowlistRoute, async (c) => {
      const { id } = c.req.valid("param");
      await removeAllowlistEntry(deps, id, actorOf(c));
      return c.json({ id }, 200);
    });
  },
};
