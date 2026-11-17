import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { domains, services, studioApps, studioMembers, users } from "../../core/db/schema";
import {
  hostMatcher,
  InvalidProxyInputError,
  PANEL_SERVICE,
  PROXY_PAGES_PREFIX,
  type ProxyGuard,
  STUDIO_GUEST_ROUTER_PREFIX,
  STUDIO_SIGNIN_PREFIX,
} from "../../core/proxy";
import type { Secrets } from "../../core/secrets";
import { readStudioSettings } from "./settings";

/**
 * Studio previews behind the panel's own sign-in, instead of a password shared by every site.
 *
 * Traefik asks the panel about every request to a preview (its forwardAuth middleware). With no
 * cookie for that preview, the browser goes to the panel, which knows who is signed in, gives a code
 * good once for a minute, and sends the browser back to the preview, where the code becomes a
 * cookie of that preview's own. Whether that person may still open the preview is read again on
 * each request, from a short cache, so taking a project back takes effect within half a minute.
 */

/** The middleware's name prefix: the server's gate leaves a route that carries one alone. */
export const SIGNIN_MIDDLEWARE_PREFIX = STUDIO_SIGNIN_PREFIX;
/** Where Traefik asks: under the proxy's own pages, which answer under any name. */
export const SIGNIN_CHECK_PATH = `${PROXY_PAGES_PREFIX}/studio-signin`;
/** On the preview's own address: where a code from the panel becomes the preview's cookie. */
export const SIGNIN_RETURN_PATH = "/__opsifier/studio-signin";
export const PREVIEW_COOKIE = "opsifier_studio_preview";
/**
 * On the preview's own address: the panel's pages for the people a client's link lets in, and their
 * remarks. Same origin as the page, so the inspector reaches them with the page's own cookies.
 */
export const GUEST_PAGES_PATH = "/__opsifier/studio/";
/** Where the proxy sends them, on the panel: under its pages, which answer under any name. */
export const GUEST_PAGES_PREFIX = `${PROXY_PAGES_PREFIX}/studio`;

/** A short page in the panel's two languages, for the hops of a preview that can fail. */
export function previewPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head><body><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;
}

const CODE_TTL_MS = 60_000;
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
const DECISION_TTL_MS = 30_000;
const TOKEN_CONTEXT = "studio-preview-signin";
const MAX_CODES = 10_000;

export interface PreviewApp {
  serviceId: string;
  projectName: string;
  serviceName: string;
  https: boolean;
}

/**
 * The Studio project whose preview answers on this host, if any. Two previews on one host, each on a
 * path of its own, can't be told apart from the host alone: neither is, and a wildcard answers none.
 */
export function previewAppOfHost(db: DbHandle, host: string): PreviewApp | null {
  const rows = db
    .select({
      serviceId: studioApps.serviceId,
      projectName: services.projectName,
      serviceName: services.name,
      https: domains.https,
    })
    .from(domains)
    .innerJoin(
      services,
      and(eq(services.projectName, domains.projectName), eq(services.name, domains.serviceName)),
    )
    .innerJoin(studioApps, eq(studioApps.serviceId, services.id))
    .where(and(eq(domains.host, host.toLowerCase()), eq(domains.wildcard, false)))
    .all();
  return new Set(rows.map((row) => row.serviceId)).size === 1 ? (rows[0] ?? null) : null;
}

/** Whether a service is a Studio project's preview. */
export function isLinkedPreview(db: Db, projectName: string, serviceName: string): boolean {
  return (
    db
      .select({ id: services.id })
      .from(services)
      .innerJoin(studioApps, eq(studioApps.serviceId, services.id))
      .where(and(eq(services.projectName, projectName), eq(services.name, serviceName)))
      .get() !== undefined
  );
}

/** Whether a Studio preview's routes carry the sign-in: turned on, and the service linked. */
export function signInOnFor(db: Db, projectName: string, serviceName: string): boolean {
  return readStudioSettings({ db }).previewSignIn && isLinkedPreview(db, projectName, serviceName);
}

/** An administrator, or an account the project is shared with, still active. */
export function mayOpenPreview(db: DbHandle, userId: string, serviceId: string): boolean {
  const user = db
    .select({ role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (user === undefined || user.deactivatedAt !== null) {
    return false;
  }
  if (user.role === "admin") {
    return true;
  }
  return (
    db
      .select({ userId: studioMembers.userId })
      .from(studioMembers)
      .where(and(eq(studioMembers.serviceId, serviceId), eq(studioMembers.userId, userId)))
      .get() !== undefined
  );
}

/** A path on the preview to land on: absolute, on the same host, and nothing a browser reads as another. */
export function safeReturnPath(to: string | undefined): string {
  if (to === undefined || !to.startsWith("/") || to.startsWith("//") || /[\\\r\n]/.test(to)) {
    return "/";
  }
  return to;
}

interface Code {
  userId: string;
  host: string;
  expires: number;
}

/** Codes from the panel to a preview: in memory, good once and for a minute, for one host. */
export class PreviewSignIn {
  private readonly codes = new Map<string, Code>();
  private readonly decisions = new Map<string, { allowed: boolean; until: number }>();

  constructor(
    private readonly secrets: Pick<Secrets, "seal" | "unseal">,
    private readonly now: () => number,
  ) {}

  issueCode(userId: string, host: string): string {
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (entry.expires <= now) {
        this.codes.delete(code);
      }
    }
    if (this.codes.size >= MAX_CODES) {
      this.codes.clear();
    }
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { userId, host: host.toLowerCase(), expires: now + CODE_TTL_MS });
    return code;
  }

  /** The account a code was given to, once, if it is for this host and still good. */
  redeemCode(code: string, host: string): string | null {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (entry === undefined || entry.expires <= this.now() || entry.host !== host.toLowerCase()) {
      return null;
    }
    return entry.userId;
  }

  /** The preview's cookie: who, for which host, until when, sealed with the panel's key. */
  cookieFor(userId: string, host: string): { value: string; maxAgeSeconds: number } {
    const expires = this.now() + COOKIE_TTL_MS;
    const value = this.secrets.seal(
      JSON.stringify({ u: userId, h: host.toLowerCase(), e: expires }),
      TOKEN_CONTEXT,
    );
    return { value, maxAgeSeconds: Math.floor(COOKIE_TTL_MS / 1000) };
  }

  /** The account a cookie names for this host, if it is genuine and still good. */
  readCookie(value: string, host: string): string | null {
    try {
      const token = JSON.parse(this.secrets.unseal(value, TOKEN_CONTEXT)) as {
        u?: unknown;
        h?: unknown;
        e?: unknown;
      };
      if (
        typeof token.u !== "string" ||
        token.h !== host.toLowerCase() ||
        typeof token.e !== "number" ||
        token.e <= this.now()
      ) {
        return null;
      }
      return token.u;
    } catch {
      return null;
    }
  }

  /** Whether this cookie opens this preview, decided at most every half minute. */
  allowed(cookie: string, decide: () => boolean): boolean {
    const now = this.now();
    const known = this.decisions.get(cookie);
    if (known !== undefined && known.until > now) {
      return known.allowed;
    }
    if (this.decisions.size >= MAX_CODES) {
      this.decisions.clear();
    }
    const allowed = decide();
    this.decisions.set(cookie, { allowed, until: now + DECISION_TTL_MS });
    return allowed;
  }
}

interface Router {
  rule: string;
  middlewares?: string[];
  entryPoints?: string[];
  tls?: unknown;
  [key: string]: unknown;
}

const REDIRECT_TO_HTTPS = "opsifier-redirect-https";

/**
 * A preview's routing file with the sign-in on every route, or without it, and, for a Studio project's
 * preview, with routes of the panel's own under {@link GUEST_PAGES_PATH} on each of its hosts. Applied
 * every time a file is written, so it starts from the routes without either, and adds what the
 * preview needs. The panel's routes carry a middleware named as the sign-in's, so that the server's
 * gate leaves them alone: the panel checks who is there itself, from a client's link or the sign-in.
 */
export function withStudioSignIn(
  file: string,
  input: unknown,
  address: string | null,
  guestPages = false,
): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const config = input as {
    http?: { routers?: Record<string, Router>; middlewares?: Record<string, unknown> };
  };
  if (config.http?.routers === undefined) {
    return input;
  }
  const slug = file.replace(/\.ya?ml$/, "").replace(/[^A-Za-z0-9_-]/g, "-");
  const name = `${SIGNIN_MIDDLEWARE_PREFIX}${slug}`;
  // A file's name holds `__` once, so no other file's sign-in can be called this.
  const guestName = `${SIGNIN_MIDDLEWARE_PREFIX}${slug}__guest`;
  const routers: Record<string, Router> = {};
  const guestRouters: Record<string, Router> = {};
  const hosts = new Set<string>();
  for (const [routerName, router] of Object.entries(config.http.routers)) {
    if (routerName.startsWith(STUDIO_GUEST_ROUTER_PREFIX)) {
      // Made again below, from the routes as they are now.
      continue;
    }
    if (typeof router?.rule !== "string") {
      throw new InvalidProxyInputError(`The route ${routerName} has no rule.`);
    }
    const chain = (router.middlewares ?? []).filter((one) => !one.startsWith(SIGNIN_MIDDLEWARE_PREFIX));
    const signed =
      address === null
        ? chain
        : chain[0] === REDIRECT_TO_HTTPS
          ? [REDIRECT_TO_HTTPS, name, ...chain.slice(1)]
          : [name, ...chain];
    const { middlewares: _dropped, ...rest } = router;
    routers[routerName] = signed.length > 0 ? { ...rest, middlewares: signed } : rest;

    const host = guestPages ? hostMatcher(router.rule) : null;
    const key = `${host}|${(router.entryPoints ?? []).join(",")}`;
    if (host !== null && !hosts.has(key)) {
      hosts.add(key);
      const { entryPoints, tls } = router;
      // Longer than any rule of the preview's own on the same host, so Traefik ranks it first.
      guestRouters[`${STUDIO_GUEST_ROUTER_PREFIX}${routerName}`] = {
        rule: `${host} && PathPrefix(\`${GUEST_PAGES_PATH}\`)`,
        ...(entryPoints === undefined ? {} : { entryPoints }),
        middlewares: chain[0] === REDIRECT_TO_HTTPS ? [REDIRECT_TO_HTTPS, guestName] : [guestName],
        service: PANEL_SERVICE,
        ...(tls === undefined ? {} : { tls }),
      };
    }
  }
  Object.assign(routers, guestRouters);
  const definitions = Object.fromEntries(
    Object.entries(config.http.middlewares ?? {}).filter(
      ([one]) => !one.startsWith(SIGNIN_MIDDLEWARE_PREFIX),
    ),
  );
  if (address !== null) {
    // Traefik sets the X-Forwarded headers itself, from the request: none sent by a browser is trusted.
    definitions[name] = { forwardAuth: { address, trustForwardHeader: false } };
  }
  if (Object.keys(guestRouters).length > 0) {
    definitions[guestName] = {
      replacePathRegex: { regex: `^${GUEST_PAGES_PATH}(.*)$`, replacement: `${GUEST_PAGES_PREFIX}/$1` },
    };
  }
  const { middlewares: _old, ...http } = config.http;
  return {
    ...config,
    http: { ...http, routers, ...(Object.keys(definitions).length > 0 ? { middlewares: definitions } : {}) },
  };
}

/** A service's routing file is `<project>__<service>.yaml`, and neither name holds `__`. */
const routingTarget = (file: string): { project: string; service: string } | null => {
  if (file.startsWith("_") || !file.endsWith(".yaml")) {
    return null;
  }
  const [project, service, ...rest] = file.slice(0, -".yaml".length).split("__");
  return project && service && rest.length === 0 ? { project, service } : null;
};

/**
 * Puts the sign-in, and the panel's pages for clients, on the routes of the Studio's previews, before
 * any other guard sees them.
 */
export function studioSignInGuard(db: Db, address: string, inner: ProxyGuard): ProxyGuard {
  return {
    apply(file, config) {
      const target = routingTarget(file);
      if (target === null) {
        return inner.apply(file, config);
      }
      const linked = isLinkedPreview(db, target.project, target.service);
      const on = linked && readStudioSettings({ db }).previewSignIn;
      return inner.apply(file, withStudioSignIn(file, config, on ? address : null, linked));
    },
    forget: (file) => inner.forget?.(file),
  };
}
