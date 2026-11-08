const GITHUB_API = "https://api.github.com";
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
