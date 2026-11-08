import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { UserRow } from "../../core/auth";
import type { DbHandle } from "../../core/db";
import { recoveryCodes, users } from "../../core/db/schema";

export function hasAnyUser(db: DbHandle): boolean {
  return db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
}

export function findUserByEmail(db: DbHandle, email: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.email, email)).get();
}

export function findUserById(db: DbHandle, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function insertUser(db: DbHandle, user: typeof users.$inferInsert): UserRow {
  return db.insert(users).values(user).returning().get();
}

export function updateCredentials(
  db: DbHandle,
  id: string,
  values: { email: string; passwordHash: string; updatedAt: Date },
): UserRow {
  return db.update(users).set(values).where(eq(users.id, id)).returning().get();
}

export function setPendingTotp(db: DbHandle, id: string, sealedSecret: string, updatedAt: Date): void {
  db.update(users).set({ totpPendingSecret: sealedSecret, updatedAt }).where(eq(users.id, id)).run();
}

/** Promotes the pending secret. Returns null if it changed since it was read. */
export function activateTotp(
  db: DbHandle,
  id: string,
  expectedPending: string,
  sealedSecret: string,
  step: number,
  updatedAt: Date,
): UserRow | undefined {
  return db
    .update(users)
    .set({ totpSecret: sealedSecret, totpPendingSecret: null, totpLastStep: step, updatedAt })
    .where(and(eq(users.id, id), eq(users.totpPendingSecret, expectedPending), isNull(users.totpSecret)))
    .returning()
    .get();
}

export function clearTotp(db: DbHandle, id: string, updatedAt: Date): UserRow {
  return db
    .update(users)
    .set({ totpSecret: null, totpPendingSecret: null, totpLastStep: null, updatedAt })
    .where(eq(users.id, id))
    .returning()
    .get();
}

/** Whatever was issued before is gone, so an old printout cannot be mixed with the new set. */
export function replaceRecoveryCodes(
  db: DbHandle,
  userId: string,
  codeHashes: readonly string[],
  createdAt: Date,
): void {
  deleteRecoveryCodes(db, userId);
  db.insert(recoveryCodes)
    .values(codeHashes.map((codeHash) => ({ userId, codeHash, createdAt })))
    .run();
}

export function deleteRecoveryCodes(db: DbHandle, userId: string): void {
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
}

/** Uses a code up. Deleting decides, so of two concurrent requests with one code only one can win. */
export function consumeRecoveryCode(db: DbHandle, userId: string, codeHash: string): boolean {
  const removed = db
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, codeHash)))
    .returning({ userId: recoveryCodes.userId })
    .all();
  return removed.length === 1;
}

/**
 * Records a time step as used. The condition makes this the one place that decides, so of two
 * concurrent requests carrying the same code exactly one can win.
 */
export function consumeTotpStep(db: DbHandle, id: string, step: number): boolean {
  const result = db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
    .returning({ id: users.id })
    .all();
  return result.length === 1;
}
