import type {
  BasicAuthEntry,
  CreateBasicAuthRequest,
  RevealedSecret,
  StoredBasicAuthEntry,
  UpdateBasicAuthRequest,
} from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import { conflict, notFound } from "../../../core/errors";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget, writeProxyConfig } from "../../services/service";
import { BASIC_AUTH_PASSWORD_CONTEXT } from "../../services/spec";

/** Traefik checks this cost on every request, so it stays as low as bcrypt's usual default. */
const BCRYPT_COST = 10;

const toEntry = ({ id, username, sealedPassword }: StoredBasicAuthEntry): BasicAuthEntry => ({
  id,
  username,
  revealable: sealedPassword !== null,
});

async function apply(deps: AppDeps, target: ServiceTarget, basicAuth: StoredBasicAuthEntry[]): Promise<void> {
  const record = requireService(deps, target);
  const spec = { ...record.spec, basicAuth };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  await writeProxyConfig(deps, target, spec);
}

/** The hash for Traefik, and the password sealed so that it can be shown again. */
async function protect(
  deps: AppDeps,
  password: string,
): Promise<Pick<StoredBasicAuthEntry, "passwordHash" | "sealedPassword">> {
  return {
    passwordHash: await bcrypt.hash(password, BCRYPT_COST),
    sealedPassword: deps.secrets.seal(password, BASIC_AUTH_PASSWORD_CONTEXT),
  };
}

const TAKEN = "This username is already in the list";

function assertUsernameFree(
  entries: readonly StoredBasicAuthEntry[],
  username: string,
  ownId?: string,
): void {
  if (entries.some((entry) => entry.username === username && entry.id !== ownId)) {
    throw conflict("basic_auth_taken", TAKEN, { username: TAKEN });
  }
}

function requireEntry(entries: readonly StoredBasicAuthEntry[], id: string): StoredBasicAuthEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw notFound("This entry does not exist.");
  }
  return entry;
}

export function listBasicAuth(deps: AppDeps, target: ServiceTarget): BasicAuthEntry[] {
  return requireService(deps, target).spec.basicAuth.map(toEntry);
}

export async function addBasicAuth(
  deps: AppDeps,
  target: ServiceTarget,
  request: CreateBasicAuthRequest,
): Promise<BasicAuthEntry> {
  assertUsernameFree(requireService(deps, target).spec.basicAuth, request.username);
  const secret = await protect(deps, request.password);

  // Hashing yields to other requests, so the list is read again after it.
  const current = requireService(deps, target).spec.basicAuth;
  assertUsernameFree(current, request.username);
  const entry: StoredBasicAuthEntry = { id: nanoid(), username: request.username, ...secret };
  await apply(deps, target, [...current, entry]);
  return toEntry(entry);
}

export async function updateBasicAuth(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  request: UpdateBasicAuthRequest,
): Promise<BasicAuthEntry> {
  const entries = requireService(deps, target).spec.basicAuth;
  requireEntry(entries, id);
  assertUsernameFree(entries, request.username, id);
  const secret = request.password === undefined ? undefined : await protect(deps, request.password);

  const current = requireService(deps, target).spec.basicAuth;
  const existing = requireEntry(current, id);
  assertUsernameFree(current, request.username, id);
  const updated: StoredBasicAuthEntry = {
    id,
    username: request.username,
    passwordHash: secret?.passwordHash ?? existing.passwordHash,
    sealedPassword: secret === undefined ? existing.sealedPassword : secret.sealedPassword,
  };
  await apply(
    deps,
    target,
    current.map((entry) => (entry.id === id ? updated : entry)),
  );
  return toEntry(updated);
}

export async function deleteBasicAuth(deps: AppDeps, target: ServiceTarget, id: string): Promise<void> {
  const entries = requireService(deps, target).spec.basicAuth;
  requireEntry(entries, id);
  await apply(
    deps,
    target,
    entries.filter((entry) => entry.id !== id),
  );
}

/**
 * Reads one user's password, and leaves a line in the activity log naming who asked. The only
 * place on the API where a basic auth password is ever returned.
 */
export function revealBasicAuthPassword(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  actorEmail: string | undefined,
): RevealedSecret {
  const entry = requireEntry(requireService(deps, target).spec.basicAuth, id);
  if (entry.sealedPassword === null) {
    throw conflict(
      "password_not_kept",
      "This password was set before the panel kept basic auth passwords. Give this user a new password to be able to show it.",
    );
  }
  const value = deps.secrets.unseal(entry.sealedPassword, BASIC_AUTH_PASSWORD_CONTEXT);
  deps.actions.record({
    type: "service.security-reveal",
    title: `Reveal the basic auth password of ${entry.username} on ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return { value };
}
