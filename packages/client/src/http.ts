import type { Connection } from "./connection";
import { ClientError } from "./errors";

const DEFAULT_TIMEOUT_MS = 60_000;

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** A path as it would be written in the OpenAPI document, only filled in: no scheme, host or query. */
function checkedPath(path: string): string {
  const segments = path.split("/").slice(1);
  const clean =
    path.startsWith("/api/v1/") &&
    !/[\\?#{}]/.test(path) &&
    segments.every((segment) => {
      const decoded = decodeSegment(segment);
      return decoded !== undefined && decoded !== "" && decoded !== "." && decoded !== "..";
    });
  if (!clean) {
    throw new ClientError("invalid_path", `Not a path under /api/v1: "${path}".`);
  }
  return path;
}

/** Accepts a path from the reference (`/api/v1/projects`) or a shorter one (`/projects`, `projects`). */
export function normalizeApiPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/api/v1/") ? trimmed : `/api/v1/${trimmed.replace(/^\/+/, "")}`;
}

/** An address as it can safely be repeated in a message: a query string can carry anything. */
function destination(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export class PanelClient {
  constructor(
    private readonly connection: Connection,
    private readonly send: typeof fetch = fetch,
  ) {}

  /** The panel this client talks to, and the only place its key ever goes. */
  get panelOrigin(): string {
    return this.connection.url.origin;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    // Every path starts with `/api/v1/` by now, so resolving it can only ever land on the panel.
    const url = new URL(checkedPath(path), this.connection.url);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.connection.apiKey}`,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    let text: string;
    try {
      response = await this.send(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Our own decision for each response, below: following would resend the key wherever it points.
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          ...(options.signal === undefined ? [] : [options.signal]),
        ]),
      });
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new ClientError("cancelled", "Interrupted.");
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ClientError("timeout", `The panel at ${url.origin} did not answer in time.`);
      }
      throw new ClientError("unreachable", `Could not reach the panel at ${url.origin}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw this.refuseRedirect(url, response.headers.get("location"));
    }

    let document: unknown;
    try {
      document = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new ClientError(
        "not_json",
        `The answer from ${destination(url)} was not JSON (HTTP ${response.status}).`,
        response.status,
      );
    }

    if (!response.ok) {
      const refusal = (
        document as { error?: { code?: string; message?: string; fields?: Record<string, string> } }
      )?.error;
      throw new ClientError(
        refusal?.code ?? `http_${response.status}`,
        refusal?.message ?? `The panel answered HTTP ${response.status}.`,
        response.status,
        refusal?.fields,
      );
    }
    return document as T;
  }

  private refuseRedirect(from: URL, location: string | null): ClientError {
    let target = "";
    try {
      target = location === null ? "" : ` to ${destination(new URL(location, from))}`;
    } catch {
      // Not an address at all: there is nothing worth repeating.
    }
    return new ClientError(
      "redirect_refused",
      `${from.origin} answered with a redirect${target}. Nothing was sent there.`,
    );
  }
}
