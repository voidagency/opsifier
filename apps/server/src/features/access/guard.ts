import { getConnInfo } from "@hono/node-server/conninfo";
import { actionsTopic, projectName, serviceLogsTopic, serviceMetricsTopic } from "@opsifier/contract";
import type { Context, MiddlewareHandler } from "hono";
import { HOST_ADMIN_ONLY, holdsHostAdmin } from "../../core/auth";
import type { AppDeps, AppEnv } from "../../core/context";
import { AppError, forbidden, notFound } from "../../core/errors";
import { PROXY_PAGES_PREFIX } from "../../core/proxy";
import type { TopicGuard } from "../../core/realtime";
import { findAction } from "../actions/repo";
import { belongsToCurrent } from "../projects/generation";
import { isPanelHostAllowed } from "../server/panel-host";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
import { type ProjectLevel, type Requirement, requirementFor } from "./policy";
import {
  type Access,
  accessOf,
  canReachHost,
  type canSeeAction,
  findUser,
  meetsLevel,
  membershipsOf,
  roleInProject,
} from "./rules";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requireLevel(
  access: Access,
  method: string,
  requirement: Extract<Requirement, { kind: "project" }>,
): void {
  // A project name a validator would refuse, or an encoded one, can't name anything the caller reaches.
  const role = projectName.safeParse(requirement.project).success
    ? roleInProject(access, requirement.project)
    : null;
  if (role === null) {
    throw notFound();
  }
  if (requirement.session && access.principal.kind !== "session") {
    throw forbidden("session_required", "This can only be done from a signed-in browser session.");
  }
  if (!meetsLevel(role, requirement.level)) {
    throw requirement.level === "admin"
      ? forbidden("admin_required", "Only an administrator can do this.")
      : forbidden("forbidden", "You don't have access to this.");
  }
  assertWriteAllowed(access, method);
}

/**
 * For a route that names a second project in its body: the same answer the table gives for the one
 * in its path, so a project out of reach looks exactly like one that does not exist.
 */
export function requireProjectLevel(
  access: Access,
  method: string,
  project: string,
  level: ProjectLevel,
): void {
  requireLevel(access, method, { kind: "project", project, level, session: false });
}

/** Mounting the host reaches every project on it, so neither a role nor a narrowed key can grant it. */
export function requireHostAccess(access: Access): void {
  if (!canReachHost(access)) {
    throw forbidden("admin_required", "Only an administrator can give a service access to the server.");
  }
}

function assertWriteAllowed(access: Access, method: string): void {
  if (!access.canWrite && UNSAFE_METHODS.has(method)) {
    throw forbidden("read_only_key", "This API key can only read.");
  }
}

function enforce(access: Access, method: string, requirement: Requirement): void {
  switch (requirement.kind) {
    case "open":
      assertWriteAllowed(access, method);
      return;
    case "own_credential":
      // Its route takes its own token and nothing else, so this says nothing about any account.
      return;
    case "session":
      if (access.principal.kind !== "session") {
        throw forbidden("session_required", "This can only be done from a signed-in browser session.");
      }
      return;
    case "admin":
      if (!access.admin || access.scoped) {
        throw forbidden("admin_required", "Only an administrator can do this.");
      }
      if (requirement.session && access.principal.kind !== "session") {
        throw forbidden("session_required", "This can only be done from a signed-in browser session.");
      }
      assertWriteAllowed(access, method);
      return;
    case "host":
      if (access.principal.kind !== "session" || !holdsHostAdmin(access.principal.user)) {
        throw forbidden("host_admin_required", HOST_ADMIN_ONLY);
      }
      return;
    case "project":
      requireLevel(access, method, requirement);
      return;
  }
}

/** Every API route passes through here: rights live in one table, and are denied by default. */
export function authorizeRequests(deps: Pick<AppDeps, "db">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal !== null) {
      enforce(accessOf(deps.db, principal), c.req.method, requirementFor(c.req.method, c.req.path));
    }
    return next();
  };
}

/** Whether the table would let this caller through, for clients asking what they may do. */
export function isPermitted(access: Access, method: string, path: string): boolean {
  const requirement = requirementFor(method, path);
  // No account or key can use these, so none of them is told it may.
  if (requirement.kind === "own_credential") {
    return false;
  }
  try {
    enforce(access, method, requirement);
    return true;
  } catch (error) {
    if (error instanceof AppError) {
      return false;
    }
    throw error;
  }
}

/** The access of the request's caller, for handlers that filter what they list. */
export function requestAccess(deps: Pick<AppDeps, "db">, c: Context<AppEnv>): Access {
  const principal = c.get("principal");
  if (principal === null) {
    throw notFound();
  }
  return accessOf(deps.db, principal);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function peerOf(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * With "serve on IP" off, the panel refuses requests that name anything but its own domains. The
 * server itself always gets through, so a wrong domain can never lock anyone out for good.
 */
export function guardPanelHost(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      c.req.path.startsWith(PROXY_PAGES_PREFIX) ||
      isLoopback(peerOf(c)) ||
      isPanelHostAllowed(deps, c.req.header("host"))
    ) {
      return next();
    }
    return c.notFound();
  };
}

const prefixed = (topic: string, prefix: string): string[] | null =>
  topic.startsWith(prefix) ? topic.slice(prefix.length).split("/") : null;

/** What a WebSocket may listen to. The rules follow those of the routes the same data comes from. */
export function createTopicGuard(deps: Pick<AppDeps, "db">): TopicGuard {
  const roleFor = (userId: string, project: string) => membershipsOf(deps.db, userId).get(project) ?? null;

  return {
    allow(userId, topic) {
      const user = findUser(deps.db, userId);
      // An account kept to turning on two-factor sign-in listens to nothing, as it reads nothing.
      if (user === undefined || needsTwoFactorSetup(deps.db, user)) {
        return false;
      }
      if (user.role === "admin" || topic === actionsTopic) {
        return true;
      }
      const metrics = prefixed(topic, serviceMetricsTopic("", "").replace("/", ""));
      if (metrics !== null) {
        return metrics[0] !== undefined && roleFor(userId, metrics[0]) !== null;
      }
      const logs = prefixed(topic, serviceLogsTopic("", "").replace("/", ""));
      if (logs !== null) {
        return logs[0] !== undefined && roleFor(userId, logs[0]) === "operator";
      }
      if (topic.startsWith("action:")) {
        const action = findAction(deps.db, topic.slice("action:".length));
        return (
          action !== undefined &&
          action.projectName !== null &&
          roleFor(userId, action.projectName) === "operator" &&
          belongsToCurrent(deps.db, action)
        );
      }
      return false;
    },

    deliver(userId, topic, payload) {
      const user = findUser(deps.db, userId);
      if (user === undefined || needsTwoFactorSetup(deps.db, user)) {
        return false;
      }
      if (topic !== actionsTopic) {
        return true;
      }
      if (user.role === "admin") {
        return true;
      }
      const entry = payload as Pick<ActionShape, "projectName" | "actorEmail">;
      return entry.projectName === null
        ? entry.actorEmail === user.email
        : roleFor(userId, entry.projectName) !== null;
    },
  };
}

type ActionShape = Parameters<typeof canSeeAction>[1];
