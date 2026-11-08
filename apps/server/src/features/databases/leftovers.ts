import { setTimeout as sleep } from "node:timers/promises";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { removeAllCompanions } from "../service-tabs/companions/service";
import type { ServiceTarget } from "../services/service";
import type { DatabaseRecord } from "./service";

/**
 * Deletes what a database owns beyond its Swarm service: its companions and its data volume. Tasks
 * take a moment to let go of a volume after their service is removed, so this keeps trying.
 */
export async function removeDatabaseLeftovers(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  log: (line: string) => void,
): Promise<void> {
  await removeAllCompanions(deps, target, record, log);

  const { volume } = record.spec.database;
  log(`Deleting the data volume ${volume}`);
  const deadline = performance.now() + deps.rollout.timeoutMs;
  for (;;) {
    try {
      await deps.docker.removeVolume(volume);
      return;
    } catch (error) {
      if (!(error instanceof DockerDriverError) || performance.now() >= deadline) {
        throw new Error(
          `The service is gone, but its data volume ${volume} could not be deleted: ${(error as Error).message}`,
        );
      }
      await sleep(deps.rollout.pollMs);
    }
  }
}
