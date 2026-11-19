import { createRoute } from "@hono/zod-openapi";
import {
  boxIdeStatus,
  issueBoxIdeTokenRequest,
  issuedBoxIdeToken,
  saveBoxIdeRequest,
  servicePath,
} from "@opsifier/contract";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { requestAccess } from "../../access/guard";
import { getBoxIdeStatus, issueBoxIdeToken, revokeBoxIdeToken, setBoxIdeEnabled } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/box/ide";
const tags = ["Box"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such box.");
const reachRefused = errorResponse(
  "The box reaches the server, and only an administrator can open its workspace to an editor.",
);
const status = jsonResponse(
  boxIdeStatus,
  "Whether the IDE can be reached, and what is known about its token.",
);

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: { 200: status, 400: invalid, 401: denied, 404: missing },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description:
    "Turns the IDE on or off. Turning it off ends the token: nothing can get in until a new one is issued.",
  request: { params: servicePath, body: jsonBody(saveBoxIdeRequest) },
  responses: { 200: status, 400: invalid, 401: denied, 403: reachRefused, 404: missing },
});

const issueRoute = createRoute({
  method: "post",
  path: `${PATH}/token`,
  tags,
  description:
    "Replaces the IDE token, which ends the previous one immediately. Returns the token once: only its hash is kept. It expires by itself.",
  request: { params: servicePath, body: jsonBody(issueBoxIdeTokenRequest) },
  responses: {
    200: jsonResponse(issuedBoxIdeToken, "The new token, shown once."),
    400: invalid,
    401: denied,
    403: reachRefused,
    404: missing,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: `${PATH}/token`,
  tags,
  description: "Ends the IDE token. Anyone holding it can no longer get in.",
  request: { params: servicePath },
  responses: { 200: status, 400: invalid, 401: denied, 404: missing },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** The token is issued to whoever is signed in, so the routes need an account behind them. */
export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getBoxIdeStatus(deps, target(c.req.valid("param"))), 200));

    app.openapi(putRoute, async (c) => {
      const { user } = requirePrincipal(c);
      return c.json(
        await setBoxIdeEnabled(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json").enabled,
          user.email,
          requestAccess(deps, c),
        ),
        200,
      );
    });

    app.openapi(issueRoute, async (c) => {
      const { user } = requirePrincipal(c);
      return c.json(
        await issueBoxIdeToken(
          deps,
          target(c.req.valid("param")),
          user.id,
          c.req.valid("json").expiresInHours,
          user.email,
          requestAccess(deps, c),
        ),
        200,
      );
    });

    app.openapi(revokeRoute, (c) => {
      const { user } = requirePrincipal(c);
      return c.json(revokeBoxIdeToken(deps, target(c.req.valid("param")), user.email), 200);
    });
  },
};
