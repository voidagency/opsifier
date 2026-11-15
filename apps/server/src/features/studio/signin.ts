import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbHandle } from "../../core/db";
import { domains, services, studioApps, studioMembers, users } from "../../core/db/schema";
import {
  InvalidProxyInputError,
  PROXY_PAGES_PREFIX,
  type ProxyGuard,
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

/** The Studio project whose preview answers on this host, if any. */
export function previewAppOfHost(db: DbHandle, host: string): PreviewApp | null {
  const row = db
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
    .where(eq(domains.host, host.toLowerCase()))
    .get();
  return row ?? null;
}

/** Whether a Studio preview's routes carry the sign-in: turned on, and the service linked. */
export function signInOnFor(db: Db, projectName: string, serviceName: string): boolean {
  if (!readStudioSettings({ db }).previewSignIn) {
    return false;
  }
  return (
    db
      .select({ id: services.id })
      .from(services)
      .innerJoin(studioApps, eq(studioApps.serviceId, services.id))
      .where(and(eq(services.projectName, projectName), eq(services.name, serviceName)))
      .get() !== undefined
  );
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
  [key: string]: unknown;
}

const REDIRECT_TO_HTTPS = "opsifier-redirect-https";

/**
 * A preview's routing file with the sign-in on every route, or without it. Applied every time a file
 * is written, so it starts from the routes without it, and adds it when the preview needs it.
 */
export function withStudioSignIn(file: string, input: unknown, address: string | null): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const config = input as {
    http?: { routers?: Record<string, Router>; middlewares?: Record<string, unknown> };
  };
  if (config.http?.routers === undefined) {
    return input;
  }
  const name = `${SIGNIN_MIDDLEWARE_PREFIX}${file.replace(/\.ya?ml$/, "").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const routers: Record<string, Router> = {};
  for (const [routerName, router] of Object.entries(config.http.routers)) {
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
  }
  const definitions = Object.fromEntries(
    Object.entries(config.http.middlewares ?? {}).filter(
      ([one]) => !one.startsWith(SIGNIN_MIDDLEWARE_PREFIX),
    ),
  );
  if (address !== null) {
    // Traefik sets the X-Forwarded headers itself, from the request: none sent by a browser is trusted.
    definitions[name] = { forwardAuth: { address, trustForwardHeader: false } };
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

/** Puts the sign-in on the routes of the Studio's previews, before any other guard sees them. */
export function studioSignInGuard(db: Db, address: string, inner: ProxyGuard): ProxyGuard {
  return {
    apply(file, config) {
      const target = routingTarget(file);
      if (target === null) {
        return inner.apply(file, config);
      }
      const on = signInOnFor(db, target.project, target.service);
      return inner.apply(file, withStudioSignIn(file, config, on ? address : null));
    },
    forget: (file) => inner.forget?.(file),
  };
}
