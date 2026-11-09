import { isValidHostname } from "@opsifier/contract";
import { z } from "zod";

/**
 * The only call home. A registration, a heartbeat, a release: the requests carry the server's ID and
 * secret where they are needed and nothing else, so no version, hostname or inventory leaves the server.
 */

const REGISTER_TIMEOUT_MS = 5000;

/** `gone` means disabled, `denied` that the service no longer knows these credentials. */
export type NamesFailure = "unreachable" | "denied" | "gone" | "refused" | "malformed";

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

const registration = z.object({
  id: z.string().regex(/^[a-z0-9]{1,63}$/),
  secret: z.string().min(32).max(256),
  domain: z.string(),
  ip: z.ipv4(),
});
export type Registration = z.infer<typeof registration>;

const heartbeatAnswer = z.object({ ip: z.ipv4() });

/** The suffix comes from the answer, not from here: only its shape can be checked. */
function assertDomainOf({ id, domain }: Registration): void {
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
  timeoutMs: number;
}

async function call(baseUrl: string, { method, path, credentials, timeoutMs }: Call): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "opsifier",
        ...(credentials === undefined ? {} : { authorization: basic(credentials) }),
      },
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
    throw new NamesServiceError("gone", "This address has been disabled.");
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

/** Short on purpose: an install waits for this, and a late answer is worth nothing. */
export async function registerServer(
  baseUrl: string,
  timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<Registration> {
  const parsed = registration.safeParse(
    await call(baseUrl, { method: "POST", path: "/v1/servers", timeoutMs }),
  );
  if (!parsed.success) {
    throw new NamesServiceError("malformed", "The address service sent an unexpected answer.");
  }
  assertDomainOf(parsed.data);
  return parsed.data;
}

/** Tells the service this server is alive, which is also how it learns a new public IP. */
export async function sendHeartbeat(
  baseUrl: string,
  credentials: Credentials,
  timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<{ ip: string }> {
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
