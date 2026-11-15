import { createRoute } from "@hono/zod-openapi";
import {
  addStudioProjectRequest,
  linkStudioAppRequest,
  servicePath,
  studioAppDetail,
  studioCheck,
  studioConversation,
  studioConversationPath,
  studioEventPage,
  studioEventsQuery,
  studioMessageRequest,
  studioModels,
  studioOverview,
  studioSettings,
  unlinkedStudioApp,
} from "@opsifier/contract";
import { requirePrincipal, requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { addStudioProject } from "./projects";
import {
  checkStudioAgent,
  getStudioApp,
  getStudioEvents,
  getStudioModels,
  getStudioOverview,
  getStudioSettings,
  linkStudioApp,
  saveStudioSettings,
  sendStudioMessage,
  startStudioConversation,
  stopStudioConversation,
  unlinkStudioApp,
} from "./service";

const tags = ["Studio"];
const SETTINGS = "/api/v1/settings/studio";
const APP = "/api/v1/projects/{project}/services/{service}/studio";
const CONVERSATION = `${APP}/conversations/{conversation}`;

const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Not allowed: the Studio is for the server's administrators for now.");
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
    "with the agent server's GITHUB_TOKEN secret, makes its preview in the agent server's project, links the two, " +
    "and starts the preview's first deployment. The token never leaves the agent server's container.",
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

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** The person behind the request, including whoever owns an API key. */
const actorOf = (principal: ReturnType<typeof requirePrincipal>) => principal.user.email;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getSettingsRoute, (c) => {
      requireSessionPrincipal(c);
      return c.json(getStudioSettings(deps), 200);
    });

    app.openapi(saveSettingsRoute, (c) => {
      const principal = requireSessionPrincipal(c);
      const saved = saveStudioSettings(deps, c.req.valid("json"));
      deps.actions.record({
        type: "studio.settings",
        title: saved.enabled ? "Turn the Studio on" : "Turn the Studio off",
        actorEmail: principal.user.email,
      });
      return c.json(saved, 200);
    });

    app.openapi(checkRoute, async (c) => {
      requireSessionPrincipal(c);
      return c.json(await checkStudioAgent(deps), 200);
    });

    app.openapi(overviewRoute, async (c) => c.json(await getStudioOverview(deps), 200));

    app.openapi(modelsRoute, async (c) => c.json(await getStudioModels(deps), 200));

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

    app.openapi(unlinkRoute, (c) => {
      const params = c.req.valid("param");
      unlinkStudioApp(deps, target(params));
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
        await getStudioEvents(deps, target(params), params.conversation, c.req.valid("query").after),
        200,
      );
    });

    app.openapi(messageRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(
        await sendStudioMessage(deps, target(params), params.conversation, c.req.valid("json")),
        200,
      );
    });

    app.openapi(stopRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(await stopStudioConversation(deps, target(params), params.conversation), 200);
    });
  },
};
