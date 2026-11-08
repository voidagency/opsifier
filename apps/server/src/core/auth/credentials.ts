import { createHash, randomBytes } from "node:crypto";
import type { SessionUser, UserRole } from "@opsifier/contract";
import { and, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db, DbHandle } from "../db";
import { apiTokens, sessions, users } from "../db/schema";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_TOKEN_PREFIX = "opsifier_";
const API_TOKEN_PATTERN = /^opsifier_[A-Za-z0-9_-]{43}$/;

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A token sent in the clear can be copied off the wire, so it must not stay useful for long. */
export const PLAIN_HTTP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Avoids a write on every request while keeping "last used" accurate to the minute. */
const TOKEN_USE_WRITE_INTERVAL_MS = 60_000;

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;

export type Principal =
  | { kind: "session"; sessionId: string; user: UserRow }
  | { kind: "token"; tokenId: string; user: UserRow };

/** The only shape in which a user leaves the server. */
export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    twoFactorEnabled: user.totpSecret !== null,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens carry 256 bits of entropy, so a plain hash is all the storage needs. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** How long a new session lasts. Without HTTPS the cap wins, whatever was asked for. */
export function sessionTtlMs(persistent: boolean, secure: boolean): number {
  const ttl = persistent ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS;
  return secure ? ttl : Math.min(ttl, PLAIN_HTTP_SESSION_TTL_MS);
}

export interface NewSession {
  userId: string;
  persistent: boolean;
  /** Whether the session is being opened over HTTPS. */
  secure: boolean;
  ip: string | null;
  userAgent: string | null;
  now: number;
}

export function insertSession(db: DbHandle, input: NewSession): { token: string; session: SessionRow } {
  const token = randomToken();
  const ttl = sessionTtlMs(input.persistent, input.secure);
  const session: SessionRow = {
    id: nanoid(),
    tokenHash: hashToken(token),
    userId: input.userId,
    persistent: input.persistent,
    ip: input.ip,
    userAgent: input.userAgent === null ? null : input.userAgent.slice(0, 512),
    createdAt: new Date(input.now),
    expiresAt: new Date(input.now + ttl),
  };
  db.insert(sessions).values(session).run();
  return { token, session };
}

export function findSessionPrincipal(db: DbHandle, token: string, now: number): Principal | null {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date(now))))
    .get();
  return row === undefined ? null : { kind: "session", sessionId: row.session.id, user: row.user };
}

/** Whether a session is still valid, for connections that outlive their upgrade request. */
export function isSessionActive(db: DbHandle, sessionId: string, now: number): boolean {
  const row = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date(now))))
    .get();
  return row !== undefined;
}

export function deleteSession(db: DbHandle, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function deleteSessionByToken(db: DbHandle, token: string): string | null {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const row = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();
  if (row === undefined) {
    return null;
  }
  deleteSession(db, row.id);
  return row.id;
}

/** Ends every session of a user but one, and returns the ids that were ended. */
export function deleteOtherSessions(db: DbHandle, userId: string, keepSessionId: string): string[] {
  const rows = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .all();
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    db.delete(sessions).where(inArray(sessions.id, ids)).run();
  }
  return ids;
}

export function purgeExpiredSessions(db: DbHandle, now: number): void {
  db.delete(sessions)
    .where(lte(sessions.expiresAt, new Date(now)))
    .run();
}

export interface NewApiToken {
  userId: string;
  name: string;
  now: number;
  expiresAt?: Date | null;
}

/** The plain token exists only in the return value: it cannot be read back later. */
export function createApiToken(db: DbHandle, input: NewApiToken): { token: string; row: ApiTokenRow } {
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const row: ApiTokenRow = {
    id: nanoid(),
    userId: input.userId,
    name: input.name,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
    createdAt: new Date(input.now),
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
  };
  db.insert(apiTokens).values(row).run();
  return { token, row };
}

export function findTokenPrincipal(db: Db, token: string, now: number): Principal | null {
  if (!API_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const row = db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(token)),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date(now))),
      ),
    )
    .get();
  if (row === undefined) {
    return null;
  }

  const lastUsed = row.token.lastUsedAt?.getTime() ?? 0;
  if (now - lastUsed >= TOKEN_USE_WRITE_INTERVAL_MS) {
    db.update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, row.token.id))
      .run();
  }
  return { kind: "token", tokenId: row.token.id, user: row.user };
}

export function revokeApiToken(db: DbHandle, tokenId: string): void {
  db.delete(apiTokens).where(eq(apiTokens.id, tokenId)).run();
}
