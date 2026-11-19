import { apiError } from "@opsifier/contract";
import { bindingHeaders } from "./session-binding";

/** Codes the client uses when the failure did not come from an API error body. */
export const clientErrorCode = {
  /** The request never reached the server. */
  network: "network",
  /** The server answered, but not with the error shape the contract promises. */
  badResponse: "bad_response",
  /** The request was never sent: its address could have led somewhere other than the route it names. */
  badRequest: "invalid_request",
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

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * A path the browser would read as another route: a `.` or `..` segment, written plainly or
 * percent-encoded, which the browser resolves before sending; a `?`, `#` or backslash that cuts the
 * path short; or a control character, since the browser drops tabs and line breaks wherever they are
 * (`.<tab>.` arrives as `..`). Paths are built from names and ids, some from the address bar or an
 * outside server: such a path is refused rather than sent with the session to wherever it leads.
 */
function isUnsafePath(path: string): boolean {
  if (/[?#\\]/.test(path) || hasControlCharacter(path)) {
    return true;
  }
  return path.split("/").some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === "..";
  });
}

/**
 * The address of an API path, for what the browser sends by other means than this client: an upload
 * that reports its progress, a download link, a WebSocket. Refused like any request's.
 */
export function apiUrl(path: string, query?: RequestOptions<unknown>["query"]): string {
  return buildUrl(path, query);
}

/**
 * Whether the browser, reading the address the way it will, keeps every segment of the path. A step
 * up it would make of what the checks above let through, such as a trailing space it drops after
 * `..`, would leave fewer.
 */
function resolvesAsBuilt(path: string): boolean {
  const built = `${basePath}${path}`;
  return new URL(built, "http://panel.invalid").pathname.split("/").length === built.split("/").length;
}

function buildUrl(path: string, query: RequestOptions<unknown>["query"]): string {
  if (isUnsafePath(path) || !resolvesAsBuilt(path)) {
    throw new ApiError(0, clientErrorCode.badRequest, "This request's address is not valid.");
  }
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
  // Outside the try below: an address refused here is not the server being unreachable.
  const url = buildUrl(path, query);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...bindingHeaders(),
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

/**
 * An image the API sends, as a data URL: the panel's pages show images from data URLs only, and the
 * request needs the session's headers, which an image's own address could not carry.
 */
async function image(path: string, options: Pick<RequestOptions<unknown>, "signal"> = {}): Promise<string> {
  const { signal } = options;
  const url = buildUrl(path, undefined);
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "image/jpeg, image/png, image/webp", ...bindingHeaders() },
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    throw new ApiError(0, clientErrorCode.network, "The server could not be reached");
  }
  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized?.();
    }
    const error = await toApiError(response);
    if (error.code === "two_factor_setup_required") {
      onTwoFactorRequired?.();
    }
    throw error;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!/^image\/(jpeg|png|webp)$/.test(type)) {
    throw new ApiError(
      response.status,
      clientErrorCode.badResponse,
      "The server sent an unexpected response",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  // In slices: a whole image as the arguments of one call would be too many for some engines.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** The typed REST client. Paths are relative to `/api/v1`. */
export const api = {
  get: <T>(path: string, options?: RequestOptions<T>) => request<T>("GET", path, options),
  post: <T>(path: string, options?: RequestOptions<T>) => request<T>("POST", path, options),
  put: <T>(path: string, options?: RequestOptions<T>) => request<T>("PUT", path, options),
  patch: <T>(path: string, options?: RequestOptions<T>) => request<T>("PATCH", path, options),
  delete: <T>(path: string, options?: RequestOptions<T>) => request<T>("DELETE", path, options),
  image,
};
