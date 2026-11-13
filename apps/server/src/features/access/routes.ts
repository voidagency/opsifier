import { createRoute, z } from "@hono/zod-openapi";
import {
  apiKeyList,
  apiKeyPath,
  createApiKeyRequest,
  createdApiKey,
  createUserRequest,
  deleteUserRequest,
  panelUser,
  projectMemberList,
  projectMemberPath,
  projectMembersPath,
  setProjectMemberRequest,
  setUserActiveRequest,
  updateUserRequest,
  userApiKeyPath,
  userList,
  userPath,
} from "@opsifier/contract";
import { requireSessionPrincipal } from "../../core/auth";
import type { Feature } from "../../core/context";
import { notFound } from "../../core/errors";
import { errorResponse, jsonBody, jsonResponse } from "../../core/openapi";
import { createTopicGuard } from "./guard";
import * as repo from "./repo";
import {
  createApiKey,
  createPanelUser,
  deletePanelUser,
  listApiKeys,
  listPanelUsers,
  listProjectMembers,
  revokeApiKey,
  setPanelUserActive,
  setProjectMember,
  updatePanelUser,
} from "./service";

const tags = ["Accounts"];
const keyTags = ["API keys"];
const invalid = errorResponse("The request failed validation.");
const denied = errorResponse("Not signed in.");
const refused = errorResponse("The caller is not allowed to do this.");
const missing = errorResponse("No such account or key.");
const missingMember = errorResponse("No such project or account, or the project is out of reach.");
const clash = errorResponse("The request conflicts with the current state.");

const projectMembersRoute = "/api/v1/projects/{project}/members";

const listProjectMembersRoute = createRoute({
  method: "get",
  path: projectMembersRoute,
  tags,
  summary: "List who reaches a project",
  description:
    "Administrators, members with a role in every project, and members the project gives a role of its own, each with what it can do there. For an administrator at a browser.",
  request: { params: projectMembersPath },
  responses: {
    200: jsonResponse(projectMemberList, "Every account that reaches the project."),
    400: invalid,
    401: denied,
    403: refused,
    404: missingMember,
  },
});

const setProjectMemberRoute = createRoute({
  method: "put",
  path: `${projectMembersRoute}/{user}`,
  tags,
  summary: "Set a member's own role in a project",
  description:
    "Null takes the project's own role away. It is the same change as on the account, so a lower role ends its sessions and revokes its API keys. An administrator reaches every project and is refused with 409.",
  request: { params: projectMemberPath, body: jsonBody(setProjectMemberRequest) },
  responses: {
    200: jsonResponse(projectMemberList, "Who reaches the project now."),
    400: invalid,
    401: denied,
    403: refused,
    404: missingMember,
    409: clash,
  },
});

const empty = z.object({ ok: z.literal(true) });

const usersPath = "/api/v1/users";
const userPathTemplate = `${usersPath}/{user}`;
const meKeys = "/api/v1/me/api-keys";

const listUsersRoute = createRoute({
  method: "get",
  path: usersPath,
  tags,
  summary: "List the accounts of this panel",
  responses: { 200: jsonResponse(userList, "Every account."), 401: denied, 403: refused },
});

const createUserRoute = createRoute({
  method: "post",
  path: usersPath,
  tags,
  summary: "Create an account",
  request: { body: jsonBody(createUserRequest) },
  responses: {
    201: jsonResponse(panelUser, "The new account."),
    400: invalid,
    401: denied,
    403: refused,
    409: clash,
  },
});

const updateUserRoute = createRoute({
  method: "put",
  path: userPathTemplate,
  tags,
  summary: "Change an account",
  description:
    "Taking rights away, a lower role in every project included, or changing the email or password, ends its sessions and revokes its API keys.",
  request: { params: userPath, body: jsonBody(updateUserRequest) },
  responses: {
    200: jsonResponse(panelUser, "The account."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: userPathTemplate,
  tags,
  summary: "Delete an account",
  request: { params: userPath, body: jsonBody(deleteUserRequest) },
  responses: {
    200: jsonResponse(empty, "Deleted."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const setUserActiveRoute = createRoute({
  method: "post",
  path: `${userPathTemplate}/active`,
  tags,
  summary: "Deactivate an account, or bring it back",
  description: "Deactivating ends its sessions and revokes its API keys. Its project rights are kept.",
  request: { params: userPath, body: jsonBody(setUserActiveRequest) },
  responses: {
    200: jsonResponse(panelUser, "The account."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
    409: clash,
  },
});

const listUserKeysRoute = createRoute({
  method: "get",
  path: `${userPathTemplate}/api-keys`,
  tags: keyTags,
  summary: "List the API keys of an account",
  request: { params: userPath },
  responses: {
    200: jsonResponse(apiKeyList, "Its keys, without their secrets."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const revokeUserKeyRoute = createRoute({
  method: "delete",
  path: `${userPathTemplate}/api-keys/{key}`,
  tags: keyTags,
  summary: "Revoke an API key of an account",
  request: { params: userApiKeyPath },
  responses: {
    200: jsonResponse(empty, "Revoked."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

const listMyKeysRoute = createRoute({
  method: "get",
  path: meKeys,
  tags: keyTags,
  summary: "List your API keys",
  responses: {
    200: jsonResponse(apiKeyList, "Your keys, without their secrets."),
    401: denied,
    403: refused,
  },
});

const createMyKeyRoute = createRoute({
  method: "post",
  path: meKeys,
  tags: keyTags,
  summary: "Create an API key",
  description: "The secret is in this answer and nowhere else: only its hash is stored.",
  request: { body: jsonBody(createApiKeyRequest) },
  responses: {
    201: jsonResponse(createdApiKey, "The key, with its secret."),
    400: invalid,
    401: denied,
    403: refused,
    409: clash,
  },
});

const revokeMyKeyRoute = createRoute({
  method: "delete",
  path: `${meKeys}/{key}`,
  tags: keyTags,
  summary: "Revoke one of your API keys",
  request: { params: apiKeyPath },
  responses: {
    200: jsonResponse(empty, "Revoked."),
    400: invalid,
    401: denied,
    403: refused,
    404: missing,
  },
});

export const feature: Feature = {
  register(app, deps) {
    deps.realtime.setGuard(createTopicGuard(deps));

    app.openapi(listUsersRoute, (c) => c.json({ users: listPanelUsers(deps) }, 200));

    app.openapi(createUserRoute, async (c) =>
      c.json(await createPanelUser(deps, requireSessionPrincipal(c), c.req.valid("json")), 201),
    );

    app.openapi(updateUserRoute, async (c) =>
      c.json(
        await updatePanelUser(
          deps,
          requireSessionPrincipal(c),
          c.req.valid("param").user,
          c.req.valid("json"),
        ),
        200,
      ),
    );

    app.openapi(deleteUserRoute, (c) => {
      deletePanelUser(
        deps,
        requireSessionPrincipal(c),
        c.req.valid("param").user,
        c.req.valid("json").confirm,
      );
      return c.json({ ok: true as const }, 200);
    });

    app.openapi(setUserActiveRoute, (c) =>
      c.json(
        setPanelUserActive(
          deps,
          requireSessionPrincipal(c),
          c.req.valid("param").user,
          c.req.valid("json").active,
        ),
        200,
      ),
    );

    app.openapi(listProjectMembersRoute, (c) =>
      c.json({ members: listProjectMembers(deps, c.req.valid("param").project) }, 200),
    );

    app.openapi(setProjectMemberRoute, async (c) => {
      const { project, user } = c.req.valid("param");
      const members = await setProjectMember(
        deps,
        requireSessionPrincipal(c),
        project,
        user,
        c.req.valid("json").role,
      );
      return c.json({ members }, 200);
    });

    app.openapi(listUserKeysRoute, (c) => {
      const { user } = c.req.valid("param");
      if (repo.findUserById(deps.db, user) === undefined) {
        throw notFound("This account does not exist.");
      }
      return c.json({ keys: listApiKeys(deps, user) }, 200);
    });

    app.openapi(revokeUserKeyRoute, (c) => {
      const { user, key } = c.req.valid("param");
      revokeApiKey(deps, requireSessionPrincipal(c), user, key);
      return c.json({ ok: true as const }, 200);
    });

    app.openapi(listMyKeysRoute, (c) =>
      c.json({ keys: listApiKeys(deps, requireSessionPrincipal(c).user.id) }, 200),
    );

    app.openapi(createMyKeyRoute, (c) =>
      c.json(createApiKey(deps, requireSessionPrincipal(c), c.req.valid("json")), 201),
    );

    app.openapi(revokeMyKeyRoute, (c) => {
      const principal = requireSessionPrincipal(c);
      revokeApiKey(deps, principal, principal.user.id, c.req.valid("param").key);
      return c.json({ ok: true as const }, 200);
    });
  },
};
