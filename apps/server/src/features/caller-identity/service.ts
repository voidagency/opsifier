import type { CallerIdentity, CallerOperation } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import { apiTokens } from "../../core/db/schema";
import { isPermitted } from "../access/guard";
import { type Access, meetsLevel } from "../access/rules";

/** An API route as the OpenAPI document names it. */
export interface RouteRef {
  method: CallerOperation["method"];
  path: string;
}

/** Any valid project name stands for all of them when every project is in reach with the same rights. */
const ANY_PROJECT = "any";

/** The table leaves cancelling to its handler, which checks the project of the action in question. */
const CANCEL_ACTION = "/api/v1/actions/{id}/cancel";

const isOperatorSomewhere = (access: Access): boolean =>
  access.projects === null || [...access.projects.values()].some((role) => meetsLevel(role, "operator"));

/**
 * Runs each route through the same check a real request goes through, once per project the caller
 * holds, so that what this says it may do and what it is actually allowed cannot disagree.
 */
function permittedOperations(access: Access, routes: readonly RouteRef[]): CallerOperation[] {
  return routes.flatMap(({ method, path }): CallerOperation[] => {
    if (path === CANCEL_ACTION && !isOperatorSomewhere(access)) {
      return [];
    }
    if (!path.includes("{project}")) {
      return isPermitted(access, method, path) ? [{ method, path, projects: null }] : [];
    }
    if (access.projects === null) {
      return isPermitted(access, method, path.replaceAll("{project}", ANY_PROJECT))
        ? [{ method, path, projects: null }]
        : [];
    }
    const projects = [...access.projects.keys()].filter((project) =>
      isPermitted(access, method, path.replaceAll("{project}", project)),
    );
    return projects.length > 0 ? [{ method, path, projects }] : [];
  });
}

export function describeCaller(
  deps: Pick<AppDeps, "db">,
  access: Access,
  routes: readonly RouteRef[],
): CallerIdentity {
  const { principal } = access;
  const expiresAt =
    principal.kind === "token"
      ? deps.db
          .select({ expiresAt: apiTokens.expiresAt })
          .from(apiTokens)
          .where(eq(apiTokens.id, principal.tokenId))
          .get()?.expiresAt
      : null;
  return {
    user: {
      id: principal.user.id,
      email: principal.user.email,
      role: principal.user.role as "admin" | "member",
    },
    credential:
      principal.kind === "session"
        ? { kind: "session" }
        : {
            kind: "api_key",
            name: principal.tokenName,
            level: principal.level,
            projects: principal.projects,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
    projects: access.projects === null ? null : [...access.projects].map(([name, role]) => ({ name, role })),
    operations: permittedOperations(access, routes),
  };
}
