import { setTimeout as sleep } from "node:timers/promises";
import type { DockerDriver, SwarmServiceSpec } from "../core/docker";
import { hasSnapshot, readJournal, restoreSnapshot, writeJournal } from "../features/panel-update/journal";
import { SetupError } from "./setup";
import { PANEL_SWARM_SERVICE } from "./specs";

export interface RollbackDeps {
  docker: DockerDriver;
  dataDir: string;
  log(line: string): void;
  pollMs?: number;
  timeoutMs?: number;
}

function withReplicas(spec: SwarmServiceSpec, replicas: number): SwarmServiceSpec {
  return { ...spec, Mode: { Replicated: { Replicas: replicas } } };
}

function withImage(spec: SwarmServiceSpec, image: string): SwarmServiceSpec {
  return {
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Image: image },
    },
  };
}

async function waitForTasks(
  deps: RollbackDeps,
  done: (running: number) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + (deps.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const tasks = await deps.docker.listTasks({ service: PANEL_SWARM_SERVICE });
    if (done(tasks.filter((task) => task.state === "running").length)) {
      return;
    }
    await sleep(deps.pollMs ?? 1000);
  }
  throw new SetupError(`The panel did not ${what} in time.`);
}

/**
 * The last resort, from outside the panel: for when the new version runs badly enough that its own
 * rollback can't be reached. Stops the panel, puts the saved state back and starts the old image.
 */
export async function runRollback(deps: RollbackDeps): Promise<void> {
  const paths = {
    dataDir: deps.dataDir,
    databaseFile: `${deps.dataDir}/opsifier.db`,
    secretKeyFile: `${deps.dataDir}/secret.key`,
  };
  const journal = readJournal(paths);
  if (journal === null || journal.kind !== "update" || journal.state === "rolled-back") {
    throw new SetupError("There is no update to go back from on this server.");
  }
  if (!hasSnapshot(paths, journal.snapshotId)) {
    throw new SetupError(`The state saved before the update (${journal.snapshotId}) is missing.`);
  }
  const panel = await deps.docker.inspectService(PANEL_SWARM_SERVICE);
  if (panel === null) {
    throw new SetupError("The panel is not installed as a Swarm service here. Run setup instead.");
  }
  if ((await deps.docker.inspectImage(journal.fromImage)) === null) {
    throw new SetupError(
      `The image of ${journal.fromVersion} is no longer on this server. Nothing was changed.`,
    );
  }

  deps.log("Stopping the panel");
  await deps.docker.updateService(PANEL_SWARM_SERVICE, withReplicas(panel.spec, 0));
  await waitForTasks(deps, (running) => running === 0, "stop");

  deps.log(`Restoring the state saved before ${journal.toVersion}`);
  restoreSnapshot(paths, journal.snapshotId);
  writeJournal(paths, {
    ...journal,
    state: "rolled-back",
    error: `Version ${journal.toVersion} was rolled back by hand to ${journal.fromVersion}.`,
    finishedAt: new Date().toISOString(),
  });

  deps.log(`Starting ${journal.fromImage}`);
  await deps.docker.updateService(
    PANEL_SWARM_SERVICE,
    withReplicas(withImage(panel.spec, journal.fromImage), 1),
  );
  await waitForTasks(deps, (running) => running > 0, "start");
  deps.log(`The panel is back on ${journal.fromVersion}.`);
}
