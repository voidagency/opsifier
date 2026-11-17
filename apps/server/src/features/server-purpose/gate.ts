import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isProtectedPurpose, isValidHostname } from "@opsifier/contract";
import bcrypt from "bcryptjs";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { requestMeta } from "../../core/auth/middleware";
import type { ApiApp, AppDeps, AppEnv } from "../../core/context";
import { DEFAULT_PANEL_UPSTREAM_URL, PROXY_PAGES_PREFIX } from "../../core/proxy";
import type { Secrets } from "../../core/secrets";
import { GATE_COOKIE, REALM } from "../services/compile/protection";
import { type ProtectionState, readProtection } from "./repo";

/**
 * The server's gate, the password every site of a server that is not in production asks for, remembers
 * a browser. Traefik asks the panel about a request that does not carry the gate's cookie: with the
 * right password, the panel gives the browser that cookie, for a week, and every request carrying it
 * goes through without the password, a service worker's included. Browsers send a password typed
 * once with what a page asks, but not with what its service worker asks: without the cookie, a site
 * with a service worker asked for the password again and again.
 *
 * A site sees the cookie, as it sees every cookie of its own host, so its value is good on that host
 * only, and for two weeks at most: it changes every week, and as soon as the gate's users change.
 */

/** Where Traefik asks the panel about a request that does not carry the gate's cookie. */
export const GATE_CHECK_PATH = `${PROXY_PAGES_PREFIX}/gate`;
/** How long a browser is remembered on a site, one week, the time the cookie's value lasts. */
const REMEMBER_SECONDS = 7 * 24 * 60 * 60;
const WEEK_MS = REMEMBER_SECONDS * 1000;
/** How long a password that was right is taken as right, so that a client without cookies stays fast. */
const CHECKED_MS = 5 * 60 * 1000;
const MAX_CHECKED = 2000;
/** Wrong passwords one address may try, before it waits. The same wrong one again is not counted. */
const FAILURES = { limit: 30, windowMs: 5 * 60 * 1000 };
/** Passwords checked at once. bcrypt is slow on purpose: past this, a request is asked to come back. */
const MAX_CHECKING = 8;
/** Checked against when the user does not exist, so that an answer takes as long either way. */
let dummyHash: string | null = null;

export const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
export const SAFE_USERNAME = /^[A-Za-z0-9._@-]+$/;

/** The gate's users as Traefik reads them, `user:bcrypt`, leaving out any entry that is not sound. */
export function gateUsersOf(state: Pick<ProtectionState, "users">): string[] {
  return state.users
    .filter((user) => SAFE_USERNAME.test(user.username) && BCRYPT_HASH.test(user.passwordHash))
    .map((user) => `${user.username}:${user.passwordHash}`);
}

/** What a server's routes need to remember browsers: where to ask, the key to the cookie, and the time. */
export interface GateRemembering {
  address: string;
  secrets: Pick<Secrets, "fingerprint">;
  now: () => number;
}

export const gateRemembering = (deps: Pick<AppDeps, "config" | "secrets" | "now">): GateRemembering => ({
  address: `${deps.config.panelUpstream ?? DEFAULT_PANEL_UPSTREAM_URL}${GATE_CHECK_PATH}`,
  secrets: deps.secrets,
  now: deps.now,
});

/** The week a moment falls in, counted from 1970: the cookie's value changes with it. */
export const gateWeek = (now: number): number => Math.floor(now / WEEK_MS);

/** The cookie's value on one host, for these users, in one week: of no use to guess, nor anywhere else. */
export function gateToken(
  secrets: Pick<Secrets, "fingerprint">,
  users: readonly string[],
  host: string,
  week: number,
): string {
  return secrets.fingerprint(JSON.stringify([[...users].sort(), host, week]), "server-gate-cookie");
}

/**
 * The values a host's routes let through: this week's; last week's, for a browser remembered then,
 * which keeps its cookie for a week; and next week's, so that routes written late in a week already
 * take what the panel hands out once it has turned.
 */
export function gateTokens(
  secrets: Pick<Secrets, "fingerprint">,
  users: readonly string[],
  host: string,
  now: number,
): string[] {
  const week = gateWeek(now);
  return [week - 1, week, week + 1].map((one) => gateToken(secrets, users, host, one));
}

/** Whether a Basic header names one of the users, with their password. */
async function isRight(header: string, users: readonly string[]): Promise<boolean> {
  const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) {
    return false;
  }
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  const line = users.find((one) => one.slice(0, one.indexOf(":")) === username);
  if (line === undefined) {
    dummyHash ??= await bcrypt.hash("opsifier-gate", 10);
    await bcrypt.compare(password, dummyHash);
    return false;
  }
  // Traefik writes bcrypt's 2y, the same as 2b.
  const hash = line.slice(line.indexOf(":") + 1).replace(/^\$2y\$/, "$2b$");
  return bcrypt.compare(password, hash);
}

/**
 * The site a request is for, as the proxy names it, in the form a route's rule names it: lower case,
 * without a port or a final dot. Traefik writes the header itself, from the request it is asked about.
 */
function siteOf(c: Context<AppEnv>): string | null {
  const host = (c.req.header("x-forwarded-host") ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return isValidHostname(host) ? host : null;
}

/**
 * Who is trying, for the count of wrong passwords: an address, or for IPv6 the /64 it belongs to,
 * since one subscriber usually holds a whole /64 and could otherwise try from every address in it.
 */
export function attemptKey(address: string): string {
  if (isIP(address) !== 6) {
    return address;
  }
  const [head = "", tail] = address.toLowerCase().split("%")[0]?.split("::") ?? [];
  const groups = (part: string | undefined) => (part === undefined || part === "" ? [] : part.split(":"));
  const width = (parts: string[]) => parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
  const left = groups(head);
  const right = groups(tail);
  const zeros =
    tail === undefined ? [] : Array<string>(Math.max(8 - width(left) - width(right), 0)).fill("0");
  const prefix = [...left, ...zeros, ...right]
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/** Whether the browser reached the site over HTTPS, so that the cookie never goes out over HTTP. */
function overHttps(c: Context<AppEnv>, deps: AppDeps): boolean {
  // Traefik says it itself, so this is right even where the panel was not told to trust it; a client
  // that asks the panel directly can only make its own cookie stricter.
  const proto = c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim().toLowerCase();
  return proto === "https" || proto === "wss" || requestMeta(c, deps.config).secure;
}

export function registerGateCheck(app: ApiApp, deps: AppDeps): void {
  // Digests of the Basic headers checked lately, right or wrong, until when.
  const right = new Map<string, number>();
  const wrong = new Map<string, number>();
  const keep = (map: Map<string, number>, key: string, until: number) => {
    if (map.size >= MAX_CHECKED) {
      map.clear();
    }
    map.set(key, until);
  };
  let checking = 0;

  const challenge = (c: Context<AppEnv>) => {
    c.header("WWW-Authenticate", `Basic realm="${REALM}"`);
    return c.text("401 Unauthorized\n", 401);
  };

  app.get(GATE_CHECK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const state = readProtection(deps.db);
    const users = gateUsersOf(state);
    const header = c.req.header("authorization") ?? "";
    const site = siteOf(c);
    if (
      !isProtectedPurpose(state.purpose) ||
      users.length === 0 ||
      site === null ||
      !header.startsWith("Basic ")
    ) {
      return challenge(c);
    }
    const now = deps.now();
    const digest = createHash("sha256")
      .update(`${users.join("\n")}\0${header}`)
      .digest("hex");
    if ((right.get(digest) ?? 0) <= now) {
      if ((wrong.get(digest) ?? 0) > now) {
        return challenge(c);
      }
      if (checking >= MAX_CHECKING) {
        c.header("Retry-After", "1");
        return c.text("503 Service Unavailable\n", 503);
      }
      // The address as the rest of the panel reads it: the proxy's word only when the proxy is trusted.
      const attempt = deps.rateLimiter.consume([
        { key: `server-gate:${attemptKey(requestMeta(c, deps.config).ip)}`, rule: FAILURES },
      ]);
      checking += 1;
      let isValid: boolean;
      try {
        isValid = await isRight(header, users);
      } finally {
        checking -= 1;
      }
      if (!isValid) {
        keep(wrong, digest, now + CHECKED_MS);
        return challenge(c);
      }
      attempt.refund();
      keep(right, digest, now + CHECKED_MS);
    }
    setCookie(c, GATE_COOKIE, gateToken(deps.secrets, users, site, gateWeek(now)), {
      path: "/",
      maxAge: REMEMBER_SECONDS,
      httpOnly: true,
      secure: overHttps(c, deps),
      sameSite: "Lax",
    });
    return c.body(null, 200);
  });
}
