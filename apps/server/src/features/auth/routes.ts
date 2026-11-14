import { createRoute } from "@hono/zod-openapi";
import {
  changeCredentialsRequest,
  cliLoginAnswered,
  cliLoginApprove,
  cliLoginCollect,
  cliLoginPath,
  cliLoginPending,
  cliLoginRequest,
  cliLoginSession,
  cliLoginStart,
  cliLoginStarted,
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

const cliStartRoute = createRoute({
  method: "post",
  path: `${PREFIX}/cli/start`,
  tags,
  security: [],
  summary: "Ask to sign the command line in as a person",
  description:
    "Returns a secret device code for the command line and a short code for the person, who approves the request in a signed-in browser within ten minutes.",
  request: { body: jsonBody(cliLoginStart) },
  responses: {
    201: jsonResponse(cliLoginStarted, "The request, waiting for a person to approve it."),
    400: invalid,
    429: rateLimited,
    503: errorResponse("Too many requests are waiting."),
  },
});

const cliTokenRoute = createRoute({
  method: "post",
  path: `${PREFIX}/cli/token`,
  tags,
  security: [],
  summary: "Collect the command line's session",
  description:
    "Asked every few seconds with the device code. Pending until a person answers; once approved, the session is handed over once.",
  request: { body: jsonBody(cliLoginCollect) },
  responses: {
    200: jsonResponse(cliLoginSession, "The session, valid for a day."),
    202: jsonResponse(cliLoginPending, "Nobody has answered yet."),
    400: invalid,
    410: errorResponse("Refused, expired or unknown: start again."),
  },
});

const cliRequestPath = `${PREFIX}/cli/requests/{code}`;

const cliRequestRoute = createRoute({
  method: "get",
  path: cliRequestPath,
  tags,
  summary: "Show a command line sign-in request",
  request: { params: cliLoginPath },
  responses: {
    200: jsonResponse(cliLoginRequest, "The request, still waiting."),
    401: denied,
    403: errorResponse("Only a person signed in can answer."),
    404: errorResponse("Expired, already answered, or unknown."),
  },
});

const cliApproveRoute = createRoute({
  method: "post",
  path: `${cliRequestPath}/approve`,
  tags,
  summary: "Approve a command line sign-in request",
  description:
    "Gives the command line a session of this account for a day. The person proves who they are again: with their two-factor code when they have one, else with their password.",
  request: { params: cliLoginPath, body: jsonBody(cliLoginApprove) },
  responses: {
    200: jsonResponse(cliLoginAnswered, "Approved: the command line receives its session."),
    400: invalid,
    401: denied,
    403: errorResponse("Only a person signed in can answer."),
    404: errorResponse("Expired, already answered, or unknown."),
    429: rateLimited,
  },
});

const cliDenyRoute = createRoute({
  method: "post",
  path: `${cliRequestPath}/deny`,
  tags,
  summary: "Refuse a command line sign-in request",
  request: { params: cliLoginPath },
  responses: {
    200: jsonResponse(cliLoginAnswered, "Refused: the command line is told so."),
    401: denied,
    403: errorResponse("Only a person signed in can answer."),
    404: errorResponse("Expired, already answered, or unknown."),
  },
});

export const feature: Feature = {
  publicPaths: [
    `${PREFIX}/session`,
    `${PREFIX}/setup`,
    `${PREFIX}/login`,
    `${PREFIX}/logout`,
    `${PREFIX}/cli/start`,
    `${PREFIX}/cli/token`,
  ],
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
      const principal = c.get("principal");
      const cookie = getCookie(c, sessionCookieName(requestScheme(c, deps.config)));
      if (cookie === undefined && principal?.kind === "session") {
        // The command line's session, sent in a header.
        service.endSession(principal.sessionId);
      } else {
        service.logout(cookie);
      }
      clearSessionCookie(c, deps.config);
      return c.json({ status: "signed-out" as const }, 200);
    });

    app.openapi(cliStartRoute, (c) =>
      c.json(service.startCliLogin(c.req.valid("json"), requestMeta(c, deps.config)), 201),
    );

    app.openapi(cliTokenRoute, (c) => {
      const result = service.collectCliLogin(c.req.valid("json").deviceCode, requestMeta(c, deps.config));
      return result.status === "pending" ? c.json(result, 202) : c.json(result, 200);
    });

    app.openapi(cliRequestRoute, (c) => {
      requireSessionPrincipal(c);
      return c.json(service.viewCliLogin(c.req.valid("param").code, requestMeta(c, deps.config)), 200);
    });

    app.openapi(cliApproveRoute, async (c) => {
      await service.approveCliLogin(
        requireSessionPrincipal(c),
        c.req.valid("param").code,
        c.req.valid("json"),
      );
      return c.json({ status: "approved" as const }, 200);
    });

    app.openapi(cliDenyRoute, (c) => {
      requireSessionPrincipal(c);
      service.denyCliLogin(c.req.valid("param").code);
      return c.json({ status: "denied" as const }, 200);
    });

    app.openapi(credentialsRoute, async (c) => {
      const user = await service.changeCredentials(requireSessionPrincipal(c), c.req.valid("json"));
      // Kept to turning on two-factor sign-in, an account never gets this far.
      return c.json({ status: "signed-in" as const, user, twoFactorSetupRequired: false }, 200);
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
      // Turning it off is refused while it is required, so nothing is required of this account now.
      return c.json({ status: "signed-in" as const, user, twoFactorSetupRequired: false }, 200);
    });
  },
};
