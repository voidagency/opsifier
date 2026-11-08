import type { GithubBranchList, GithubRepositoryList, GithubStatus } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest } from "../../core/errors";
import { getSetting, putSetting } from "../system/repo";
import { fetchLogin, GithubError, listBranches, listRepositories } from "./client";
import { deleteSetting } from "./repo";

const TOKEN_KEY = "github_token";
const TOKEN_CONTEXT = "github-token";
const MAX_RESULTS = 30;

interface StoredToken {
  sealed: string;
  login: string;
  updatedAt: string;
}

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

export function getGithubStatus(deps: Pick<AppDeps, "db">): GithubStatus {
  const stored = readStored(deps);
  return {
    configured: stored !== null,
    login: stored?.login ?? null,
    updatedAt: stored?.updatedAt ?? null,
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
  const updatedAt = new Date(deps.now());
  const stored: StoredToken = {
    sealed: deps.secrets.seal(token, TOKEN_CONTEXT),
    login,
    updatedAt: updatedAt.toISOString(),
  };
  putSetting(deps.db, TOKEN_KEY, stored, updatedAt);
  return getGithubStatus(deps);
}

export function removeGithubToken(deps: Pick<AppDeps, "db">): GithubStatus {
  deleteSetting(deps.db, TOKEN_KEY);
  return getGithubStatus(deps);
}

export function requireGithubToken(deps: Pick<AppDeps, "db" | "secrets">): string {
  const token = getGithubToken(deps);
  if (token === null) {
    throw badRequest("github_token_missing", "Save a GitHub token in Settings first.");
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
