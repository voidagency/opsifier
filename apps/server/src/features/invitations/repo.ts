import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { invitations, users } from "../../core/db/schema";

export type InvitationRow = typeof invitations.$inferSelect;
export type InviterRow = Pick<typeof users.$inferSelect, "id" | "email" | "name" | "role" | "deactivatedAt">;

const inviterColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  deactivatedAt: users.deactivatedAt,
};

/** Newest first, and in address order within one batch. */
export function listInvitations(db: DbHandle): Array<{ invitation: InvitationRow; inviter: InviterRow }> {
  return db
    .select({ invitation: invitations, inviter: inviterColumns })
    .from(invitations)
    .innerJoin(users, eq(invitations.invitedBy, users.id))
    .orderBy(desc(invitations.createdAt), asc(invitations.email))
    .all();
}

export function findInvitation(db: DbHandle, id: string): InvitationRow | undefined {
  return db.select().from(invitations).where(eq(invitations.id, id)).get();
}

export function findByEmail(db: DbHandle, email: string): InvitationRow | undefined {
  return db.select().from(invitations).where(eq(invitations.email, email)).get();
}

export function findByTokenHash(
  db: DbHandle,
  tokenHash: string,
): { invitation: InvitationRow; inviter: InviterRow } | undefined {
  return db
    .select({ invitation: invitations, inviter: inviterColumns })
    .from(invitations)
    .innerJoin(users, eq(invitations.invitedBy, users.id))
    .where(eq(invitations.tokenHash, tokenHash))
    .get();
}

export function inviterOf(db: DbHandle, userId: string): InviterRow | undefined {
  return db.select(inviterColumns).from(users).where(eq(users.id, userId)).get();
}

export function countInvitations(db: DbHandle): number {
  return Number(db.select({ count: sql<number>`count(*)` }).from(invitations).get()?.count ?? 0);
}

export function insertInvitation(db: DbHandle, row: typeof invitations.$inferInsert): InvitationRow {
  return db.insert(invitations).values(row).returning().get();
}

export function updateInvitation(
  db: DbHandle,
  id: string,
  changes: Partial<typeof invitations.$inferInsert>,
): InvitationRow | undefined {
  return db.update(invitations).set(changes).where(eq(invitations.id, id)).returning().get();
}

/**
 * Records how one e-mail went, unless the invitation has had a new link since: a later send then
 * speaks for it, and this one is about a link that no longer works.
 */
export function recordDelivery(
  db: DbHandle,
  id: string,
  tokenHash: string,
  changes: Pick<Partial<typeof invitations.$inferInsert>, "delivery" | "sentAt" | "deliveryError">,
): boolean {
  const updated = db
    .update(invitations)
    .set(changes)
    .where(and(eq(invitations.id, id), eq(invitations.tokenHash, tokenHash)))
    .returning({ id: invitations.id })
    .all();
  return updated.length > 0;
}

export function deleteInvitation(db: DbHandle, id: string): void {
  db.delete(invitations).where(eq(invitations.id, id)).run();
}

/** Takes back every invitation an account sent, when it stops being able to send them. */
export function deleteInvitationsBy(db: DbHandle, userId: string): number {
  return db
    .delete(invitations)
    .where(eq(invitations.invitedBy, userId))
    .returning({ id: invitations.id })
    .all().length;
}

/** E-mails that were waiting when the panel stopped. Nothing will send them now. */
export function failInterruptedSends(db: DbHandle, reason: string): number {
  return db
    .update(invitations)
    .set({ delivery: "failed", deliveryError: reason })
    .where(eq(invitations.delivery, "sending"))
    .returning({ id: invitations.id })
    .all().length;
}
