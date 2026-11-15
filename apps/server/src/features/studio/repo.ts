import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { services, studioApps, studioConversations } from "../../core/db/schema";

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
