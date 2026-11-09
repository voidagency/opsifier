import { createRoute } from "@hono/zod-openapi";
import {
  listScriptRunsQuery,
  scriptItemPath,
  scriptList,
  scriptRun,
  scriptRunDetail,
  scriptRunPage,
  scriptRunPath,
  scriptSpec,
  servicePath,
  startedScriptRun,
  startScriptRunRequest,
} from "@opsifier/contract";
import { toActionEntry } from "../../../core/actions";
import { requirePrincipal } from "../../../core/auth";
import type { AppDeps, Feature } from "../../../core/context";
import { notFound } from "../../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import type { ServiceTarget } from "../../services/service";
import { findRun, listRuns } from "./repo";
import { cancelRun, claimRunActions, settleAfterRestart, startRun, toScriptRun } from "./run";
import { startScriptScheduler, stopScriptScheduler } from "./schedule";
import { addScript, listScripts, removeScript, updateScript } from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/scripts";
const RUNS_PATH = "/api/v1/projects/{project}/services/{service}/script-runs";
const tags = ["Service scripts"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service or script.");
const taken = errorResponse("A script with this name already exists.");
const forbiddenAnswer = errorResponse("The caller lacks the operator role on this project.");
const list = jsonResponse(scriptList, "The service's scripts.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const addRoute = createRoute({
  method: "post",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(scriptSpec) },
  responses: { 201: list, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const updateRoute = createRoute({
  method: "put",
  path: `${PATH}/{index}`,
  tags,
  request: { params: scriptItemPath, body: jsonBody(scriptSpec) },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing, 409: taken },
});

const removeRoute = createRoute({
  method: "delete",
  path: `${PATH}/{index}`,
  tags,
  request: { params: scriptItemPath },
  responses: { 200: list, 400: invalid, 401: denied, 404: missing },
});

const startRunRoute = createRoute({
  method: "post",
  path: RUNS_PATH,
  tags,
  description:
    "Starts a saved script now. Answers 202 at once with the Action doing the work and the run, whose id is also the Action's: poll this run, or the Action, for how it went. " +
    "Authorized like any other change to a project: a session or a write API key holding the operator role. " +
    "Running a script that is already queued or running is refused with 409 script_already_running and starts nothing, so a retried request cannot start a second job.",
  request: { params: servicePath, body: jsonBody(startScriptRunRequest) },
  responses: {
    202: jsonResponse(startedScriptRun, "The Action doing the work, and the run it belongs to."),
    400: invalid,
    401: denied,
    403: forbiddenAnswer,
    404: missing,
    409: errorResponse("This script is already running, or the service cannot take new work."),
  },
});

const listRunsRoute = createRoute({
  method: "get",
  path: RUNS_PATH,
  tags,
  description:
    "The stored history of the service's script runs, newest first: origin, exit code and what is known about each. Output is in the detail of one run.",
  request: { params: servicePath, query: listScriptRunsQuery },
  responses: {
    200: jsonResponse(scriptRunPage, "A page of runs, newest first."),
    400: invalid,
    401: denied,
    403: forbiddenAnswer,
    404: missing,
  },
});

const getRunRoute = createRoute({
  method: "get",
  path: `${RUNS_PATH}/{id}`,
  tags,
  description:
    "One run with its output. When the panel lost sight of a run, as across a restart, `outputComplete` is false and the note says what is known and what is not.",
  request: { params: scriptRunPath },
  responses: {
    200: jsonResponse(scriptRunDetail, "One run with what it printed."),
    400: invalid,
    401: denied,
    403: forbiddenAnswer,
    404: missing,
  },
});

const cancelRunRoute = createRoute({
  method: "post",
  path: `${RUNS_PATH}/{id}/cancel`,
  tags,
  description:
    "Stops a run. A queued run never starts. A running one has its process and everything it started ended, and is recorded as cancelled once Docker confirms it: until then it still reads as running.",
  request: { params: scriptRunPath },
  responses: {
    200: jsonResponse(scriptRun, "The run, which may still be ending."),
    400: invalid,
    401: denied,
    403: forbiddenAnswer,
    404: missing,
    409: errorResponse("This run has already finished."),
  },
});

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

function recordChange(deps: AppDeps, serviceTarget: ServiceTarget, actorEmail: string | undefined): void {
  deps.actions.record({
    type: "service.scripts",
    title: `Update the scripts of ${serviceTarget.projectName}/${serviceTarget.serviceName}`,
    ...serviceTarget,
    actorEmail,
  });
}

const actorEmailOf = (principal: ReturnType<typeof requirePrincipal>) =>
  principal.kind === "session" ? principal.user.email : undefined;

export const feature: Feature = {
  async boot(deps) {
    await settleAfterRestart(deps);
    startScriptScheduler(deps);
  },

  shutdown(deps) {
    stopScriptScheduler(deps);
  },

  register(app, deps) {
    claimRunActions(deps);

    app.openapi(getRoute, (c) => c.json({ scripts: listScripts(deps, target(c.req.valid("param"))) }, 200));

    app.openapi(addRoute, (c) => {
      const serviceTarget = target(c.req.valid("param"));
      const scripts = addScript(deps, serviceTarget, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 201);
    });

    app.openapi(updateRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const scripts = updateScript(deps, serviceTarget, params.index, c.req.valid("json"));
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 200);
    });

    app.openapi(removeRoute, (c) => {
      const params = c.req.valid("param");
      const serviceTarget = target(params);
      const scripts = removeScript(deps, serviceTarget, params.index);
      recordChange(deps, serviceTarget, actorEmailOf(requirePrincipal(c)));
      return c.json({ scripts }, 200);
    });

    app.openapi(startRunRoute, (c) => {
      const { action, run } = startRun(deps, target(c.req.valid("param")), c.req.valid("json").script);
      return c.json({ ...toActionEntry(action), run: toScriptRun(run) }, 202);
    });

    app.openapi(listRunsRoute, (c) => {
      const query = c.req.valid("query");
      const { rows, hasMore } = listRuns(deps.db, target(c.req.valid("param")), query);
      const last = rows.at(-1);
      return c.json(
        { items: rows.map(toScriptRun), nextCursor: hasMore && last !== undefined ? String(last.seq) : null },
        200,
      );
    });

    app.openapi(getRunRoute, (c) => {
      const params = c.req.valid("param");
      const run = findRun(deps.db, target(params), params.id);
      if (run === undefined) {
        throw notFound("This run does not exist.");
      }
      return c.json({ ...toScriptRun(run), output: run.output }, 200);
    });

    app.openapi(cancelRunRoute, async (c) => {
      const params = c.req.valid("param");
      return c.json(toScriptRun(await cancelRun(deps, target(params), params.id)), 200);
    });
  },
};
