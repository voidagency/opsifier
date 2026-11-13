/**
 * Which rights each API route needs, decided from the method and path alone. Authorization lives
 * here in one table so that a route added later is denied until someone decides otherwise, instead
 * of being open because someone forgot a check. Handlers still filter what they list.
 */

export type ProjectLevel = "viewer" | "operator" | "admin";

export type Requirement =
  /** Public routes, and lists whose handlers filter by project access. */
  | { kind: "open" }
  /** Reached with a credential of its own, not an account's: its route checks that, and no account can. */
  | { kind: "own_credential" }
  /** Only a person at a browser. */
  | { kind: "session" }
  /** Global administration. `session` keeps API keys out as well. */
  | { kind: "admin"; session: boolean }
  /** The server itself: its shell, its disk and a reboot. A right of its own, never reachable with a key. */
  | { kind: "host" }
  /** Inside one project. Out of reach looks the same as missing. */
  | { kind: "project"; project: string; level: ProjectLevel; session: boolean };

const OPEN: Requirement = { kind: "open" };
const OWN_CREDENTIAL: Requirement = { kind: "own_credential" };
const SESSION: Requirement = { kind: "session" };
const ADMIN: Requirement = { kind: "admin", session: false };
/** Account administration, server settings and other keys: never reachable with an API key. */
const SERVER_ADMIN: Requirement = { kind: "admin", session: true };
const HOST_ADMIN: Requirement = { kind: "host" };

const isSafeMethod = (method: string) => method === "GET" || method === "HEAD";

/** Global sections that are server settings, closed to API keys. */
const SERVER_SETTINGS_ROOTS = new Set([
  "users",
  "settings",
  "server",
  "notifications",
  "certificates",
  "server-purpose",
  "storage-providers",
]);

/**
 * What a viewer may read inside a project: the inventory and the state of things. Anything not listed
 * needs at least an operator, which is what keeps sources, notes, logs and secrets out of reach.
 */
function isViewerReadable(rest: readonly string[]): boolean {
  if (rest.length === 0) {
    return true;
  }
  if (rest[0] !== "services") {
    return false;
  }
  const [, service, section, leaf, ...more] = rest;
  if (service === undefined || more.length > 0) {
    return false;
  }
  if (section === undefined) {
    return true;
  }
  if (section === "metrics") {
    return leaf === undefined || leaf === "history";
  }
  if (section === "domains") {
    return leaf === undefined || leaf === "exposed-ports";
  }
  return false;
}

function projectRequirement(method: string, project: string, rest: readonly string[]): Requirement {
  const safe = isSafeMethod(method);
  if (rest.length === 0 && method === "DELETE") {
    return { kind: "project", project, level: "admin", session: false };
  }
  if (rest[0] === "members") {
    // Who reaches a project is account administration: an administrator at a browser, never a key.
    return { kind: "project", project, level: "admin", session: true };
  }
  if (rest[2] === "console") {
    return { kind: "project", project, level: "admin", session: false };
  }
  if (rest[2] === "deployments" && (rest[3] === "trigger" || rest[3] === "webhook")) {
    // A trigger or webhook is its own credential, separate from sessions and API keys.
    return { kind: "project", project, level: "operator", session: true };
  }
  if (rest[2] === "box" && rest[3] === "ide") {
    // So is the token that opens a box's IDE, which is written to files on the server.
    return { kind: "project", project, level: "operator", session: true };
  }
  return {
    kind: "project",
    project,
    level: safe && isViewerReadable(rest) ? "viewer" : "operator",
    session: false,
  };
}

export function requirementFor(method: string, path: string): Requirement {
  const prefix = "/api/v1/";
  if (!path.startsWith(prefix)) {
    return OPEN;
  }
  const [root, second, ...rest] = path.slice(prefix.length).split("/");
  switch (root) {
    case "auth":
    case "health":
    case "openapi.json":
    case "deploy":
    case "ws":
    case "terminal":
      return OPEN;
    case "ide":
      return OWN_CREDENTIAL;
    case "me":
      return SESSION;
    case "actions":
      return OPEN;
    case "templates":
      // The catalogue is public knowledge: installing one is what needs rights, inside a project.
      return OPEN;
    case "server":
      return second === "reboot" || second === "disk" ? HOST_ADMIN : SERVER_ADMIN;
    case "server-purpose":
      return second === undefined && isSafeMethod(method) ? OPEN : SERVER_ADMIN;
    case "system":
      // Updating or rolling back the panel is server administration, as much as its settings are.
      return (second === "info" || second === "storage") && isSafeMethod(method) ? OPEN : SERVER_ADMIN;
    case "domains":
      return second === undefined && isSafeMethod(method) ? OPEN : SERVER_ADMIN;
    case "projects":
      if (second === undefined) {
        return isSafeMethod(method) ? OPEN : ADMIN;
      }
      return projectRequirement(method, second, rest);
    default:
      return root !== undefined && SERVER_SETTINGS_ROOTS.has(root) ? SERVER_ADMIN : ADMIN;
  }
}
