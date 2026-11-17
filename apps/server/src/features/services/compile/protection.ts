import { isAllowlistIp, isAllowlistPath, isValidHostname } from "@opsifier/contract";
import {
  BASE_FILE,
  hostMatcher,
  InvalidProxyInputError,
  PANEL_SERVICE,
  PROXY_PAGES_PREFIX,
  REDIRECT_HTTPS_MIDDLEWARE,
  STUDIO_GUEST_ROUTER_PREFIX,
  STUDIO_SIGNIN_PREFIX,
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
/** The gate that remembers a browser: the panel checks the password, and gives the browser a cookie. */
export const GATE_CHECK_MIDDLEWARE = `${RESERVED}remember-check`;
/** The gate's password never reaches a site, whichever way the request got through. */
export const GATE_STRIP_MIDDLEWARE = `${RESERVED}remember-strip`;
/** A route's twin for a browser the gate remembers that sends no password: it reaches the site as sent. */
export const PASS_ROUTER_PREFIX = `${RESERVED}pass-`;
/** The same twin for a browser that still sends the gate's password, which is taken off on the way. */
export const PASS_BASIC_ROUTER_PREFIX = `${RESERVED}passbasic-`;
/** The cookie the gate remembers a browser by, on each site it got into. */
export const GATE_COOKIE = "opsifier_gate";
/** What a value of the cookie looks like: anything else is never written into a rule. */
const GATE_TOKEN = /^[0-9a-f]{32,128}$/;
/** A request that sends a password the way a browser sends the gate's. */
const BASIC_MATCHER = "HeaderRegexp(`Authorization`, `(?i)^basic\\b`)";
const ROBOTS_PATH_MIDDLEWARE = `${RESERVED}robots-path`;
export const ROBOTS_ROUTER_PREFIX = `${RESERVED}robots-`;
export const EXEMPT_ROUTER_PREFIX = `${RESERVED}exempt-`;

export const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet, noimageindex";
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
/** Where the panel answers with the file above. Public, like the proxy's other pages. */
export const ROBOTS_TXT_PATH = `${PROXY_PAGES_PREFIX}/robots.txt`;

export const REALM = "Protected server";
/** Above any rule's own length, which is what Traefik ranks a route by. */
const ROBOTS_PRIORITY = 1_000_000;
/** One notch over the catch-all, and under every real route. */
const ANY_HOST_ROBOTS_PRIORITY = 2;
const CATCH_ALL_PRIORITY = 1;
const ROBOTS_MATCHER = "Path(`/robots.txt`)";
/** `*` is outside bcrypt's alphabet, so no password can match this: the account is locked. */
const LOCKED_USER = `locked:$2y$10$${"*".repeat(53)}`;

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
  /**
   * The gate remembers a browser: where the panel checks the password, and the values its cookie may
   * hold on one site, which change with the users and every week. Without it, Traefik asks for the
   * password itself, and asks again for every request that comes without it.
   */
  remember?: GateRemember | null;
}

export interface GateRemember {
  address: string;
  /** The values the cookie may hold on this host, in lower case and without a final dot. */
  tokensFor(host: string): readonly string[];
}

/** A plan's remembering, when it can work: someone can sign in. */
function rememberOf(plan: ProtectionPlan): GateRemember | null {
  const remember = plan.remember ?? null;
  return remember !== null && plan.users.length > 0 ? remember : null;
}

interface Router extends Record<string, unknown> {
  rule: string;
  entryPoints?: string[];
  middlewares?: string[];
  priority?: number;
  ruleSyntax?: string;
}

/** Outside its quoted values, a rule this module reasons about holds only these: no comment, no other quote. */
const PLAIN_RULE_CHARACTER = /[A-Za-z0-9_\s(),&|!]/;

/**
 * A rule's parts joined by `&&` at its top level, read the way Traefik reads it; the whole rule as one
 * part when an `||` sits there too. Null for a rule that can't be read for sure: one with an unbalanced
 * parenthesis or backtick, a comment or another kind of quote. Put in parentheses, such a rule could
 * close its group early, and what follows would then hold on its own.
 */
function conjunctsOf(rule: string): string[] | null {
  const conjuncts: string[] = [];
  let depth = 0;
  let quoted = false;
  let either = false;
  let start = 0;
  for (let index = 0; index < rule.length; index += 1) {
    const character = rule.charAt(index);
    if (character === "`") {
      quoted = !quoted;
      continue;
    }
    // Inside a value, Traefik takes everything as it is.
    if (quoted) {
      continue;
    }
    if (!PLAIN_RULE_CHARACTER.test(character)) {
      return null;
    }
    if (character === "(" || character === ")") {
      depth += character === "(" ? 1 : -1;
      if (depth < 0) {
        return null;
      }
      continue;
    }
    const pair = rule.slice(index, index + 2);
    if (depth === 0 && (pair === "&&" || pair === "||")) {
      if (pair === "&&") {
        conjuncts.push(rule.slice(start, index).trim());
        start = index + 2;
      } else {
        either = true;
      }
      index += 1;
    }
  }
  if (quoted || depth !== 0) {
    return null;
  }
  conjuncts.push(rule.slice(start).trim());
  return either ? [rule.trim()] : conjuncts;
}

/** Whether a rule can be put in parentheses and given one more condition, and still mean what it says. */
const isSoundRule = (rule: string): boolean => conjunctsOf(rule) !== null;

const EXACT_HOST = /^Host\(`([^`]*)`\)$/;

/**
 * The one host a rule can ever match, when its form makes that certain: `Host()` stands at its top
 * level, joined to the rest by `&&`, and nothing else in it names a host. Null for anything else, such
 * as a domain and all its subdomains, or two domains on one route.
 */
export function soleHost(rule: string): string | null {
  const conjuncts = conjunctsOf(rule);
  if (conjuncts === null) {
    return null;
  }
  const hosts = conjuncts.flatMap((part) => EXACT_HOST.exec(part)?.slice(1) ?? []);
  const named = rule.replace(/`[^`]*`/g, "``").match(/host/gi)?.length ?? 0;
  const host = hosts.length === 1 && named === 1 ? (hosts[0] as string).toLowerCase().replace(/\.$/, "") : "";
  return isValidHostname(host) ? host : null;
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

function gatedChain(chain: readonly string[], gate: string | readonly string[] | null): string[] {
  const gates = gate === null ? [] : typeof gate === "string" ? [gate] : gate;
  return chain[0] === REDIRECT_HTTPS_MIDDLEWARE
    ? [NOINDEX_MIDDLEWARE, REDIRECT_HTTPS_MIDDLEWARE, ...gates, ...chain.slice(1)]
    : [NOINDEX_MIDDLEWARE, ...gates, ...chain];
}

/** A route that asks for the panel's own sign-in, which says who someone is, needs no shared password. */
const behindPanelSignIn = (chain: readonly string[]): boolean =>
  chain.some((name) => name.startsWith(STUDIO_SIGNIN_PREFIX));

const gateUsers = (plan: ProtectionPlan): string[] =>
  plan.users.length > 0 ? [...plan.users] : [LOCKED_USER];

/**
 * The middlewares every protected route points at. They live in `_base.yaml`, so a route can't be
 * published with its protection half-defined: Traefik refuses a route naming a middleware it can't find.
 */
function sharedDefinitions(plan: ProtectionPlan): Record<string, unknown> {
  const remember = rememberOf(plan);
  return {
    [NOINDEX_MIDDLEWARE]: { headers: { customResponseHeaders: { "X-Robots-Tag": ROBOTS_TAG } } },
    [GATE_MIDDLEWARE]: { basicAuth: { users: gateUsers(plan), realm: REALM, removeHeader: true } },
    [ROBOTS_PATH_MIDDLEWARE]: { replacePath: { path: ROBOTS_TXT_PATH } },
    ...(remember === null
      ? {}
      : {
          // Traefik sets the X-Forwarded headers itself, and passes the cookie on to the browser.
          [GATE_CHECK_MIDDLEWARE]: {
            forwardAuth: {
              address: remember.address,
              trustForwardHeader: false,
              addAuthCookiesToResponse: [GATE_COOKIE],
            },
          },
          [GATE_STRIP_MIDDLEWARE]: { headers: { customRequestHeaders: { Authorization: "" } } },
        }),
  };
}

/**
 * A twin's rule: its route's, for a request carrying the gate's cookie with one of these values, and
 * sending the gate's password or not.
 */
const twinRule = (rule: string, tokens: readonly string[], basic: boolean): string =>
  `(${rule}) && HeaderRegexp(\`Cookie\`, \`(?:^|;\\s*)${GATE_COOKIE}=(?:${tokens.join("|")})(?:;|$)\`) && ${
    basic ? "" : "!"
  }${BASIC_MATCHER}`;

/**
 * The cookie values a route lets through, or none when the route is better left to Traefik's own
 * gate: it sends to HTTPS rather than answers, or its rule does not say for certain which one host
 * it is for, as for a domain with all its subdomains. A value is valid on one host only, and the
 * twin's rule must match that host and no other.
 */
function rememberedTokens(router: Router, remember: GateRemember | null): readonly string[] {
  if (
    remember === null ||
    router.middlewares?.[0] === REDIRECT_HTTPS_MIDDLEWARE ||
    (router.ruleSyntax !== undefined && router.ruleSyntax !== "v3")
  ) {
    return [];
  }
  const host = soleHost(router.rule);
  const tokens = host === null ? [] : remember.tokensFor(host);
  return tokens.length > 0 && tokens.every((token) => GATE_TOKEN.test(token)) ? tokens : [];
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
): string | null {
  if (behindPanelSignIn(router.middlewares ?? [])) {
    return null;
  }
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
  const remember = rememberOf(plan);

  for (const [name, router] of Object.entries(config.http.routers)) {
    const chain = router.middlewares ?? [];
    const gate = gateFor(name, router, definitions, plan, added);
    // The server's own gate remembers a browser: the panel checks the password once, and the route's
    // twins let the browser's cookie through, for what a page asks without the password, such as a
    // service worker's requests. One twin passes the request on as it came, a token of the site's own
    // included; the other takes off the gate's password, which a browser keeps sending once typed.
    const tokens = gate === GATE_MIDDLEWARE ? rememberedTokens(router, remember) : [];
    if (tokens.length > 0) {
      routers[name] = {
        ...router,
        middlewares: gatedChain(chain, [GATE_CHECK_MIDDLEWARE, GATE_STRIP_MIDDLEWARE]),
      };
      // Just above its own route, never above another route the request would otherwise take.
      const priority = (router.priority ?? router.rule.length) + 1;
      routers[`${PASS_ROUTER_PREFIX}${name}`] = {
        ...router,
        rule: twinRule(router.rule, tokens, false),
        priority,
        middlewares: gatedChain(chain, null),
      };
      routers[`${PASS_BASIC_ROUTER_PREFIX}${name}`] = {
        ...router,
        rule: twinRule(router.rule, tokens, true),
        priority,
        middlewares: gatedChain(chain, GATE_STRIP_MIDDLEWARE),
      };
    } else {
      routers[name] = { ...router, middlewares: gatedChain(chain, gate) };
    }

    const robots = `${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`;
    if (!seenRobots.has(robots)) {
      seenRobots.add(robots);
      routers[`${ROBOTS_ROUTER_PREFIX}${name}`] = robotsRouter(router, ROBOTS_PRIORITY);
    }

    plan.exemptions.forEach((exemption, index) => {
      const matcher = exemptionMatcher(exemption);
      // A rule that can't be read for sure gets no exemption: in parentheses, it could end up wider.
      if (matcher !== null && isSoundRule(router.rule)) {
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
  return (
    behindPanelSignIn(chain) ||
    chain.some(
      (name) =>
        ((name === GATE_MIDDLEWARE || name === GATE_CHECK_MIDDLEWARE) &&
          definedUsers(shared[GATE_MIDDLEWARE]).length > 0 &&
          shared[name] !== undefined) ||
        (name.startsWith(`${GATE_MIDDLEWARE}-`) && definedUsers(own[name]).length > 0),
    )
  );
}

const EXEMPTION_CONDITION = /^(?:ClientIP|Path|PathPrefix)\(`[^`]*`\)$/;
const TWIN_TOKENS = new RegExp(`${GATE_COOKIE}=\\(\\?:([0-9a-f|]+)\\)`);

/** The route a twin or an exemption was made from, by its name. */
function siblingName(name: string): string | null {
  if (name.startsWith(PASS_BASIC_ROUTER_PREFIX)) {
    return name.slice(PASS_BASIC_ROUTER_PREFIX.length);
  }
  if (name.startsWith(PASS_ROUTER_PREFIX)) {
    return name.slice(PASS_ROUTER_PREFIX.length);
  }
  return name.startsWith(EXEMPT_ROUTER_PREFIX)
    ? name.slice(EXEMPT_ROUTER_PREFIX.length).replace(/-\d+$/, "")
    : null;
}

/**
 * Whether a route that lets requests past the gate is only ever narrower than the route it was made
 * from, as this module writes it: a twin asks for the gate's cookie on that route's one host, and an
 * exemption adds one path or address to a rule that can be read for sure.
 */
function isBounded(name: string, router: Router, sibling: Router | undefined): boolean {
  if (sibling === undefined || router.middlewares?.[0] !== NOINDEX_MIDDLEWARE) {
    return false;
  }
  if (name.startsWith(EXEMPT_ROUTER_PREFIX)) {
    const prefix = `(${sibling.rule}) && `;
    return (
      isSoundRule(sibling.rule) &&
      router.rule.startsWith(prefix) &&
      EXEMPTION_CONDITION.test(router.rule.slice(prefix.length))
    );
  }
  const tokens = TWIN_TOKENS.exec(router.rule)?.[1]?.split("|") ?? [];
  return (
    soleHost(sibling.rule) !== null &&
    tokens.length > 0 &&
    tokens.every((token) => GATE_TOKEN.test(token)) &&
    router.rule === twinRule(sibling.rule, tokens, name.startsWith(PASS_BASIC_ROUTER_PREFIX))
  );
}

function auditServiceFile(file: string, input: unknown, shared: Record<string, unknown>): AuditedDomain[] {
  const config = asConfig(input);
  const byName = config.http?.routers ?? {};
  const routers = Object.entries(byName);
  const own = config.http?.middlewares ?? {};
  const robots = new Set(
    routers
      .filter(([name]) => name.startsWith(ROBOTS_ROUTER_PREFIX))
      .map(([, router]) => `${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`),
  );

  const domains = new Map<string, AuditedDomain>();
  const note = (rule: string, isProtected: boolean) => {
    const shape = routeShape(rule);
    const key = `${shape.wildcard}|${shape.host}|${shape.path}`;
    const known = domains.get(key);
    domains.set(key, { ...shape, file, protected: isProtected && (known?.protected ?? true) });
  };
  for (const [name, router] of routers) {
    if (name.startsWith(STUDIO_GUEST_ROUTER_PREFIX)) {
      continue;
    }
    if (name.startsWith(RESERVED)) {
      // A way past the gate that is wider than its route leaves that route's domain open.
      const sibling = siblingName(name);
      const made = sibling === null || sibling.startsWith(RESERVED) ? undefined : byName[sibling];
      if (sibling !== null && !isBounded(name, router, made)) {
        note(made?.rule ?? router.rule, false);
      }
      continue;
    }
    const chain = router.middlewares ?? [];
    const isProtected =
      chain[0] === NOINDEX_MIDDLEWARE &&
      isGated(chain, shared, own) &&
      robots.has(`${hostMatcher(router.rule) ?? "*"}|${entryKey(router)}`);
    note(router.rule, isProtected);
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
