import { createHash, randomBytes } from "node:crypto";
import {
  type CreatedStudioGuestLink,
  type createStudioGuestLinkRequest,
  type StudioGuestLink,
  type StudioGuestLinkList,
  type StudioPreviewRemarks,
  type StudioRemark,
  type StudioRemarkElement,
  type StudioRemarkList,
  studioRemarkPoint,
  studioRemarkViewport,
  type UpdateStudioRemarkRequest,
} from "@opsifier/contract";
import { and, asc, count, desc, eq, max, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppDeps } from "../../core/context";
import { studioApps, studioGuestLinks, studioRemarks } from "../../core/db/schema";
import { badRequest, conflict, notFound } from "../../core/errors";
import { externalUrl, listDomainRows } from "../service-tabs/domains/service";
import type { ServiceTarget } from "../services/service";
import { requireLinked } from "./service";
import { GUEST_PAGES_PATH, type PreviewApp } from "./signin";

/**
 * A Studio project's links for clients, and the remarks left on its preview.
 *
 * A link opens the preview to someone without an account. It holds a secret the panel keeps the hash
 * of only, and it is shown once. Opened, it gives the browser a cookie of the preview's own, which the
 * previews' sign-in accepts too, and which signs the remarks written with it. Whoever may work on the
 * project in the Studio sees the remarks there, hands them to the agent, and marks them dealt with,
 * which their writer sees on the preview.
 */

export const GUEST_COOKIE = "opsifier_studio_guest";
const GUEST_CONTEXT = "studio-preview-guest";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest a link's cookie lasts: opening the link again gives a new one. */
const GUEST_COOKIE_MAX_MS = 30 * DAY_MS;
const TOKEN_BYTES = 24;
/** How many remarks a project keeps, so that a link passed around can't fill the panel's disk. */
export const MAX_REMARKS = 500;
/** How many remarks one link, or one account, may have written on a project. */
export const MAX_REMARKS_PER_AUTHOR = 100;
/** How many remarks one person may write in a minute. */
const REMARKS_PER_MINUTE = 20;
const MAX_TEXT = 2000;
/** The attributes the Studio's inspector describes an element by: no other one is kept. */
const ELEMENT_ATTRIBUTES = new Set([
  "id",
  "href",
  "src",
  "alt",
  "title",
  "aria-label",
  "role",
  "name",
  "type",
  "placeholder",
]);

/** Controls, and the marks that turn text around. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters to take out
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * What someone wrote, without the characters that only hide things: controls, and those that turn
 * text around. Lines and tabs stay where they may.
 */
export function cleanText(value: string, lines = false): string {
  const kept = value.replace(/\r\n?/g, "\n").replace(HIDDEN, "");
  return lines ? kept : kept.replace(/[\n\t]/g, " ");
}

type LinkRow = typeof studioGuestLinks.$inferSelect;
type RemarkRow = typeof studioRemarks.$inferSelect;
type CreateLink = z.infer<typeof createStudioGuestLinkRequest>;
type Deps = Pick<AppDeps, "db" | "now">;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (date: Date | null) => (date === null ? null : date.toISOString());
const isLive = (row: LinkRow, now: number) => row.expiresAt === null || row.expiresAt.getTime() > now;

function toLink(row: LinkRow, now: number, remarkCount: number): StudioGuestLink {
  return {
    id: row.id,
    label: row.label,
    remarks: row.remarks,
    remarkCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    expired: !isLive(row, now),
  };
}

function toRemark(row: RemarkRow): StudioRemark {
  return {
    id: row.id,
    number: row.number,
    path: row.path,
    element: row.element ?? null,
    point: row.point ?? null,
    viewport: row.viewport ?? null,
    text: row.text,
    author: row.author,
    authorKind: row.authorKind,
    status: row.status,
    conversationId: row.conversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listGuestLinks(deps: Deps, target: ServiceTarget): StudioGuestLinkList {
  const { app } = requireLinked(deps, target);
  const now = deps.now();
  const rows = deps.db
    .select()
    .from(studioGuestLinks)
    .where(eq(studioGuestLinks.serviceId, app.serviceId))
    .orderBy(desc(studioGuestLinks.createdAt))
    .all();
  const written = new Map(
    deps.db
      .select({ link: studioRemarks.guestLinkId, total: count() })
      .from(studioRemarks)
      .where(eq(studioRemarks.serviceId, app.serviceId))
      .groupBy(studioRemarks.guestLinkId)
      .all()
      .map((one) => [one.link, one.total]),
  );
  return { links: rows.map((row) => toLink(row, now, written.get(row.id) ?? 0)) };
}

/**
 * Makes a link that opens the preview, for `days` or until it is taken back. Its address is in the
 * answer, and nowhere else: the panel keeps the hash of its secret.
 */
export function createGuestLink(
  deps: Pick<AppDeps, "db" | "now" | "actions">,
  target: ServiceTarget,
  request: CreateLink,
  actorEmail: string | undefined,
): CreatedStudioGuestLink {
  const { app } = requireLinked(deps, target);
  const primary = listDomainRows(deps.db, target).find((row) => row.isPrimary);
  if (primary === undefined) {
    throw conflict(
      "studio_preview_without_address",
      "The preview has no address yet: give its service a domain, then make the link.",
    );
  }
  // A link lands on the address's home page, which must be the preview's, and only the preview's.
  if (primary.wildcard || primary.path !== "/") {
    throw conflict(
      "studio_preview_not_linkable",
      "The preview's address is a wildcard or a path: give it an address of its own, then make the link.",
    );
  }
  const preview = externalUrl(primary);
  const label = cleanText(request.label).trim() || "?";
  const now = deps.now();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const row: LinkRow = {
    id: nanoid(),
    serviceId: app.serviceId,
    label,
    tokenHash: hashToken(token),
    remarks: request.remarks,
    createdBy: actorEmail ?? null,
    createdAt: new Date(now),
    expiresAt: request.days === null ? null : new Date(now + request.days * DAY_MS),
    lastUsedAt: null,
  };
  deps.db.insert(studioGuestLinks).values(row).run();
  deps.actions.record({
    type: "studio.guest-link",
    title: `Make a link to ${target.projectName}/${target.serviceName} for ${label}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return { ...toLink(row, now, 0), url: `${new URL(preview).origin}${GUEST_PAGES_PATH}link/${token}` };
}

/**
 * Takes a link back: whoever opened it is let in no more, within half a minute. What they wrote stays,
 * unless `withRemarks` says to delete it too.
 */
export function removeGuestLink(
  deps: Pick<AppDeps, "db" | "now" | "actions">,
  target: ServiceTarget,
  id: string,
  withRemarks: boolean,
  actorEmail: string | undefined,
): { id: string } {
  const { app } = requireLinked(deps, target);
  const removed = deps.db.transaction((tx) => {
    if (withRemarks) {
      tx.delete(studioRemarks)
        .where(and(eq(studioRemarks.serviceId, app.serviceId), eq(studioRemarks.guestLinkId, id)))
        .run();
    }
    return tx
      .delete(studioGuestLinks)
      .where(and(eq(studioGuestLinks.id, id), eq(studioGuestLinks.serviceId, app.serviceId)))
      .returning({ label: studioGuestLinks.label })
      .all();
  });
  const label = removed[0]?.label;
  if (label === undefined) {
    throw notFound("This Studio project has no such link.");
  }
  deps.actions.record({
    type: "studio.guest-link",
    title: `Take back the link to ${target.projectName}/${target.serviceName} made for ${label}${withRemarks ? ", with its remarks" : ""}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return { id };
}

export function listRemarks(deps: Deps, target: ServiceTarget): StudioRemarkList {
  const { app } = requireLinked(deps, target);
  const rows = deps.db
    .select()
    .from(studioRemarks)
    .where(eq(studioRemarks.serviceId, app.serviceId))
    .orderBy(desc(studioRemarks.number))
    .all();
  return { remarks: rows.map(toRemark) };
}

function requireRemark(deps: Deps, target: ServiceTarget, id: string): RemarkRow {
  const { app } = requireLinked(deps, target);
  const row = deps.db
    .select()
    .from(studioRemarks)
    .where(and(eq(studioRemarks.id, id), eq(studioRemarks.serviceId, app.serviceId)))
    .get();
  if (row === undefined) {
    throw notFound("This Studio project has no such remark.");
  }
  return row;
}

/** A remark handed to the agent, dealt with, or back to be dealt with. */
export function updateRemark(
  deps: Deps,
  target: ServiceTarget,
  id: string,
  request: UpdateStudioRemarkRequest,
): StudioRemark {
  const row = requireRemark(deps, target, id);
  const updated = deps.db
    .update(studioRemarks)
    .set({
      status: request.status,
      ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
      updatedAt: new Date(deps.now()),
    })
    .where(eq(studioRemarks.id, row.id))
    .returning()
    .get();
  return toRemark(updated ?? row);
}

export function deleteRemark(deps: Deps, target: ServiceTarget, id: string): { id: string } {
  const row = requireRemark(deps, target, id);
  deps.db.delete(studioRemarks).where(eq(studioRemarks.id, row.id)).run();
  return { id };
}

/** Who is on a preview's own pages: a link's guest, or an account let in by the previews' sign-in. */
export type PreviewVisitor =
  | { kind: "guest"; link: LinkRow }
  | { kind: "account"; userId: string; email: string };

/** The cookie a link gives, for one host, until the link expires or a month at most. */
export function guestCookieFor(
  deps: Pick<AppDeps, "secrets" | "now">,
  link: LinkRow,
  host: string,
): { value: string; maxAgeSeconds: number } {
  const now = deps.now();
  const until = Math.min(link.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY, now + GUEST_COOKIE_MAX_MS);
  const value = deps.secrets.seal(
    JSON.stringify({ l: link.id, h: host.toLowerCase(), e: until }),
    GUEST_CONTEXT,
  );
  return { value, maxAgeSeconds: Math.max(0, Math.floor((until - now) / 1000)) };
}

/** The link a cookie names for this preview, if the cookie is genuine and the link still opens it. */
export function liveGuestLink(
  deps: Pick<AppDeps, "db" | "secrets" | "now">,
  cookie: string,
  host: string,
  preview: Pick<PreviewApp, "serviceId">,
): LinkRow | null {
  let id: unknown;
  try {
    const token = JSON.parse(deps.secrets.unseal(cookie, GUEST_CONTEXT)) as {
      l?: unknown;
      h?: unknown;
      e?: unknown;
    };
    if (token.h !== host.toLowerCase() || typeof token.e !== "number" || token.e <= deps.now()) {
      return null;
    }
    id = token.l;
  } catch {
    return null;
  }
  if (typeof id !== "string") {
    return null;
  }
  const row = deps.db.select().from(studioGuestLinks).where(eq(studioGuestLinks.id, id)).get();
  return row !== undefined && row.serviceId === preview.serviceId && isLive(row, deps.now()) ? row : null;
}

/** The link a secret opens, if it opens this preview still. It is noted as used. */
export function redeemGuestToken(
  deps: Deps,
  token: string,
  preview: Pick<PreviewApp, "serviceId">,
): LinkRow | null {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return null;
  }
  const now = deps.now();
  const row = deps.db
    .select()
    .from(studioGuestLinks)
    .where(eq(studioGuestLinks.tokenHash, hashToken(token)))
    .get();
  if (row === undefined || row.serviceId !== preview.serviceId || !isLive(row, now)) {
    return null;
  }
  deps.db
    .update(studioGuestLinks)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(studioGuestLinks.id, row.id))
    .run();
  return row;
}

const isMine = (row: RemarkRow, visitor: PreviewVisitor) =>
  visitor.kind === "guest" ? row.guestLinkId === visitor.link.id : row.userId === visitor.userId;

function toPreviewRemark(row: RemarkRow, visitor: PreviewVisitor): StudioPreviewRemarks["remarks"][number] {
  return {
    id: row.id,
    number: row.number,
    path: row.path,
    element: row.element ?? null,
    point: row.point ?? null,
    viewport: row.viewport ?? null,
    text: row.text,
    author: row.author,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    mine: isMine(row, visitor),
  };
}

/** What the preview's remarks tool shows: who is there, and every remark of the project, in order. */
export function remarksForVisitor(
  deps: Deps,
  preview: Pick<PreviewApp, "serviceId">,
  visitor: PreviewVisitor,
): StudioPreviewRemarks {
  const rows = deps.db
    .select()
    .from(studioRemarks)
    .where(eq(studioRemarks.serviceId, preview.serviceId))
    .orderBy(asc(studioRemarks.number))
    .all();
  return {
    viewer:
      visitor.kind === "guest"
        ? { name: visitor.link.label, kind: "guest" }
        : { name: visitor.email, kind: "account" },
    remarks: rows.map((row) => toPreviewRemark(row, visitor)),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const short = (value: unknown, length: number): string =>
  typeof value === "string" ? cleanText(value).replace(/\s+/g, " ").trim().slice(0, length) : "";
const strings = (value: unknown, length: number, each: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => short(item, each))
        .filter((item) => item !== "")
        .slice(0, length)
    : [];

/** What a page says of an element, cut to the sizes the Studio shows, or null when it is no element. */
export function cleanElement(value: unknown): StudioRemarkElement | null {
  if (!isRecord(value)) {
    return null;
  }
  const tag = short(value.tag, 40).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    return null;
  }
  const attributes: Record<string, string> = {};
  if (isRecord(value.attributes)) {
    for (const [name, attribute] of Object.entries(value.attributes)) {
      const text = short(attribute, 200);
      if (ELEMENT_ATTRIBUTES.has(name) && text !== "") {
        attributes[name] = text;
      }
    }
  }
  return {
    tag,
    text: short(value.text, 160),
    classes: strings(value.classes, 10, 80),
    attributes,
    selector: short(value.selector, 400),
    components: strings(value.components, 4, 80),
  };
}

/**
 * A page of the preview, as its address bar shows it from the host on, without the remarks flag. Never
 * one that a browser would read as another site's: a single slash leads it, however it was written.
 */
export function cleanPath(value: string): string {
  if (!value.startsWith("/") || /[\\\r\n\0]/.test(value)) {
    return "/";
  }
  try {
    const url = new URL(value, "https://preview.invalid");
    url.searchParams.delete("remarks");
    const page = `/${url.pathname.replace(/^\/+/, "")}${url.search}${url.hash}`;
    return page.length > 300 ? "/" : page;
  } catch {
    return "/";
  }
}

const newRemark = z.object({
  path: z.string().max(2000),
  text: z.string().trim().min(1, "Required").max(MAX_TEXT, `Must be at most ${MAX_TEXT} characters`),
  element: z.unknown().optional(),
  point: studioRemarkPoint.nullable().optional(),
  viewport: studioRemarkViewport.nullable().optional(),
});

/** Writes a remark on the preview, numbered after the project's last one. */
export function addRemark(
  deps: Pick<AppDeps, "db" | "now" | "rateLimiter">,
  preview: Pick<PreviewApp, "serviceId">,
  visitor: PreviewVisitor,
  body: unknown,
): StudioPreviewRemarks["remarks"][number] {
  const parsed = newRemark.safeParse(body);
  if (!parsed.success) {
    throw badRequest("validation_failed", "The remark is not one the Studio can keep.", {
      text: parsed.error.issues[0]?.message ?? "Invalid",
    });
  }
  deps.rateLimiter.consume([
    {
      key: `studio-remark:${visitor.kind === "guest" ? `link:${visitor.link.id}` : `user:${visitor.userId}`}`,
      rule: { limit: REMARKS_PER_MINUTE, windowMs: 60_000 },
    },
  ]);
  const { path, element, point, viewport } = parsed.data;
  const text = cleanText(parsed.data.text, true).trim();
  if (text === "") {
    throw badRequest("validation_failed", "The remark is not one the Studio can keep.", { text: "Required" });
  }
  const at = new Date(deps.now());
  const row = deps.db.transaction((tx) => {
    const kept = tx
      .select({ total: count() })
      .from(studioRemarks)
      .where(eq(studioRemarks.serviceId, preview.serviceId))
      .get();
    if ((kept?.total ?? 0) >= MAX_REMARKS) {
      throw conflict(
        "studio_remarks_full",
        `This project keeps ${MAX_REMARKS} remarks at most: delete some in the Studio first.`,
      );
    }
    const theirs = tx
      .select({ total: count() })
      .from(studioRemarks)
      .where(
        and(
          eq(studioRemarks.serviceId, preview.serviceId),
          visitor.kind === "guest"
            ? eq(studioRemarks.guestLinkId, visitor.link.id)
            : eq(studioRemarks.userId, visitor.userId),
        ),
      )
      .get();
    if ((theirs?.total ?? 0) >= MAX_REMARKS_PER_AUTHOR) {
      throw conflict(
        "studio_remarks_author_full",
        `You have written ${MAX_REMARKS_PER_AUTHOR} remarks on this project: the team deals with them first.`,
      );
    }
    // A number is given once: a remark deleted or taken back leaves its number unused.
    const last = tx
      .select({ number: max(studioRemarks.number) })
      .from(studioRemarks)
      .where(eq(studioRemarks.serviceId, preview.serviceId))
      .get();
    const counted = tx
      .update(studioApps)
      .set({ remarkCounter: sql`max(${studioApps.remarkCounter}, ${last?.number ?? 0}) + 1` })
      .where(eq(studioApps.serviceId, preview.serviceId))
      .returning({ counter: studioApps.remarkCounter })
      .get();
    return tx
      .insert(studioRemarks)
      .values({
        id: nanoid(),
        serviceId: preview.serviceId,
        number: counted?.counter ?? (last?.number ?? 0) + 1,
        path: cleanPath(path),
        element: cleanElement(element),
        point: point ?? null,
        viewport: viewport ?? null,
        text,
        author: visitor.kind === "guest" ? visitor.link.label : visitor.email,
        authorKind: visitor.kind,
        guestLinkId: visitor.kind === "guest" ? visitor.link.id : null,
        userId: visitor.kind === "account" ? visitor.userId : null,
        status: "new",
        conversationId: null,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
  });
  return toPreviewRemark(row, visitor);
}

/** Its writer takes a remark back, while nobody has dealt with it yet. */
export function takeBackRemark(
  deps: Deps,
  preview: Pick<PreviewApp, "serviceId">,
  visitor: PreviewVisitor,
  id: string,
): void {
  const row = deps.db
    .select()
    .from(studioRemarks)
    .where(and(eq(studioRemarks.id, id), eq(studioRemarks.serviceId, preview.serviceId)))
    .get();
  if (row === undefined || !isMine(row, visitor)) {
    throw notFound("No such remark of yours.");
  }
  if (row.status !== "new") {
    throw conflict("studio_remark_taken", "The project's team is on this remark already.");
  }
  deps.db.delete(studioRemarks).where(eq(studioRemarks.id, row.id)).run();
}
