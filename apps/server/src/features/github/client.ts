const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
/** What a panel connected through OAuth needs: read private repositories, and add webhooks to them. */
const OAUTH_SCOPES = "repo admin:repo_hook";
const REQUEST_TIMEOUT_MS = 15_000;
const PER_PAGE = 100;

/** GitHub's own answer, or that it never gave one (status 0). */
export class GithubError extends Error {
  override readonly name = "GithubError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Opsifier",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubError(0, "GitHub could not be reached.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : `GitHub answered ${response.status}.`;
    throw new GithubError(response.status, message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** The account a token belongs to. A bad token is what makes this fail, which is the point. */
export async function fetchLogin(token: string): Promise<string> {
  return (await request<{ login: string }>(token, "/user")).login;
}

interface RepositoryRow {
  full_name: string;
  private: boolean;
  default_branch: string;
}

/** Repositories the token can reach, most recently pushed first. */
export function listRepositories(token: string): Promise<RepositoryRow[]> {
  return request<RepositoryRow[]>(token, `/user/repos?per_page=${PER_PAGE}&sort=pushed`);
}

export function listBranches(token: string, owner: string, repo: string): Promise<Array<{ name: string }>> {
  return request(token, `/repos/${owner}/${repo}/branches?per_page=${PER_PAGE}`);
}

/** The screen GitHub shows the person who is granting the panel access. */
export function oauthAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("/login/oauth/authorize", GITHUB_WEB);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Trades the one-time code GitHub sent back for the token. An error here means no token was granted. */
export async function exchangeOauthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Opsifier" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubError(0, "GitHub could not be reached.");
  }
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    error_description?: unknown;
  } | null;
  if (typeof body?.access_token !== "string" || body.access_token === "") {
    const message = typeof body?.error_description === "string" ? body.error_description : null;
    throw new GithubError(response.status, message ?? `GitHub answered ${response.status}.`);
  }
  return body.access_token;
}

/** Tells GitHub the panel no longer holds a grant, so it stops appearing on the person's account. */
export async function revokeOauthGrant(clientId: string, clientSecret: string, token: string): Promise<void> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/grant`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${credentials}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Opsifier",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export interface HookTarget {
  url: string;
  secret: string;
}

const hookConfig = ({ url, secret }: HookTarget) => ({
  url,
  secret,
  content_type: "json",
  insecure_ssl: "0",
});

/** Creates a push webhook and returns its id. */
export async function createHook(token: string, repository: string, target: HookTarget): Promise<number> {
  const hook = await request<{ id: number }>(token, `/repos/${repository}/hooks`, {
    method: "POST",
    body: JSON.stringify({ name: "web", active: true, events: ["push"], config: hookConfig(target) }),
  });
  return hook.id;
}

export async function updateHook(
  token: string,
  repository: string,
  hookId: number,
  target: HookTarget,
): Promise<void> {
  await request(token, `/repos/${repository}/hooks/${hookId}`, {
    method: "PATCH",
    body: JSON.stringify({ config: hookConfig(target) }),
  });
}

export async function deleteHook(token: string, repository: string, hookId: number): Promise<void> {
  try {
    await request(token, `/repos/${repository}/hooks/${hookId}`, { method: "DELETE" });
  } catch (error) {
    // Already gone is what we were after.
    if (!(error instanceof GithubError && error.status === 404)) {
      throw error;
    }
  }
}
