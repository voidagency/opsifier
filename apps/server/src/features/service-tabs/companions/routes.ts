import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  companionList,
  companionPath,
  revealedCompanionToken,
  servicePath,
} from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonResponse } from "../../../core/openapi";
import {
  enqueueDisableCompanion,
  enqueueEnableCompanion,
  listCompanions,
  revealCompanionToken,
} from "./service";

const BASE = "/api/v1/projects/{project}/services/{service}/companions";
const tags = ["Service companions"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such database or tool.");
const refused = errorResponse("The tool is not in a state that allows this.");
const accepted = jsonResponse(actionEntry, "The Action that is doing the work.");

const listRoute = createRoute({
  method: "get",
  path: BASE,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(companionList, "The web tools this engine offers."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const enableRoute = createRoute({
  method: "post",
  path: `${BASE}/{tool}`,
  tags,
  request: { params: companionPath },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const disableRoute = createRoute({
  method: "delete",
  path: `${BASE}/{tool}`,
  tags,
  request: { params: companionPath },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const revealRoute = createRoute({
  method: "post",
  path: `${BASE}/{tool}/reveal`,
  tags,
  description: "Returns the tool's access token and records who asked for it.",
  request: { params: companionPath },
  responses: {
    200: jsonResponse(revealedCompanionToken, "The access token."),
    400: invalid,
    401: denied,
    404: missing,
    409: refused,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const auditEmail = (principal: ReturnType<typeof requirePrincipal>) => principal.user.email;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(listRoute, (c) =>
      c.json({ companions: listCompanions(deps, target(c.req.valid("param"))) }, 200),
    );

    app.openapi(enableRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        toActionEntry(
          enqueueEnableCompanion(deps, target(params), params.tool, auditEmail(requirePrincipal(c))),
        ),
        202,
      );
    });

    app.openapi(disableRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        toActionEntry(
          enqueueDisableCompanion(deps, target(params), params.tool, auditEmail(requirePrincipal(c))),
        ),
        202,
      );
    });

    app.openapi(revealRoute, (c) => {
      const params = c.req.valid("param");
      c.header("Cache-Control", "no-store");
      return c.json(
        revealCompanionToken(deps, target(params), params.tool, auditEmail(requirePrincipal(c))),
        200,
      );
    });
  },
};
