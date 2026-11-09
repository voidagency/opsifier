import { isValidHostname } from "@opsifier/contract";
import { z } from "zod";

/**
 * The only call home. A request for an address, a heartbeat, a release. Apart from the email and the
 * purpose an administrator typed to ask, they carry the server's ID and secret where those are needed
 * and nothing else, so no version, hostname or inventory leaves the server.
 */

const REGISTER_TIMEOUT_MS = 5000;

/**
 * `gone` means disabled, `declined` that a request was refused, and `denied` that the service no longer
 * knows these credentials.
 */
export type NamesFailure = "unreachable" | "denied" | "gone" | "declined" | "refused" | "malformed";

export class NamesServiceError extends Error {
  override readonly name = "NamesServiceError";

  constructor(
    readonly kind: NamesFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface Credentials {
  id: string;
  secret: string;
}

const requestAnswer = z.object({
  id: z.string().regex(/^[a-z0-9]{1,63}$/),
  secret: z.string().min(32).max(256),
  domain: z.string(),
  ip: z.ipv4(),
});
export type RequestAnswer = z.infer<typeof requestAnswer>;

const heartbeatAnswer = z.object({ ip: z.ipv4(), status: z.enum(["active", "requested"]) });
export type HeartbeatAnswer = z.infer<typeof heartbeatAnswer>;

/** The suffix comes from the answer, not from here: only its shape can be checked. */
function assertDomainOf({ id, domain }: RequestAnswer): void {
  if (
    !domain.startsWith(`${id}.`) ||
    !isValidHostname(domain) ||
    !domain.slice(id.length + 1).includes(".")
  ) {
    throw new NamesServiceError("malformed", "The address service answered with an unusable name.");
  }
}

const basic = ({ id, secret }: Credentials): string =>
  `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;

interface Call {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  credentials?: Credentials;
  body?: unknown;
  timeoutMs: number;
}

async function call(baseUrl: string, { method, path, credentials, body, timeoutMs }: Call): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "opsifier",
        ...(credentials === undefined ? {} : { authorization: basic(credentials) }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new NamesServiceError(
      "unreachable",
      error instanceof Error && error.name === "TimeoutError"
        ? "The address service did not answer in time."
        : "The address service could not be reached.",
    );
  }
  if (response.status === 401) {
    throw new NamesServiceError("denied", "The address service no longer knows this server.");
  }
  if (response.status === 410) {
    const answer = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    throw answer?.error?.code === "refused"
      ? new NamesServiceError("declined", "This request was refused.")
      : new NamesServiceError("gone", "This address has been disabled.");
  }
  if (response.status === 429) {
    throw new NamesServiceError("refused", "This server has asked too many times today. Try again tomorrow.");
  }
  if (!response.ok) {
    throw new NamesServiceError(
      response.status >= 500 ? "unreachable" : "refused",
      `The address service answered ${response.status}.`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new NamesServiceError("malformed", "The address service sent something that isn't JSON.");
  }
}

/** Asks for an address. The answer says which name is held for this server if the request is approved. */
export async function requestServerAddress(
  baseUrl: string,
  request: { email: string; purpose: string },
  timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<RequestAnswer> {
  const parsed = requestAnswer.safeParse(
    await call(baseUrl, { method: "POST", path: "/v1/servers", body: request, timeoutMs }),
  );
  if (!parsed.success) {
    throw new NamesServiceError("malformed", "The address service sent an unexpected answer.");
  }
  assertDomainOf(parsed.data);
  return parsed.data;
}

/**
 * Tells the service this server is alive, which is also how it learns a new public IP. The answer says
 * whether a request is still waiting.
 */
export async function sendHeartbeat(
  baseUrl: string,
  credentials: Credentials,
  timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<HeartbeatAnswer> {
  const answer = await call(baseUrl, {
    method: "PUT",
    path: `/v1/servers/${credentials.id}`,
    credentials,
    timeoutMs,
  });
  const parsed = heartbeatAnswer.safeParse(answer);
  if (!parsed.success) {
    throw new NamesServiceError("malformed", "The address service sent an unexpected answer.");
  }
  return parsed.data;
}

export async function releaseServer(
  baseUrl: string,
  credentials: Credentials,
  timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<void> {
  await call(baseUrl, {
    method: "DELETE",
    path: `/v1/servers/${credentials.id}`,
    credentials,
    timeoutMs,
  });
}
