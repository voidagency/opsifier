import type { ActionDetail, ActionEntry, ActionPage, ListActionsQuery } from "@opsifier/contract";
import { toActionEntry } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { notFound } from "../../core/errors";
import { findAction, listActions } from "./repo";

export function listActionPage(deps: AppDeps, query: ListActionsQuery): ActionPage {
  const { rows, hasMore } = listActions(deps.db, query);
  const last = rows.at(-1);
  return {
    items: rows.map(toActionEntry),
    nextCursor: hasMore && last !== undefined ? String(last.seq) : null,
  };
}

export async function getActionDetail(deps: AppDeps, id: string): Promise<ActionDetail> {
  const row = findAction(deps.db, id);
  if (row === undefined) {
    throw notFound("This action does not exist.");
  }
  return { ...toActionEntry(row), ...(await deps.actions.readLog(row)) };
}

export function cancelAction(deps: AppDeps, id: string): ActionEntry {
  return toActionEntry(deps.actions.cancel(id));
}
