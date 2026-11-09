import { createRoute, z } from "@hono/zod-openapi";
import {
  checkStorageProviderResponse,
  createStorageProviderRequest,
  oauthStartResponse,
  storageProviderEntry,
  storageProviderList,
  storageProviderOptions,
  storageProviderPath,
  updateStorageProviderRequest,
} from "@opsifier/contract";
import type { Context } from "hono";
import { requestScheme, requirePrincipal } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { forbidden } from "../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  checkProvider,
  completeOAuth,
  createProvider,
  deleteProvider,
  disconnectProvider,
  ensureBuiltInProvider,
  listProviderOptions,
  listProviders,
  oauthCallbackPath,
  startOAuth,
  updateProvider,
} from "./service";

const BASE = "/api/v1/storage-providers";
const tags = ["Storage providers"];
const invalid = errorResponse("The request failed validation, or the destination could not be reached.");
const denied = errorResponse("Not signed in, or not an administrator.");
const missing = errorResponse("No such storage provider.");
const refused = errorResponse("The built-in Local Disk cannot be changed or removed.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  responses: {
    200: jsonResponse(storageProviderList, "Every storage provider. Secrets are never included."),
    401: denied,
    403: denied,
  },
});

const optionsRoute = createRoute({
  method: "get",
  path: `${BASE}/options`,
  tags,
  description: "The destinations a backup can use right now, for a form to offer.",
  responses: { 200: jsonResponse(storageProviderOptions, "Connected providers."), 401: denied },
});

const createProviderRoute = createRoute({
  method: "post",
  path: BASE,
  tags,
  request: { body: jsonBody(createStorageProviderRequest) },
  responses: {
    201: jsonResponse(storageProviderEntry, "The provider, already checked to work."),
    400: invalid,
    401: denied,
    403: denied,
    409: refused,
  },
});

const updateRoute = createRoute({
  method: "put",
  path: `${BASE}/{id}`,
  tags,
  request: { params: storageProviderPath, body: jsonBody(updateStorageProviderRequest) },
  responses: {
    200: jsonResponse(storageProviderEntry, "The updated provider."),
    400: invalid,
    401: denied,
    403: denied,
    404: missing,
    409: refused,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${BASE}/{id}`,
  tags,
  description: "Removes the provider. Its stored files are left where they are.",
  request: { params: storageProviderPath },
  responses: {
    200: jsonResponse(z.object({ id: z.string() }), "The provider was removed."),
    401: denied,
    403: denied,
    404: missing,
    409: refused,
  },
});

const checkRoute = createRoute({
  method: "post",
  path: `${BASE}/{id}/check`,
  tags,
  description: "Tries listing, writing and removing a file at this destination.",
  request: { params: storageProviderPath },
  responses: {
    200: jsonResponse(checkStorageProviderResponse, "The outcome of the check."),
    401: denied,
    403: denied,
    404: missing,
  },
});

const startOAuthRoute = createRoute({
  method: "post",
  path: `${BASE}/{id}/connect`,
  tags,
  description: "Starts signing in to Dropbox or Google Drive. Returns where to send the browser.",
  request: { params: storageProviderPath },
  responses: {
    200: jsonResponse(oauthStartResponse, "The address of the provider's consent screen."),
    400: invalid,
    401: denied,
    403: denied,
    404: missing,
  },
});

const disconnectRoute = createRoute({
  method: "post",
  path: `${BASE}/{id}/disconnect`,
  tags,
  description: "Gives up access. The entry stays, and is hidden from backups until connected again.",
  request: { params: storageProviderPath },
  responses: {
    200: jsonResponse(storageProviderEntry, "The disconnected provider."),
    400: invalid,
    401: denied,
    403: denied,
    404: missing,
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: oauthCallbackPath,
  tags,
  description: "Where the provider sends the browser back to. It redirects to the panel's settings page.",
  request: {
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: { 302: { description: "Redirects to Settings, Storage providers." } },
});

function requireAdministrator(c: Context<AppEnv>): void {
  if (requirePrincipal(c).user.role !== "admin") {
    throw forbidden("admin_required", "Only an administrator can manage storage providers.");
  }
}

const actorOf = (c: Context<AppEnv>): string => requirePrincipal(c).user.email;

function panelOrigin(c: Context<AppEnv>, deps: AppDeps): string {
  return `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

export const feature: Feature = {
  // The provider sends the browser back here with no cookie, because the session's is SameSite=Strict.
  publicPaths: [oauthCallbackPath],

  boot(deps) {
    ensureBuiltInProvider(deps);
  },

  register(app, deps) {
    app.openapi(listRoute, (c) => {
      requireAdministrator(c);
      return c.json(listProviders(deps, panelOrigin(c, deps)), 200);
    });

    app.openapi(optionsRoute, (c) => c.json(listProviderOptions(deps), 200));

    app.openapi(createProviderRoute, async (c) => {
      requireAdministrator(c);
      return c.json(await createProvider(deps, c.req.valid("json"), actorOf(c)), 201);
    });

    app.openapi(updateRoute, async (c) => {
      requireAdministrator(c);
      return c.json(
        await updateProvider(deps, c.req.valid("param").id, c.req.valid("json"), actorOf(c)),
        200,
      );
    });

    app.openapi(deleteRoute, (c) => {
      requireAdministrator(c);
      const { id } = c.req.valid("param");
      deleteProvider(deps, id, actorOf(c));
      return c.json({ id }, 200);
    });

    app.openapi(checkRoute, async (c) => {
      requireAdministrator(c);
      return c.json(await checkProvider(deps, c.req.valid("param").id), 200);
    });

    app.openapi(startOAuthRoute, (c) => {
      requireAdministrator(c);
      return c.json(startOAuth(deps, c.req.valid("param").id, panelOrigin(c, deps), actorOf(c)), 200);
    });

    app.openapi(disconnectRoute, async (c) => {
      requireAdministrator(c);
      return c.json(await disconnectProvider(deps, c.req.valid("param").id, actorOf(c)), 200);
    });

    app.openapi(callbackRoute, async (c) => {
      const outcome = await completeOAuth(deps, c.req.valid("query"));
      const query = outcome.ok
        ? `connected=${encodeURIComponent(outcome.providerId)}`
        : `oauthError=${encodeURIComponent(outcome.reason)}`;
      return c.redirect(`/settings/server/storage-providers?${query}`, 302);
    });
  },
};
