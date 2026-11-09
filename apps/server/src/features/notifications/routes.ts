import { createRoute, z } from "@hono/zod-openapi";
import {
  notificationChannel,
  notificationChannelList,
  notificationChannelPath,
  notificationDeliveryList,
  notificationSettings,
  saveNotificationChannelRequest,
  testNotificationRequest,
  testNotificationResult,
} from "@opsifier/contract";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  createChannel,
  deleteChannel,
  listChannelsView,
  listDeliveries,
  readSettings,
  saveSettings,
  startNotifications,
  stopNotifications,
  testChannel,
  updateChannel,
} from "./service";

const tags = ["Notifications"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("Only an administrator can do this.");
const missing = errorResponse("No such channel.");
const channels = "/api/v1/notifications/channels";

const listRoute = createRoute({
  method: "get",
  path: channels,
  tags,
  summary: "List notification channels",
  responses: {
    200: jsonResponse(notificationChannelList, "Channels and settings."),
    401: denied,
    403: refused,
  },
});

const createChannelRoute = createRoute({
  method: "post",
  path: channels,
  tags,
  summary: "Add a notification channel",
  request: { body: jsonBody(saveNotificationChannelRequest) },
  responses: {
    201: jsonResponse(notificationChannel, "The new channel."),
    400: invalid,
    401: denied,
    403: refused,
  },
});

const updateChannelRoute = createRoute({
  method: "put",
  path: `${channels}/{channel}`,
  tags,
  summary: "Change a notification channel",
  description: "A secret left empty keeps the stored value.",
  request: { params: notificationChannelPath, body: jsonBody(saveNotificationChannelRequest) },
  responses: {
    200: jsonResponse(notificationChannel, "The channel."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const deleteChannelRoute = createRoute({
  method: "delete",
  path: `${channels}/{channel}`,
  tags,
  summary: "Delete a notification channel",
  request: { params: notificationChannelPath },
  responses: {
    200: jsonResponse(z.object({ ok: z.literal(true) }), "Deleted."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const testRoute = createRoute({
  method: "post",
  path: "/api/v1/notifications/test",
  tags,
  summary: "Send a test notification",
  description:
    "Uses the values in the form, saved or not. With an `id`, stored secrets fill in any left empty.",
  request: { body: jsonBody(testNotificationRequest) },
  responses: {
    200: jsonResponse(testNotificationResult, "Whether the destination accepted it."),
    400: invalid,
    401: denied,
    403: refused,
  },
});

const saveSettingsRoute = createRoute({
  method: "put",
  path: "/api/v1/notifications/settings",
  tags,
  summary: "Allow or block private destinations",
  description: "Only the owner can change this.",
  request: { body: jsonBody(notificationSettings) },
  responses: {
    200: jsonResponse(notificationSettings, "Saved."),
    400: invalid,
    401: denied,
    403: refused,
  },
});

const deliveriesRoute = createRoute({
  method: "get",
  path: "/api/v1/notifications/deliveries",
  tags,
  summary: "Recent notification deliveries",
  responses: { 200: jsonResponse(notificationDeliveryList, "Newest first."), 401: denied, 403: refused },
});

export const feature: Feature = {
  boot(deps) {
    if (deps.config.environment !== "test") {
      startNotifications(deps);
    }
  },

  shutdown: stopNotifications,

  register(app, deps) {
    app.openapi(listRoute, (c) =>
      c.json(
        {
          channels: listChannelsView(deps),
          settings: readSettings(deps),
          canChangeSettings: requireSessionPrincipal(c).user.isOwner,
        },
        200,
      ),
    );

    app.openapi(createChannelRoute, async (c) =>
      c.json(await createChannel(deps, c.req.valid("json"), requireSessionPrincipal(c).user.email), 201),
    );

    app.openapi(updateChannelRoute, async (c) =>
      c.json(
        await updateChannel(
          deps,
          c.req.valid("param").channel,
          c.req.valid("json"),
          requireSessionPrincipal(c).user.email,
        ),
        200,
      ),
    );

    app.openapi(deleteChannelRoute, (c) => {
      deleteChannel(deps, c.req.valid("param").channel, requireSessionPrincipal(c).user.email);
      return c.json({ ok: true as const }, 200);
    });

    app.openapi(testRoute, async (c) => c.json(await testChannel(deps, c.req.valid("json")), 200));

    app.openapi(saveSettingsRoute, (c) => {
      const settings = c.req.valid("json");
      saveSettings(deps, requireSessionPrincipal(c), settings);
      return c.json(settings, 200);
    });

    app.openapi(deliveriesRoute, (c) => c.json({ deliveries: listDeliveries(deps) }, 200));
  },
};
