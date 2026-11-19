import { getConnInfo } from "@hono/node-server/conninfo";
import { actionsTopic, projectName, serviceLogsTopic, serviceMetricsTopic } from "@opsifier/contract";
import type { Context, MiddlewareHandler } from "hono";
import { HOST_ADMIN_ONLY, holdsHostAdmin, requestScheme } from "../../core/auth";
import type { AppDeps, AppEnv } from "../../core/context";
import type { DbHandle } from "../../core/db";
import type { TaskAccess } from "../../core/docker";
import { AppError, forbidden, notFound } from "../../core/errors";
import { PROXY_PAGES_PREFIX } from "../../core/proxy";
import type { TopicGuard } from "../../core/realtime";
import { findAction } from "../actions/repo";
import { belongsToCurrent } from "../projects/generation";
import { isPanelHostAllowed, isPanelOwnName } from "../server/panel-host";
import { anyTaskReachesServer, reachesServer, taskReachesServer } from "../services/reach";
import { findService, type ServiceRecord } from "../services/repo";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
import { type ProjectLevel, type Requirement, requirementFor } from "./policy";
import { isStudioMember } from "./repo";
import {
  type Access,
  accessOf,
  accountCanReachHost,
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
      : requirement.level === "maintainer"
        ? forbidden(
            "maintainer_required",
            "Only an administrator or a maintainer of this project can do this.",
          )
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

const SERVICE_REACHES_SERVER =
  "Only an administrator can change what runs in this service, because it can reach the server.";
const PROJECT_REACHES_SERVER =
  "Only an administrator can change this project's variables, because one of its services can reach the server.";

function refuseUnlessHost(access: Access, reaches: boolean, message: string): void {
  if (reaches && !canReachHost(access)) {
    throw forbidden("service_reaches_server", message);
  }
}

/**
 * A service given a path on the host, an added capability or a confirmed Compose file reaches the server,
 * and so does whatever runs in it. Deciding what that is, its code, command, variables, mounts or
 * scripts, takes the same rights as giving it that access: an administrator's own, never narrowed.
 */
export function requireHostAccessFor(access: Access, record: Pick<ServiceRecord, "spec">): void {
  refuseUnlessHost(access, reachesServer(record), SERVICE_REACHES_SERVER);
}

/**
 * The same for what acts on the tasks running now, a process, the workspace, a restore or a database's
 * own superuser: judged on the settings and on each of those tasks, which keep a mount or a capability
 * taken out of the settings until a deploy replaces them.
 */
export async function requireHostAccessNow(
  deps: Pick<AppDeps, "docker" | "config">,
  access: Access,
  target: { projectName: string; serviceName: string },
  record: Pick<ServiceRecord, "spec">,
): Promise<void> {
  requireHostAccessFor(access, record);
  if (!canReachHost(access) && (await anyTaskReachesServer(deps, target))) {
    throw forbidden("service_reaches_server", SERVICE_REACHES_SERVER);
  }
}

/**
 * For work queued now that acts on the service later, such as a restore: asked again when it starts,
 * since the service may have come to reach the server while it waited, or the person lost the right.
 */
export function holdToRequester(
  deps: Pick<AppDeps, "db" | "docker" | "config">,
  access: Access,
  target: { projectName: string; serviceName: string },
): () => Promise<void> {
  const requester = canReachHost(access) ? access.principal.user.id : null;
  return async () => {
    if (requester !== null && accountCanReachHost(deps.db, requester)) {
      return;
    }
    const record = findService(deps.db, target.projectName, target.serviceName);
    if (record !== undefined && (reachesServer(record) || (await anyTaskReachesServer(deps, target)))) {
      throw forbidden("service_reaches_server", SERVICE_REACHES_SERVER);
    }
  };
}

/** The same, judged on what a task is or would be given rather than on the settings. */
export function requireHostAccessForTask(access: Access, task: TaskAccess, ownFiles: string): void {
  refuseUnlessHost(access, taskReachesServer(task, ownFiles), SERVICE_REACHES_SERVER);
}

/** A project's variables go to each of its services, so one service reaching the server is enough. */
export function requireHostAccessForProject(
  access: Access,
  records: ReadonlyArray<Pick<ServiceRecord, "spec">>,
): void {
  refuseUnlessHost(access, records.some(reachesServer), PROJECT_REACHES_SERVER);
}

function assertWriteAllowed(access: Access, method: string): void {
  if (!access.canWrite && UNSAFE_METHODS.has(method)) {
    throw forbidden("read_only_key", "This API key can only read.");
  }
}

function enforce(access: Access, method: string, requirement: Requirement, db?: DbHandle): void {
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
    case "studio":
      if (access.admin && !access.scoped) {
        assertWriteAllowed(access, method);
        return;
      }
      if (
        access.principal.kind === "session" &&
        db !== undefined &&
        isStudioMember(db, requirement.project, requirement.service, access.principal.user.id)
      ) {
        return;
      }
      throw notFound();
  }
}

/** Every API route passes through here: rights live in one table, and are denied by default. */
export function authorizeRequests(deps: Pick<AppDeps, "db">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal !== null) {
      enforce(accessOf(deps.db, principal), c.req.method, requirementFor(c.req.method, c.req.path), deps.db);
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
/** A year: what a browser keeps to once it has seen the panel over HTTPS. */
const STRICT_TRANSPORT = "max-age=31536000";

/**
 * Tells a browser that reached the panel over HTTPS, under one of its own names, to keep to HTTPS
 * for that name, so that nothing on the way can strip TLS from a later sign-in. Plain HTTP and bare
 * addresses get nothing, as browsers ignore it there, and neither do the pages the panel serves for
 * the proxy under the names of services, whose policy is theirs.
 */
export function strictTransport(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (
      !c.req.path.startsWith(PROXY_PAGES_PREFIX) &&
      requestScheme(c, deps.config) === "https" &&
      // A server's request carries Host, from which its URL is built: the URL says it either way.
      isPanelOwnName(deps, c.req.header("host") ?? new URL(c.req.url).host)
    ) {
      c.header("Strict-Transport-Security", STRICT_TRANSPORT);
    }
  };
}

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
  // The same reach the routes compute, a role in every project included.
  const roleFor = (user: Parameters<typeof membershipsOf>[1], project: string) =>
    membershipsOf(deps.db, user).get(project) ?? null;

  const allow: TopicGuard["allow"] = (userId, topic) => {
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
      return metrics[0] !== undefined && roleFor(user, metrics[0]) !== null;
    }
    const logs = prefixed(topic, serviceLogsTopic("", "").replace("/", ""));
    if (logs !== null) {
      const role = logs[0] === undefined ? null : roleFor(user, logs[0]);
      return role !== null && meetsLevel(role, "operator");
    }
    if (topic.startsWith("action:")) {
      const action = findAction(deps.db, topic.slice("action:".length));
      const role = action?.projectName == null ? null : roleFor(user, action.projectName);
      return (
        action !== undefined &&
        role !== null &&
        meetsLevel(role, "operator") &&
        belongsToCurrent(deps.db, action)
      );
    }
    return false;
  };

  return {
    allow,

    deliver(userId, topic, payload) {
      const user = findUser(deps.db, userId);
      if (user === undefined || needsTwoFactorSetup(deps.db, user)) {
        return false;
      }
      // Rights can go while a socket stays open, as when a project is destroyed and its members with
      // it: every frame is held to the rights as they are now, not as they were at subscribing.
      if (topic !== actionsTopic) {
        return allow(userId, topic);
      }
      if (user.role === "admin") {
        return true;
      }
      const entry = payload as Pick<ActionShape, "projectName" | "actorEmail">;
      return entry.projectName === null
        ? entry.actorEmail === user.email
        : roleFor(user, entry.projectName) !== null;
    },
  };
}

type ActionShape = Parameters<typeof canSeeAction>[1];
