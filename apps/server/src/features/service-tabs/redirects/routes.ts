import { createRoute } from "@hono/zod-openapi";
import {
  deletedRedirect,
  redirectList,
  redirectPath,
  redirectRule,
  saveRedirectRequest,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { addRedirect, deleteRedirect, listRedirects, updateRedirect } from "./service";

const tags = ["Service redirects"];
const BASE = "/api/v1/projects/{project}/services/{service}/redirects";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or redirect.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(redirectList, "The service's redirect rules, in order."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const createRedirectRoute = createRoute({
  method: "post",
  path: BASE,
  tags,
  description: "Adds a rule and applies it at once. The Docker service is not touched.",
  request: { params: servicePath, body: jsonBody(saveRedirectRequest) },
  responses: {
    201: jsonResponse(redirectRule, "The new rule."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const updateRedirectRoute = createRoute({
  method: "put",
  path: `${BASE}/{redirect}`,
  tags,
  description: "Changes a rule and applies it at once.",
  request: { params: redirectPath, body: jsonBody(saveRedirectRequest) },
  responses: {
    200: jsonResponse(redirectRule, "The rule."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const deleteRedirectRoute = createRoute({
  method: "delete",
  path: `${BASE}/{redirect}`,
  tags,
  description: "Removes a rule at once.",
  request: { params: redirectPath },
  responses: {
    200: jsonResponse(deletedRedirect, "Removed."),
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
        type: "service.redirects",
        title,
        ...target(params),
        actorEmail: actorEmailOf(principal),
      });
    };

    app.openapi(listRoute, (c) =>
      c.json({ redirects: listRedirects(deps, target(c.req.valid("param"))) }, 200),
    );

    app.openapi(createRedirectRoute, async (c) => {
      const params = c.req.valid("param");
      const rule = await addRedirect(deps, target(params), c.req.valid("json"));
      record(params, `Add a redirect to ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json(rule, 201);
    });

    app.openapi(updateRedirectRoute, async (c) => {
      const params = c.req.valid("param");
      const rule = await updateRedirect(deps, target(params), params.redirect, c.req.valid("json"));
      record(params, `Update a redirect of ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json(rule, 200);
    });

    app.openapi(deleteRedirectRoute, async (c) => {
      const params = c.req.valid("param");
      await deleteRedirect(deps, target(params), params.redirect);
      record(params, `Remove a redirect of ${params.project}/${params.service}`, requirePrincipal(c));
      return c.json({ id: params.redirect }, 200);
    });
  },
};
