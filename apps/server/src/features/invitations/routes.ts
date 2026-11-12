import { createRoute, z } from "@hono/zod-openapi";
import {
  acceptInvitationRequest,
  checkInvitationRequest,
  createdInvitations,
  createInvitationsRequest,
  invitationList,
  invitationPath,
  invitationPreview,
  resendInvitationRequest,
  resentInvitation,
  sessionState,
} from "@opsifier/contract";
import type { Context } from "hono";
import { requestMeta, requestScheme, requireSessionPrincipal, setSessionCookie } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  acceptInvitation,
  checkInvitation,
  concludeInterruptedSends,
  createInvitations,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "./service";

const tags = ["Accounts"];
const authTags = ["Authentication"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("The caller is not allowed to do this.");
const missing = errorResponse("No such invitation.");
const clash = errorResponse("The request conflicts with the current state.");
const rateLimited = errorResponse("Too many attempts.");
const unusable = errorResponse(
  "`invitation_invalid`: the link was used, replaced or taken back, it expired, or whoever sent it is no longer an administrator.",
);

const invitationsPath = "/api/v1/users/invitations";
const invitationPathTemplate = `${invitationsPath}/{invitation}`;
const CHECK_PATH = "/api/v1/auth/invitation/check";
const ACCEPT_PATH = "/api/v1/auth/invitation/accept";

const listRoute = createRoute({
  method: "get",
  path: invitationsPath,
  tags,
  summary: "List the invitations nobody has accepted yet",
  responses: {
    200: jsonResponse(invitationList, "Every invitation, expired ones included."),
    401: denied,
    403: refused,
  },
});

const createInvitationsRoute = createRoute({
  method: "post",
  path: invitationsPath,
  tags,
  summary: "Invite people to create their own account",
  description:
    "Each address gets a link that works once and expires. With `channel`, an Action e-mails the links through that SMTP notification channel; without, they are in this answer and nowhere else, since only their hash is stored. Duplicates, addresses with an account and addresses with an invitation still waiting are reported and leave the others alone.",
  request: { body: jsonBody(createInvitationsRequest) },
  responses: {
    201: jsonResponse(createdInvitations, "What became of each address."),
    400: invalid,
    401: denied,
    403: refused,
    409: clash,
  },
});

const resendRoute = createRoute({
  method: "post",
  path: `${invitationPathTemplate}/resend`,
  tags,
  summary: "Send an invitation again, with a new link",
  description: "The new link has a new term, and the old one stops working at once.",
  request: { params: invitationPath, body: jsonBody(resendInvitationRequest) },
  responses: {
    200: jsonResponse(resentInvitation, "The invitation, and its link when no channel e-mails it."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: invitationPathTemplate,
  tags,
  summary: "Take an invitation back",
  request: { params: invitationPath },
  responses: {
    200: jsonResponse(z.object({ ok: z.literal(true) }), "Revoked: its link no longer works."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const checkRoute = createRoute({
  method: "post",
  path: CHECK_PATH,
  tags: authTags,
  security: [],
  summary: "Read what an invitation link offers",
  description: "A POST, so the token never ends up in an address or a log.",
  request: { body: jsonBody(checkInvitationRequest) },
  responses: {
    200: jsonResponse(invitationPreview, "The account the link would create."),
    400: invalid,
    404: unusable,
    429: rateLimited,
  },
});

const acceptRoute = createRoute({
  method: "post",
  path: ACCEPT_PATH,
  tags: authTags,
  security: [],
  summary: "Accept an invitation",
  description:
    "Creates the account with the name and password given, uses the link up and signs the account in.",
  request: { body: jsonBody(acceptInvitationRequest) },
  responses: {
    201: jsonResponse(sessionState, "The session of the new account."),
    400: invalid,
    404: unusable,
    409: errorResponse("The address has an account already."),
    429: rateLimited,
  },
});

/**
 * The address the caller is using, as the browser named it. The origin guard already holds a
 * cookie-carrying mutation's `Origin` to its host, so this names the panel and nothing else.
 */
function requestOrigin(c: Context<AppEnv>, deps: AppDeps): string {
  const origin = c.req.header("origin");
  if (origin !== undefined && /^https?:\/\/[^/\s]+$/i.test(origin)) {
    return origin;
  }
  return `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

export const feature: Feature = {
  publicPaths: [CHECK_PATH, ACCEPT_PATH],
  boot: (deps) => concludeInterruptedSends(deps),

  register(app, deps) {
    app.openapi(listRoute, (c) => c.json({ invitations: listInvitations(deps) }, 200));

    app.openapi(createInvitationsRoute, (c) =>
      c.json(
        createInvitations(deps, requireSessionPrincipal(c), c.req.valid("json"), requestOrigin(c, deps)),
        201,
      ),
    );

    app.openapi(resendRoute, (c) =>
      c.json(
        resendInvitation(
          deps,
          requireSessionPrincipal(c),
          c.req.valid("param").invitation,
          c.req.valid("json"),
          requestOrigin(c, deps),
        ),
        200,
      ),
    );

    app.openapi(revokeRoute, (c) => {
      revokeInvitation(deps, requireSessionPrincipal(c), c.req.valid("param").invitation);
      return c.json({ ok: true as const }, 200);
    });

    app.openapi(checkRoute, (c) =>
      c.json(checkInvitation(deps, c.req.valid("json").token, requestMeta(c, deps.config)), 200),
    );

    app.openapi(acceptRoute, async (c) => {
      const signedIn = await acceptInvitation(deps, c.req.valid("json"), requestMeta(c, deps.config));
      setSessionCookie(c, deps.config, signedIn.token, signedIn.persistent);
      return c.json(signedIn.state, 201);
    });
  },
};
