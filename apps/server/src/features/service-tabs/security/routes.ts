import { createRoute } from "@hono/zod-openapi";
import {
  basicAuthEntry,
  basicAuthList,
  basicAuthPath,
  createBasicAuthRequest,
  deletedBasicAuth,
  revealedSecret,
  servicePath,
  updateBasicAuthRequest,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import {
  addBasicAuth,
  deleteBasicAuth,
  listBasicAuth,
  revealBasicAuthPassword,
  updateBasicAuth,
} from "./service";

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
    200: jsonResponse(
      basicAuthList,
      "Who may enter, and whether each password can be shown. Passwords are never in this list.",
    ),
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

const revealRoute = createRoute({
  method: "post",
  path: `${BASE}/{entry}/reveal`,
  tags,
  description:
    "Returns one user's password and records who asked for it in the activity log. A password set before the panel kept them answers 409 `password_not_kept`.",
  request: { params: basicAuthPath },
  responses: {
    200: jsonResponse(revealedSecret, "The password."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The panel did not keep this password: give the user a new one."),
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

/** The person behind the request, including whoever owns an API key: a reveal is always named. */
const auditEmail = (principal: ReturnType<typeof requirePrincipal>) => principal.user.email;

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

    app.openapi(revealRoute, (c) => {
      const params = c.req.valid("param");
      c.header("Cache-Control", "no-store");
      return c.json(
        revealBasicAuthPassword(deps, target(params), params.entry, auditEmail(requirePrincipal(c))),
        200,
      );
    });
  },
};
