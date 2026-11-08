import { createRoute } from "@hono/zod-openapi";
import {
  changeCredentialsRequest,
  loginRequest,
  sessionState,
  setupRequest,
  twoFactorBegin,
  twoFactorConfirm,
  twoFactorDisable,
  twoFactorEnabled,
  twoFactorSetup,
} from "@opsifier/contract";
import { getCookie } from "hono/cookie";
import {
  clearSessionCookie,
  prepareDecoyHash,
  requestMeta,
  requestScheme,
  requireSessionPrincipal,
  sessionCookieName,
  setSessionCookie,
} from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { createAuthService, prepareSetupToken } from "./service";

const PREFIX = "/api/v1/auth";
const tags = ["Authentication"];

const stateResponse = jsonResponse(sessionState, "The session after this request.");
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const rateLimited = errorResponse("Too many attempts.");

const sessionRoute = createRoute({
  method: "get",
  path: `${PREFIX}/session`,
  tags,
  security: [],
  responses: { 200: stateResponse },
});

const setupRoute = createRoute({
  method: "post",
  path: `${PREFIX}/setup`,
  tags,
  security: [],
  request: { body: jsonBody(setupRequest) },
  responses: {
    201: stateResponse,
    400: invalid,
    403: errorResponse("The setup code is not the one this server issued."),
    409: errorResponse("A user already exists."),
    429: rateLimited,
  },
});

const loginRoute = createRoute({
  method: "post",
  path: `${PREFIX}/login`,
  tags,
  security: [],
  request: { body: jsonBody(loginRequest) },
  responses: {
    200: stateResponse,
    400: invalid,
    401: errorResponse("Wrong credentials, or `two_factor_required` when a code is needed."),
    429: rateLimited,
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: `${PREFIX}/logout`,
  tags,
  security: [],
  responses: { 200: stateResponse },
});

const credentialsRoute = createRoute({
  method: "post",
  path: `${PREFIX}/credentials`,
  tags,
  request: { body: jsonBody(changeCredentialsRequest) },
  responses: {
    200: stateResponse,
    400: invalid,
    401: denied,
    409: errorResponse("The email is taken."),
    429: rateLimited,
  },
});

const beginTwoFactorRoute = createRoute({
  method: "post",
  path: `${PREFIX}/two-factor/begin`,
  tags,
  request: { body: jsonBody(twoFactorBegin) },
  responses: {
    200: jsonResponse(twoFactorSetup, "A new secret. It stays inactive until confirmed."),
    400: invalid,
    401: denied,
    409: errorResponse("Two-factor authentication is already on."),
    429: rateLimited,
  },
});

const enableTwoFactorRoute = createRoute({
  method: "post",
  path: `${PREFIX}/two-factor/enable`,
  tags,
  request: { body: jsonBody(twoFactorConfirm) },
  responses: {
    200: jsonResponse(twoFactorEnabled, "The session, and recovery codes that are never shown again."),
    400: invalid,
    401: denied,
    409: errorResponse("Setup was not started, or is already complete."),
    429: rateLimited,
  },
});

const disableTwoFactorRoute = createRoute({
  method: "post",
  path: `${PREFIX}/two-factor/disable`,
  tags,
  request: { body: jsonBody(twoFactorDisable) },
  responses: {
    200: stateResponse,
    400: invalid,
    401: denied,
    409: errorResponse("Two-factor authentication is not on."),
    429: rateLimited,
  },
});

export const feature: Feature = {
  publicPaths: [`${PREFIX}/session`, `${PREFIX}/setup`, `${PREFIX}/login`, `${PREFIX}/logout`],
  boot: async (deps) => {
    await prepareDecoyHash();
    prepareSetupToken(deps);
  },

  register(app, deps) {
    const service = createAuthService(deps);

    app.openapi(sessionRoute, (c) => c.json(service.sessionState(c.get("principal")), 200));

    app.openapi(setupRoute, async (c) => {
      const signedIn = await service.setup(c.req.valid("json"), requestMeta(c, deps.config));
      setSessionCookie(c, deps.config, signedIn.token, signedIn.persistent);
      return c.json(signedIn.state, 201);
    });

    app.openapi(loginRoute, async (c) => {
      const signedIn = await service.login(c.req.valid("json"), requestMeta(c, deps.config));
      setSessionCookie(c, deps.config, signedIn.token, signedIn.persistent);
      return c.json(signedIn.state, 200);
    });

    app.openapi(logoutRoute, (c) => {
      service.logout(getCookie(c, sessionCookieName(requestScheme(c, deps.config))));
      clearSessionCookie(c, deps.config);
      return c.json({ status: "signed-out" as const }, 200);
    });

    app.openapi(credentialsRoute, async (c) => {
      const user = await service.changeCredentials(requireSessionPrincipal(c), c.req.valid("json"));
      return c.json({ status: "signed-in" as const, user }, 200);
    });

    app.openapi(beginTwoFactorRoute, async (c) => {
      const principal = requireSessionPrincipal(c);
      return c.json(await service.beginTwoFactor(principal, c.req.valid("json").currentPassword), 200);
    });

    app.openapi(enableTwoFactorRoute, (c) => {
      const { user, recoveryCodes } = service.enableTwoFactor(
        requireSessionPrincipal(c),
        c.req.valid("json").code,
      );
      return c.json({ status: "signed-in" as const, user, recoveryCodes }, 200);
    });

    app.openapi(disableTwoFactorRoute, async (c) => {
      const user = await service.disableTwoFactor(requireSessionPrincipal(c), c.req.valid("json"));
      return c.json({ status: "signed-in" as const, user }, 200);
    });
  },
};
