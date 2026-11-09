import { createRoute, z } from "@hono/zod-openapi";
import {
  BOX_IDE_API_PREFIX,
  boxIdeDirectory,
  boxIdeDirectoryQuery,
  boxIdeFile,
  boxIdeFileQuery,
  boxIdePath,
  boxIdeSession,
  createBoxIdeDirectoryRequest,
  deleteBoxIdeEntryRequest,
  MAX_BOX_IDE_FILE_BYTES,
  moveBoxIdeEntryRequest,
  writeBoxIdeFileRequest,
} from "@opsifier/contract";
import type { Context, MiddlewareHandler } from "hono";
import { requestMeta } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { boxWorkspaceDir, requireBox } from "../box/service";
import { checkBoxIdeToken } from "../service-tabs/box-ide/service";
import type { ServiceTarget } from "../services/service";
import {
  createWorkspaceDirectory,
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  readWorkspaceFile,
  removeWorkspaceEntry,
  WorkspaceError,
  writeWorkspaceFile,
} from "./confined";

const PATH = "/api/v1/ide/{project}/{service}";
const tags = ["Box IDE"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("No valid token for this IDE.");
const refused = errorResponse("Refused: the path leaves the workspace, or goes through a symbolic link.");
const missing = errorResponse("Nothing is at this path.");
const clash = errorResponse("Something is already there, or the file changed since it was read.");

const sessionRoute = createRoute({
  method: "get",
  path: `${PATH}/session`,
  tags,
  description:
    "Checks a token and says what it opens. Every route here takes this IDE's own bearer token and nothing else.",
  request: { params: boxIdePath },
  responses: { 200: jsonResponse(boxIdeSession, "What this token opens."), 400: invalid, 401: denied },
});

const treeRoute = createRoute({
  method: "get",
  path: `${PATH}/tree`,
  tags,
  request: { params: boxIdePath, query: boxIdeDirectoryQuery },
  responses: {
    200: jsonResponse(boxIdeDirectory, "One folder of the workspace."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const readFileRoute = createRoute({
  method: "get",
  path: `${PATH}/file`,
  tags,
  request: { params: boxIdePath, query: boxIdeFileQuery },
  responses: {
    200: jsonResponse(boxIdeFile, "The file, as text when it is text."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const writeFileRoute = createRoute({
  method: "put",
  path: `${PATH}/file`,
  tags,
  request: { params: boxIdePath, body: jsonBody(writeBoxIdeFileRequest) },
  responses: {
    200: jsonResponse(z.object({ version: z.string() }), "Saved."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const directoryRoute = createRoute({
  method: "post",
  path: `${PATH}/directory`,
  tags,
  request: { params: boxIdePath, body: jsonBody(createBoxIdeDirectoryRequest) },
  responses: {
    200: jsonResponse(z.object({}), "Created."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const moveRoute = createRoute({
  method: "post",
  path: `${PATH}/move`,
  tags,
  request: { params: boxIdePath, body: jsonBody(moveBoxIdeEntryRequest) },
  responses: {
    200: jsonResponse(z.object({}), "Moved."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: `${PATH}/entry`,
  tags,
  request: { params: boxIdePath, body: jsonBody(deleteBoxIdeEntryRequest) },
  responses: {
    200: jsonResponse(z.object({}), "Deleted."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const BEARER = /^Bearer\s+(\S+)$/i;

/** The same answer for anything that isn't a valid token: no token, a wrong one, the wrong service, a box with the IDE off. */
const REFUSED_MESSAGE = "This IDE needs a valid token.";

/**
 * The boundary of the editor. It runs before anything else about the request is looked at, takes a
 * token issued for this one box and no other credential of any kind, and is asked again on every call.
 */
function ideGate(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const attempt = deps.rateLimiter.consume([
      { key: `ide:${requestMeta(c, deps.config).ip}`, rule: deps.authLimits.idePerAddress },
    ]);
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const verdict =
      token === undefined
        ? "refused"
        : checkBoxIdeToken(
            deps,
            { projectName: c.req.param("project") ?? "", serviceName: c.req.param("service") ?? "" },
            token,
          );
    if (verdict === "expired") {
      throw unauthorized(
        "ide_token_expired",
        "This IDE token has expired. Issue a new one on the box's IDE tab.",
      );
    }
    if (verdict !== "valid") {
      throw unauthorized("ide_unauthorized", REFUSED_MESSAGE);
    }
    attempt.refund();
    return next();
  };
}

const target = (params: { project: string; service: string }): ServiceTarget => ({
  projectName: params.project,
  serviceName: params.service,
});

function asAppError(error: unknown): unknown {
  if (!(error instanceof WorkspaceError)) {
    return error;
  }
  switch (error.reason) {
    case "not_found":
      return notFound(error.message);
    case "symlink":
      return forbidden("ide_symlink", error.message);
    case "invalid_path":
      return badRequest("ide_invalid_path", error.message, { path: error.message });
    case "not_a_file":
    case "not_a_directory":
      return badRequest(`ide_${error.reason}`, error.message, { path: error.message });
    case "exists":
    case "conflict":
    case "not_empty":
      return conflict(`ide_${error.reason}`, error.message);
  }
}

/** Runs one workspace operation, and says what stopped it in the API's terms. */
async function workspace<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asAppError(error);
  }
}

function recordOpening(deps: AppDeps, c: Context<AppEnv>, service: ServiceTarget): void {
  deps.actions.record({
    type: "box.ide-open",
    title: `Open the IDE of ${service.projectName}/${service.serviceName} from ${requestMeta(c, deps.config).ip}`,
    ...service,
  });
}

/**
 * The editor's own API. It carries only what is in a box's workspace, as JSON: the panel never serves
 * a workspace file as a page of its own, and the token here opens nothing else in the panel.
 */
export const feature: Feature = {
  isPublicPath: (path) => path.startsWith(BOX_IDE_API_PREFIX),
  readsOwnBearer: (path) => path.startsWith(BOX_IDE_API_PREFIX),

  register(app, deps) {
    app.use(`${BOX_IDE_API_PREFIX}:project/:service/*`, ideGate(deps));

    const root = (service: ServiceTarget): string => boxWorkspaceDir(deps, service);

    app.openapi(sessionRoute, (c) => {
      const service = target(c.req.valid("param"));
      const { ide } = requireBox(deps, service).spec.box;
      recordOpening(deps, c, service);
      return c.json(
        {
          project: service.projectName,
          service: service.serviceName,
          expiresAt: ide.token?.expiresAt ?? new Date(deps.now()).toISOString(),
          maxFileBytes: MAX_BOX_IDE_FILE_BYTES,
        },
        200,
      );
    });

    app.openapi(treeRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { path } = c.req.valid("query");
      const listing = await workspace(() => listWorkspaceDirectory(root(service), path));
      return c.json({ path, ...listing }, 200);
    });

    app.openapi(readFileRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { path } = c.req.valid("query");
      const file = await workspace(() => readWorkspaceFile(root(service), path, MAX_BOX_IDE_FILE_BYTES));
      return c.json({ path, ...file }, 200);
    });

    app.openapi(writeFileRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { path, content, version } = c.req.valid("json");
      if (Buffer.byteLength(content) > MAX_BOX_IDE_FILE_BYTES) {
        throw new AppError(413, "payload_too_large", "This file is too large to save here.");
      }
      return c.json(
        { version: await workspace(() => writeWorkspaceFile(root(service), path, content, version)) },
        200,
      );
    });

    app.openapi(directoryRoute, async (c) => {
      const service = target(c.req.valid("param"));
      await workspace(() => createWorkspaceDirectory(root(service), c.req.valid("json").path));
      return c.json({}, 200);
    });

    app.openapi(moveRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { from, to } = c.req.valid("json");
      await workspace(() => moveWorkspaceEntry(root(service), from, to));
      return c.json({}, 200);
    });

    app.openapi(deleteRoute, async (c) => {
      const service = target(c.req.valid("param"));
      const { path, recursive } = c.req.valid("json");
      await workspace(() => removeWorkspaceEntry(root(service), path, recursive));
      return c.json({}, 200);
    });
  },
};
