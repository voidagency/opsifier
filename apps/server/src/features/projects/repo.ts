import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../../core/db";
import { projects } from "../../core/db/schema";

export type ProjectRow = typeof projects.$inferSelect;

export function findProject(db: DbHandle, name: string): ProjectRow | undefined {
  return db.select().from(projects).where(eq(projects.name, name)).get();
}

export function listProjects(db: DbHandle): ProjectRow[] {
  return db.select().from(projects).orderBy(asc(projects.name)).all();
}

export function insertProject(db: DbHandle, name: string, now: Date): ProjectRow {
  return db.insert(projects).values({ name, createdAt: now, updatedAt: now }).returning().get();
}

export function updateProjectEnv(db: DbHandle, name: string, env: string, now: Date): void {
  db.update(projects).set({ env, updatedAt: now }).where(eq(projects.name, name)).run();
}

/** Services and their domains go with it, through the foreign keys. */
export function deleteProject(db: DbHandle, name: string): void {
  db.delete(projects).where(eq(projects.name, name)).run();
}
