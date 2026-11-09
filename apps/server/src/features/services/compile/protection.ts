import { isAllowlistIp, isAllowlistPath } from "@opsifier/contract";
import {
  BASE_FILE,
  InvalidProxyInputError,
  PANEL_SERVICE,
  PROXY_PAGES_PREFIX,
  REDIRECT_HTTPS_MIDDLEWARE,
} from "../../../core/proxy";

/**
 * What a non-production server adds to every route. Pure, and it works on the routing files
 * themselves rather than on one kind of service, so whatever produces a route later is covered by
 * the same code. Everything it adds carries the reserved prefix, so applying it twice, or to a file
 * that was protected for another purpose, always starts from the plain routes.
 */

const RESERVED = "opsifier-protect-";

export const NOINDEX_MIDDLEWARE = `${RESERVED}noindex`;
export const GATE_MIDDLEWARE = `${RESERVED}gate`;
const ROBOTS_PATH_MIDDLEWARE = `${RESERVED}robots-path`;
export const ROBOTS_ROUTER_PREFIX = `${RESERVED}robots-`;
export const EXEMPT_ROUTER_PREFIX = `${RESERVED}exempt-`;

export const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet, noimageindex";
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
/** Where the panel answers with the file above. Public, like the proxy's other pages. */
export const ROBOTS_TXT_PATH = `${PROXY_PAGES_PREFIX}/robots.txt`;

const REALM = "Protected server";
/** Above any rule's own length, which is what Traefik ranks a route by. */
const ROBOTS_PRIORITY = 1_000_000;
/** One notch over the catch-all, and under every real route. */
const ANY_HOST_ROBOTS_PRIORITY = 2;
const CATCH_ALL_PRIORITY = 1;
const ROBOTS_MATCHER = "Path(`/robots.txt`)";
/** `*` is outside bcrypt's alphabet, so no password can match this: the account is locked. */
const LOCKED_USER = `locked:$2y$10$${"*".repeat(53)}`;

const HOST_MATCHERS = /(?:HostRegexp|Host)\(`[^`]*`\)/g;

export interface ProtectionExemption {
  kind: "path" | "ip";
  value: string;
}

export interface ProtectionPlan {
  /** False on production, where nothing is injected. */
  enabled: boolean;
  /** `user:bcrypt` lines. With none, every route is locked: nobody gets through. */
  users: readonly string[];
  exemptions: readonly ProtectionExemption[];
}

interface Router extends Record<string, unknown> {
  rule: string;
  entryPoints?: string[];
  middlewares?: string[];
  priority?: number;
}

interface HttpSection extends Record<string, unknown> {
  routers?: Record<string, Router>;
  middlewares?: Record<string, unknown>;
}

interface RoutingConfig extends Record<string, unknown> {
  http?: HttpSection;
}

function asConfig(value: unknown): RoutingConfig {
  if (value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProxyInputError("A routing file must be a mapping.");
  }
  const config = value as RoutingConfig;
  for (const [name, router] of Object.entries(config.http?.routers ?? {})) {
    if (typeof router?.rule !== "string") {
      throw new InvalidProxyInputError(`The route ${name} has no rule.`);
    }
  }
  return config;
}

/** The routes as their owner wrote them, with anything this module added taken out. */
export function stripProtection(input: unknown): RoutingConfig {
  const config = asConfig(input);
  if (config.http === undefined) {
    return config;
  }
  const { routers, middlewares, ...http } = config.http;
  const plain: HttpSection = { ...http };
  if (routers !== undefined) {
    plain.routers = Object.fromEntries(
      Object.entries(routers)
        .filter(([name]) => !name.startsWith(RESERVED))
        .map(([name, router]) => [name, withoutReservedMiddlewares(router)]),
    );
  }
  const definitions = Object.entries(middlewares ?? {}).filter(([name]) => !name.startsWith(RESERVED));
  if (definitions.length > 0) {
    plain.middlewares = Object.fromEntries(definitions);
  }
  return { ...config, http: plain };
}

function withoutReservedMiddlewares(router: Router): Router {
  const { middlewares, ...rest } = router;
  const kept = (middlewares ?? []).filter((name) => !name.startsWith(RESERVED));
  return kept.length > 0 ? { ...rest, middlewares: kept } : rest;
}

/** Basic auth cannot reach a raw TCP or UDP route, so on a protected server it is not published. */
function assertHttpOnly(config: RoutingConfig): void {
  for (const protocol of ["tcp", "udp"] as const) {
    const section = config[protocol] as { routers?: Record<string, unknown> } | undefined;
    if (Object.keys(section?.routers ?? {}).length > 0) {
      throw new InvalidProxyInputError(`A ${protocol} route can't be protected.`);
    }
  }
}

function safeHttpSection(value: unknown): HttpSection | undefined {
  try {
    return asConfig(value).http;
  } catch {
    return undefined;
  }
}

function hostMatcher(rule: string): string | null {
  const matchers = rule.match(HOST_MATCHERS);
  if (matchers === null) {
    return null;
  }
  return matchers.length === 1 ? (matchers[0] as string) : `(${matchers.join(" || ")})`;
}

function isBasicAuth(definition: unknown): definition is { basicAuth: { users?: string[] } } {
  return typeof definition === "object" && definition !== null && "basicAuth" in definition;
}

const entryKey = (router: Router): string => (router.entryPoints ?? []).join(",");

function robotsRouter(source: Router, priority: number): Router {
  const matcher = hostMatcher(source.rule);
  const { tls, entryPoints } = source;
  return {
    rule: matcher === null ? ROBOTS_MATCHER : `${matcher} && ${ROBOTS_MATCHER}`,
    priority,
    ...(entryPoints === undefined ? {} : { entryPoints }),
    middlewares: [NOINDEX_MIDDLEWARE, ROBOTS_PATH_MIDDLEWARE],
    service: PANEL_SERVICE,
    ...(tls === undefined ? {} : { tls }),
  };
}

/** Exactly where the exemption says, and never wider than the route it belongs to. */
function exemptionMatcher({ kind, value }: ProtectionExemption): string | null {
  if (kind === "ip") {
    return isAllowlistIp(value) ? `ClientIP(\`${value}\`)` : null;
  }
  if (!isAllowlistPath(value)) {
    return null;
  }
  return value.endsWith("/*") ? `PathPrefix(\`${value.slice(0, -1)}\`)` : `Path(\`${value}\`)`;
}

function gatedChain(chain: readonly string[], gate: string): string[] {
  return chain[0] === REDIRECT_HTTPS_MIDDLEWARE
    ? [NOINDEX_MIDDLEWARE, REDIRECT_HTTPS_MIDDLEWARE, gate, ...chain.slice(1)]
    : [NOINDEX_MIDDLEWARE, gate, ...chain];
}

const gateUsers = (plan: ProtectionPlan): string[] =>
  plan.users.length > 0 ? [...plan.users] : [LOCKED_USER];

/**
 * The middlewares every protected route points at. They live in `_base.yaml`, so a route can't be
 * published with its protection half-defined: Traefik refuses a route naming a middleware it can't find.
 */
function sharedDefinitions(plan: ProtectionPlan): Record<string, unknown> {
  return {
    [NOINDEX_MIDDLEWARE]: { headers: { customResponseHeaders: { "X-Robots-Tag": ROBOTS_TAG } } },
    [GATE_MIDDLEWARE]: { basicAuth: { users: gateUsers(plan), realm: REALM, removeHeader: true } },
    [ROBOTS_PATH_MIDDLEWARE]: { replacePath: { path: ROBOTS_TXT_PATH } },
  };
}

/**
 * One gate per request is all HTTP allows: a browser sends a single Authorization header, so two
 * independent basic auth layers can never both pass. A route with its own users therefore gets a gate
 * that also lets those users in, and its own layer still has the last word.
 */
function gateFor(
  name: string,
  router: Router,
  definitions: Record<string, unknown>,
  plan: ProtectionPlan,
  added: Record<string, unknown>,
): string {
  const own = (router.middlewares ?? []).flatMap((middleware) => {
    const definition = definitions[middleware];
    return isBasicAuth(definition) ? (definition.basicAuth.users ?? []) : [];
  });
  if (own.length === 0) {
    return GATE_MIDDLEWARE;
  }
  const gate = `${GATE_MIDDLEWARE}-${name}`;
  added[gate] = { basicAuth: { users: [...gateUsers(plan), ...own], realm: REALM, removeHeader: false } };
  return gate;
}

/** A service's routing file: every route behind the gate, tagged, and with its own robots.txt. */
export function protectServiceConfig(input: unknown, plan: ProtectionPlan): RoutingConfig {
  const config = stripProtection(input);
  if (!plan.enabled) {
    return config;
  }
  assertHttpOnly(config);
  if (config.http?.routers === undefined) {
    return config;
  }

  const definitions = config.http.middlewares ?? {};
  const routers: Record<string, Router> = {};
  const added: Record<string, unknown> = {};
  const seenRobots = new Set<string>();

  for (const [name, router] of Object.entries(config.http.routers)) {
    const chain = router.middlewares ?? [];
    routers[name] = {
      ...router,
      middlewares: gatedChain(chain, gateFor(name, router, definitions, plan, added)),
    };

    const robots = `${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`;
    if (!seenRobots.has(robots)) {
      seenRobots.add(robots);
      routers[`${ROBOTS_ROUTER_PREFIX}${name}`] = robotsRouter(router, ROBOTS_PRIORITY);
    }

    plan.exemptions.forEach((exemption, index) => {
      const matcher = exemptionMatcher(exemption);
      if (matcher !== null) {
        routers[`${EXEMPT_ROUTER_PREFIX}${name}-${index}`] = {
          ...router,
          rule: `(${router.rule}) && ${matcher}`,
          // Just above its own route, so it can't take a path another service is answering on.
          priority: (router.priority ?? router.rule.length) + 1,
          middlewares: [NOINDEX_MIDDLEWARE, ...chain],
        };
      }
    });
  }

  return {
    ...config,
    http: {
      ...config.http,
      routers,
      ...(Object.keys(definitions).length + Object.keys(added).length > 0
        ? { middlewares: { ...definitions, ...added } }
        : {}),
    },
  };
}

/** The panel's own routes keep its login: they get the header and robots.txt, never the gate. */
export function protectBaseConfig(input: unknown, plan: ProtectionPlan): RoutingConfig {
  const config = stripProtection(input);
  if (!plan.enabled) {
    return config;
  }
  const routers: Record<string, Router> = {};
  const seenRobots = new Set<string>();
  for (const [name, router] of Object.entries(config.http?.routers ?? {})) {
    routers[name] = { ...router, middlewares: [NOINDEX_MIDDLEWARE, ...(router.middlewares ?? [])] };
    const robots = `${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`;
    if (!seenRobots.has(robots)) {
      seenRobots.add(robots);
      const catchAll = router.priority === CATCH_ALL_PRIORITY;
      routers[`${ROBOTS_ROUTER_PREFIX}${name}`] = robotsRouter(
        router,
        catchAll ? ANY_HOST_ROBOTS_PRIORITY : ROBOTS_PRIORITY,
      );
    }
  }
  return {
    ...config,
    http: {
      ...config.http,
      routers,
      middlewares: { ...config.http?.middlewares, ...sharedDefinitions(plan) },
    },
  };
}

/** The one entry point: whatever is about to reach the proxy, under the given plan. */
export function protectRoutingFile(file: string, input: unknown, plan: ProtectionPlan): RoutingConfig {
  return file === BASE_FILE ? protectBaseConfig(input, plan) : protectServiceConfig(input, plan);
}

export interface AuditedDomain {
  host: string;
  path: string;
  wildcard: boolean;
  file: string;
  protected: boolean;
}

export interface RoutingAudit {
  domains: AuditedDomain[];
  panelProtected: boolean;
  unreadable: string[];
}

function routeShape(rule: string): Pick<AuditedDomain, "host" | "path" | "wildcard"> {
  const wildcard = /HostRegexp\(`\^\[a-z0-9-\]\+\\\.([^`$]*)\$`\)/.exec(rule);
  const host = /Host\(`([^`]*)`\)/.exec(rule);
  // A route under a path holds `Path(/api)` and then `PathPrefix(/api/)`, and its path is the first.
  const path = /Path\(`([^`]*)`\)/.exec(rule) ?? /PathPrefix\(`([^`]*)`\)/.exec(rule);
  return {
    host: wildcard?.[1]?.replaceAll("\\.", ".") ?? host?.[1] ?? rule,
    path: path?.[1] ?? "/",
    wildcard: wildcard !== null,
  };
}

const definedUsers = (definition: unknown): readonly unknown[] =>
  isBasicAuth(definition) ? (definition.basicAuth.users ?? []) : [];

function isGated(
  chain: readonly string[],
  shared: Record<string, unknown>,
  own: Record<string, unknown>,
): boolean {
  return chain.some(
    (name) =>
      (name === GATE_MIDDLEWARE && definedUsers(shared[name]).length > 0) ||
      (name.startsWith(`${GATE_MIDDLEWARE}-`) && definedUsers(own[name]).length > 0),
  );
}

function auditServiceFile(file: string, input: unknown, shared: Record<string, unknown>): AuditedDomain[] {
  const config = asConfig(input);
  const routers = Object.entries(config.http?.routers ?? {});
  const own = config.http?.middlewares ?? {};
  const robots = new Set(
    routers
      .filter(([name]) => name.startsWith(ROBOTS_ROUTER_PREFIX))
      .map(([, router]) => `${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`),
  );

  const domains = new Map<string, AuditedDomain>();
  for (const [name, router] of routers) {
    if (name.startsWith(RESERVED)) {
      continue;
    }
    const chain = router.middlewares ?? [];
    const isProtected =
      chain[0] === NOINDEX_MIDDLEWARE &&
      isGated(chain, shared, own) &&
      robots.has(`${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`);
    const shape = routeShape(router.rule);
    const key = `${shape.wildcard}|${shape.host}|${shape.path}`;
    const known = domains.get(key);
    domains.set(key, {
      ...shape,
      file,
      protected: isProtected && (known?.protected ?? true),
    });
  }
  return [...domains.values()];
}

/** Reads back what the proxy was really given. A gap here is a real gap. */
export function auditRoutingFiles(
  files: readonly { file: string; config: unknown }[],
  enabled: boolean,
): RoutingAudit {
  const unreadable: string[] = [];
  const readable = files.filter(({ file, config }) => {
    if (config === null) {
      unreadable.push(file);
      return false;
    }
    return true;
  });
  const base = readable.find(({ file }) => file === BASE_FILE);
  const baseHttp = base === undefined ? undefined : safeHttpSection(base.config);
  const shared = baseHttp?.middlewares ?? {};

  const domains = readable
    .filter(({ file }) => file !== BASE_FILE)
    .flatMap(({ file, config }) => {
      try {
        return auditServiceFile(file, config, shared);
      } catch {
        unreadable.push(file);
        return [];
      }
    });

  const baseRouters = Object.entries(baseHttp?.routers ?? {});
  const panelProtected =
    !enabled ||
    (NOINDEX_MIDDLEWARE in shared &&
      baseRouters.every(
        ([name, router]) => name.startsWith(RESERVED) || router.middlewares?.[0] === NOINDEX_MIDDLEWARE,
      ));

  return { domains, panelProtected, unreadable };
}
