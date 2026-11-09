import { isAbortError, networkMessage, StorageError } from "./types";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Where a provider's tokens live, sealed. Each refresh saves the new ones right away. */
export interface OAuthTokenStore {
  load(): OAuthTokens | null;
  save(tokens: OAuthTokens): void;
  /** The provider has revoked access: only the person who connected it can fix that. */
  revoked(reason: string): void;
}

export interface OAuthSessionOptions {
  store: OAuthTokenStore;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  http?: typeof fetch;
  now?: () => number;
}

/** A token this close to expiring is refreshed before anyone tries to use it. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** A refresh token good for one connection, and an access token that never goes stale mid-transfer. */
export class OAuthSession {
  private readonly http: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly options: OAuthSessionOptions) {
    this.http = options.http ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private tokens(): OAuthTokens {
    const tokens = this.options.store.load();
    if (tokens === null) {
      throw new StorageError("disconnected", "This destination is not connected.");
    }
    return tokens;
  }

  /** The current access token, refreshing it first when it is about to expire. */
  async token(): Promise<string> {
    const tokens = this.tokens();
    return this.now() < tokens.expiresAt - EXPIRY_MARGIN_MS ? tokens.accessToken : this.refresh();
  }

  /** Refreshes once however many callers ask, so the provider is not asked five times at once. */
  private refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const { refreshToken } = this.tokens();
    let response: Response;
    try {
      response = await this.http(this.options.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new StorageError("unreachable", networkMessage(error, "The sign-in server"));
    }

    const body = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    } | null;

    if (!response.ok || body === null || typeof body.access_token !== "string") {
      if (body?.error === "invalid_grant" || response.status === 400 || response.status === 401) {
        this.options.store.revoked("The provider no longer accepts this connection.");
        throw new StorageError("disconnected", "This destination's access was revoked. Connect it again.");
      }
      throw new StorageError("unreachable", "The sign-in server did not issue a new token.");
    }

    const tokens: OAuthTokens = {
      accessToken: body.access_token,
      // Most providers only send a new refresh token when they rotate it.
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    this.options.store.save(tokens);
    return tokens.accessToken;
  }

  /**
   * A signed-in request. A 401 means the token stopped working early, so it is refreshed and the
   * request tried once more. If that fails too, the connection is really gone.
   */
  async request(url: string | URL, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    let response = await this.attempt(url, init, await this.token());
    if (response.status !== 401) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    response = await this.attempt(url, init, await this.refresh());
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      this.options.store.revoked("The provider no longer accepts this connection.");
      throw new StorageError("disconnected", "This destination's access was revoked. Connect it again.");
    }
    return response;
  }

  private async attempt(url: string | URL, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    try {
      return await this.http(url, { ...init, headers });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new StorageError("unreachable", networkMessage(error, "The storage service"));
    }
  }
}

/** Waits for a rate limit or a server hiccup, honouring what the server asked for. */
export function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const asked = header === null ? Number.NaN : Number(header);
  return Number.isFinite(asked) && asked >= 0 ? Math.min(asked * 1000, 60_000) : 1000 * 2 ** attempt;
}

export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;
