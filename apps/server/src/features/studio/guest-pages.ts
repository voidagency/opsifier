import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import type { ApiApp, AppDeps, AppEnv } from "../../core/context";
import { errorBody } from "../../core/errors";
import { findUserById } from "../access/repo";
import {
  addRemark,
  GUEST_COOKIE,
  guestCookieFor,
  liveGuestLink,
  type PreviewVisitor,
  redeemGuestToken,
  remarksForVisitor,
  takeBackRemark,
} from "./remarks";
import { readStudioSettings } from "./settings";
import {
  GUEST_PAGES_PREFIX,
  mayOpenPreview,
  PREVIEW_COOKIE,
  type PreviewApp,
  type PreviewSignIn,
  previewAppOfHost,
  previewPage,
} from "./signin";

/**
 * The panel's pages on a Studio preview's own address, under /__opsifier/studio/, which the proxy
 * sends to the panel as {@link GUEST_PAGES_PREFIX}: a client's link, and the remarks the Studio's
 * inspector shows and writes from the page. Same origin as the page, so its own cookies come along:
 * a link's, or the previews' sign-in's. The host the request names says which preview it is about.
 */

/** A remark, with its element and a screenshot of the window as a data URL. */
const MAX_BODY_BYTES = 320 * 1024;
/** Says « show the remarks tool » to the inspector, for the first page a client's link lands on. */
export const REMARKS_FLAG_COOKIE = "opsifier_studio_remarks";
const REMARKS_FLAG_SECONDS = 600;

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The page for a link that no longer opens the preview. With `signIn`, the panel's hop that signs
 * someone with an account in: the team still gets to the preview, whatever link they once opened.
 */
export function linkGonePage(signIn: string | null): string {
  const body =
    "Ce lien n'ouvre plus cet aperçu : demandez-en un nouveau à la personne qui vous l'a envoyé. This link no longer opens this preview: ask whoever sent it for a new one.";
  return previewPage(
    "Lien expiré · Link expired",
    signIn === null
      ? body
      : `${body}</p><p><a href="${escapeAttribute(signIn)}">Membre de l'équipe ? Se connecter · Team member? Sign in</a>`,
  );
}

const LINK_GONE = linkGonePage(null);
const NO_PREVIEW = previewPage(
  "Aperçu introuvable · Preview not found",
  "Cette adresse n'est pas celle d'un aperçu du Studio. This address is not a Studio preview's.",
);

const hostOf = (c: Context<AppEnv>): string =>
  (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");

/**
 * A change sent by the preview's own pages, by its exact origin: scheme, host and port. A form or a
 * script of another site, or of another port of the same name, can't name it.
 */
function fromThePage(c: Context<AppEnv>, preview: PreviewApp): boolean {
  const origin = c.req.header("origin");
  const host = (c.req.header("host") ?? "").toLowerCase();
  if (origin === undefined || host === "") {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(`${preview.https ? "https" : "http"}://${host}`).origin;
  } catch {
    return false;
  }
}

export function registerGuestPages(app: ApiApp, deps: AppDeps, signIn: PreviewSignIn): void {
  /** The Studio project whose preview answers on the request's host, while the Studio is on. */
  const previewOf = (c: Context<AppEnv>): PreviewApp | null => {
    const preview = previewAppOfHost(deps.db, hostOf(c));
    return preview !== null && readStudioSettings(deps).enabled ? preview : null;
  };

  /** Who is there: an account the previews' sign-in let in, or the guest of a link still good. */
  const visitorOf = (c: Context<AppEnv>, preview: PreviewApp): PreviewVisitor | null => {
    const host = hostOf(c);
    const account = getCookie(c, PREVIEW_COOKIE);
    if (account !== undefined) {
      const userId = signIn.readCookie(account, host);
      const user = userId === null ? undefined : findUserById(deps.db, userId);
      if (user !== undefined && mayOpenPreview(deps.db, user.id, preview.serviceId)) {
        return { kind: "account", userId: user.id, email: user.email };
      }
    }
    const guest = getCookie(c, GUEST_COOKIE);
    const link = guest === undefined ? null : liveGuestLink(deps, guest, host, preview);
    return link === null ? null : { kind: "guest", link };
  };

  const noPreview = (c: Context<AppEnv>) =>
    c.json(errorBody("not_found", "This address is not a Studio preview's."), 404);
  const noVisitor = (c: Context<AppEnv>) =>
    c.json(errorBody("studio_guest_required", "Open the link you were sent to leave remarks."), 401);
  const notFromThePage = (c: Context<AppEnv>) =>
    c.json(errorBody("forbidden", "This can only be sent from the preview's own pages."), 403);

  app.use(`${GUEST_PAGES_PREFIX}/*`, async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // A client's link: a cookie of the preview's own, then its home page, with the remarks tool when the
  // link says so. Relative: the browser asked the preview's address, which the proxy passed on.
  app.get(`${GUEST_PAGES_PREFIX}/link/:token`, (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const preview = previewOf(c);
    if (preview === null) {
      return c.html(NO_PREVIEW, 404);
    }
    const link = redeemGuestToken(deps, c.req.param("token"), preview);
    if (link === null) {
      return c.html(LINK_GONE, 404);
    }
    const cookie = guestCookieFor(deps, link, hostOf(c));
    setCookie(c, GUEST_COOKIE, cookie.value, {
      path: "/",
      maxAge: cookie.maxAgeSeconds,
      httpOnly: true,
      secure: preview.https,
      sameSite: "Lax",
    });
    if (link.remarks) {
      // Many sites send their home page on to another, a language's most often, and the address's flag
      // would not follow: the inspector reads this cookie as it reads ?remarks=1, then takes it off.
      setCookie(c, REMARKS_FLAG_COOKIE, "1", {
        path: "/",
        maxAge: REMARKS_FLAG_SECONDS,
        secure: preview.https,
        sameSite: "Lax",
      });
    }
    return c.redirect(link.remarks ? "/?remarks=1" : "/", 302);
  });

  app.get(`${GUEST_PAGES_PREFIX}/remarks`, (c) => {
    const preview = previewOf(c);
    if (preview === null) {
      return noPreview(c);
    }
    const visitor = visitorOf(c, preview);
    if (visitor === null) {
      return noVisitor(c);
    }
    return c.json(remarksForVisitor(deps, preview, visitor), 200);
  });

  app.post(
    `${GUEST_PAGES_PREFIX}/remarks`,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("payload_too_large", "The remark is too large."), 413),
    }),
    async (c) => {
      const preview = previewOf(c);
      if (preview === null) {
        return noPreview(c);
      }
      if (!fromThePage(c, preview)) {
        return notFromThePage(c);
      }
      const visitor = visitorOf(c, preview);
      if (visitor === null) {
        return noVisitor(c);
      }
      deps.storage.assertWritable();
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(errorBody("validation_failed", "The request body is not JSON."), 400);
      }
      return c.json({ remark: addRemark(deps, preview, visitor, body) }, 201);
    },
  );

  app.delete(`${GUEST_PAGES_PREFIX}/remarks/:id`, (c) => {
    const preview = previewOf(c);
    if (preview === null) {
      return noPreview(c);
    }
    if (!fromThePage(c, preview)) {
      return notFromThePage(c);
    }
    const visitor = visitorOf(c, preview);
    if (visitor === null) {
      return noVisitor(c);
    }
    deps.storage.assertWritable();
    const id = c.req.param("id");
    takeBackRemark(deps, preview, visitor, id);
    return c.json({ id }, 200);
  });
}
