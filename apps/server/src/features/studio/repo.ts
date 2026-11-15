import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { services, studioApps, studioConversations, studioMembers, users } from "../../core/db/schema";

export type StudioAppRow = typeof studioApps.$inferSelect;
export type StudioConversationRow = typeof studioConversations.$inferSelect;

export interface LinkedApp extends StudioAppRow {
  projectName: string;
  serviceName: string;
}

/** Every linked service, by project and then name. */
export function listLinkedApps(db: DbHandle): LinkedApp[] {
  return db
    .select({
      serviceId: studioApps.serviceId,
      workspaceDir: studioApps.workspaceDir,
      createdAt: studioApps.createdAt,
      updatedAt: studioApps.updatedAt,
      projectName: services.projectName,
      serviceName: services.name,
    })
    .from(studioApps)
    .innerJoin(services, eq(services.id, studioApps.serviceId))
    .orderBy(services.projectName, services.name)
    .all();
}

export function findApp(db: DbHandle, serviceId: string): StudioAppRow | undefined {
  return db.select().from(studioApps).where(eq(studioApps.serviceId, serviceId)).get();
}

export function saveApp(db: DbHandle, serviceId: string, workspaceDir: string, now: Date): void {
  db.insert(studioApps)
    .values({ serviceId, workspaceDir, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: studioApps.serviceId, set: { workspaceDir, updatedAt: now } })
    .run();
}

/** The conversations go with it: the agent server keeps their content. */
export function deleteApp(db: DbHandle, serviceId: string): void {
  db.delete(studioApps).where(eq(studioApps.serviceId, serviceId)).run();
}

/** Most recently active first. */
export function listConversations(db: DbHandle, serviceId: string): StudioConversationRow[] {
  return db
    .select()
    .from(studioConversations)
    .where(eq(studioConversations.serviceId, serviceId))
    .orderBy(desc(studioConversations.updatedAt))
    .all();
}

export function findConversation(
  db: DbHandle,
  serviceId: string,
  id: string,
): StudioConversationRow | undefined {
  return db
    .select()
    .from(studioConversations)
    .where(and(eq(studioConversations.serviceId, serviceId), eq(studioConversations.id, id)))
    .get();
}

export function insertConversation(db: DbHandle, row: StudioConversationRow): void {
  db.insert(studioConversations).values(row).run();
}

export function updateConversation(
  db: DbHandle,
  id: string,
  changes: Partial<Pick<StudioConversationRow, "title" | "updatedAt">>,
): void {
  db.update(studioConversations).set(changes).where(eq(studioConversations.id, id)).run();
}

/** The accounts a project is shared with, by e-mail. */
export function listMembers(
  db: DbHandle,
  serviceId: string,
): { userId: string; email: string; addedAt: Date }[] {
  return db
    .select({ userId: studioMembers.userId, email: users.email, addedAt: studioMembers.createdAt })
    .from(studioMembers)
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .where(eq(studioMembers.serviceId, serviceId))
    .orderBy(users.email)
    .all();
}

/**
 * Shares a project with exactly these accounts: the ones left out lose it, those kept keep their date.
 * Two statements: the caller runs it in a transaction.
 */
export function setMembers(db: DbHandle, serviceId: string, userIds: readonly string[], now: Date): void {
  const kept = new Set(userIds);
  const existing = db
    .select({ userId: studioMembers.userId })
    .from(studioMembers)
    .where(eq(studioMembers.serviceId, serviceId))
    .all()
    .map((row) => row.userId);
  const gone = existing.filter((userId) => !kept.has(userId));
  if (gone.length > 0) {
    db.delete(studioMembers)
      .where(and(eq(studioMembers.serviceId, serviceId), inArray(studioMembers.userId, gone)))
      .run();
  }
  const added = [...kept].filter((userId) => !existing.includes(userId));
  if (added.length > 0) {
    db.insert(studioMembers)
      .values(added.map((userId) => ({ serviceId, userId, createdAt: now })))
      .run();
  }
}

/** The projects shared with this account, as service identifiers. */
export function appsSharedWith(db: DbHandle, userId: string): Set<string> {
  return new Set(
    db
      .select({ serviceId: studioMembers.serviceId })
      .from(studioMembers)
      .where(eq(studioMembers.userId, userId))
      .all()
      .map((row) => row.serviceId),
  );
}
