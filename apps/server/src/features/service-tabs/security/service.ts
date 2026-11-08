import type {
  BasicAuthEntry,
  CreateBasicAuthRequest,
  StoredBasicAuthEntry,
  UpdateBasicAuthRequest,
} from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import { conflict, notFound } from "../../../core/errors";
import { saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget, writeProxyConfig } from "../../services/service";

/** Traefik checks this cost on every request, so it stays as low as bcrypt's usual default. */
const BCRYPT_COST = 10;

const toEntry = ({ id, username }: StoredBasicAuthEntry): BasicAuthEntry => ({ id, username });

async function apply(deps: AppDeps, target: ServiceTarget, basicAuth: StoredBasicAuthEntry[]): Promise<void> {
  const record = requireService(deps, target);
  const spec = { ...record.spec, basicAuth };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  await writeProxyConfig(deps, target, spec);
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
  const passwordHash = await bcrypt.hash(request.password, BCRYPT_COST);

  // Hashing yields to other requests, so the list is read again after it.
  const current = requireService(deps, target).spec.basicAuth;
  assertUsernameFree(current, request.username);
  const entry: StoredBasicAuthEntry = { id: nanoid(), username: request.username, passwordHash };
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
  const newHash =
    request.password === undefined ? undefined : await bcrypt.hash(request.password, BCRYPT_COST);

  const current = requireService(deps, target).spec.basicAuth;
  const existing = requireEntry(current, id);
  assertUsernameFree(current, request.username, id);
  const updated: StoredBasicAuthEntry = {
    id,
    username: request.username,
    passwordHash: newHash ?? existing.passwordHash,
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
