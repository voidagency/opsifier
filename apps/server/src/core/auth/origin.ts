import type { Config } from "../config";
import type { RequestScheme } from "./client-ip";

const DEFAULT_PORTS: Record<string, string> = { "http:": ":80", "https:": ":443" };

/**
 * True when a browser's `Origin` is the panel itself or is explicitly allowed. A missing or
 * `null` origin is never allowed: `Host` comes from the same browser and only ever matches a
 * same-origin request, while the session cookie is scoped to the panel's own host. The scheme
 * has to match too, or a page served over plain HTTP could act on the HTTPS panel.
 */
export function isOriginAllowed(
  origin: string | undefined,
  request: { host: string | undefined; scheme: RequestScheme },
  allowedOrigins: Config["allowedOrigins"],
): boolean {
  if (origin === undefined || origin === "null") {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (allowedOrigins.has(parsed.origin)) {
    return true;
  }
  if (request.host === undefined || parsed.protocol !== `${request.scheme}:`) {
    return false;
  }

  const defaultPort = DEFAULT_PORTS[parsed.protocol];
  const requestHost = request.host.toLowerCase();
  const normalizedHost =
    defaultPort !== undefined && requestHost.endsWith(defaultPort)
      ? requestHost.slice(0, -defaultPort.length)
      : requestHost;
  return parsed.host === normalizedHost;
}
