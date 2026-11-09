import {
  type DestinationProtocol,
  isValidMiddlewareName,
  isValidResolverName,
  isValidRoutePath,
} from "@opsifier/contract";
import { assertHostname, InvalidProxyInputError, PANEL_SERVICE } from "../../../core/proxy";
import { type CompiledMiddlewares, routerMiddlewares } from "./middlewares";

export interface DomainInput {
  host: string;
  path: string;
  /** Takes `path` off the request before it reaches the backend. */
  stripPath?: boolean;
  /** The port the container listens on. */
  port: number;
  https: boolean;
  destinationProtocol?: DestinationProtocol;
  /** Prefixed to the request path before it reaches the backend. */
  destinationPath?: string;
  /** With an HTTPS upstream, the name its certificate must carry. Absent means the public hostname. */
  upstreamServerName?: string | null;
  /** With an HTTPS upstream, the certificates to trust. Absent means the public authorities. */
  upstreamCa?: string | null;
  /** Null or absent means the default resolver. */
  certificateResolver?: string | null;
  /** Answers on every direct subdomain of `host` instead of on `host` itself. */
  wildcard?: boolean;
  /** Proxy middlewares named on this domain. */
  middlewares?: readonly string[];
  /** Where a Compose stack's domain goes instead of the service. Null until a child is chosen. */
  upstreamHost?: string | null;
}

export interface ProxyRouter {
  rule: string;
  entryPoints: string[];
  service: string;
  priority?: number;
  middlewares?: string[];
  tls?: { certResolver: string; domains: Array<{ main: string }> };
}

export interface ProxyService {
  loadBalancer: {
    passHostHeader: boolean;
    servers: Array<{ url: string }>;
    serversTransport?: string;
  };
}

export interface DomainsInput {
  qualifiedName: string;
  domains: readonly DomainInput[];
  /** A stopped service keeps its routers but has no servers, so its domains answer 503. */
  stopped: boolean;
  middlewares: CompiledMiddlewares;
}

export interface CompiledDomains {
  routers: Record<string, ProxyRouter>;
  services: Record<string, ProxyService>;
  /** Definitions that belong to one domain, such as its destination path. */
  middlewares: Record<string, unknown>;
  /** How each HTTPS upstream's certificate is checked, in the file of the service it belongs to. */
  transports: Record<string, unknown>;
}

const CERT_RESOLVER = "letsencrypt";

/** Under every exact host's default priority, which is its rule's length (30 at the very least). */
const WILDCARD_PRIORITY_CEILING = 29;
/** Above the protected server's robots.txt for any host, which sits one notch over the catch-all. */
const WILDCARD_PRIORITY_FLOOR = 3;

/** The address the proxy forwards a domain to. */
export const internalUrl = (
  qualifiedName: string,
  port: number,
  protocol: DestinationProtocol = "http",
  path = "/",
): string => `${protocol}://${qualifiedName}:${port}${path}`;

/** Everything here ends up inside a Traefik rule or the generated file. It is checked again here. */
function assertRoutable(domain: DomainInput): void {
  assertHostname(domain.host);
  if (!isValidRoutePath(domain.path)) {
    throw new InvalidProxyInputError(`Invalid path: ${JSON.stringify(domain.path)}.`);
  }
  const destinationPath = domain.destinationPath ?? "/";
  if (!isValidRoutePath(destinationPath)) {
    throw new InvalidProxyInputError(`Invalid destination path: ${JSON.stringify(destinationPath)}.`);
  }
  if (!Number.isInteger(domain.port) || domain.port < 1 || domain.port > 65535) {
    throw new InvalidProxyInputError(`Invalid port: ${domain.port}.`);
  }
  const resolver = domain.certificateResolver;
  if (resolver !== undefined && resolver !== null && !isValidResolverName(resolver)) {
    throw new InvalidProxyInputError(`Invalid certificate resolver: ${JSON.stringify(resolver)}.`);
  }
  const invalidMiddleware = (domain.middlewares ?? []).find((name) => !isValidMiddlewareName(name));
  if (invalidMiddleware !== undefined) {
    throw new InvalidProxyInputError(`Invalid middleware name: ${JSON.stringify(invalidMiddleware)}.`);
  }
}

const hostMatcher = (host: string, wildcard: boolean): string =>
  wildcard ? `HostRegexp(\`^[a-z0-9-]+\\.${host.replaceAll(".", "\\.")}$\`)` : `Host(\`${host}\`)`;

const pathBase = (path: string): string => path.replace(/\/$/, "");

/** A route for `/api` answers on `/api` and below it. A bare prefix would also take `/apix`. */
function pathMatcher(path: string): string {
  const base = pathBase(path);
  return base === "" ? "PathPrefix(`/`)" : `(Path(\`${base}\`) || PathPrefix(\`${base}/\`))`;
}

/** The rule of one route, whatever it leads to. Its length is its default priority in Traefik. */
export const routeRule = (host: string, path: string, wildcard: boolean): string =>
  `${hostMatcher(host, wildcard)} && ${pathMatcher(path)}`;

/**
 * Deeper paths win among wildcards, and every wildcard ranks below every exact host. Only a path
 * nested under another can ever compete with it, so depth ranks them without running out of numbers.
 */
export const wildcardPriority = (path: string): number =>
  Math.min(WILDCARD_PRIORITY_FLOOR + pathBase(path).split("/").length - 1, WILDCARD_PRIORITY_CEILING);

/** The middleware that takes a route's path off the request. Null when there is nothing to take off. */
export function stripPathMiddleware(
  name: string,
  path: string,
  strip: boolean | undefined,
): { name: string; definition: unknown } | null {
  const base = pathBase(path);
  return strip === true && base !== ""
    ? { name: `opsifier-strip-${name}`, definition: { stripPrefix: { prefixes: [base] } } }
    : null;
}

/**
 * How an HTTPS upstream's certificate is checked. The proxy dials an internal name that no certificate
 * carries, so the name to check is the public one unless the domain says otherwise. A failed check is
 * an error for that route, which is the point: a certificate is never accepted unseen.
 */
function upstreamTransport(domain: DomainInput): Record<string, unknown> | null {
  if (domain.destinationProtocol !== "https") {
    return null;
  }
  const serverName = domain.upstreamServerName ?? (domain.wildcard === true ? null : domain.host);
  const ca = domain.upstreamCa ?? null;
  if (serverName === null && ca === null) {
    return null;
  }
  return { ...(serverName === null ? {} : { serverName }), ...(ca === null ? {} : { rootCAs: [ca] }) };
}

function withOptional(router: ProxyRouter, domain: DomainInput, names: string[]): ProxyRouter {
  return {
    ...router,
    ...(domain.wildcard === true ? { priority: wildcardPriority(domain.path) } : {}),
    ...(names.length > 0 ? { middlewares: names } : {}),
  };
}

function compileService(
  qualifiedName: string,
  domain: DomainInput,
  stopped: boolean,
  transport: string | null,
): ProxyService {
  const protocol = domain.destinationProtocol ?? "http";
  const host = domain.upstreamHost === undefined ? qualifiedName : domain.upstreamHost;
  return {
    loadBalancer: {
      passHostHeader: true,
      servers:
        stopped || host === null
          ? []
          : [{ url: internalUrl(host, domain.port, protocol, domain.destinationPath ?? "/") }],
      ...(transport === null ? {} : { serversTransport: transport }),
    },
  };
}

/** One pair of routers and one upstream per domain. `index` is the domain's position in the list. */
export function compileDomains({
  qualifiedName,
  domains,
  stopped,
  middlewares,
}: DomainsInput): CompiledDomains {
  const routers: Record<string, ProxyRouter> = {};
  const services: Record<string, ProxyService> = {};
  const definitions: Record<string, unknown> = {};
  const transports: Record<string, unknown> = {};

  domains.forEach((domain, index) => {
    assertRoutable(domain);
    const name = `${qualifiedName}-${index}`;
    const wildcard = domain.wildcard === true;
    const rule = routeRule(domain.host, domain.path, wildcard);
    const certificateHost = wildcard ? `*.${domain.host}` : domain.host;
    const service = middlewares.maintenance === null ? name : PANEL_SERVICE;

    const domainSpecific: string[] = [];
    // The path comes off first, so the destination path is what ends up in front of the remainder.
    const strip = stripPathMiddleware(name, domain.path, domain.stripPath);
    if (strip !== null) {
      definitions[strip.name] = strip.definition;
      domainSpecific.push(strip.name);
    }
    const destinationPath = domain.destinationPath ?? "/";
    if (destinationPath !== "/") {
      const prefix = `opsifier-prefix-${name}`;
      definitions[prefix] = { addPrefix: { prefix: destinationPath } };
      domainSpecific.push(prefix);
    }

    const chain = (entry: "http" | "https") =>
      routerMiddlewares(domain, entry, middlewares, { stopped, domainSpecific });

    routers[`http-${name}`] = withOptional({ rule, entryPoints: ["web"], service }, domain, chain("http"));
    if (domain.https) {
      routers[`https-${name}`] = withOptional(
        {
          rule,
          entryPoints: ["websecure"],
          service,
          tls: {
            certResolver: domain.certificateResolver ?? CERT_RESOLVER,
            domains: [{ main: certificateHost }],
          },
        },
        domain,
        chain("https"),
      );
    }
    const transport = upstreamTransport(domain);
    const transportName = transport === null ? null : `opsifier-tls-${name}`;
    if (transportName !== null) {
      transports[transportName] = transport;
    }
    services[name] = compileService(qualifiedName, domain, stopped, transportName);
  });

  return { routers, services, middlewares: definitions, transports };
}
