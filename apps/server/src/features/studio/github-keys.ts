import type { AddStudioGithubKeyRequest, StudioGithubKey, StudioGithubKeyCheck } from "@opsifier/contract";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppDeps } from "../../core/context";
import { conflict, notFound } from "../../core/errors";
import { getSetting, putSetting } from "../system/repo";

/**
 * The Studio's GitHub keys: one token per GitHub account or organization, since a fine-grained token
 * reaches the repositories of one owner only. They serve projects that have an agent server of their
 * own: the panel copies such a project and passes its agent's git on to GitHub with the key of the
 * owner that holds its repository, and falls back on the model agent server's GITHUB_TOKEN secret
 * when there is none, or when GitHub refuses the key. A token is kept sealed and never sent back.
 */

const SETTINGS_KEY = "studio_github_keys";
const MAX_KEYS = 50;
const GITHUB_API = "https://api.github.com";
const CHECK_TIMEOUT_MS = 10_000;

const storedKey = z.object({
  id: z.string(),
  owner: z.string(),
  sealedToken: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  valid: z.boolean().nullable().default(null),
  login: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
});
type StoredKey = z.infer<typeof storedKey>;

/** Each sealed token is bound to its key, so one cannot be moved to stand in for another. */
const contextOf = (id: string) => `studio-github-key:${id}`;
const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The stored entries as they are. A value that is not a list is refused: writing would lose it. */
function storedEntries(deps: Pick<AppDeps, "db">): unknown[] {
  const value = getSetting(deps.db, SETTINGS_KEY);
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw conflict(
      "studio_github_keys_unreadable",
      "The Studio's GitHub keys cannot be read on this server, so nothing was changed.",
    );
  }
  return value;
}

/** Each entry read on its own: one that does not parse hides no other. */
function readKeys(deps: Pick<AppDeps, "db">): StoredKey[] {
  let entries: unknown[];
  try {
    entries = storedEntries(deps);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const parsed = storedKey.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Writes the keys a change makes, with every entry it could not read kept as it was. */
function updateKeys(
  deps: Pick<AppDeps, "db" | "now">,
  change: (keys: StoredKey[]) => StoredKey[],
): StoredKey[] {
  const entries = storedEntries(deps);
  const unreadable = entries.filter((entry) => !storedKey.safeParse(entry).success);
  const keys = change(
    entries.flatMap((entry) => {
      const parsed = storedKey.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  putSetting(deps.db, SETTINGS_KEY, [...keys, ...unreadable], new Date(deps.now()));
  return keys;
}

const toKey = ({ sealedToken: _sealed, ...key }: StoredKey): StudioGithubKey => key;

function requireKey(deps: Pick<AppDeps, "db">, id: string): StoredKey {
  const key = readKeys(deps).find((one) => one.id === id);
  if (key === undefined) {
    throw notFound("The Studio has no such GitHub key.");
  }
  return key;
}

export function listGithubKeys(deps: Pick<AppDeps, "db">): StudioGithubKey[] {
  return readKeys(deps)
    .sort((a, b) => a.owner.localeCompare(b.owner))
    .map(toKey);
}

export function addGithubKey(
  deps: AppDeps,
  request: AddStudioGithubKeyRequest,
  actorEmail: string | undefined,
): StudioGithubKey {
  const now = new Date(deps.now()).toISOString();
  const id = nanoid();
  const key: StoredKey = {
    id,
    owner: request.owner,
    sealedToken: deps.secrets.seal(request.token, contextOf(id)),
    createdAt: now,
    updatedAt: now,
    valid: null,
    login: null,
    expiresAt: null,
    checkedAt: null,
  };
  updateKeys(deps, (keys) => {
    if (keys.some((one) => sameOwner(one.owner, request.owner))) {
      throw conflict(
        "studio_github_key_exists",
        `The Studio has a GitHub key for ${request.owner} already: give it a new token instead.`,
        { owner: "Has a key already" },
      );
    }
    if (keys.length >= MAX_KEYS) {
      throw conflict("too_many_github_keys", `The Studio holds at most ${MAX_KEYS} GitHub keys.`);
    }
    return [...keys, key];
  });
  deps.actions.record({
    type: "studio.github-key",
    title: `Add the Studio's GitHub key for ${request.owner}`,
    actorEmail,
  });
  return toKey(key);
}

export function replaceGithubKey(
  deps: AppDeps,
  id: string,
  token: string,
  actorEmail: string | undefined,
): StudioGithubKey {
  const current = requireKey(deps, id);
  const replaced: StoredKey = {
    ...current,
    sealedToken: deps.secrets.seal(token, contextOf(id)),
    updatedAt: new Date(deps.now()).toISOString(),
    // What a check said was about the token before.
    valid: null,
    login: null,
    expiresAt: null,
    checkedAt: null,
  };
  updateKeys(deps, (keys) => keys.map((one) => (one.id === id ? replaced : one)));
  deps.actions.record({
    type: "studio.github-key",
    title: `Give the Studio's GitHub key for ${current.owner} a new token`,
    actorEmail,
  });
  return toKey(replaced);
}

export function removeGithubKey(deps: AppDeps, id: string, actorEmail: string | undefined): { id: string } {
  const current = requireKey(deps, id);
  updateKeys(deps, (keys) => keys.filter((one) => one.id !== id));
  deps.actions.record({
    type: "studio.github-key",
    title: `Remove the Studio's GitHub key for ${current.owner}`,
    actorEmail,
  });
  return { id };
}

/** Whether the Studio has a key for the owner of this repository, `owner/name`. */
export function hasGithubKeyFor(deps: Pick<AppDeps, "db">, repository: string): boolean {
  const owner = repository.split("/", 1)[0] ?? "";
  return readKeys(deps).some((one) => sameOwner(one.owner, owner));
}

/** The token of the key whose owner holds this repository, `owner/name`, or null without one. */
export function githubKeyFor(deps: Pick<AppDeps, "db" | "secrets">, repository: string): string | null {
  const owner = repository.split("/", 1)[0] ?? "";
  const key = readKeys(deps).find((one) => sameOwner(one.owner, owner));
  return key === undefined ? null : deps.secrets.unseal(key.sealedToken, contextOf(key.id));
}

/** GitHub writes when a token expires as `2026-12-16 10:00:00 UTC`, or with an offset. */
export function parseTokenExpiry(value: string | null): string | null {
  const match =
    value === null ? null : /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, day, time, zone] = match;
  const offset = zone === "UTC" ? "Z" : `${zone?.slice(0, 3)}:${zone?.slice(3)}`;
  const date = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The number of the last page GitHub links to, which, one item a page, is how many there are. */
export function lastPageOf(link: string | null): number | null {
  const match = link === null ? null : /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return match === null ? null : Number(match[1]);
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "Opsifier",
});

const failed = (message: string): StudioGithubKeyCheck => ({
  ok: false,
  login: null,
  expiresAt: null,
  repositories: null,
  message,
});

/** How many private repositories of the owner the token reads, when GitHub says. */
async function privateRepositories(
  token: string,
  owner: string,
  login: string | null,
): Promise<number | null> {
  const path =
    login !== null && sameOwner(login, owner)
      ? "/user/repos?visibility=private&affiliation=owner&per_page=1"
      : `/orgs/${encodeURIComponent(owner)}/repos?type=private&per_page=1`;
  try {
    const answer = await fetch(`${GITHUB_API}${path}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!answer.ok) {
      return null;
    }
    const last = lastPageOf(answer.headers.get("link"));
    if (last !== null) {
      return last;
    }
    const body = (await answer.json()) as unknown;
    return Array.isArray(body) ? body.length : null;
  } catch {
    return null;
  }
}

/**
 * Asks GitHub about the key's token, and keeps what it said next to the key, unless the token was
 * replaced meanwhile: then what was found is about a token the key no longer holds.
 */
export async function checkGithubKey(deps: AppDeps, id: string): Promise<StudioGithubKeyCheck> {
  const key = requireKey(deps, id);
  const token = deps.secrets.unseal(key.sealedToken, contextOf(key.id));
  const remember = (found: Pick<StoredKey, "valid" | "login" | "expiresAt">) => {
    updateKeys(deps, (keys) =>
      keys.map((one) =>
        one.id === id && one.sealedToken === key.sealedToken
          ? { ...one, ...found, checkedAt: new Date(deps.now()).toISOString() }
          : one,
      ),
    );
  };
  let answer: Response;
  try {
    answer = await fetch(`${GITHUB_API}/user`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return failed("GitHub could not be reached from the server.");
  }
  if (answer.status === 401) {
    remember({ valid: false, login: null, expiresAt: null });
    return failed("GitHub refused this token: it is wrong, revoked or expired.");
  }
  if (!answer.ok) {
    return failed(`GitHub answered ${answer.status}.`);
  }
  const body = (await answer.json().catch(() => ({}))) as { login?: unknown };
  const login = typeof body.login === "string" ? body.login : null;
  const expiresAt = parseTokenExpiry(answer.headers.get("github-authentication-token-expiration"));
  const repositories = await privateRepositories(token, key.owner, login);
  remember({ valid: true, login, expiresAt });
  return { ok: true, login, expiresAt, repositories, message: null };
}
