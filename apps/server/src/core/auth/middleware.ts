import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ActionSource } from "../actions/source";
import { runAs } from "../actions/source";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import type { Db } from "../db";
import { forbidden, unauthorized } from "../errors";
import { type RequestScheme, resolveClientIp, resolveRequestScheme, UNKNOWN_IP } from "./client-ip";
import { findSessionPrincipal, findTokenPrincipal, type Principal, sessionTtlMs } from "./credentials";
import { isOriginAllowed } from "./origin";
import type { RateLimitRule } from "./rate-limit";

export const SESSION_COOKIE = "opsifier_session";
/** Over HTTPS. Browsers only accept this name with `Secure`, no `Domain` and `Path=/`. */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

/**
 * The one cookie a request may authenticate with. Reading only this one is what makes the prefix
 * worth having: a plain cookie planted from another port or over HTTP is ignored on HTTPS.
 */
export function sessionCookieName(scheme: RequestScheme): string {
  return scheme === "https" ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

export interface AuthLimits {
  /** One address guessing at one account. */
  loginPerAddressAndEmail: RateLimitRule;
  /** One address trying many accounts. */
  loginPerAddress: RateLimitRule;
  /** Many addresses guessing at one account. High enough that one address cannot lock anyone out. */
  loginPerEmail: RateLimitRule;
  /** Password or code checks behind an existing session, in case the session was stolen. */
  sensitivePerUser: RateLimitRule;
  /** One address failing to open a box's IDE. A token that works costs nothing. */
  idePerAddress: RateLimitRule;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const defaultAuthLimits: AuthLimits = {
  loginPerAddressAndEmail: { limit: 5, windowMs: FIFTEEN_MINUTES },
  loginPerAddress: { limit: 20, windowMs: FIFTEEN_MINUTES },
  loginPerEmail: { limit: 50, windowMs: FIFTEEN_MINUTES },
  sensitivePerUser: { limit: 10, windowMs: FIFTEEN_MINUTES },
  idePerAddress: { limit: 30, windowMs: FIFTEEN_MINUTES },
};

const BEARER = /^Bearer\s+(\S+)$/i;
/** A session the command line received from `opsifier login --web`, sent the way an API key is. */
const SESSION = /^Session\s+(\S+)$/i;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function peerAddress(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // No socket behind this request: it did not come over the network.
    return undefined;
  }
}

/** The scheme this request reached the panel with, as far as it can be believed. */
export function requestScheme(c: Context<AppEnv>, config: Pick<Config, "trustedProxies">): RequestScheme {
  return resolveRequestScheme(
    {
      encrypted: new URL(c.req.url).protocol === "https:",
      peer: peerAddress(c),
      forwardedProto: c.req.header("x-forwarded-proto"),
    },
    config.trustedProxies,
  );
}

/** What an Action started by this request will say about where it came from. */
function sourceOf(principal: Principal | null): ActionSource {
  if (principal?.kind === "token") {
    return { origin: "api_key", actorEmail: principal.user.email, detail: principal.tokenName };
  }
  return { origin: "session", actorEmail: principal?.user.email };
}

/**
 * Resolves the caller into `principal`. Credentials that were sent but are wrong are a 401, except
 * on paths that read the Authorization header themselves: a deployment trigger is no API key.
 */
export function authenticate(
  deps: {
    db: Db;
    now: () => number;
    config: Pick<Config, "trustedProxies">;
  },
  readsOwnBearer: (path: string) => boolean = () => false,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = readsOwnBearer(c.req.path) ? undefined : c.req.header("authorization");
    let principal: Principal | null = null;

    if (authorization !== undefined) {
      const session = SESSION.exec(authorization)?.[1];
      if (session !== undefined) {
        principal = findSessionPrincipal(deps.db, session, deps.now());
        if (principal === null) {
          throw unauthorized(
            "invalid_session",
            "This session has ended. Sign in again with opsifier login --web.",
          );
        }
      } else {
        const token = BEARER.exec(authorization)?.[1];
        principal = token === undefined ? null : findTokenPrincipal(deps.db, token, deps.now());
        if (principal === null) {
          throw unauthorized("invalid_token", "This API token is not valid.");
        }
      }
    } else {
      const token = getCookie(c, sessionCookieName(requestScheme(c, deps.config)));
      if (token !== undefined) {
        principal = findSessionPrincipal(deps.db, token, deps.now());
      }
    }

    c.set("principal", principal);
    await runAs(sourceOf(principal), next);
  };
}

/**
 * Stops cross-site requests. A bearer token is never sent automatically by a browser, so only
 * cookies need this. A request without an `Origin` is allowed only if it has no cookie either:
 * browsers always send one on a mutation, so that case is a script with nothing to abuse.
 */
export function originGuard(
  config: Pick<Config, "allowedOrigins" | "trustedProxies">,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method) || c.req.header("authorization") !== undefined) {
      return next();
    }
    const scheme = requestScheme(c, config);
    const origin = c.req.header("origin");
    if (origin === undefined && getCookie(c, sessionCookieName(scheme)) === undefined) {
      return next();
    }
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isOriginAllowed(origin, { host, scheme }, config.allowedOrigins)) {
      throw forbidden("origin_rejected", "This request came from a page that is not allowed to make it.");
    }
    return next();
  };
}

/** Secure by default: a route is private unless its feature declares it public. */
export function requireAuthentication(isPublic: (path: string) => boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("principal") === null && !isPublic(c.req.path)) {
      throw unauthorized("unauthenticated", "Sign in to continue.");
    }
    return next();
  };
}

/** The signed-in principal of a route that requires authentication. */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (principal === null) {
    throw unauthorized("unauthenticated", "Sign in to continue.");
  }
  return principal;
}

/** Changing a password or a second factor takes a person at a browser, not an API token. */
export function requireSessionPrincipal(c: Context<AppEnv>): Extract<Principal, { kind: "session" }> {
  const principal = requirePrincipal(c);
  if (principal.kind !== "session") {
    throw forbidden(
      "session_required",
      "This can only be done by a person signed in: in a browser, or from the command line after opsifier login --web.",
    );
  }
  return principal;
}

export function setSessionCookie(
  c: Context<AppEnv>,
  config: Pick<Config, "trustedProxies">,
  token: string,
  persistent: boolean,
): void {
  const scheme = requestScheme(c, config);
  const secure = scheme === "https";
  setCookie(c, sessionCookieName(scheme), token, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    secure,
    ...(persistent ? { maxAge: Math.floor(sessionTtlMs(persistent, secure) / 1000) } : {}),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, config: Pick<Config, "trustedProxies">): void {
  const scheme = requestScheme(c, config);
  deleteCookie(c, sessionCookieName(scheme), {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    secure: scheme === "https",
  });
}

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
  /** Whether the request reached the panel over HTTPS. */
  secure: boolean;
}

export function requestMeta(c: Context<AppEnv>, config: Pick<Config, "trustedProxies">): RequestMeta {
  return {
    ip: resolveClientIp(peerAddress(c), c.req.header("x-forwarded-for"), config.trustedProxies) || UNKNOWN_IP,
    userAgent: c.req.header("user-agent") ?? null,
    secure: requestScheme(c, config) === "https",
  };
}
