import type { DbHandle } from "../../core/db";
import type { ProxyGuard } from "../../core/proxy";
import { registeredDomain } from "./repo";

/** Traefik's name for the resolver that answers the DNS challenge through the address service. */
export const ADDRESS_RESOLVER = "opsifier";
const DEFAULT_RESOLVER = "letsencrypt";

const HOST_MATCHER = /\bHost\(`([^`]*)`\)/g;

export const wildcardOf = (domain: string): string => `*.${domain}`;

/** `*.x.y` covers exactly one label: `a.x.y`, never `x.y` and never `a.b.x.y`. */
export function isCoveredByWildcard(host: string, domain: string): boolean {
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) {
    return false;
  }
  const label = host.slice(0, -suffix.length);
  return label !== "" && !label.includes(".");
}

interface RouterLike extends Record<string, unknown> {
  rule?: unknown;
  tls?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every host of the rule has to fit the wildcard, because one certificate has to serve the route. */
function coveredHosts(rule: string, domain: string): boolean {
  const hosts = [...rule.matchAll(HOST_MATCHER)].map((match) => match[1] as string);
  return hosts.length > 0 && hosts.every((host) => isCoveredByWildcard(host, domain));
}

function retargeted(router: RouterLike, domain: string): RouterLike | null {
  const { rule, tls } = router;
  if (typeof rule !== "string" || !isRecord(tls)) {
    return null;
  }
  // Someone who named another resolver on a domain meant it.
  const resolver = tls.certResolver;
  if ((resolver !== undefined && resolver !== DEFAULT_RESOLVER) || !coveredHosts(rule, domain)) {
    return null;
  }
  return {
    ...router,
    tls: { ...tls, certResolver: ADDRESS_RESOLVER, domains: [{ main: wildcardOf(domain) }] },
  };
}

/**
 * Sends every HTTPS route under the address to the one wildcard certificate. A route's own compiler
 * doesn't have to know: like protection, this works on the routing file, so anything that produces a
 * route is covered. It only ever touches `tls`.
 */
export function applyAddressCertificates(config: unknown, domain: string | null): unknown {
  if (domain === null || !isRecord(config) || !isRecord(config.http) || !isRecord(config.http.routers)) {
    return config;
  }
  const routers = Object.fromEntries(
    Object.entries(config.http.routers).map(([name, router]) => [
      name,
      (isRecord(router) ? retargeted(router as RouterLike, domain) : null) ?? router,
    ]),
  );
  return { ...config, http: { ...config.http, routers } };
}

/**
 * Wraps the protection guard rather than the other way round, so the last word on what reaches the
 * proxy stays with protection. Anything that goes wrong in here throws, and the write is refused.
 */
export function addressCertificatesGuard(db: DbHandle, enabled: boolean, inner: ProxyGuard): ProxyGuard {
  return {
    apply: (file, config) =>
      inner.apply(file, applyAddressCertificates(config, enabled ? registeredDomain(db) : null)),
    forget: (file) => inner.forget?.(file),
  };
}
