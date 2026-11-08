import {
  type DestinationProtocol,
  isValidMiddlewareName,
  isValidResolverName,
  isValidRoutePath,
} from "@opsifier/contract";
import {
  assertHostname,
  BACKEND_TLS_TRANSPORT,
  InvalidProxyInputError,
  PANEL_SERVICE,
} from "../../../core/proxy";
import { type CompiledMiddlewares, routerMiddlewares } from "./middlewares";

export interface DomainInput {
  host: string;
  path: string;
  /** The port the container listens on. */
  port: number;
  https: boolean;
  destinationProtocol?: DestinationProtocol;
  /** Prefixed to the request path before it reaches the backend. */
  destinationPath?: string;
  /** Null or absent means the default resolver. */
  certificateResolver?: string | null;
  /** Answers on every direct subdomain of `host` instead of on `host` itself. */
  wildcard?: boolean;
  /** Proxy middlewares named on this domain. */
  middlewares?: readonly string[];
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
}

const CERT_RESOLVER = "letsencrypt";

/** Under every exact host's default priority, which is its rule's length (30 at the very least). */
const WILDCARD_PRIORITY_CEILING = 29;
const WILDCARD_PRIORITY_FLOOR = 2;

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

/** A domain's host part of the rule, and the name its certificate is issued for. */
function hostRuleParts(domain: DomainInput): { matcher: string; certificateHost: string } {
  if (domain.wildcard !== true) {
    return { matcher: `Host(\`${domain.host}\`)`, certificateHost: domain.host };
  }
  const escaped = domain.host.replaceAll(".", "\\.");
  return {
    matcher: `HostRegexp(\`^[a-z0-9-]+\\.${escaped}$\`)`,
    certificateHost: `*.${domain.host}`,
  };
}

/** Longer paths still win among wildcards, and every wildcard ranks below every exact host. */
const wildcardPriority = (path: string): number =>
  Math.min(WILDCARD_PRIORITY_FLOOR + path.length, WILDCARD_PRIORITY_CEILING);

function withOptional(router: ProxyRouter, domain: DomainInput, names: string[]): ProxyRouter {
  return {
    ...router,
    ...(domain.wildcard === true ? { priority: wildcardPriority(domain.path) } : {}),
    ...(names.length > 0 ? { middlewares: names } : {}),
  };
}

function compileService(qualifiedName: string, domain: DomainInput, stopped: boolean): ProxyService {
  const protocol = domain.destinationProtocol ?? "http";
  return {
    loadBalancer: {
      passHostHeader: true,
      servers: stopped
        ? []
        : [{ url: internalUrl(qualifiedName, domain.port, protocol, domain.destinationPath ?? "/") }],
      // Inside the project's network a backend's certificate can't be checked against any name.
      ...(protocol === "https" ? { serversTransport: BACKEND_TLS_TRANSPORT } : {}),
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

  domains.forEach((domain, index) => {
    assertRoutable(domain);
    const name = `${qualifiedName}-${index}`;
    const { matcher, certificateHost } = hostRuleParts(domain);
    const rule = `${matcher} && PathPrefix(\`${domain.path}\`)`;
    const service = middlewares.maintenance === null ? name : PANEL_SERVICE;

    const domainSpecific: string[] = [];
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
    services[name] = compileService(qualifiedName, domain, stopped);
  });

  return { routers, services, middlewares: definitions };
}
