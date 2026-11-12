import type {
  ApiKey,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateUserRequest,
  PanelUser,
  ProjectGrant,
  UpdateUserRequest,
} from "@opsifier/contract";
import { createApiKeyRequest, projectGrant, userRole } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { z } from "zod";
import {
  createApiToken,
  hashPassword,
  holdsHostAdmin,
  type Principal,
  revokeApiToken,
  revokeUserCredentials,
} from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { badRequest, conflict, forbidden, notFound } from "../../core/errors";
import { deleteInvitationsBy } from "../invitations/repo";
import { revokeBoxIdeTokensOfAccount } from "../service-tabs/box-ide/service";
import { revokeTriggersOfAccount } from "../service-tabs/deployments/trigger";
import * as repo from "./repo";
import { accessOf, meetsLevel, roleInProject } from "./rules";

type SessionPrincipal = Extract<Principal, { kind: "session" }>;

const MAX_KEYS_PER_USER = 64;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

function toPanelUser(user: repo.UserRow, grants: readonly ProjectGrant[], keyCount: number): PanelUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: userRole.parse(user.role),
    owner: user.isOwner,
    hostAdmin: holdsHostAdmin(user),
    twoFactorEnabled: user.totpSecret !== null,
    active: user.deactivatedAt === null,
    createdAt: user.createdAt.toISOString(),
    projects: [...grants],
    apiKeyCount: keyCount,
  };
}

export function toApiKey(row: repo.ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    level: row.level,
    projects: row.projects ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    // Keys issued before expiry existed are shown with the date they would have had.
    expiresAt: (row.expiresAt ?? new Date(row.createdAt.getTime() + 365 * MS_PER_DAY)).toISOString(),
  };
}

function assertProjectsExist(deps: AppDeps, names: readonly string[], field: string): void {
  const found = repo.existingProjects(deps.db, names);
  const missing = names.find((name) => !found.has(name));
  if (missing !== undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      [field]: `Project ${missing} does not exist`,
    });
  }
}

/** Keeps only what the account can reach, so a grant list is never more than it can be. */
const grantsFor = (role: string, requested: readonly ProjectGrant[]) =>
  role === "admin" ? [] : [...requested];

/** A change takes rights away when it drops a grant, weakens one or ends an administrator role. */
function reducesRights(
  before: { role: string; grants: ReadonlyMap<string, string> },
  after: { role: string; grants: readonly ProjectGrant[] },
): boolean {
  if (before.role === "admin" && after.role !== "admin") {
    return true;
  }
  const next = new Map(after.grants.map((grant) => [grant.project, grant.role]));
  return [...before.grants].some(([project, role]) => {
    const updated = next.get(project);
    return updated === undefined || (role === "operator" && updated === "viewer");
  });
}

/**
 * Which projects' deployment tokens from before issuers were recorded this account could read until
 * now and no longer can. Reading one took an operator's rights, or an administrator's anywhere.
 */
function lostTriggerReach(
  before: { role: string; grants: ReadonlyMap<string, string> },
  after: { role: string; grants: readonly ProjectGrant[] },
): (project: string) => boolean {
  if (after.role === "admin") {
    return () => false;
  }
  const operatorAfter = new Set(
    after.grants.filter((grant) => grant.role === "operator").map((grant) => grant.project),
  );
  return (project) =>
    (before.role === "admin" || before.grants.get(project) === "operator") && !operatorAfter.has(project);
}

function grantsOf(deps: AppDeps, userId: string): Map<string, "viewer" | "operator"> {
  const grants = new Map<string, "viewer" | "operator">();
  for (const row of repo.allMemberships(deps.db)) {
    if (row.userId === userId) {
      grants.set(row.projectName, projectGrant.shape.role.parse(row.role));
    }
  }
  return grants;
}

export function listPanelUsers(deps: AppDeps): PanelUser[] {
  const grants = new Map<string, ProjectGrant[]>();
  for (const row of repo.allMemberships(deps.db)) {
    grants.set(row.userId, [
      ...(grants.get(row.userId) ?? []),
      { project: row.projectName, role: projectGrant.shape.role.parse(row.role) },
    ]);
  }
  const counts = repo.apiKeyCounts(deps.db);
  return repo
    .listUsers(deps.db)
    .map((user) => toPanelUser(user, grants.get(user.id) ?? [], counts.get(user.id) ?? 0));
}

function emailTaken() {
  return conflict("email_taken", "That email is already in use.", { email: "Already in use" });
}

function isConstraintViolation(error: unknown): boolean {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  return (code ?? cause?.code ?? "").startsWith("SQLITE_CONSTRAINT");
}

export async function createPanelUser(
  deps: AppDeps,
  actor: SessionPrincipal,
  request: CreateUserRequest,
): Promise<PanelUser> {
  const email = normalizeEmail(request.email);
  const grants = grantsFor(request.role, request.projects);
  assertProjectsExist(
    deps,
    grants.map((grant) => grant.project),
    "projects",
  );
  const passwordHash = await hashPassword(request.password);
  const now = new Date(deps.now());
  const id = nanoid();

  try {
    deps.db.transaction(
      (tx) => {
        if (repo.findUserByEmail(tx, email) !== undefined) {
          throw emailTaken();
        }
        repo.insertUser(tx, {
          id,
          email,
          passwordHash,
          role: request.role,
          createdAt: now,
          updatedAt: now,
        });
        repo.replaceMemberships(tx, id, grants, now);
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    throw isConstraintViolation(error) ? emailTaken() : error;
  }

  deps.actions.record({
    type: "auth.user-create",
    title: `Create the account ${email}`,
    actorEmail: actor.user.email,
  });
  return findPanelUser(deps, id);
}

function findPanelUser(deps: AppDeps, id: string): PanelUser {
  const user = listPanelUsers(deps).find((candidate) => candidate.id === id);
  if (user === undefined) {
    throw notFound("This account does not exist.");
  }
  return user;
}

export async function updatePanelUser(
  deps: AppDeps,
  actor: SessionPrincipal,
  id: string,
  request: UpdateUserRequest,
): Promise<PanelUser> {
  const current = repo.findUserById(deps.db, id);
  if (current === undefined) {
    throw notFound("This account does not exist.");
  }
  if (current.isOwner && request.role !== "admin") {
    throw conflict("owner_protected", "The owner's account can't be demoted.", {
      role: "The owner stays an administrator",
    });
  }
  if (
    id === actor.user.id &&
    (request.role !== current.role || request.email !== current.email || request.password)
  ) {
    throw conflict("change_own_account", "Change your own email and password on your Authentication page.");
  }

  const email = normalizeEmail(request.email);
  const grants = grantsFor(request.role, request.projects);
  assertProjectsExist(
    deps,
    grants.map((grant) => grant.project),
    "projects",
  );

  const passwordHash = request.password === undefined ? undefined : await hashPassword(request.password);
  const before = { role: current.role, grants: grantsOf(deps, id) };
  const after = { role: request.role, grants };
  const hostAdmin = hostAdminAfter(actor, current, request);
  const emailChanged = email !== current.email;
  const revoke =
    emailChanged ||
    passwordHash !== undefined ||
    reducesRights(before, after) ||
    (current.hostAdmin && !hostAdmin);
  const now = new Date(deps.now());

  let ended: string[] = [];
  try {
    deps.db.transaction(
      (tx) => {
        const holder = repo.findUserByEmail(tx, email);
        if (holder !== undefined && holder.id !== id) {
          throw emailTaken();
        }
        repo.updateUserRow(tx, id, {
          email,
          role: request.role,
          hostAdmin,
          updatedAt: now,
          ...(passwordHash === undefined ? {} : { passwordHash }),
        });
        repo.replaceMemberships(tx, id, grants, now);
        if (revoke) {
          ended = revokeUserCredentials(tx, id);
          revokeTriggersOfAccount(tx, id, lostTriggerReach(before, after), now);
        }
        if (current.role === "admin" && request.role !== "admin") {
          // An invitation speaks for whoever sent it, and they can no longer send one.
          deleteInvitationsBy(tx, id);
        }
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    throw isConstraintViolation(error) ? emailTaken() : error;
  }

  deps.realtime.disconnectSessions(ended);
  deps.actions.record({
    type: "auth.user-update",
    title: `Update the account ${email}`,
    actorEmail: actor.user.email,
  });
  return findPanelUser(deps, id);
}

/** Only the owner hands out the server itself, and only an administrator can hold it. */
function hostAdminAfter(actor: SessionPrincipal, current: repo.UserRow, request: UpdateUserRequest): boolean {
  if (request.hostAdmin !== undefined && request.hostAdmin !== holdsHostAdmin(current)) {
    assertOwner(actor);
  }
  const wanted = request.hostAdmin ?? current.hostAdmin;
  return !current.isOwner && request.role === "admin" && wanted;
}

export function deletePanelUser(deps: AppDeps, actor: SessionPrincipal, id: string, confirm: string): void {
  const current = repo.findUserById(deps.db, id);
  if (current === undefined) {
    throw notFound("This account does not exist.");
  }
  if (current.isOwner) {
    throw conflict("owner_protected", "The owner's account can't be deleted.");
  }
  if (id === actor.user.id) {
    throw conflict("change_own_account", "You can't delete your own account.");
  }
  if (confirm !== current.email) {
    throw conflict("confirmation_mismatch", "Type the account's exact email to confirm.", {
      confirm: "Does not match the account's email",
    });
  }

  const ended = repo.sessionIdsOf(deps.db, id);
  const wasAdmin = current.role === "admin";
  const grants = grantsOf(deps, id);
  deps.db.transaction(
    (tx) => {
      revokeTriggersOfAccount(
        tx,
        id,
        (project) => wasAdmin || grants.get(project) === "operator",
        new Date(deps.now()),
      );
      repo.deleteUserRow(tx, id);
    },
    { behavior: "immediate" },
  );
  deps.realtime.disconnectSessions(ended);
  deps.actions.record({
    type: "auth.user-delete",
    title: `Delete the account ${current.email}`,
    actorEmail: actor.user.email,
  });
}

/**
 * Takes an account out of use, or brings it back. What it was doing ends at once, its keys are gone
 * for good, and its rights are kept for when it returns. The owner and the caller stay in use, so
 * that a panel always has someone who can undo this.
 */
export function setPanelUserActive(
  deps: AppDeps,
  actor: SessionPrincipal,
  id: string,
  active: boolean,
): PanelUser {
  const current = repo.findUserById(deps.db, id);
  if (current === undefined) {
    throw notFound("This account does not exist.");
  }
  if (!active && current.isOwner) {
    throw conflict("owner_protected", "The owner's account can't be deactivated.");
  }
  if (!active && id === actor.user.id) {
    throw conflict("change_own_account", "You can't deactivate your own account.");
  }

  const now = new Date(deps.now());
  let ended: string[] = [];
  deps.db.transaction(
    (tx) => {
      repo.updateUserRow(tx, id, { deactivatedAt: active ? null : now, updatedAt: now });
      if (!active) {
        ended = revokeUserCredentials(tx, id);
        revokeBoxIdeTokensOfAccount(tx, id, now);
        deleteInvitationsBy(tx, id);
      }
    },
    { behavior: "immediate" },
  );
  deps.realtime.disconnectSessions(ended);
  deps.actions.record({
    type: active ? "auth.user-reactivate" : "auth.user-deactivate",
    title: `${active ? "Reactivate" : "Deactivate"} the account ${current.email}`,
    actorEmail: actor.user.email,
  });
  return findPanelUser(deps, id);
}

export function listApiKeys(deps: AppDeps, userId: string): ApiKey[] {
  return repo.listApiKeys(deps.db, userId).map(toApiKey);
}

/** The plain token exists only in this answer. A key can never reach beyond its owner. */
export function createApiKey(
  deps: AppDeps,
  owner: SessionPrincipal,
  request: z.output<typeof createApiKeyRequest>,
): CreatedApiKey {
  if (repo.countApiKeys(deps.db, owner.user.id) >= MAX_KEYS_PER_USER) {
    throw conflict(
      "too_many_api_keys",
      "You have as many API keys as an account can hold. Revoke one first.",
    );
  }
  if (request.projects !== null) {
    assertProjectsExist(deps, request.projects, "projects");
    const access = accessOf(deps.db, owner);
    const outside = request.projects.find((project) => {
      const role = roleInProject(access, project);
      return role === null || !meetsLevel(role, "viewer");
    });
    if (outside !== undefined) {
      throw badRequest("validation_failed", "Some fields need attention.", {
        projects: `Project ${outside} does not exist`,
      });
    }
  }

  const now = deps.now();
  const { token, row } = createApiToken(deps.db, {
    userId: owner.user.id,
    name: request.name,
    now,
    level: request.level,
    projects: request.projects,
    expiresAt: new Date(now + request.expiresInDays * MS_PER_DAY),
  });
  deps.actions.record({
    type: "auth.api-key-create",
    title: `Create the API key ${request.name}`,
    actorEmail: owner.user.email,
  });
  return { ...toApiKey(row), token };
}

export function revokeApiKey(deps: AppDeps, actor: SessionPrincipal, userId: string, keyId: string): void {
  const key = repo.findApiKey(deps.db, userId, keyId);
  if (key === undefined) {
    throw notFound("This API key does not exist.");
  }
  revokeApiToken(deps.db, keyId);
  deps.actions.record({
    type: "auth.api-key-revoke",
    title: `Revoke the API key ${key.name}`,
    actorEmail: actor.user.email,
  });
}

export function assertOwner(actor: SessionPrincipal): void {
  if (!actor.user.isOwner) {
    throw forbidden("owner_required", "Only the owner of this panel can change this.");
  }
}

export const parseCreateKey = (request: CreateApiKeyRequest) => createApiKeyRequest.parse(request);
