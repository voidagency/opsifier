import { randomInt } from "node:crypto";
import {
  type AllowlistEntry,
  type AllowlistState,
  type CreateAllowlistEntryRequest,
  type CreateProtectionUserRequest,
  isProtectedPurpose,
  MAX_ALLOWLIST_ENTRIES,
  type ProtectedDomain,
  type ProtectionProblem,
  type ProtectionUser,
  type ProtectionUserResult,
  publicConfirmation,
  type ServerPurposeState,
  type SetServerPurposeRequest,
  type SetServerPurposeResult,
  type ShownOnceCredentials,
  type UpdateProtectionUserRequest,
} from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { AppError, conflict, notFound } from "../../core/errors";
import {
  InvalidProxyInputError,
  type ProxyGuard,
  type RewritePlan,
  type RoutingFile,
} from "../../core/proxy";
import { auditRoutingFiles, type ProtectionPlan, protectRoutingFile } from "../services/compile/protection";
import { findService, listServiceRecords } from "../services/repo";
import { type ProtectionState, readProtection, type StoredUser, saveProtection } from "./repo";

/** Traefik checks this on every request, so it stays at bcrypt's usual cost. */
const BCRYPT_COST = 10;
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SAFE_USERNAME = /^[A-Za-z0-9._@-]+$/;
/** No letters that are easy to confuse, since people copy this out of a dialog. */
const GENERATED_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
/** 32 characters of 5 bits each: 160 bits from a CSPRNG. */
const GENERATED_LENGTH = 32;
const DEFAULT_USERNAME = "opsifier";

function generatePassword(): string {
  let password = "";
  for (let index = 0; index < GENERATED_LENGTH; index += 1) {
    password += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)];
  }
  return password;
}

/** Compared as text on purpose: a damaged stored entry must never make every write fail. */
const routingFileOf = ({ project, service }: { project: string; service: string }) =>
  `${project}__${service}.yaml`;

function planFor(file: string, state: ProtectionState): ProtectionPlan {
  return {
    enabled: isProtectedPurpose(state.purpose),
    users: state.users
      .filter((user) => SAFE_USERNAME.test(user.username) && BCRYPT_HASH.test(user.passwordHash))
      .map((user) => `${user.username}:${user.passwordHash}`),
    exemptions: state.allowlist.filter((entry) => routingFileOf(entry) === file),
  };
}

/**
 * What stands between the compilers and the proxy. It reads the state as each file is written, so
 * a route compiled before a change of purpose still lands under the purpose in force at that moment.
 */
export function protectionGuard(db: DbHandle, now: () => number): ProxyGuard {
  return {
    apply: (file, config) => protectRoutingFile(file, config, planFor(file, readProtection(db))),
    forget(file) {
      const state = readProtection(db);
      const allowlist = state.allowlist.filter((entry) => routingFileOf(entry) !== file);
      if (allowlist.length !== state.allowlist.length) {
        saveProtection(db, { ...state, allowlist }, new Date(now()));
      }
    },
  };
}

/** Brings what is on disk in line with the stored purpose, at every start. */
export async function reconcileProtection(deps: AppDeps): Promise<void> {
  const state = readProtection(deps.db);
  const failed = await deps.proxy.reconcile((file, config) =>
    protectRoutingFile(file, config, planFor(file, state)),
  );
  if (failed.length === 0) {
    return;
  }
  if (!isProtectedPurpose(state.purpose)) {
    deps.logger.error({ files: failed }, "Could not bring some routing files in line with production");
    return;
  }
  for (const file of failed) {
    await deps.proxy.discard(file);
    deps.logger.error({ file }, "Removed a routing file that could not be protected");
    deps.actions.record({
      type: "server.purpose",
      title: `Remove ${file}: it could not be protected`,
      status: "failed",
      error: "The routing file could not be read or rewritten.",
    });
  }
}

function routeOwner(file: string): { project: string; service: string } {
  const stem = file.replace(/\.ya?ml$/, "");
  const [project = "", service] = stem.split("__");
  return service === undefined ? { project: "", service: stem } : { project, service };
}

const domainOrder: Record<ProtectedDomain["status"], number> = { exposed: 0, protected: 1, public: 2 };

function describeState(state: ProtectionState, files: readonly RoutingFile[]): ServerPurposeState {
  const protection = isProtectedPurpose(state.purpose);
  const audit = auditRoutingFiles(files, protection);
  const domains = audit.domains
    .map<ProtectedDomain>((domain) => ({
      host: domain.host,
      path: domain.path,
      wildcard: domain.wildcard,
      ...routeOwner(domain.file),
      status: !protection ? "public" : domain.protected ? "protected" : "exposed",
    }))
    .sort((a, b) => domainOrder[a.status] - domainOrder[b.status] || a.host.localeCompare(b.host));

  const problems: ProtectionProblem[] = [];
  if (protection) {
    if (state.users.length === 0) {
      problems.push({ code: "no_credentials" });
    }
    if (!audit.panelProtected) {
      problems.push({ code: "panel_exposed" });
    }
  }
  problems.push(...audit.unreadable.map((file): ProtectionProblem => ({ code: "unreadable_file", file })));

  return {
    purpose: state.purpose,
    protection,
    domains,
    protectedCount: domains.filter((domain) => domain.status === "protected").length,
    totalCount: domains.length,
    problems,
    confirmation: publicConfirmation(domains.length),
  };
}

export async function getServerPurposeState(deps: AppDeps): Promise<ServerPurposeState> {
  return describeState(readProtection(deps.db), await deps.proxy.readAll());
}

/** A change to the state, carried out over every routing file as one. */
function planChange(deps: AppDeps, before: ProtectionState, after: ProtectionState): RewritePlan {
  return {
    protecting: isProtectedPurpose(after.purpose) && !isProtectedPurpose(before.purpose),
    render: (file, config) => protectRoutingFile(file, config, planFor(file, after)),
    commit: () => saveProtection(deps.db, after, new Date(deps.now())),
    revert: () => saveProtection(deps.db, before, new Date(deps.now())),
  };
}

const NOT_APPLIED = "The proxy's files could not be written, so nothing changed.";

function recordOutcome(
  deps: AppDeps,
  entry: { type: string; title: string; project?: string; service?: string; actorEmail: string | undefined },
  failure?: unknown,
): void {
  const { project, service, ...rest } = entry;
  deps.actions.record({
    ...rest,
    projectName: project,
    serviceName: service,
    ...(failure === undefined ? {} : { status: "failed" as const, error: NOT_APPLIED }),
  });
  if (failure !== undefined) {
    deps.logger.error({ err: failure, title: entry.title }, NOT_APPLIED);
  }
}

/** Runs a change, says so in the Activity log, and turns a proxy failure into a clear error. */
async function applied<T>(
  deps: AppDeps,
  entry: { type: string; title: string; project?: string; service?: string; actorEmail: string | undefined },
  change: () => Promise<T>,
): Promise<T> {
  try {
    const result = await change();
    recordOutcome(deps, entry);
    return result;
  } catch (error) {
    throw reportFailure(deps, entry, error);
  }
}

/** A refused request stays what it is. A route that can't be protected says why. Anything else is the proxy. */
function reportFailure(
  deps: AppDeps,
  entry: { type: string; title: string; project?: string; service?: string; actorEmail: string | undefined },
  error: unknown,
): Error {
  if (error instanceof AppError) {
    return error;
  }
  recordOutcome(deps, entry, error);
  if (error instanceof InvalidProxyInputError) {
    return conflict("route_cannot_be_protected", error.message);
  }
  return new AppError(500, "protection_not_applied", NOT_APPLIED);
}

async function newUser(username: string, password: string): Promise<StoredUser> {
  return {
    id: nanoid(),
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    createdAt: new Date().toISOString(),
  };
}

function requireConfirmation(confirm: string | undefined, expected: string): void {
  if (confirm !== expected) {
    throw conflict("confirmation_mismatch", `Type ${expected} to confirm.`, {
      confirm: `Type ${expected} to confirm`,
    });
  }
}

export async function setServerPurpose(
  deps: AppDeps,
  request: SetServerPurposeRequest,
  actorEmail: string | undefined,
): Promise<SetServerPurposeResult> {
  const { purpose } = request;
  // Hashing takes a while, so it happens before the queue is held, on the chance it is needed.
  const password = generatePassword();
  const initial = await newUser(DEFAULT_USERNAME, password);
  let credentials: ShownOnceCredentials | null = null;
  let changed = false;

  const entry = {
    type: "server.purpose",
    title: `Set the server's purpose to ${purpose}`,
    actorEmail,
  };
  const apply = () =>
    deps.proxy.rewriteAll(async () => {
      const before = readProtection(deps.db);
      if (before.purpose === purpose) {
        return planChange(deps, before, before);
      }
      if (purpose === "production") {
        const { confirmation } = describeState(before, await deps.proxy.readAll());
        requireConfirmation(request.confirm, confirmation);
      }
      changed = true;
      const needsUser = isProtectedPurpose(purpose) && before.users.length === 0;
      if (needsUser) {
        credentials = { username: DEFAULT_USERNAME, password };
      }
      return planChange(deps, before, {
        ...before,
        purpose,
        users: needsUser ? [initial] : before.users,
      });
    });

  // Nothing to report when the purpose was already the one asked for.
  try {
    await apply();
  } catch (error) {
    throw reportFailure(deps, entry, error);
  }
  if (changed) {
    recordOutcome(deps, entry);
  }
  return { state: await getServerPurposeState(deps), credentials };
}

const toUser = ({ id, username, createdAt }: StoredUser): ProtectionUser => ({ id, username, createdAt });

export function listProtectionUsers(deps: AppDeps): ProtectionUser[] {
  return readProtection(deps.db).users.map(toUser);
}

/** Every change here goes over the proxy's files together with the state, one way or the other. */
function changeState(deps: AppDeps, transform: (before: ProtectionState) => ProtectionState): Promise<void> {
  return deps.proxy.rewriteAll(() => {
    const before = readProtection(deps.db);
    return planChange(deps, before, transform(before));
  });
}

const USERNAME_TAKEN = "This username is already in the list";

function assertUsernameFree(state: ProtectionState, username: string): void {
  if (state.users.some((user) => user.username === username)) {
    throw conflict("protection_user_taken", USERNAME_TAKEN, { username: USERNAME_TAKEN });
  }
}

export async function addProtectionUser(
  deps: AppDeps,
  request: CreateProtectionUserRequest,
  actorEmail: string | undefined,
): Promise<ProtectionUserResult> {
  assertUsernameFree(readProtection(deps.db), request.username);
  const password = request.password ?? generatePassword();
  const user = await newUser(request.username, password);
  await applied(
    deps,
    { type: "server.credentials", title: `Add ${request.username} to the server's credentials`, actorEmail },
    () =>
      changeState(deps, (before) => {
        // Hashing yielded to other requests, so the list is checked again.
        assertUsernameFree(before, request.username);
        return { ...before, users: [...before.users, user] };
      }),
  );
  return {
    user: toUser(user),
    credentials: request.password === undefined ? { username: request.username, password } : null,
  };
}

function requireUser(state: ProtectionState, id: string): StoredUser {
  const user = state.users.find((candidate) => candidate.id === id);
  if (user === undefined) {
    throw notFound("This user does not exist.");
  }
  return user;
}

export async function updateProtectionUser(
  deps: AppDeps,
  id: string,
  request: UpdateProtectionUserRequest,
  actorEmail: string | undefined,
): Promise<ProtectionUserResult> {
  const current = requireUser(readProtection(deps.db), id);
  const password = request.password ?? generatePassword();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await applied(
    deps,
    {
      type: "server.credentials",
      title: `Change the password of ${current.username} in the server's credentials`,
      actorEmail,
    },
    () =>
      changeState(deps, (before) => {
        requireUser(before, id);
        return {
          ...before,
          users: before.users.map((user) => (user.id === id ? { ...user, passwordHash } : user)),
        };
      }),
  );
  return {
    user: toUser(current),
    credentials: request.password === undefined ? { username: current.username, password } : null,
  };
}

export async function removeProtectionUser(
  deps: AppDeps,
  id: string,
  actorEmail: string | undefined,
): Promise<void> {
  const current = requireUser(readProtection(deps.db), id);
  await applied(
    deps,
    {
      type: "server.credentials",
      title: `Remove ${current.username} from the server's credentials`,
      actorEmail,
    },
    () =>
      changeState(deps, (before) => {
        requireUser(before, id);
        if (isProtectedPurpose(before.purpose) && before.users.length === 1) {
          throw conflict(
            "protection_last_user",
            "Add another user first: a protected server always keeps one.",
          );
        }
        return { ...before, users: before.users.filter((user) => user.id !== id) };
      }),
  );
}

export function getAllowlist(deps: AppDeps): AllowlistState {
  return {
    entries: readProtection(deps.db).allowlist,
    services: listServiceRecords(deps.db).map((record) => ({
      project: record.projectName,
      service: record.name,
    })),
  };
}

export async function addAllowlistEntry(
  deps: AppDeps,
  request: CreateAllowlistEntryRequest,
  actorEmail: string | undefined,
): Promise<AllowlistEntry> {
  const { project, service, kind, value } = request;
  if (findService(deps.db, project, service) === undefined) {
    throw notFound("This service does not exist.");
  }
  const entry: AllowlistEntry = {
    id: nanoid(),
    project,
    service,
    kind,
    value,
    createdAt: new Date(deps.now()).toISOString(),
  };
  await applied(
    deps,
    {
      type: "server.allowlist",
      title: `Exempt ${value} on ${project}/${service} from the server's protection`,
      project,
      service,
      actorEmail,
    },
    () =>
      changeState(deps, (before) => {
        const own = before.allowlist.filter((item) => item.project === project && item.service === service);
        if (own.some((item) => item.kind === kind && item.value === value)) {
          throw conflict("allowlist_entry_exists", "This entry is already on the list.", {
            value: "This entry is already on the list",
          });
        }
        if (own.length >= MAX_ALLOWLIST_ENTRIES) {
          throw conflict("allowlist_full", `A service can have at most ${MAX_ALLOWLIST_ENTRIES} exemptions.`);
        }
        return { ...before, allowlist: [...before.allowlist, entry] };
      }),
  );
  return entry;
}

export async function removeAllowlistEntry(
  deps: AppDeps,
  id: string,
  actorEmail: string | undefined,
): Promise<void> {
  const current = readProtection(deps.db).allowlist.find((entry) => entry.id === id);
  if (current === undefined) {
    throw notFound("This exemption does not exist.");
  }
  await applied(
    deps,
    {
      type: "server.allowlist",
      title: `Remove the exemption of ${current.value} on ${current.project}/${current.service}`,
      project: current.project,
      service: current.service,
      actorEmail,
    },
    () =>
      changeState(deps, (before) => ({
        ...before,
        allowlist: before.allowlist.filter((entry) => entry.id !== id),
      })),
  );
}
