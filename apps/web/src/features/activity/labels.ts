import type { ActionEntry, ActionStatus } from "@opsifier/contract";
import type { TFunction } from "i18next";
import type { LampStatus } from "../../ui";

export function lampForAction(status: ActionStatus): LampStatus {
  switch (status) {
    case "running":
      return "busy";
    case "succeeded":
      return "ok";
    case "failed":
      return "bad";
    default:
      return "off";
  }
}

/** The interface's words for an action, falling back to the title stored with it. */
export function actionLabel(action: Pick<ActionEntry, "type" | "title">, t: TFunction): string {
  return t(`types.${action.type}`, { ns: "activity", defaultValue: action.title });
}

export function actionTarget(action: Pick<ActionEntry, "projectName" | "serviceName">): string | null {
  return action.projectName === null
    ? null
    : action.serviceName === null
      ? action.projectName
      : `${action.projectName}/${action.serviceName}`;
}
