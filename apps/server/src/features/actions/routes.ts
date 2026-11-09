import { createRoute, z } from "@hono/zod-openapi";
import { actionDetail, actionEntry, actionPage, listActionsQuery } from "@opsifier/contract";
import type { Feature } from "../../core/context";
import { errorResponse, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { cancelAction, getActionDetail, listActionPage } from "./service";

const tags = ["Actions"];
const params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id") });
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/actions",
  tags,
  request: { query: listActionsQuery },
  responses: { 200: jsonResponse(actionPage, "A page of actions, newest first."), 400: invalid, 401: denied },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/actions/{id}",
  tags,
  request: { params },
  responses: {
    200: jsonResponse(actionDetail, "One action with its log."),
    400: invalid,
    401: denied,
    404: errorResponse("No such action."),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/api/v1/actions/{id}/cancel",
  tags,
  request: { params },
  responses: {
    200: jsonResponse(actionEntry, "Cancelled if it was queued, otherwise asked to stop."),
    400: invalid,
    401: denied,
    404: errorResponse("No such action."),
    409: errorResponse("The action has already finished."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(listRoute, (c) =>
      c.json(listActionPage(deps, c.req.valid("query"), requestAccess(deps, c)), 200),
    );

    app.openapi(getRoute, async (c) =>
      c.json(await getActionDetail(deps, c.req.valid("param").id, requestAccess(deps, c)), 200),
    );

    app.openapi(cancelRoute, (c) =>
      c.json(cancelAction(deps, c.req.valid("param").id, requestAccess(deps, c)), 200),
    );
  },
};
