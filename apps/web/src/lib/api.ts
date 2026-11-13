import { apiError } from "@opsifier/contract";

/** Codes the client uses when the failure did not come from an API error body. */
export const clientErrorCode = {
  /** The request never reached the server. */
  network: "network",
  /** The server answered, but not with the error shape the contract promises. */
  badResponse: "bad_response",
} as const;

/** Every failed API call rejects with this error, so callers can always read `code` and `fields`. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    /** HTTP status, or 0 when the request never reached the server. */
    readonly status: number,
    /** Machine-readable reason, as sent by the API. */
    readonly code: string,
    message: string,
    /** Per-field messages for validation failures. Empty when there are none. */
    readonly fields: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }

  get isNetworkError(): boolean {
    return this.code === clientErrorCode.network;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Anything with a Zod-style `parse`. Contract schemas satisfy this. */
export interface ResponseSchema<T> {
  parse(data: unknown): T;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  /** JSON-serialized and sent as the request body. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** Validates the response body. Without one the body is returned as-is, typed by the caller. */
  schema?: ResponseSchema<T>;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const basePath = "/api/v1";

let onUnauthorized: (() => void) | undefined;
let onTwoFactorRequired: (() => void) | undefined;

/**
 * Registers what happens when a request made with a session comes back 401: the session has ended
 * underneath the app. Sign-in is excluded because a 401 there is an answer, not an event.
 */
export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler;
}

/**
 * Registers what happens when the panel answers that this account must turn on two-factor sign-in
 * before anything else: the owner may have required it while the app was open.
 */
export function setTwoFactorRequiredHandler(handler: (() => void) | undefined): void {
  onTwoFactorRequired = handler;
}

function buildUrl(path: string, query: RequestOptions<unknown>["query"]): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) {
      search.set(key, String(value));
    }
  }
  const suffix = search.size > 0 ? `?${search}` : "";
  return `${basePath}${path}${suffix}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  return JSON.parse(text);
}

async function toApiError(response: Response): Promise<ApiError> {
  // A gateway answering in place of the API means the same thing as no answer at all.
  const unreachable = [502, 503, 504].includes(response.status);
  const fallback = new ApiError(
    response.status,
    unreachable ? clientErrorCode.network : clientErrorCode.badResponse,
    response.statusText || `Unexpected response (${response.status})`,
  );
  let body: unknown;
  try {
    body = await readJson(response);
  } catch {
    return fallback;
  }
  const parsed = apiError.safeParse(body);
  if (!parsed.success) {
    return fallback;
  }
  const { code, message, fields } = parsed.data.error;
  return new ApiError(response.status, code, message, fields ?? {});
}

async function request<T>(method: Method, path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { body, query, signal, schema } = options;
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    throw new ApiError(0, clientErrorCode.network, "The server could not be reached");
  }

  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") {
      onUnauthorized?.();
    }
    const error = await toApiError(response);
    if (error.code === "two_factor_setup_required") {
      onTwoFactorRequired?.();
    }
    throw error;
  }

  let data: unknown;
  try {
    data = await readJson(response);
  } catch {
    throw new ApiError(
      response.status,
      clientErrorCode.badResponse,
      "The server sent an unreadable response",
    );
  }
  if (!schema) {
    return data as T;
  }
  try {
    return schema.parse(data);
  } catch {
    throw new ApiError(
      response.status,
      clientErrorCode.badResponse,
      "The server sent an unexpected response",
    );
  }
}

/** The typed REST client. Paths are relative to `/api/v1`. */
export const api = {
  get: <T>(path: string, options?: RequestOptions<T>) => request<T>("GET", path, options),
  post: <T>(path: string, options?: RequestOptions<T>) => request<T>("POST", path, options),
  put: <T>(path: string, options?: RequestOptions<T>) => request<T>("PUT", path, options),
  patch: <T>(path: string, options?: RequestOptions<T>) => request<T>("PATCH", path, options),
  delete: <T>(path: string, options?: RequestOptions<T>) => request<T>("DELETE", path, options),
};
