import type { ActionEntry, ProjectRole } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import type { Principal } from "../../core/auth";
import type { DbHandle } from "../../core/db";
import { projectMembers, users } from "../../core/db/schema";
import type { ProjectLevel } from "./policy";

export type ProjectAccessRole = ProjectRole | "admin";

const LEVEL_RANK: Record<ProjectLevel, number> = { viewer: 1, operator: 2, admin: 3 };

/** The projects one caller reaches, and how far. Computed fresh for every request. */
export interface Access {
  principal: Principal;
  /** True for an administrator account, whatever a key narrows it to. */
  admin: boolean;
  /** True when a key confines the caller to a list of projects. */
  scoped: boolean;
  /** Null means every project. */
  projects: ReadonlyMap<string, ProjectAccessRole> | null;
  /** False for a read-only key. */
  canWrite: boolean;
}

export function membershipsOf(db: DbHandle, userId: string): Map<string, ProjectRole> {
  const rows = db.select().from(projectMembers).where(eq(projectMembers.userId, userId)).all();
  return new Map(rows.map((row) => [row.projectName, row.role as ProjectRole]));
}

export function accessOf(db: DbHandle, principal: Principal): Access {
  const admin = principal.user.role === "admin";
  const keyProjects = principal.kind === "token" ? principal.projects : null;
  const canWrite = principal.kind === "session" || principal.level === "write";

  if (admin && keyProjects === null) {
    return { principal, admin, scoped: false, projects: null, canWrite };
  }

  let granted: Map<string, ProjectAccessRole> = admin
    ? new Map((keyProjects as string[]).map((project) => [project, "admin"]))
    : membershipsOf(db, principal.user.id);
  if (!admin && keyProjects !== null) {
    granted = new Map([...granted].filter(([project]) => keyProjects.includes(project)));
  }
  return { principal, admin, scoped: keyProjects !== null, projects: granted, canWrite };
}

export const roleInProject = (access: Access, project: string): ProjectAccessRole | null => {
  if (access.projects === null) {
    return "admin";
  }
  return access.projects.get(project) ?? null;
};

export const meetsLevel = (role: ProjectAccessRole, level: ProjectLevel): boolean =>
  LEVEL_RANK[role] >= LEVEL_RANK[level];

/** Whether the caller holds at least `level` in this project. */
export function hasProjectLevel(access: Access, project: string, level: ProjectLevel): boolean {
  const role = roleInProject(access, project);
  return role !== null && meetsLevel(role, level);
}

/** Only an administrator's own rights, never narrowed to a list of projects, can reach the host. */
export const canReachHost = (access: Access): boolean => access.admin && !access.scoped;

/** Null means no restriction at all. */
export function visibleProjects(access: Access): ReadonlySet<string> | null {
  return access.projects === null ? null : new Set(access.projects.keys());
}

export function canSeeProject(access: Access, project: string): boolean {
  return roleInProject(access, project) !== null;
}

/** Keeps what the caller may see of a list that spans projects. */
export function filterVisible<T>(
  access: Access,
  items: readonly T[],
  projectOf: (item: T) => string | null,
): T[] {
  return access.projects === null
    ? [...items]
    : items.filter((item) => {
        const project = projectOf(item);
        return project !== null && canSeeProject(access, project);
      });
}

/** A signed-in person sees their own account's events alongside their projects' ones. */
export function canSeeAction(
  access: Access,
  action: Pick<ActionEntry, "projectName" | "actorEmail">,
): boolean {
  if (access.projects === null) {
    return true;
  }
  if (action.projectName === null) {
    return access.principal.kind === "session" && action.actorEmail === access.principal.user.email;
  }
  return canSeeProject(access, action.projectName);
}

/** Viewers read the inventory: not the notes or an inline source that may say more than it should. */
export function redactForViewer<T extends { notes: string; notesHidden: boolean; source: unknown }>(
  access: Access,
  project: string,
  detail: T,
): T {
  if (roleInProject(access, project) !== "viewer") {
    return detail;
  }
  const source = detail.source as { type?: string; dockerfile?: string } | null;
  const redactedSource =
    source !== null && source.type === "dockerfile" ? { ...source, dockerfile: "" } : source;
  return { ...detail, notes: "", notesHidden: false, source: redactedSource as T["source"] };
}

/** The account behind a WebSocket, looked up again for every check so a change applies at once. */
export function findUser(db: DbHandle, userId: string) {
  return db.select().from(users).where(eq(users.id, userId)).get();
}
