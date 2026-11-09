import { createRoute, z } from "@hono/zod-openapi";
import {
  githubBranchList,
  githubOauthCallbackPath,
  githubOauthStart,
  githubRepositoryList,
  githubRepositoryPath,
  githubSearchQuery,
  githubStatus,
  saveGithubOauthAppRequest,
  saveGithubTokenRequest,
} from "@opsifier/contract";
import type { Context } from "hono";
import { requestScheme, requirePrincipal } from "../../core/auth";
import type { AppDeps, AppEnv, Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  completeOauthConnection,
  getGithubStatus,
  removeGithubToken,
  removeOauthApp,
  saveGithubToken,
  saveOauthApp,
  searchBranches,
  searchRepositories,
  startOauthConnection,
} from "./service";

const tags = ["GitHub"];
const invalid = errorResponse("The request failed validation, or GitHub refused it.");
const denied = errorResponse("Not signed in.");
const SETTINGS_PATH = "/api/v1/settings/github";

const statusRoute = createRoute({
  method: "get",
  path: SETTINGS_PATH,
  tags,
  responses: { 200: jsonResponse(githubStatus, "Whether a token is stored."), 401: denied },
});

const saveRoute = createRoute({
  method: "put",
  path: SETTINGS_PATH,
  tags,
  request: { body: jsonBody(saveGithubTokenRequest) },
  responses: {
    200: jsonResponse(githubStatus, "Validated with GitHub and stored."),
    400: invalid,
    401: denied,
    502: errorResponse("GitHub could not be reached."),
  },
});

const removeRoute = createRoute({
  method: "delete",
  path: SETTINGS_PATH,
  tags,
  responses: { 200: jsonResponse(githubStatus, "The token is gone."), 401: denied },
});

const saveOauthAppRoute = createRoute({
  method: "put",
  path: `${SETTINGS_PATH}/oauth`,
  tags,
  request: { body: jsonBody(saveGithubOauthAppRequest) },
  responses: {
    200: jsonResponse(githubStatus, "Stored. Its secret is never shown again."),
    400: invalid,
    401: denied,
  },
});

const removeOauthAppRoute = createRoute({
  method: "delete",
  path: `${SETTINGS_PATH}/oauth`,
  tags,
  responses: { 200: jsonResponse(githubStatus, "The app is forgotten."), 401: denied },
});

const startOauthRoute = createRoute({
  method: "post",
  path: `${SETTINGS_PATH}/oauth/start`,
  tags,
  responses: {
    200: jsonResponse(githubOauthStart, "Send the browser here to grant access."),
    400: invalid,
    401: denied,
  },
});

const oauthCallbackRoute = createRoute({
  method: "get",
  path: githubOauthCallbackPath,
  tags,
  description: "Where GitHub sends the browser back to. It redirects to the GitHub settings page.",
  request: {
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: { 302: { description: "Redirects to the GitHub settings page." } },
});

const repositoriesRoute = createRoute({
  method: "get",
  path: "/api/v1/github/repositories",
  tags,
  request: { query: githubSearchQuery },
  responses: {
    200: jsonResponse(githubRepositoryList, "Repositories the token can reach."),
    400: invalid,
    401: denied,
    502: errorResponse("GitHub could not be reached."),
  },
});

const branchesRoute = createRoute({
  method: "get",
  path: "/api/v1/github/repositories/{owner}/{repo}/branches",
  tags,
  request: { params: githubRepositoryPath, query: githubSearchQuery },
  responses: {
    200: jsonResponse(githubBranchList, "The repository's branches."),
    400: invalid,
    401: denied,
    502: errorResponse("GitHub could not be reached."),
  },
});

function panelOrigin(c: Context<AppEnv>, deps: AppDeps): string {
  return `${requestScheme(c, deps.config)}://${c.req.header("host") ?? new URL(c.req.url).host}`;
}

export const feature: Feature = {
  // GitHub sends the browser back here with no cookie, because the session's is SameSite=Strict.
  publicPaths: [githubOauthCallbackPath],

  register(app, deps) {
    app.openapi(statusRoute, (c) => c.json(getGithubStatus(deps), 200));

    app.openapi(saveRoute, async (c) => c.json(await saveGithubToken(deps, c.req.valid("json").token), 200));

    app.openapi(removeRoute, async (c) => c.json(await removeGithubToken(deps), 200));

    app.openapi(saveOauthAppRoute, (c) => c.json(saveOauthApp(deps, c.req.valid("json")), 200));

    app.openapi(removeOauthAppRoute, (c) => c.json(removeOauthApp(deps), 200));

    app.openapi(startOauthRoute, (c) =>
      c.json(startOauthConnection(deps, panelOrigin(c, deps), requirePrincipal(c).user.email), 200),
    );

    app.openapi(oauthCallbackRoute, async (c) => {
      const outcome = await completeOauthConnection(deps, c.req.valid("query"));
      return c.redirect(
        `/settings/server/github?${outcome.ok ? "connected=1" : `oauthError=${outcome.reason}`}`,
        302,
      );
    });

    app.openapi(repositoriesRoute, async (c) =>
      c.json(await searchRepositories(deps, c.req.valid("query").q), 200),
    );

    app.openapi(branchesRoute, async (c) => {
      const { owner, repo } = c.req.valid("param");
      return c.json(await searchBranches(deps, owner, repo, c.req.valid("query").q), 200);
    });
  },
};
