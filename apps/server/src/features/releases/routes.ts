import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  pendingChanges,
  releaseDetail,
  releaseList,
  releasePath,
  rollbackRequest,
  servicePath,
} from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import { requirePrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { requestAccess } from "../access/guard";
import { pendingChangesOf } from "../services/applied";
import { requireService } from "../services/service";
import { enqueueRollback } from "./rollback";
import { getReleaseDetail, getReleaseList } from "./service";

const tags = ["Service deployments"];
const PATH = "/api/v1/projects/{project}/services/{service}";
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such project, service or version.");

const pendingRoute = createRoute({
  method: "get",
  path: `${PATH}/deployments/pending`,
  tags,
  description:
    "What is saved against what runs: every difference the next deployment would make. Variables and file contents are named and never quoted.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(pendingChanges, "What the next deployment would change."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const listRoute = createRoute({
  method: "get",
  path: `${PATH}/releases`,
  tags,
  description: "The kept versions of a service, newest first, and which of them can be gone back to.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(releaseList, "The kept versions. Only metadata: their configuration stays sealed."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const detailRoute = createRoute({
  method: "get",
  path: `${PATH}/releases/{number}`,
  tags,
  description: "One kept version, and what going back to it would change about what runs now.",
  request: { params: releasePath },
  responses: {
    200: jsonResponse(releaseDetail, "The version and the difference."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const rollbackRoute = createRoute({
  method: "post",
  path: `${PATH}/releases/{number}/rollback`,
  tags,
  description:
    "Runs a kept version again from the image already on this server, with no pull, build or Git access. Volumes and saved settings are left as they are. `confirm` is the service's exact name.",
  request: { params: releasePath, body: jsonBody(rollbackRequest) },
  responses: {
    202: jsonResponse(actionEntry, "The Action that is doing the work."),
    400: invalid,
    401: denied,
    403: errorResponse("Going back needs an operator of the project."),
    404: missing,
    409: errorResponse("This version can't be gone back to, and nothing was changed."),
  },
});

export const feature: Feature = {
  register(app, deps) {
    app.openapi(pendingRoute, (c) => {
      const { project, service } = c.req.valid("param");
      const target = { projectName: project, serviceName: service };
      return c.json(pendingChangesOf(deps, target, requireService(deps, target)), 200);
    });

    app.openapi(listRoute, async (c) => {
      const { project, service } = c.req.valid("param");
      return c.json(await getReleaseList(deps, { projectName: project, serviceName: service }), 200);
    });

    app.openapi(detailRoute, async (c) => {
      const { project, service, number } = c.req.valid("param");
      return c.json(
        await getReleaseDetail(deps, { projectName: project, serviceName: service }, number),
        200,
      );
    });

    app.openapi(rollbackRoute, async (c) => {
      const { project, service, number } = c.req.valid("param");
      const action = await enqueueRollback(
        deps,
        { projectName: project, serviceName: service },
        number,
        c.req.valid("json").confirm,
        requestAccess(deps, c),
        requirePrincipal(c).user.email,
      );
      return c.json(toActionEntry(action), 202);
    });
  },
};
