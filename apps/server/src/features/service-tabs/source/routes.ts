import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import {
  autoDeployRequest,
  envFileSettings,
  saveBuildRequest,
  saveBuildResponse,
  saveSourceRequest,
  servicePath,
  serviceSource,
  sourceSettings,
  sshKeyResponse,
  uploadSourceQuery,
} from "@opsifier/contract";
import type { Context } from "hono";
import { requestScheme, requirePrincipal } from "../../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../../core/openapi";
import { setAutoDeploy } from "./auto-deploy";
import {
  generateDeployKey,
  getEnvFile,
  getSourceSettings,
  receiveUpload,
  saveBuildSettings,
  saveEnvFile,
  saveServiceSource,
} from "./service";

const PATH = "/api/v1/projects/{project}/services/{service}/source";
const tags = ["Service source"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const missing = errorResponse("No such service.");

const getRoute = createRoute({
  method: "get",
  path: PATH,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(sourceSettings, "The service's source and build settings."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putRoute = createRoute({
  method: "put",
  path: PATH,
  tags,
  request: { params: servicePath, body: jsonBody(saveSourceRequest) },
  responses: {
    200: jsonResponse(serviceSource, "Saved. Takes effect at the next deploy."),
    400: invalid,
    401: denied,
    404: missing,
    503: errorResponse("git is not available on this server."),
  },
});

const buildRoute = createRoute({
  method: "put",
  path: `${PATH}/build`,
  tags,
  request: { params: servicePath, body: jsonBody(saveBuildRequest) },
  responses: {
    200: jsonResponse(saveBuildResponse, "Saved. Used by the next build."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const uploadRoute = createRoute({
  method: "put",
  path: `${PATH}/upload`,
  tags,
  description: "The request body is the archive itself.",
  request: {
    params: servicePath,
    query: uploadSourceQuery,
    body: {
      required: true,
      content: {
        "application/octet-stream": { schema: z.string().openapi({ type: "string", format: "binary" }) },
      },
    },
  },
  responses: {
    200: jsonResponse(serviceSource, "Stored. Unpacked and built by the next deploy."),
    400: invalid,
    401: denied,
    404: missing,
    413: errorResponse("The archive is larger than the panel accepts."),
    503: errorResponse("bsdtar is not available on this server."),
  },
});

const sshKeyRoute = createRoute({
  method: "post",
  path: `${PATH}/ssh-key`,
  tags,
  description: "Generates a deploy key, replacing any earlier one. Only the public half is ever returned.",
  request: { params: servicePath },
  responses: {
    200: jsonResponse(sshKeyResponse, "The new key's public half."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const autoDeployRoute = createRoute({
  method: "put",
  path: `${PATH}/auto-deploy`,
  tags,
  request: { params: servicePath, body: jsonBody(autoDeployRequest) },
  responses: {
    200: jsonResponse(serviceSource, "The webhook was created or removed."),
    400: invalid,
    401: denied,
    404: missing,
    502: errorResponse("GitHub could not be reached."),
  },
});

const getEnvFileRoute = createRoute({
  method: "get",
  path: `${PATH}/env-file`,
  tags,
  request: { params: servicePath },
  responses: {
    200: jsonResponse(envFileSettings, "Where the environment is written in the source tree."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const putEnvFileRoute = createRoute({
  method: "put",
  path: `${PATH}/env-file`,
  tags,
  request: { params: servicePath, body: jsonBody(envFileSettings) },
  responses: {
    200: jsonResponse(envFileSettings, "Saved. Used by the next build."),
    400: invalid,
    401: denied,
    404: missing,
  },
});

const target = (params: { project: string; service: string }) => ({
  projectName: params.project,
  serviceName: params.service,
});

const actorOf = (c: Context<AppEnv>) => {
  const principal = requirePrincipal(c);
  return principal.kind === "session" ? principal.user.email : undefined;
};

/** The address this panel was reached on, as far as it can be believed. */
function panelOrigin(c: Context<AppEnv>, deps: AppDeps): string {
  return `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

export const feature: Feature = {
  // An archive is far larger than the API's general limit, and is counted as it comes in.
  readsOwnBody: (path) => path.endsWith("/source/upload"),

  /** Anything here is left over from a run that died: keys and tokens must not outlive their operation. */
  async boot(deps) {
    await rm(join(deps.config.dataDir, "tmp"), { recursive: true, force: true });
  },

  register(app, deps) {
    app.openapi(getRoute, (c) => c.json(getSourceSettings(deps, target(c.req.valid("param"))), 200));

    app.openapi(putRoute, async (c) =>
      c.json(
        await saveServiceSource(deps, target(c.req.valid("param")), c.req.valid("json"), actorOf(c)),
        200,
      ),
    );

    app.openapi(buildRoute, (c) =>
      c.json(
        {
          build: saveBuildSettings(deps, target(c.req.valid("param")), c.req.valid("json").build, actorOf(c)),
        },
        200,
      ),
    );

    app.openapi(uploadRoute, async (c) => {
      const length = c.req.header("content-length");
      return c.json(
        await receiveUpload(
          deps,
          target(c.req.valid("param")),
          c.req.valid("query"),
          c.req.raw.body,
          length === undefined ? undefined : Number(length),
          actorOf(c),
        ),
        200,
      );
    });

    app.openapi(sshKeyRoute, (c) =>
      c.json({ publicKey: generateDeployKey(deps, target(c.req.valid("param"))) }, 200),
    );

    app.openapi(autoDeployRoute, async (c) =>
      c.json(
        await setAutoDeploy(
          deps,
          target(c.req.valid("param")),
          c.req.valid("json").enabled,
          panelOrigin(c, deps),
          actorOf(c),
        ),
        200,
      ),
    );

    app.openapi(getEnvFileRoute, (c) => c.json(getEnvFile(deps, target(c.req.valid("param"))), 200));

    app.openapi(putEnvFileRoute, (c) =>
      c.json(saveEnvFile(deps, target(c.req.valid("param")), c.req.valid("json"), actorOf(c)), 200),
    );
  },
};
