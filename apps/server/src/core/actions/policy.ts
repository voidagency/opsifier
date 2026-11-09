import { isDeploymentAction, rollbackActionType } from "@opsifier/contract";
import { type AppError, conflict } from "../errors";

/**
 * Which work may begin while other work is under way.
 *
 * Deployments queue, because a later one simply replaces what an earlier one did, and a webhook
 * delivery must never be lost. Everything here is the other kind: work that makes no sense once
 * something else has happened to the service, so it is refused at once instead of failing later. A
 * rollback is one of those: somebody chose it after seeing what was running.
 */

/** Change what the service is called, or remove it. Nothing else can follow them. */
const EXCLUSIVE_VERBS: Readonly<Record<string, string>> = {
  "service.destroy": "destroy",
  "service.rename": "rename or move",
};

/** Change whether its tasks are running, which a rollout is busy deciding for itself. */
const LIFECYCLE_VERBS: Readonly<Record<string, string>> = {
  "service.start": "start",
  "service.stop": "stop",
  "service.restart": "restart",
  "box.process-restart": "restart a process of",
};

/** Restart the panel itself, ending whatever else it is doing. */
export const PANEL_ACTION_TYPES: ReadonlySet<string> = new Set(["panel.update", "panel.rollback"]);

/** What the policy needs to know about a queued or running Action. */
export interface ActiveWork {
  type: string;
  title: string;
}

/** Refuses a panel-wide Action while anything is active, and anything while one is. */
export function panelRefusal(type: string, active: readonly ActiveWork[]): AppError | null {
  const update = active.find((work) => PANEL_ACTION_TYPES.has(work.type));
  if (update !== undefined) {
    return conflict("panel_updating", "The panel is restarting into another version. Try again afterwards.");
  }
  const [blocker] = active;
  if (PANEL_ACTION_TYPES.has(type) && blocker !== undefined) {
    return conflict(
      "panel_busy",
      `The panel cannot restart while "${blocker.title}" is in progress. Wait for it to finish or cancel it, then try again.`,
    );
  }
  return null;
}

/** Refuses work on a service that cannot safely follow what is already active on it. */
export function serviceRefusal(type: string, target: string, active: readonly ActiveWork[]): AppError | null {
  const exclusive = active.find((work) => EXCLUSIVE_VERBS[work.type] !== undefined);
  if (exclusive !== undefined) {
    return conflict(
      "service_busy",
      `${target} cannot take new work while "${exclusive.title}" is in progress. Wait for it to finish.`,
    );
  }

  const [blocker] = active;
  const exclusiveVerb = EXCLUSIVE_VERBS[type];
  if (exclusiveVerb !== undefined && blocker !== undefined) {
    return conflict(
      "service_busy",
      `Cannot ${exclusiveVerb} ${target} while "${blocker.title}" is in progress. Wait for it to finish or cancel it, then try again.`,
    );
  }

  if (type === rollbackActionType && blocker !== undefined) {
    return conflict(
      "service_busy",
      `Cannot roll back ${target} while "${blocker.title}" is in progress. Wait for it to finish or cancel it, then try again.`,
    );
  }

  const lifecycleVerb = LIFECYCLE_VERBS[type];
  if (lifecycleVerb !== undefined && active.some((work) => isDeploymentAction(work.type))) {
    return conflict(
      "deployment_in_progress",
      `Cannot ${lifecycleVerb} ${target} during a deployment. Wait for it to finish or cancel it, then try again.`,
    );
  }
  return null;
}
