import { createRoute } from "@hono/zod-openapi";
import {
  actionEntry,
  boxDetail,
  boxProcessesStatus,
  boxProcessPath,
  saveBoxProcessesRequest,
  servicePath,
} from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { saveBoxProcesses } from "../../box/service";
import { enqueueBoxProcessRestart, getBoxProcessesStatus } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/box/processes";
const tags = ["Box"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such box or process.");

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  description: "Saves the processes this box supervises. Takes effect at the next deploy.",
  request: { params: servicePath, body: jsonBody(saveBoxProcessesRequest) },
  responses: {
    200: jsonResponse(boxDetail, "Saved. Used by the next deploy."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const statusRoute = createRoute({
  method: "get",
  path: `${PATH}/status`,
  tags,
  description: "What the supervisor inside the running box reports, process by process.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(boxProcessesStatus, "Each process's state, restarts and last exit."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const restartRoute = createRoute({
  method: "post",
  path: `${PATH}/{process}/restart`,
  tags,
  description: "Restarts one process inside the box. Its neighbours and the task itself are left alone.",
  request: { params: boxProcessPath },
  responses: {
    202: jsonResponse(actionEntry, "The Action doing it."),
    400: invalid,
    401: denied,
    404: missing,
    409: errorResponse("The box is in the middle of something else, or is not running."),
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
    app.openapi(putRoute, (c) =>
      c.json(saveBoxProcesses(deps, target(c.req.valid("param")), c.req.valid("json").processes), 200),
    );

    app.openapi(statusRoute, async (c) =>
      c.json(await getBoxProcessesStatus(deps, target(c.req.valid("param"))), 200),
    );

    app.openapi(restartRoute, (c) => {
      const params = c.req.valid("param");
      return c.json(
        toActionEntry(
          enqueueBoxProcessRestart(deps, target(params), params.process, actorEmailOf(requirePrincipal(c))),
        ),
        202,
      );
    });
  },
};
