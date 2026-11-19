import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  changePasswordRequest,
  databaseCredentials,
  revealedSecret,
  revealSecretRequest,
  servicePath,
} from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { requestAccess, requireHostAccessNow } from "../../access/guard";
import { enqueuePasswordChange, enqueueRotationCheck } from "../../databases/rotation";
import { requireService } from "../../services/service";
import { getCredentials, revealSecret } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/credentials";
const tags = ["Service credentials"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such database.");
const refused = errorResponse("The database is not in a state that allows this.");
const accepted = jsonResponse(actionEntry, "The Action that is doing the work.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(databaseCredentials, "Connection details, with every password masked."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const revealRoute = createRoute({
  method: "post",
  path: `${PATH}/reveal`,
  tags,
  description: "Returns one secret and records who asked for it in the activity log.",
  request: { params: servicePath, body: jsonBody(revealSecretRequest) },
  responses: {
    200: jsonResponse(revealedSecret, "The secret."),
    400: invalid,
    401: denied,
    403: errorResponse("The database reaches the server, and only an administrator can reach its superuser."),
    404: missing,
    409: refused,
  },
});

const changeRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Changes the password inside the running database, then in the panel.",
  request: { params: servicePath, body: jsonBody(changePasswordRequest) },
  responses: {
    202: accepted,
    400: invalid,
    401: denied,
    403: errorResponse("The database reaches the server, and only an administrator can reach its superuser."),
    404: missing,
    409: refused,
  },
});

const checkRoute = createRoute({
  method: "post",
  path: `${PATH}/check`,
  tags,
  description: "Finds out where a password change the panel lost track of ended up.",
  request: { params: servicePath },
  responses: { 202: accepted, 400: invalid, 401: denied, 404: missing, 409: refused },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

/** The person behind the request, including whoever owns an API token. Used for audit lines. */
const auditEmail = (principal: ReturnType<typeof requirePrincipal>) => principal.user.email;

export const feature: Feature = {
  register(app, deps) {
    app.openapi(getRoute, async (c) =>
      c.json(await getCredentials(deps, target(c.req.valid("param")), c.req.header("host")), 200),
    );

    app.openapi(revealRoute, async (c) => {
      const params = c.req.valid("param");
      // A database's superuser can run programs in its container, which here reaches the server.
      await requireHostAccessNow(
        deps,
        requestAccess(deps, c),
        target(params),
        requireService(deps, target(params)),
      );
      c.header("Cache-Control", "no-store");
      return c.json(
        await revealSecret(
          deps,
          target(params),
          c.req.valid("json").secret,
          c.req.header("host"),
          auditEmail(requirePrincipal(c)),
        ),
        200,
      );
    });

    app.openapi(changeRoute, async (c) => {
      const params = c.req.valid("param");
      await requireHostAccessNow(
        deps,
        requestAccess(deps, c),
        target(params),
        requireService(deps, target(params)),
      );
      return c.json(
        toActionEntry(
          enqueuePasswordChange(deps, target(params), c.req.valid("json"), auditEmail(requirePrincipal(c))),
        ),
        202,
      );
    });

    app.openapi(checkRoute, (c) =>
      c.json(
        toActionEntry(
          enqueueRotationCheck(deps, target(c.req.valid("param")), auditEmail(requirePrincipal(c))),
        ),
        202,
      ),
    );
  },
};
