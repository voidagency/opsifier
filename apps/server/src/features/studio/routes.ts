import { createRoute, z } from "@hono/zod-openapi";
import {
  actionEntry,
  addStudioGithubKeyRequest,
  addStudioProjectRequest,
  createdStudioGuestLink,
  createStudioGuestLinkRequest,
  deletedStudioGithubKey,
  deletedStudioGuestLink,
  deletedStudioRemark,
  deleteStudioGuestLinkQuery,
  destroyRequest,
  linkStudioAppRequest,
  replaceStudioGithubKeyRequest,
  servicePath,
  setStudioMembersRequest,
  studioAppDetail,
  studioCheck,
  studioConversation,
  studioConversationPath,
  studioEventPage,
  studioEventsQuery,
  studioGithubKey,
  studioGithubKeyCheck,
  studioGithubKeyList,
  studioGithubKeyPath,
  studioGuestLinkList,
  studioGuestLinkPath,
  studioIsolateAll,
  studioIsolated,
  studioMembers,
  studioMessageRequest,
  studioModels,
  studioOverview,
  studioPreviewStart,
  studioRemark,
  studioRemarkList,
  studioRemarkPath,
  studioSettings,
  studioSync,
  studioSyncQuery,
  unlinkedStudioApp,
  updateStudioRemarkRequest,
} from "@opsifier/contract";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal, requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { getPanelDomainSettings } from "../server/settings";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
import { GIT_RELAY_PREFIX, startIdleAgentSweeper } from "./agents";
import {
  addGithubKey,
  checkGithubKey,
  listGithubKeys,
  removeGithubKey,
  replaceGithubKey,
} from "./github-keys";
import { linkGonePage, registerGuestPages } from "./guest-pages";
import { isolateAllStudioApps, isolateStudioApp } from "./isolate";
import { refreshPreviewDockerfiles } from "./preview";
import { addStudioProject } from "./projects";
import { isRelayPath, relayGit } from "./relay";
import {
  createGuestLink,
  deleteRemark,
  GUEST_COOKIE,
  listGuestLinks,
  listRemarks,
  liveGuestLink,
  remarkScreenshot,
  removeGuestLink,
  updateRemark,
} from "./remarks";
import { removeStudioProject } from "./remove";
import {
  checkStudioAgent,
  getStudioApp,
  getStudioEvents,
  getStudioMembers,
  getStudioModels,
  getStudioOverview,
  getStudioSettings,
  linkStudioApp,
  saveStudioSettings,
  sendStudioMessage,
  setStudioMembers,
  startStudioConversation,
  startStudioPreview,
  stopStudioConversation,
  unlinkStudioApp,
} from "./service";
import {
  mayOpenPreview,
  PREVIEW_COOKIE,
  PreviewSignIn,
  previewAppOfHost,
  previewPage,
  SIGNIN_CHECK_PATH,
  SIGNIN_RETURN_PATH,
  safeReturnPath,
} from "./signin";
import { syncBeforeStart, syncStudioProject } from "./sync";

const tags = ["Studio"];
const SETTINGS = "/api/v1/settings/studio";
const APP = "/api/v1/projects/{project}/services/{service}/studio";
const CONVERSATION = `${APP}/conversations/{conversation}`;

const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Not allowed: this is for the server's administrators.");
const missing = errorResponse("No such service, Studio link or conversation.");
const blocked = errorResponse(
  "The Studio is turned off, has no agent server, or the agent server's service is not running.",
);
const unreachable = errorResponse("The agent server could not be reached, or refused the panel's key.");

const getSettingsRoute = createRoute({
  method: "get",
  path: SETTINGS,
  tags,
  responses: {
    200: jsonResponse(studioSettings, "Whether the Studio is on, and its agent server."),
    401: denied,
    403: refused,
  },
});

const saveSettingsRoute = createRoute({
  method: "put",
  path: SETTINGS,
  tags,
  description:
    "Turns the Studio on or off and names the service that runs its OpenHands agent server. The panel reaches that server from inside the service's container, where it also reads its key.",
  request: { body: jsonBody(studioSettings) },
  responses: { 200: jsonResponse(studioSettings, "The settings."), 400: invalid, 401: denied, 403: refused },
});

const checkRoute = createRoute({
  method: "post",
  path: `${SETTINGS}/check`,
  tags,
  description: "Reaches the agent server as every Studio request does, and says what stood in the way.",
  responses: { 200: jsonResponse(studioCheck, "What the check found."), 401: denied, 403: refused },
});

const GITHUB_KEYS = `${SETTINGS}/github-keys`;
const keyPath = studioGithubKeyPath;

const githubKeysRoute = createRoute({
  method: "get",
  path: GITHUB_KEYS,
  tags,
  description: "The Studio's GitHub keys, one per account or organization, without their tokens.",
  responses: { 200: jsonResponse(studioGithubKeyList, "The keys."), 401: denied, 403: refused },
});

const addGithubKeyRoute = createRoute({
  method: "post",
  path: GITHUB_KEYS,
  tags,
  description:
    "Adds a GitHub token for every repository of one account or organization. The panel uses it to copy a project whose repository that owner holds, and to pass its agent's git on to GitHub. It is sealed and never sent back.",
  request: { body: jsonBody(addStudioGithubKeyRequest) },
  responses: {
    201: jsonResponse(studioGithubKey, "The key."),
    400: invalid,
    401: denied,
    403: refused,
    409: blocked,
  },
});

const replaceGithubKeyRoute = createRoute({
  method: "put",
  path: `${GITHUB_KEYS}/{key}`,
  tags,
  description: "Gives a key a new token, for the same owner.",
  request: { params: keyPath, body: jsonBody(replaceStudioGithubKeyRequest) },
  responses: {
    200: jsonResponse(studioGithubKey, "The key."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const removeGithubKeyRoute = createRoute({
  method: "delete",
  path: `${GITHUB_KEYS}/{key}`,
  tags,
  description:
    "Removes a key. The owner's repositories fall back on the agent server's GITHUB_TOKEN secret, when it reaches them.",
  request: { params: keyPath },
  responses: {
    200: jsonResponse(deletedStudioGithubKey, "Removed."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const checkGithubKeyRoute = createRoute({
  method: "post",
  path: `${GITHUB_KEYS}/{key}/check`,
  tags,
  description:
    "Asks GitHub about the key's token: whose it is, when it expires, and how many private repositories of the owner it reads.",
  request: { params: keyPath },
  responses: {
    200: jsonResponse(studioGithubKeyCheck, "What GitHub said."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const modelsRoute = createRoute({
  method: "get",
  path: "/api/v1/studio/models",
  tags,
  description:
    "The agent server's model profiles, each with whether what it is sent stays on private addresses, and the one a conversation starts with when none is chosen.",
  responses: {
    200: jsonResponse(studioModels, "The model profiles."),
    401: denied,
    403: refused,
    409: blocked,
    503: unreachable,
  },
});

const overviewRoute = createRoute({
  method: "get",
  path: "/api/v1/studio",
  tags,
  responses: {
    200: jsonResponse(studioOverview, "The linked services, with their previews."),
    401: denied,
    403: refused,
  },
});

const addProjectRoute = createRoute({
  method: "post",
  path: "/api/v1/studio/projects",
  tags,
  description:
    "Adds a GitHub project to the Studio: copies it into the projects folder from inside the agent server's container, " +
    "with the Studio's GitHub key for the repository's owner when each project has an agent server of its own, or else " +
    "the agent server's GITHUB_TOKEN secret, makes its preview, links the two, and starts the preview's first " +
    "deployment. No token is written, printed or sent back.",
  request: { body: jsonBody(addStudioProjectRequest) },
  responses: {
    201: jsonResponse(studioAppDetail, "The project, linked to the Studio."),
    400: invalid,
    401: denied,
    403: errorResponse("A folder of the server takes an administrator."),
    409: blocked,
    422: errorResponse(
      "GitHub did not let the agent server read the repository, it has no such branch, or it is not a Vite project.",
    ),
    502: errorResponse("The copy failed."),
    503: errorResponse("The agent server could not be reached."),
  },
});

const membersRoute = createRoute({
  method: "get",
  path: `${APP}/members`,
  tags,
  description: "The accounts the Studio project is shared with. Only the server's administrators see it.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioMembers, "The accounts, by e-mail."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const setMembersRoute = createRoute({
  method: "put",
  path: `${APP}/members`,
  tags,
  description:
    "Shares the Studio project with exactly these accounts. Each reaches the project's conversations and its preview, and nothing else of the server.",
  request: { params: servicePath, body: jsonBody(setStudioMembersRequest) },
  responses: {
    200: jsonResponse(studioMembers, "The accounts it is now shared with."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const isolateRoute = createRoute({
  method: "post",
  path: `${APP}/isolate`,
  tags,
  description:
    "Gives the project an agent server of its own: an Opsifier project of its own, `studio-<folder>`, with a preview on the same folder and an agent server copied from the Studio's, which sees that folder only and reaches GitHub through the panel. " +
    "The project's link, conversations and accounts move to the new preview; the old preview stays where it is. Nothing is deployed until the project is opened.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioIsolated, "Where the project's preview is now."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: errorResponse(
      "Each project does not get its own agent server, the project has one already, or its folder is not a GitHub copy inside the projects folder.",
    ),
    503: unreachable,
  },
});

const isolateAllRoute = createRoute({
  method: "post",
  path: "/api/v1/studio/isolate",
  tags,
  description:
    "Gives every project still on the shared agent server an agent server of its own, one after the other.",
  responses: {
    200: jsonResponse(studioIsolateAll, "The projects moved, and those that could not be."),
    401: denied,
    403: refused,
    409: blocked,
  },
});

const startPreviewRoute = createRoute({
  method: "post",
  path: `${APP}/preview/start`,
  tags,
  description:
    "Starts the project's preview, for anyone the project is shared with. A preview that runs already is left as it is.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioPreviewStart, "Whether a start was asked for."),
    400: invalid,
    401: denied,
    404: missing,
    409: blocked,
  },
});

const syncRoute = createRoute({
  method: "post",
  path: `${APP}/sync`,
  tags,
  description:
    "Brings the project's folder up to date with its branch on GitHub, for anyone the project is shared with: " +
    "only a fast-forward, which never overwrites a file made here. The Studio asks for it when a project opens, " +
    "and before its preview starts; an answer of the last seconds is given again unless `force` is true.",
  request: { params: servicePath, query: studioSyncQuery },
  responses: {
    200: jsonResponse(studioSync, "What GitHub had, and what the folder took from it."),
    400: invalid,
    401: denied,
    404: missing,
    409: blocked,
  },
});

const appRoute = createRoute({
  method: "get",
  path: APP,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioAppDetail, "The linked service and its conversations, most recent first."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const linkRoute = createRoute({
  method: "put",
  path: APP,
  tags,
  description:
    "Links a service whose container shows the project's live preview to the Studio, with the project's folder as the agent server sees it.",
  request: { params: servicePath, body: jsonBody(linkStudioAppRequest) },
  responses: {
    200: jsonResponse(studioAppDetail, "The link."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
  },
});

const removeRoute = createRoute({
  method: "post",
  path: `${APP}/remove`,
  tags,
  description:
    "Takes the project out of the Studio, with its conversations and shares, and deletes what the Studio made for it: " +
    "its own agent server, its preview, and the Opsifier project that held them. A preview the Studio did not make stays, " +
    "and so does the project's folder: adding the same repository again reuses it. Confirmed by the project's name.",
  request: { params: servicePath, body: jsonBody(destroyRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
  },
});

const unlinkRoute = createRoute({
  method: "delete",
  path: APP,
  tags,
  description:
    "Takes the service out of the Studio. Its preview, its folder and the agent server's conversations stay.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(unlinkedStudioApp, "Unlinked."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const startRoute = createRoute({
  method: "post",
  path: `${APP}/conversations`,
  tags,
  description: "Starts a conversation on the project's folder with its first message.",
  request: { params: servicePath, body: jsonBody(studioMessageRequest) },
  responses: {
    201: jsonResponse(studioConversation, "The conversation. The agent is already at work."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
    503: unreachable,
  },
});

const eventsRoute = createRoute({
  method: "get",
  path: `${CONVERSATION}/events`,
  tags,
  request: { params: studioConversationPath, query: studioEventsQuery },
  responses: {
    200: jsonResponse(studioEventPage, "What happened after `after`, oldest first."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
    503: unreachable,
  },
});

const messageRoute = createRoute({
  method: "post",
  path: `${CONVERSATION}/messages`,
  tags,
  description: "Sends the agent a message, and sets it to work if it was not.",
  request: { params: studioConversationPath, body: jsonBody(studioMessageRequest) },
  responses: {
    200: jsonResponse(studioConversation, "The conversation."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
    503: unreachable,
  },
});

const stopRoute = createRoute({
  method: "post",
  path: `${CONVERSATION}/stop`,
  tags,
  description: "Stops the agent where it is. A new message sets it to work again.",
  request: { params: studioConversationPath },
  responses: {
    200: jsonResponse(studioConversation, "The conversation."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: blocked,
    503: unreachable,
  },
});

const LINKS = `${APP}/links`;
const REMARKS = `${APP}/remarks`;

const linksRoute = createRoute({
  method: "get",
  path: LINKS,
  tags,
  description:
    "The project's links for clients, live or expired, the most recent first. Their addresses are never sent again.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioGuestLinkList, "The links."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const createLinkRoute = createRoute({
  method: "post",
  path: LINKS,
  tags,
  description:
    "Makes a link that opens the project's preview to someone without an account, a client most often, who can leave remarks on its pages. " +
    "Anyone the project is shared with may make one. The link's address is in this answer only: the panel keeps the hash of its secret.",
  request: { params: servicePath, body: jsonBody(createStudioGuestLinkRequest) },
  responses: {
    201: jsonResponse(createdStudioGuestLink, "The link, with its address."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: errorResponse("The preview has no address yet."),
  },
});

const removeLinkRoute = createRoute({
  method: "delete",
  path: `${LINKS}/{link}`,
  tags,
  description:
    "Takes a link back: whoever opened it is let in no more, within half a minute. What they wrote stays, unless `remarks=delete`.",
  request: { params: studioGuestLinkPath, query: deleteStudioGuestLinkQuery },
  responses: {
    200: jsonResponse(deletedStudioGuestLink, "Taken back."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const remarksRoute = createRoute({
  method: "get",
  path: REMARKS,
  tags,
  description: "The remarks left on the project's preview, the most recent first.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(studioRemarkList, "The remarks."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const updateRemarkRoute = createRoute({
  method: "patch",
  path: `${REMARKS}/{remark}`,
  tags,
  description:
    "Hands a remark to the agent, marks it dealt with, or back to be dealt with. Its writer sees which on the preview.",
  request: { params: studioRemarkPath, body: jsonBody(updateStudioRemarkRequest) },
  responses: {
    200: jsonResponse(studioRemark, "The remark."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const remarkScreenshotRoute = createRoute({
  method: "get",
  path: `${REMARKS}/{remark}/screenshot`,
  tags,
  description:
    "The screenshot a remark came with: the window its writer saw, with the element outlined and the pin drawn. A JPEG, PNG or WebP image, as its first bytes say.",
  request: { params: studioRemarkPath },
  responses: {
    200: {
      description: "The image.",
      content: Object.fromEntries(
        ["image/jpeg", "image/png", "image/webp"].map((type) => [
          type,
          { schema: z.string().openapi({ type: "string", format: "binary" }) },
        ]),
      ),
    },
    400: invalid,
    401: denied,
    404: missing,
  },
});

const deleteRemarkRoute = createRoute({
  method: "delete",
  path: `${REMARKS}/{remark}`,
  tags,
  description: "Deletes a remark, for the preview's pins and the Studio alike.",
  request: { params: studioRemarkPath },
  responses: {
    200: jsonResponse(deletedStudioRemark, "Deleted."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** The person behind the request, including whoever owns an API key. */
const actorOf = (principal: ReturnType<typeof requirePrincipal>) => principal.user.email;

/** On the panel: where a browser comes to be given a code for a preview. */
const PREVIEW_SIGNIN_HOP = "/api/v1/studio/preview-signin";

const NOT_A_PREVIEW = previewPage(
  "Aperçu introuvable · Preview not found",
  "Cette adresse n'est pas celle d'un aperçu du Studio. This address is not a Studio preview's.",
);
const NOT_SHARED = previewPage(
  "Aperçu non partagé · Preview not shared",
  "Ce projet n'est pas partagé avec votre compte : demandez-le à un administrateur. This project is not shared with your account: ask an administrator.",
);
const EXPIRED = previewPage(
  "Lien expiré · Link expired",
  "Rechargez la page de l'aperçu pour vous connecter de nouveau. Reload the preview to sign in again.",
);

let stopSweeper: (() => void) | undefined;

export const feature: Feature = {
  // The hop of a preview's sign-in sends someone signed out to the panel's page that signs them in.
  publicPaths: [PREVIEW_SIGNIN_HOP],
  // Each project's agent server signs in to its git relay with its own token, and pushes stream.
  isPublicPath: isRelayPath,
  readsOwnBearer: isRelayPath,
  readsOwnBody: isRelayPath,
  ready(deps) {
    // Never in the way of the panel starting: a preview left as it was still builds what it says.
    try {
      refreshPreviewDockerfiles(deps);
    } catch (error) {
      deps.logger.warn(
        { err: error },
        "Could not bring Studio previews' Dockerfiles to the current template",
      );
    }
    stopSweeper = startIdleAgentSweeper(deps);
  },
  shutdown() {
    stopSweeper?.();
    stopSweeper = undefined;
  },
  register(app, deps) {
    const signIn = new PreviewSignIn(deps.secrets, deps.now);

    // From a project's own agent server: its git, passed to its repository with the panel's token.
    app.on(["GET", "POST"], `${GIT_RELAY_PREFIX}/*`, (c) => relayGit(deps, c.req.raw, c.req.path));

    // On the panel, from a browser: a code for a preview the person signed in may open, and back to it.
    app.get(PREVIEW_SIGNIN_HOP, (c) => {
      c.header("Cache-Control", "no-store");
      const host = (c.req.query("host") ?? "").toLowerCase();
      const to = safeReturnPath(c.req.query("to"));
      const preview = previewAppOfHost(deps.db, host);
      if (preview === null) {
        return c.html(NOT_A_PREVIEW, 404);
      }
      const principal = c.get("principal");
      if (
        principal === null ||
        principal.kind !== "session" ||
        needsTwoFactorSetup(deps.db, principal.user)
      ) {
        // The panel's own page signs the person in, or has them turn on two-factor sign-in first,
        // then comes back here.
        return c.redirect(`/studio/open-preview?${new URLSearchParams({ host, to })}`, 302);
      }
      if (!mayOpenPreview(deps.db, principal.user.id, preview.serviceId)) {
        return c.html(NOT_SHARED, 403);
      }
      const code = signIn.issueCode(principal.user.id, host);
      const scheme = preview.https ? "https" : "http";
      return c.redirect(`${scheme}://${host}${SIGNIN_RETURN_PATH}?${new URLSearchParams({ code, to })}`, 302);
    });

    // From Traefik, for every request to a preview behind the sign-in: through, or to the panel.
    app.get(SIGNIN_CHECK_PATH, (c) => {
      c.header("Cache-Control", "no-store");
      const host = (c.req.header("x-forwarded-host") ?? "").toLowerCase().replace(/:\d+$/, "");
      const uri = c.req.header("x-forwarded-uri") ?? "/";
      const method = (c.req.header("x-forwarded-method") ?? "GET").toUpperCase();
      const preview = previewAppOfHost(deps.db, host);
      if (preview === null) {
        return c.html(NOT_A_PREVIEW, 403);
      }
      const url = new URL(uri.startsWith("/") ? uri : `/${uri}`, `https://${host}`);
      if (url.pathname === SIGNIN_RETURN_PATH) {
        const userId = signIn.redeemCode(url.searchParams.get("code") ?? "", host);
        if (userId === null || !mayOpenPreview(deps.db, userId, preview.serviceId)) {
          return c.html(EXPIRED, 403);
        }
        const cookie = signIn.cookieFor(userId, host);
        setCookie(c, PREVIEW_COOKIE, cookie.value, {
          path: "/",
          maxAge: cookie.maxAgeSeconds,
          httpOnly: true,
          secure: preview.https,
          sameSite: "Lax",
        });
        // Absolute: Traefik makes a relative address absolute against the panel's own, inside the server.
        const scheme = preview.https ? "https" : "http";
        return c.redirect(
          `${scheme}://${host}${safeReturnPath(url.searchParams.get("to") ?? undefined)}`,
          302,
        );
      }
      const value = getCookie(c, PREVIEW_COOKIE);
      if (value !== undefined) {
        const allowed = signIn.allowed(`${host}|${value}`, () => {
          const userId = signIn.readCookie(value, host);
          return userId !== null && mayOpenPreview(deps.db, userId, preview.serviceId);
        });
        if (allowed) {
          return c.body(null, 200);
        }
      }
      const panel = getPanelDomainSettings(deps).url;
      const page =
        (method === "GET" || method === "HEAD") && (c.req.header("accept") ?? "").includes("text/html");
      // A client's link let them in: theirs until the link expires or is taken back.
      const guest = getCookie(c, GUEST_COOKIE);
      if (guest !== undefined) {
        const allowed = signIn.allowed(
          `${host}|guest|${guest}`,
          () => liveGuestLink(deps, guest, host, preview) !== null,
        );
        if (allowed) {
          return c.body(null, 200);
        }
        // The link is gone, and so goes its cookie: the next page goes through the panel's sign-in.
        deleteCookie(c, GUEST_COOKIE, { path: "/", secure: preview.https });
        if (value === undefined && page) {
          // Said in words for a client, with the way in for someone of the team.
          return c.html(
            linkGonePage(
              panel === null
                ? null
                : `${panel}/api/v1/studio/preview-signin?${new URLSearchParams({ host, to: uri })}`,
            ),
            403,
          );
        }
      }
      // A page someone opens goes through the panel to sign in; anything else is refused.
      if (page && panel !== null) {
        return c.redirect(
          `${panel}/api/v1/studio/preview-signin?${new URLSearchParams({ host, to: uri })}`,
          302,
        );
      }
      return c.text("Sign in to the panel to open this preview.", 401);
    });

    // On a preview's own address: a client's link, and the remarks the inspector shows and writes.
    registerGuestPages(app, deps, signIn);

    app.openapi(getSettingsRoute, (c) => {
      requireSessionPrincipal(c);
      return c.json(getStudioSettings(deps), 200);
    });

    app.openapi(saveSettingsRoute, async (c) => {
      const principal = requireSessionPrincipal(c);
      const saved = await saveStudioSettings(deps, c.req.valid("json"));
      deps.actions.record({
        type: "studio.settings",
        title: saved.enabled ? "Turn the Studio on" : "Turn the Studio off",
        actorEmail: principal.user.email,
      });
      return c.json(saved, 200);
    });

    app.openapi(githubKeysRoute, (c) => c.json({ keys: listGithubKeys(deps) }, 200));
    app.openapi(addGithubKeyRoute, (c) =>
      c.json(addGithubKey(deps, c.req.valid("json"), actorOf(requirePrincipal(c))), 201),
    );
    app.openapi(replaceGithubKeyRoute, (c) =>
      c.json(
        replaceGithubKey(
          deps,
          c.req.valid("param").key,
          c.req.valid("json").token,
          actorOf(requirePrincipal(c)),
        ),
        200,
      ),
    );
    app.openapi(removeGithubKeyRoute, (c) =>
      c.json(removeGithubKey(deps, c.req.valid("param").key, actorOf(requirePrincipal(c))), 200),
    );
    app.openapi(checkGithubKeyRoute, async (c) =>
      c.json(await checkGithubKey(deps, c.req.valid("param").key), 200),
    );

    app.openapi(checkRoute, async (c) => {
      requireSessionPrincipal(c);
      return c.json(await checkStudioAgent(deps), 200);
    });

    app.openapi(overviewRoute, async (c) => {
      const principal = requirePrincipal(c);
      const access = requestAccess(deps, c);
      const everything = access.admin && !access.scoped;
      return c.json(await getStudioOverview(deps, everything ? null : principal.user.id), 200);
    });

    app.openapi(modelsRoute, async (c) => {
      requirePrincipal(c);
      return c.json(await getStudioModels(deps), 200);
    });

    app.openapi(membersRoute, (c) => c.json(getStudioMembers(deps, target(c.req.valid("param"))), 200));

    app.openapi(setMembersRoute, (c) =>
      c.json(
        setStudioMembers(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json").userIds,
          actorOf(requirePrincipal(c)),
        ),
        200,
      ),
    );

    app.openapi(isolateRoute, async (c) => {
      const principal = requirePrincipal(c);
      return c.json(
        await isolateStudioApp(
          deps,
          target(c.req.valid("param")),
          requestAccess(deps, c),
          actorOf(principal),
          principal.user.role === "admin",
        ),
        200,
      );
    });

    app.openapi(isolateAllRoute, async (c) => {
      const principal = requireSessionPrincipal(c);
      return c.json(
        await isolateAllStudioApps(
          deps,
          requestAccess(deps, c),
          actorOf(principal),
          principal.user.role === "admin",
        ),
        200,
      );
    });

    app.openapi(startPreviewRoute, async (c) => {
      const preview = target(c.req.valid("param"));
      const actor = actorOf(requirePrincipal(c));
      // The preview installs its packages from the folder as it starts: from what is on GitHub.
      await syncBeforeStart(deps, preview, actor);
      return c.json(await startStudioPreview(deps, preview, actor), 200);
    });

    app.openapi(syncRoute, async (c) =>
      c.json(
        await syncStudioProject(
          deps,
          target(c.req.valid("param")),
          actorOf(requirePrincipal(c)),
          c.req.valid("query").force === "true",
        ),
        200,
      ),
    );

    app.openapi(appRoute, async (c) => c.json(await getStudioApp(deps, target(c.req.valid("param"))), 200));

    app.openapi(addProjectRoute, async (c) => {
      const principal = requirePrincipal(c);
      const added = await addStudioProject(
        deps,
        c.req.valid("json"),
        requestAccess(deps, c),
        actorOf(principal),
        principal.user.role === "admin",
      );
      return c.json(added, 201);
    });

    app.openapi(linkRoute, async (c) => {
      const params = c.req.valid("param");
      const linked = await linkStudioApp(deps, target(params), c.req.valid("json"));
      deps.actions.record({
        type: "studio.link",
        title: `Link ${params.project}/${params.service} to the Studio`,
        ...target(params),
        actorEmail: actorOf(requirePrincipal(c)),
      });
      return c.json(linked, 200);
    });

    app.openapi(removeRoute, async (c) =>
      c.json(
        toActionEntry(
          await removeStudioProject(
            deps,
            target(c.req.valid("param")),
            c.req.valid("json").confirm,
            actorOf(requirePrincipal(c)),
          ),
        ),
        202,
      ),
    );

    app.openapi(unlinkRoute, async (c) => {
      const params = c.req.valid("param");
      await unlinkStudioApp(deps, target(params));
      deps.actions.record({
        type: "studio.unlink",
        title: `Take ${params.project}/${params.service} out of the Studio`,
        ...target(params),
        actorEmail: actorOf(requirePrincipal(c)),
      });
      return c.json({ project: params.project, service: params.service }, 200);
    });

    app.openapi(startRoute, async (c) => {
      const conversation = await startStudioConversation(
        deps,
        target(c.req.valid("param")),
        c.req.valid("json"),
        actorOf(requirePrincipal(c)),
      );
      return c.json(conversation, 201);
    });

    app.openapi(eventsRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(
        await getStudioEvents(
          deps,
          target(params),
          params.conversation,
          c.req.valid("query").after,
          actorOf(requirePrincipal(c)),
        ),
        200,
      );
    });

    app.openapi(messageRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(
        await sendStudioMessage(
          deps,
          target(params),
          params.conversation,
          c.req.valid("json"),
          actorOf(requirePrincipal(c)),
        ),
        200,
      );
    });

    app.openapi(stopRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(await stopStudioConversation(deps, target(params), params.conversation), 200);
    });

    app.openapi(linksRoute, (c) => c.json(listGuestLinks(deps, target(c.req.valid("param"))), 200));

    app.openapi(createLinkRoute, (c) =>
      c.json(
        createGuestLink(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json"),
          actorOf(requirePrincipal(c)),
        ),
        201,
      ),
    );

    app.openapi(removeLinkRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        removeGuestLink(
          deps,
          target(params),
          params.link,
          c.req.valid("query").remarks === "delete",
          actorOf(requirePrincipal(c)),
        ),
        200,
      );
    });

    app.openapi(remarksRoute, (c) => c.json(listRemarks(deps, target(c.req.valid("param"))), 200));

    app.openapi(updateRemarkRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(updateRemark(deps, target(params), params.remark, c.req.valid("json")), 200);
    });

    app.openapi(remarkScreenshotRoute, (c) => {
      const params = c.req.valid("param");
      const shot = remarkScreenshot(deps, target(params), params.remark);
      return c.body(new Uint8Array(shot.data), 200, {
        "Content-Type": shot.type,
        "Content-Length": String(shot.data.length),
        "Content-Disposition": `inline; filename="remark-${shot.number}.${shot.type.slice("image/".length)}"`,
      });
    });

    app.openapi(deleteRemarkRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(deleteRemark(deps, target(params), params.remark), 200);
    });
  },
};
