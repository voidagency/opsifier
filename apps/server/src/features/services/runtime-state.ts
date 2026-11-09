import type { AppDeps } from "../../core/context";
import type { RuntimeUncertainty } from "../../core/db/schema";
import { conflict } from "../../core/errors";
import { isActionRunning, type ServiceRecord } from "./repo";
import { requireService, type ServiceTarget } from "./service";

/**
 * Why nobody can say what a service is really running, or null when somebody can. A deployment
 * writes the flag before it touches anything and takes it off when it is done, so a process that dies
 * halfway leaves it behind with nothing more to do. While that deployment is still running, the
 * flag only says it is under way.
 */
export function runtimeUncertainty(
  deps: Pick<AppDeps, "db">,
  record: Pick<ServiceRecord, "runtimeUncertain">,
): RuntimeUncertainty["reason"] | null {
  const flag = record.runtimeUncertain;
  return flag === null || isActionRunning(deps.db, flag.actionId) ? null : flag.reason;
}

/**
 * For work on a service's data, or that gives up a port or a name it holds: both assume the runtime
 * is what the panel believes it to be.
 */
export function assertRuntimeCertain(deps: Pick<AppDeps, "db">, target: ServiceTarget): void {
  if (runtimeUncertainty(deps, requireService(deps, target)) !== null) {
    throw conflict(
      "runtime_uncertain",
      "A deployment of this service did not finish, so what it is running is uncertain. Deploy it successfully first.",
    );
  }
}
