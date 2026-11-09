import { randomBytes } from "node:crypto";
import {
  type GithubBranchList,
  type GithubOauthStart,
  type GithubRepositoryList,
  type GithubStatus,
  githubOauthCallbackPath,
  type SaveGithubOauthAppRequest,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest, forbidden } from "../../core/errors";
import { getSetting, putSetting } from "../system/repo";
import {
  exchangeOauthCode,
  fetchLogin,
  GithubError,
  listBranches,
  listRepositories,
  oauthAuthorizeUrl,
  revokeOauthGrant,
} from "./client";
import { deleteSetting } from "./repo";

const TOKEN_KEY = "github_token";
const TOKEN_CONTEXT = "github-token";
const OAUTH_APP_KEY = "github_oauth_app";
const OAUTH_APP_CONTEXT = "github-oauth-app";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONNECTIONS = 16;
const MAX_RESULTS = 30;

interface StoredToken {
  sealed: string;
  login: string;
  updatedAt: string;
  /** Left out of tokens saved before there was another way to get one. */
  method?: "token" | "oauth";
}

interface StoredOauthApp {
  clientId: string;
  sealedSecret: string;
  updatedAt: string;
}

/** A grant someone has started, valid for one trip to GitHub and back. */
interface PendingConnection {
  redirectUri: string;
  actorEmail: string | undefined;
  expiresAt: number;
}

const pendingConnections = new Map<string, PendingConnection>();

function readStored(deps: Pick<AppDeps, "db">): StoredToken | null {
  return (getSetting(deps.db, TOKEN_KEY) as StoredToken | undefined) ?? null;
}

export function isGithubConfigured(deps: Pick<AppDeps, "db">): boolean {
  return readStored(deps) !== null;
}

export function getGithubToken(deps: Pick<AppDeps, "db" | "secrets">): string | null {
  const stored = readStored(deps);
  return stored === null ? null : deps.secrets.unseal(stored.sealed, TOKEN_CONTEXT);
}

function readOauthApp(deps: Pick<AppDeps, "db">): StoredOauthApp | null {
  return (getSetting(deps.db, OAUTH_APP_KEY) as StoredOauthApp | undefined) ?? null;
}

export function getGithubStatus(deps: Pick<AppDeps, "db">): GithubStatus {
  const stored = readStored(deps);
  const app = readOauthApp(deps);
  return {
    configured: stored !== null,
    login: stored?.login ?? null,
    updatedAt: stored?.updatedAt ?? null,
    method: stored === null ? null : (stored.method ?? "token"),
    oauthApp: app === null ? null : { clientId: app.clientId },
  };
}

/** A token GitHub refuses never gets stored. */
export async function saveGithubToken(
  deps: Pick<AppDeps, "db" | "secrets" | "now">,
  token: string,
): Promise<GithubStatus> {
  let login: string;
  try {
    login = await fetchLogin(token);
  } catch (error) {
    if (error instanceof GithubError && error.status === 0) {
      throw new AppError(502, "github_unreachable", error.message);
    }
    throw badRequest("github_token_invalid", "GitHub did not accept this token.", {
      token: "GitHub did not accept this token",
    });
  }
  storeToken(deps, token, login, "token");
  return getGithubStatus(deps);
}

function storeToken(
  deps: Pick<AppDeps, "db" | "secrets" | "now">,
  token: string,
  login: string,
  method: "token" | "oauth",
): void {
  const updatedAt = new Date(deps.now());
  const stored: StoredToken = {
    sealed: deps.secrets.seal(token, TOKEN_CONTEXT),
    login,
    updatedAt: updatedAt.toISOString(),
    method,
  };
  putSetting(deps.db, TOKEN_KEY, stored, updatedAt);
}

/** Forgets the token. One granted through the OAuth app is also given back, as far as GitHub will allow. */
export async function removeGithubToken(
  deps: Pick<AppDeps, "db" | "secrets" | "logger">,
): Promise<GithubStatus> {
  const stored = readStored(deps);
  const app = readOauthApp(deps);
  if (stored?.method === "oauth" && app !== null) {
    try {
      await revokeOauthGrant(
        app.clientId,
        deps.secrets.unseal(app.sealedSecret, OAUTH_APP_CONTEXT),
        deps.secrets.unseal(stored.sealed, TOKEN_CONTEXT),
      );
    } catch (error) {
      deps.logger.warn({ err: error }, "Could not give the GitHub grant back");
    }
  }
  deleteSetting(deps.db, TOKEN_KEY);
  return getGithubStatus(deps);
}

/** Saves the OAuth app the owner registered on GitHub. Its secret never leaves the server again. */
export function saveOauthApp(
  deps: Pick<AppDeps, "db" | "secrets" | "now">,
  input: SaveGithubOauthAppRequest,
): GithubStatus {
  const updatedAt = new Date(deps.now());
  const stored: StoredOauthApp = {
    clientId: input.clientId,
    sealedSecret: deps.secrets.seal(input.clientSecret, OAUTH_APP_CONTEXT),
    updatedAt: updatedAt.toISOString(),
  };
  putSetting(deps.db, OAUTH_APP_KEY, stored, updatedAt);
  return getGithubStatus(deps);
}

export function removeOauthApp(deps: Pick<AppDeps, "db">): GithubStatus {
  deleteSetting(deps.db, OAUTH_APP_KEY);
  return getGithubStatus(deps);
}

/** The address of GitHub's consent screen, good for one attempt within ten minutes. */
export function startOauthConnection(
  deps: Pick<AppDeps, "db" | "now">,
  origin: string,
  actorEmail: string | undefined,
): GithubOauthStart {
  const app = readOauthApp(deps);
  if (app === null) {
    throw badRequest("github_oauth_app_missing", "Save a GitHub OAuth app first.");
  }
  const now = deps.now();
  for (const [key, value] of pendingConnections) {
    if (value.expiresAt <= now) {
      pendingConnections.delete(key);
    }
  }
  while (pendingConnections.size >= MAX_PENDING_CONNECTIONS) {
    pendingConnections.delete(pendingConnections.keys().next().value as string);
  }
  const state = randomBytes(32).toString("base64url");
  const redirectUri = `${origin}${githubOauthCallbackPath}`;
  pendingConnections.set(state, { redirectUri, actorEmail, expiresAt: now + OAUTH_STATE_TTL_MS });
  return { authorizationUrl: oauthAuthorizeUrl(app.clientId, redirectUri, state) };
}

export type OauthFailure = "invalid_state" | "denied" | "not_configured" | "exchange_failed";

/**
 * Where GitHub sends the browser back to, with nothing but what it was given. The state is what proves
 * that this is the answer to a grant the panel itself started, and it only works once.
 */
export async function completeOauthConnection(
  deps: Pick<AppDeps, "db" | "secrets" | "now" | "logger" | "actions">,
  query: { state?: string; code?: string; error?: string },
): Promise<{ ok: true } | { ok: false; reason: OauthFailure }> {
  const pending = query.state === undefined ? undefined : pendingConnections.get(query.state);
  if (query.state !== undefined) {
    pendingConnections.delete(query.state);
  }
  if (pending === undefined || pending.expiresAt <= deps.now()) {
    return { ok: false, reason: "invalid_state" };
  }
  if (query.error !== undefined || query.code === undefined) {
    return { ok: false, reason: "denied" };
  }
  const app = readOauthApp(deps);
  if (app === null) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const token = await exchangeOauthCode(
      app.clientId,
      deps.secrets.unseal(app.sealedSecret, OAUTH_APP_CONTEXT),
      query.code,
      pending.redirectUri,
    );
    storeToken(deps, token, await fetchLogin(token), "oauth");
  } catch (error) {
    deps.logger.warn({ err: error }, "A GitHub connection could not be completed");
    return { ok: false, reason: "exchange_failed" };
  }
  deps.actions.record({ type: "github.connect", title: "Connect GitHub", actorEmail: pending.actorEmail });
  return { ok: true };
}

export function requireGithubToken(deps: Pick<AppDeps, "db" | "secrets">): string {
  const token = getGithubToken(deps);
  if (token === null) {
    throw badRequest("github_token_missing", "Save a GitHub token in Settings first.");
  }
  return token;
}

/** What the panel's token may do for this service: read and manage the one repository it was granted. */
export function requireTokenFor(
  deps: Pick<AppDeps, "db" | "secrets">,
  source: { repository: string; tokenRepository: string | null },
): string {
  const token = requireGithubToken(deps);
  if (source.tokenRepository?.toLowerCase() !== source.repository.toLowerCase()) {
    throw forbidden(
      "github_token_not_granted",
      "An administrator has to save this source before the panel's GitHub token can be used for this repository.",
    );
  }
  return token;
}

/** Turns a failed GitHub call into something the UI can say. */
export function githubFailure(error: unknown): AppError {
  if (error instanceof GithubError) {
    return new AppError(
      error.status === 0 ? 502 : 400,
      error.status === 0 ? "github_unreachable" : "github_refused",
      error.status === 0 ? error.message : `GitHub refused this: ${error.message}`,
    );
  }
  throw error;
}

function matches(name: string, query: string): boolean {
  return query === "" || name.toLowerCase().includes(query.toLowerCase());
}

export async function searchRepositories(
  deps: Pick<AppDeps, "db" | "secrets">,
  query: string,
): Promise<GithubRepositoryList> {
  const token = requireGithubToken(deps);
  const rows = await listRepositories(token).catch((error: unknown) => {
    throw githubFailure(error);
  });
  return {
    items: rows
      .filter((row) => matches(row.full_name, query))
      .slice(0, MAX_RESULTS)
      .map((row) => ({ fullName: row.full_name, private: row.private, defaultBranch: row.default_branch })),
  };
}

export async function searchBranches(
  deps: Pick<AppDeps, "db" | "secrets">,
  owner: string,
  repo: string,
  query: string,
): Promise<GithubBranchList> {
  const token = requireGithubToken(deps);
  const rows = await listBranches(token, owner, repo).catch((error: unknown) => {
    throw githubFailure(error);
  });
  return { items: rows.filter((row) => matches(row.name, query)).slice(0, MAX_RESULTS) };
}
