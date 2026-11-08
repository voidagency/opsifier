import { createRoute } from "@hono/zod-openapi";
import {
  githubBranchList,
  githubRepositoryList,
  githubRepositoryPath,
  githubSearchQuery,
  githubStatus,
  saveGithubTokenRequest,
} from "@opsifier/contract";
import type { Feature } from "../../core/context";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import {
  getGithubStatus,
  removeGithubToken,
  saveGithubToken,
  searchBranches,
  searchRepositories,
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

export const feature: Feature = {
  register(app, deps) {
    app.openapi(statusRoute, (c) => c.json(getGithubStatus(deps), 200));

    app.openapi(saveRoute, async (c) => c.json(await saveGithubToken(deps, c.req.valid("json").token), 200));

    app.openapi(removeRoute, (c) => c.json(removeGithubToken(deps), 200));

    app.openapi(repositoriesRoute, async (c) =>
      c.json(await searchRepositories(deps, c.req.valid("query").q), 200),
    );

    app.openapi(branchesRoute, async (c) => {
      const { owner, repo } = c.req.valid("param");
      return c.json(await searchBranches(deps, owner, repo, c.req.valid("query").q), 200);
    });
  },
};
