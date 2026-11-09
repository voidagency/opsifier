import {
  apiError,
  type BoxIdeDirectory,
  type BoxIdeFile,
  type BoxIdeSession,
  boxIdeDirectory,
  boxIdeFile,
  boxIdeSession,
} from "@opsifier/contract";
import { ApiError, clientErrorCode, type ResponseSchema } from "../../../lib/api";

type Method = "GET" | "PUT" | "POST" | "DELETE";

interface RequestOptions<T> {
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  schema?: ResponseSchema<T>;
}

async function toApiError(response: Response): Promise<ApiError> {
  const fallback = new ApiError(
    response.status,
    [502, 503, 504].includes(response.status) ? clientErrorCode.network : clientErrorCode.badResponse,
    response.statusText,
  );
  try {
    const parsed = apiError.safeParse(await response.json());
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error;
      return new ApiError(response.status, code, message, fields ?? {});
    }
  } catch {
    // Not the error shape the contract promises.
  }
  return fallback;
}

/**
 * The editor's own client. It is separate from the panel's on purpose: it carries one bearer token
 * and no cookie, and a refused token here says nothing about anyone's panel session.
 */
export function createIdeClient(project: string, service: string, token: string) {
  const base = `/api/v1/ide/${encodeURIComponent(project)}/${encodeURIComponent(service)}`;

  async function request<T>(method: Method, path: string, options: RequestOptions<T> = {}): Promise<T> {
    const search = new URLSearchParams(options.query ?? {});
    const suffix = search.size > 0 ? `?${search}` : "";
    let response: Response;
    try {
      response = await fetch(`${base}${path}${suffix}`, {
        method,
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (cause) {
      throw new ApiError(0, clientErrorCode.network, String(cause));
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    const data: unknown = await response.json();
    return options.schema === undefined ? (data as T) : options.schema.parse(data);
  }

  return {
    session: (signal?: AbortSignal): Promise<BoxIdeSession> =>
      request("GET", "/session", { schema: boxIdeSession, signal }),
    list: (path: string, signal?: AbortSignal): Promise<BoxIdeDirectory> =>
      request("GET", "/tree", { query: { path }, schema: boxIdeDirectory, signal }),
    read: (path: string, signal?: AbortSignal): Promise<BoxIdeFile> =>
      request("GET", "/file", { query: { path }, schema: boxIdeFile, signal }),
    write: (path: string, content: string, version: string | null) =>
      request<{ version: string }>("PUT", "/file", { body: { path, content, version } }),
    createDirectory: (path: string) => request("POST", "/directory", { body: { path } }),
    move: (from: string, to: string) => request("POST", "/move", { body: { from, to } }),
    remove: (path: string, recursive: boolean) => request("DELETE", "/entry", { body: { path, recursive } }),
  };
}

export type IdeClient = ReturnType<typeof createIdeClient>;
