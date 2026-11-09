import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { apiTokens, projectMembers, projects, sessions, users } from "../../core/db/schema";

export type UserRow = typeof users.$inferSelect;
export type ApiKeyRow = typeof apiTokens.$inferSelect;
export type MembershipRow = typeof projectMembers.$inferSelect;

export function listUsers(db: DbHandle): UserRow[] {
  return db.select().from(users).orderBy(sql`${users.isOwner} DESC`, asc(users.email)).all();
}

export function findUserById(db: DbHandle, id: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function findUserByEmail(db: DbHandle, email: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.email, email)).get();
}

export function insertUser(db: DbHandle, row: typeof users.$inferInsert): UserRow {
  return db.insert(users).values(row).returning().get();
}

export function updateUserRow(
  db: DbHandle,
  id: string,
  changes: Partial<typeof users.$inferInsert>,
): UserRow {
  return db.update(users).set(changes).where(eq(users.id, id)).returning().get();
}

export function deleteUserRow(db: DbHandle, id: string): void {
  db.delete(users).where(eq(users.id, id)).run();
}

export function allMemberships(db: DbHandle): MembershipRow[] {
  return db.select().from(projectMembers).orderBy(asc(projectMembers.projectName)).all();
}

export function replaceMemberships(
  db: DbHandle,
  userId: string,
  grants: ReadonlyArray<{ project: string; role: "viewer" | "operator" }>,
  now: Date,
): void {
  db.delete(projectMembers).where(eq(projectMembers.userId, userId)).run();
  if (grants.length > 0) {
    db.insert(projectMembers)
      .values(
        grants.map((grant) => ({
          userId,
          projectName: grant.project,
          role: grant.role,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();
  }
}

export function existingProjects(db: DbHandle, names: readonly string[]): Set<string> {
  if (names.length === 0) {
    return new Set();
  }
  const rows = db
    .select({ name: projects.name })
    .from(projects)
    .where(inArray(projects.name, [...names]))
    .all();
  return new Set(rows.map((row) => row.name));
}

export function apiKeyCounts(db: DbHandle): Map<string, number> {
  const rows = db
    .select({ userId: apiTokens.userId, count: sql<number>`count(*)` })
    .from(apiTokens)
    .groupBy(apiTokens.userId)
    .all();
  return new Map(rows.map((row) => [row.userId, Number(row.count)]));
}

export function listApiKeys(db: DbHandle, userId: string): ApiKeyRow[] {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(asc(apiTokens.createdAt))
    .all();
}

export function countApiKeys(db: DbHandle, userId: string): number {
  return Number(
    db.select({ count: sql<number>`count(*)` }).from(apiTokens).where(eq(apiTokens.userId, userId)).get()
      ?.count ?? 0,
  );
}

export function findApiKey(db: DbHandle, userId: string, id: string): ApiKeyRow | undefined {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id)))
    .get();
}

export function sessionIdsOf(db: DbHandle, userId: string): string[] {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all()
    .map((row) => row.id);
}
