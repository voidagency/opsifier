import { ClientError } from "./errors";

const MISSING = "OPSIFIER_URL and OPSIFIER_API_KEY must both be set.";

export interface Connection {
  /** The panel's origin, with nothing after it. */
  url: URL;
  /** The credential: an API key, or a person's session from `opsifier login --web`. Empty sends none. */
  apiKey: string;
  /** How the credential is sent: `Bearer` for an API key, `Session` for a person's session. */
  scheme?: "Bearer" | "Session";
}

/** Secrets only ever come from the environment: an argument would show up in the process list. */
export function connectionFromEnv(env: Record<string, string | undefined>): Connection {
  const address = env.OPSIFIER_URL?.trim();
  const apiKey = env.OPSIFIER_API_KEY?.trim();
  if (address === undefined || address === "" || apiKey === undefined || apiKey === "") {
    throw new ClientError("not_configured", MISSING);
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ClientError("invalid_url", `OPSIFIER_URL is not a valid address: "${address}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ClientError("invalid_url", "OPSIFIER_URL must start with http:// or https://.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ClientError(
      "invalid_url",
      "OPSIFIER_URL must be the panel's address, with no path or credentials.",
    );
  }
  return { url, apiKey };
}

/** A key sent over plain HTTP to another machine can be read on the way. Worth saying so, every time. */
export function isExposedOnTheWire(url: URL): boolean {
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
