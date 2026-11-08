import { createRoute } from "@hono/zod-openapi";
import {
  basicAuthEntry,
  basicAuthList,
  basicAuthPath,
  createBasicAuthRequest,
  deletedBasicAuth,
  servicePath,
  updateBasicAuthRequest,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { addBasicAuth, deleteBasicAuth, listBasicAuth, updateBasicAuth } from "./service";

const tags = ["Service security"];
const BASE = "/api/v1/projects/{project}/services/{service}/basic-auth";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or entry.");
const conflicted = errorResponse("This username is already in the list.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(basicAuthList, "Who may enter. Passwords are never sent back."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const createEntryRoute = createRoute({
  method: "post",
  path: BASE,
  tags,
  description: "Adds a user and applies it at once. The Docker service is not touched.",
  request: { params: servicePath, body: jsonBody(createBasicAuthRequest) },
  responses: {
    201: jsonResponse(basicAuthEntry, "The new entry."),
    400: invalid,
    401: denied,
    404: missing,
    409: conflicted,
  },
});

const updateEntryRoute = createRoute({
  method: "put",
  path: `${BASE}/{entry}`,
  tags,
  description: "Changes a user at once. Leaving the password out keeps the stored one.",
  request: { params: basicAuthPath, body: jsonBody(updateBasicAuthRequest) },
  responses: {
    200: jsonResponse(basicAuthEntry, "The entry."),
    400: invalid,
    401: denied,
    404: missing,
    409: conflicted,
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: `${BASE}/{entry}`,
  tags,
  description: "Removes a user at once.",
  request: { params: basicAuthPath },
  responses: {
    200: jsonResponse(deletedBasicAuth, "Removed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  register(app, deps) {
    const record = (
      params: { project: string; service: string },
      title: string,
      principal: ReturnType<typeof requirePrincipal>,
    ) => {
      deps.actions.record({
        type: "service.security",
        title,
        ...target(params),
        actorEmail: actorEmailOf(principal),
      });
    };

    app.openapi(listRoute, (c) =>
      c.json({ entries: listBasicAuth(deps, target(c.req.valid("param"))) }, 200),
    );

    app.openapi(createEntryRoute, async (c) => {
      const params = c.req.valid("param");
      const entry = await addBasicAuth(deps, target(params), c.req.valid("json"));
      record(params, `Add a basic auth user to ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json(entry, 201);
    });

    app.openapi(updateEntryRoute, async (c) => {
      const params = c.req.valid("param");
      const entry = await updateBasicAuth(deps, target(params), params.entry, c.req.valid("json"));
      record(params, `Update a basic auth user of ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json(entry, 200);
    });

    app.openapi(deleteEntryRoute, async (c) => {
      const params = c.req.valid("param");
      await deleteBasicAuth(deps, target(params), params.entry);
      record(params, `Remove a basic auth user of ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json({ id: params.entry }, 200);
    });
  },
};
