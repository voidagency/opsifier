import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { isProtectedPurpose, isValidHostname } from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { setCookie } from "hono/cookie";
import type { Principal } from "../../core/auth/credentials";
import { requestMeta } from "../../core/auth/middleware";
import type { ApiApp, AppDeps, AppEnv } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { customDomains, domains } from "../../core/db/schema";
import { DEFAULT_PANEL_UPSTREAM_URL, PROXY_PAGES_PREFIX } from "../../core/proxy";
import type { Secrets } from "../../core/secrets";
import { accessOf, canSeeProject } from "../access/rules";
import { escapeHtml, renderProxyPage } from "../proxy-pages/render";
import { pickLanguage } from "../proxy-pages/strings";
import { toolRoutes } from "../service-tabs/domains/repo";
import { GATE_COOKIE, GATE_PASS_PAGE, GATE_PASS_PATH, REALM } from "../services/compile/protection";
import { safeReturnPath } from "../studio/signin";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
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

/** Gives the browser the gate's cookie for this site, for a week, as the right password does. */
function rememberBrowser(
  c: Context<AppEnv>,
  deps: AppDeps,
  users: readonly string[],
  site: string,
  now: number,
): void {
  setCookie(c, GATE_COOKIE, gateToken(deps.secrets, users, site, gateWeek(now)), {
    path: "/",
    maxAge: REMEMBER_SECONDS,
    httpOnly: true,
    secure: overHttps(c, deps),
    sameSite: "Lax",
  });
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
    rememberBrowser(c, deps, users, site, now);
    return c.body(null, 200);
  });
}

/** On the panel: the hop that opens one of this server's sites, through its gate for someone signed in. */
export const OPEN_SITE_PATH = "/api/v1/server-purpose/open";
/** How long a pass is good for: the hop sends the browser on with it at once. */
const PASS_TTL_MS = 60_000;
const MAX_PASSES = 10_000;

/** Passes from the panel to a protected site: in memory, good once and for a minute, on one host. */
export class GatePasses {
  private readonly passes = new Map<string, { host: string; expires: number }>();

  constructor(private readonly now: () => number) {}

  issue(host: string): string {
    const now = this.now();
    for (const [pass, entry] of this.passes) {
      if (entry.expires <= now) {
        this.passes.delete(pass);
      }
    }
    if (this.passes.size >= MAX_PASSES) {
      this.passes.clear();
    }
    const pass = randomBytes(32).toString("base64url");
    this.passes.set(pass, { host, expires: now + PASS_TTL_MS });
    return pass;
  }

  /** Whether a pass is good on this host, which it is once only, whatever the answer. */
  redeem(pass: string, host: string): boolean {
    const entry = this.passes.get(pass);
    this.passes.delete(pass);
    return entry !== undefined && entry.expires > this.now() && entry.host === host;
  }
}

/** One of this server's sites, on one host: a service's domain, a database's web tool, or one of the panel's own list. */
interface Site {
  host: string;
  https: boolean;
  /** The projects of the services that answer on it. */
  projects: string[];
}

/** The site on a host, when this server has one there by that exact name: a wildcard names none. */
function siteNamed(db: DbHandle, host: string): Site | null {
  const own = db
    .select({ projectName: domains.projectName, https: domains.https })
    .from(domains)
    .where(and(eq(domains.host, host), eq(domains.wildcard, false)))
    .all();
  const listed = db
    .select({ https: customDomains.https })
    .from(customDomains)
    .where(and(eq(customDomains.host, host), eq(customDomains.wildcard, false)))
    .all();
  // A database's web tools are always served over HTTPS.
  const tools = toolRoutes(db).filter((route) => route.host === host);
  if (own.length + listed.length + tools.length === 0) {
    return null;
  }
  return {
    host,
    https: tools.length > 0 || [...own, ...listed].some((row) => row.https),
    projects: [
      ...new Set([
        ...own.map((row) => row.projectName),
        ...tools.flatMap((route) => (route.project === null ? [] : [route.project])),
      ]),
    ],
  };
}

/** The host a link names, and the path on it to land on, read the way a browser reads the link. */
function linkTarget(given: string | undefined): { host: string; to: string } | null {
  if (given === undefined || !URL.canParse(given)) {
    return null;
  }
  const url = new URL(given);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !isValidHostname(host)) {
    return null;
  }
  return { host, to: safeReturnPath(`${url.pathname}${url.search}${url.hash}`) };
}

/**
 * Whether someone at a browser may walk past the gate of a site: an administrator, for every site;
 * anyone else, for a site of a project they can see. The gate's cookie lets that browser in for a
 * week, the same as the password, which an administrator can read and give anyone anyway.
 */
function mayPass(db: DbHandle, principal: Principal | null, site: Site): boolean {
  if (principal?.kind !== "session" || needsTwoFactorSetup(db, principal.user)) {
    return false;
  }
  const access = accessOf(db, principal);
  return access.admin || site.projects.some((project) => canSeeProject(access, project));
}

/** The panel's pages may not send a form elsewhere: the hop's page names its own policy in this header. */
export const PAGE_POLICY_HEADER = "x-opsifier-page-policy";
/** The one script of the hop's page, allowed by its digest and nothing else. */
const SUBMIT_SCRIPT = "document.forms[0].submit();";
const SUBMIT_DIGEST = createHash("sha256").update(SUBMIT_SCRIPT).digest("base64");

const HOP_WORDS = {
  en: { title: "Opening the site", opening: "Opening", go: "Continue" },
  fr: { title: "Ouverture du site", opening: "Ouverture de", go: "Continuer" },
} as const;

/**
 * The hop's page: a form that sends the pass to the site's address for passes, at once. In the body
 * of a request, a pass is never in an address, where the site's own scripts could read it, nor in a
 * history or a log; and the service worker of a site that answers every page from its cache, which
 * would keep a request for that address from ever reaching the proxy, leaves a form's request alone.
 */
function hopPage(action: string, pass: string, to: string, language: "en" | "fr"): string {
  const words = HOP_WORDS[language];
  const host = new URL(action).host;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>${words.title}</title></head><body><form method="post" action="${escapeHtml(action)}"><p>${words.opening} ${escapeHtml(host)}…</p><input type="hidden" name="pass" value="${escapeHtml(pass)}"><input type="hidden" name="to" value="${escapeHtml(to)}"><noscript><button type="submit">${words.go}</button></noscript></form><script>${SUBMIT_SCRIPT}</script></body></html>`;
}

/**
 * Carries a page's own policy past the panel's, which allows no form to another site: set around the
 * panel's headers, it replaces their policy with the one the page named, if it named one.
 */
export function ownPagePolicy(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const policy = c.res.headers.get(PAGE_POLICY_HEADER);
    if (policy !== null) {
      c.res.headers.delete(PAGE_POLICY_HEADER);
      c.res.headers.set("Content-Security-Policy", policy);
    }
  };
}

/**
 * Opening a protected site from the panel without its password. The panel's link goes through a hop
 * of its own, which hands someone who may open the site a pass good once, for a minute, on that one
 * host, in a form its page sends at once to the site's own address for passes. The proxy brings that
 * address back to the panel, which turns the pass into the gate's cookie, as the right password does,
 * and sends the browser on to the page it was going to. Anyone else, and every site of a server in
 * production, goes straight to the site.
 */
export function registerGatePass(app: ApiApp, deps: AppDeps): void {
  const passes = new GatePasses(deps.now);

  app.get(OPEN_SITE_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    const language = pickLanguage(c.req.header("accept-language"));
    const target = linkTarget(c.req.query("url"));
    const site = target === null ? null : siteNamed(deps.db, target.host);
    if (target === null || site === null) {
      // Only a site of this server: the hop sends nobody anywhere else.
      return c.html(renderProxyPage("not-found", language).html, 404);
    }
    const origin = `${site.https ? "https" : "http"}://${site.host}`;
    const state = readProtection(deps.db);
    if (
      !isProtectedPurpose(state.purpose) ||
      gateUsersOf(state).length === 0 ||
      !mayPass(deps.db, c.get("principal"), site)
    ) {
      return c.redirect(`${origin}${target.to}`, 302);
    }
    const pass = passes.issue(site.host);
    c.header(
      PAGE_POLICY_HEADER,
      `default-src 'none'; script-src 'sha256-${SUBMIT_DIGEST}'; form-action ${origin}; base-uri 'none'; frame-ancestors 'none'`,
    );
    return c.html(hopPage(`${origin}${GATE_PASS_PATH}`, pass, target.to, language));
  });

  // On a site's own address, through the proxy: a good pass becomes the gate's cookie, and the browser
  // goes on to its page either way, where the gate asks for the password if it has to.
  app.post(GATE_PASS_PAGE, async (c) => {
    c.header("Cache-Control", "no-store");
    const site = siteOf(c);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const pass = typeof form.pass === "string" ? form.pass : "";
    if (site !== null && passes.redeem(pass, site)) {
      const state = readProtection(deps.db);
      const users = gateUsersOf(state);
      if (isProtectedPurpose(state.purpose) && users.length > 0) {
        rememberBrowser(c, deps, users, site, deps.now());
      }
    }
    return c.redirect(landing(c, deps, site, typeof form.to === "string" ? form.to : undefined), 303);
  });

  // Passes come in a form only: an address that carries one is a page anyone may have read.
  app.all(GATE_PASS_PAGE, (c) => {
    c.header("Cache-Control", "no-store");
    return c.redirect(landing(c, deps, siteOf(c), undefined), 303);
  });
}

/** Where on the site the browser lands: a path of the site's own, in full, on the site's own name. */
function landing(c: Context<AppEnv>, deps: AppDeps, site: string | null, to: string | undefined): string {
  const path = safeReturnPath(to);
  return site === null ? path : `${overHttps(c, deps) ? "https" : "http"}://${site}${path}`;
}
