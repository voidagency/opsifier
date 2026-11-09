import type { ActionDetail, ActionEntry, ActionPage, ListActionsQuery } from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { forbidden, notFound } from "../../core/errors";
import { type Access, canSeeAction, canSeeProject, meetsLevel, roleInProject } from "../access/rules";
import { findAction, listActions } from "./repo";

export function listActionPage(deps: AppDeps, query: ListActionsQuery, access: Access): ActionPage {
  if (access.projects === null) {
    const { rows, hasMore } = listActions(deps.db, query);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => toActionEntry(deps.actions.current(row))),
      nextCursor: hasMore && last !== undefined ? String(last.seq) : null,
    };
  }

  const items: ActionEntry[] = [];
  let cursor = query.cursor;
  // Filtering after the query, a page of other projects' actions must not look like the end of the list.
  while (items.length < query.limit) {
    const { rows, hasMore } = listActions(deps.db, { ...query, cursor, limit: query.limit * 4 });
    for (const row of rows) {
      if (canSeeAction(access, row) && items.length < query.limit) {
        items.push(toActionEntry(deps.actions.current(row)));
        cursor = String(row.seq);
      } else if (items.length >= query.limit) {
        break;
      } else {
        cursor = String(row.seq);
      }
    }
    if (!hasMore) {
      return { items, nextCursor: null };
    }
  }
  return { items, nextCursor: cursor ?? null };
}

/** Viewers see that work happened, but not its output. */
function assertCanReadOutput(access: Access, projectName: string | null): void {
  if (access.projects === null || projectName === null) {
    return;
  }
  const role = roleInProject(access, projectName);
  if (role !== null && !meetsLevel(role, "operator")) {
    throw forbidden("forbidden", "You don't have access to this.");
  }
}

export async function getActionDetail(deps: AppDeps, id: string, access: Access): Promise<ActionDetail> {
  const row = findAction(deps.db, id);
  if (row === undefined || !canSeeAction(access, row)) {
    throw notFound("This action does not exist.");
  }
  assertCanReadOutput(access, row.projectName);
  return { ...toActionEntry(deps.actions.current(row)), ...(await deps.actions.readLog(row)) };
}

export function cancelAction(deps: AppDeps, id: string, access: Access): ActionEntry {
  const row = findAction(deps.db, id);
  if (row === undefined || !canSeeAction(access, row)) {
    throw notFound("This action does not exist.");
  }
  if (access.projects !== null) {
    if (row.projectName === null || !canSeeProject(access, row.projectName)) {
      throw notFound("This action does not exist.");
    }
    const role = roleInProject(access, row.projectName);
    if (role === null || !meetsLevel(role, "operator")) {
      throw forbidden("forbidden", "You don't have access to this.");
    }
  }
  return toActionEntry(deps.actions.cancel(id));
}
