import { type BlockList, isIP } from "node:net";

export const UNKNOWN_IP = "unknown";

export type RequestScheme = "http" | "https";

function normalize(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4
    ? trimmed.slice(7)
    : trimmed;
}

function isTrusted(address: string, trusted: BlockList): boolean {
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The address a request really came from. `X-Forwarded-For` can be set by anyone, so it is
 * only read when the direct peer is a configured proxy, and only as far back as the first
 * address that proxy chain does not account for.
 */
export function resolveClientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: BlockList,
): string {
  if (peer === undefined || peer === "") {
    return UNKNOWN_IP;
  }
  const direct = normalize(peer);
  if (forwardedFor === undefined || !isTrusted(direct, trustedProxies)) {
    return direct;
  }

  const hops = forwardedFor
    .split(",")
    .map(normalize)
    .filter((hop) => isIP(hop) !== 0);
  for (const hop of hops.reverse()) {
    if (!isTrusted(hop, trustedProxies)) {
      return hop;
    }
  }
  return direct;
}

export interface SchemeSignals {
  /** True when TLS ended in this process rather than at a proxy. */
  encrypted: boolean;
  peer: string | undefined;
  forwardedProto: string | undefined;
}

/**
 * The scheme the browser used. Like `X-Forwarded-For`, `X-Forwarded-Proto` can be set by anyone,
 * so it only counts when the direct peer is a configured proxy. Of a list, only the last entry
 * is that proxy's own word: anything before it may have come from the client.
 */
export function resolveRequestScheme(signals: SchemeSignals, trustedProxies: BlockList): RequestScheme {
  if (signals.encrypted) {
    return "https";
  }
  if (signals.peer === undefined || !isTrusted(normalize(signals.peer), trustedProxies)) {
    return "http";
  }
  return signals.forwardedProto?.split(",").at(-1)?.trim().toLowerCase() === "https" ? "https" : "http";
}
