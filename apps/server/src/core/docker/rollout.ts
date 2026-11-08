import { setTimeout as sleep } from "node:timers/promises";
import { type DockerDriver, DockerDriverError, type TaskInfo, type TaskState } from "./driver";

export interface RolloutTiming {
  /** How often the tasks are read. */
  pollMs: number;
  /** How long every new task must stay running before the rollout counts as converged. */
  stableMs: number;
  /** How long a rollout may take altogether. */
  timeoutMs: number;
  /** How many new tasks may fail before the rollout is given up on. */
  maxTaskFailures: number;
}

/** `stableMs` matches the monitor period of the update config: a crash inside it fails the rollout. */
export const defaultRolloutTiming: RolloutTiming = {
  pollMs: 1000,
  stableMs: 6000,
  timeoutMs: 180_000,
  maxTaskFailures: 3,
};

/** Terminal task states that mean the workload did not stay up. `complete` is an exit with status 0. */
const FAILED_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "failed",
  "rejected",
  "orphaned",
  "complete",
]);
const LIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "new",
  "allocated",
  "pending",
  "assigned",
  "accepted",
  "preparing",
  "ready",
  "starting",
  "running",
]);

export interface WatchOptions {
  docker: Pick<DockerDriver, "listTasks">;
  timing: RolloutTiming;
  /** The Swarm service to watch. */
  service: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const describeTask = (task: TaskInfo): string =>
  `Task ${task.id.slice(0, 12)}${task.slot === null ? "" : ` (slot ${task.slot})`}`;

/** Logs each task once per state, so a slow rollout does not fill the log with repeats. */
function createStateLogger(log: WatchOptions["log"]) {
  const seen = new Map<string, TaskState>();
  return (tasks: readonly TaskInfo[]) => {
    for (const task of tasks) {
      if (seen.get(task.id) !== task.state) {
        seen.set(task.id, task.state);
        const detail = task.error ?? (task.state === "running" ? "" : task.message);
        log?.(
          `${describeTask(task)}: ${task.state}${detail === "" || detail === task.state ? "" : ` (${detail})`}`,
        );
      }
    }
  };
}

/** Reads the tasks, keeping a Docker hiccup from ending a watch that still has time left. */
async function readTasks(options: WatchOptions): Promise<TaskInfo[] | null> {
  try {
    return await options.docker.listTasks({ service: options.service });
  } catch (error) {
    options.signal?.throwIfAborted();
    // Docker answers 404 for the tasks of a service that has already gone.
    if (error instanceof DockerDriverError && error.statusCode === 404) {
      return [];
    }
    options.log?.(`Could not read the tasks: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Waits for a rollout to settle. Success means `desired` tasks newer than `previousTaskIds` are running
 * and have stayed running for `stableMs`. Throws when too many of them fail, or when time runs out.
 */
export async function waitForRollout(
  options: WatchOptions & { desired: number; previousTaskIds: ReadonlySet<string> },
): Promise<void> {
  const { timing, desired, previousTaskIds, signal, log } = options;
  const deadline = performance.now() + timing.timeoutMs;
  const logStates = createStateLogger(log);
  const runningSince = new Map<string, number>();

  for (;;) {
    signal?.throwIfAborted();
    const tasks = await readTasks(options);

    if (tasks !== null) {
      const fresh = tasks.filter((task) => !previousTaskIds.has(task.id));
      logStates(fresh);

      const failed = fresh.filter((task) => FAILED_STATES.has(task.state));
      const lastFailed = failed.at(-1);
      // A task that exits cleanly is not restarted, so waiting for it would only run out the clock.
      const gaveUp =
        failed.length >= timing.maxTaskFailures || failed.some((task) => task.state === "complete");
      if (gaveUp && lastFailed !== undefined) {
        throw new DockerDriverError(
          `The new tasks did not stay up: ${lastFailed.error ?? lastFailed.message ?? lastFailed.state}.`,
        );
      }

      const now = performance.now();
      const running = fresh.filter((task) => task.state === "running" && task.desiredState === "running");
      for (const task of running) {
        if (!runningSince.has(task.id)) {
          runningSince.set(task.id, now);
        }
      }
      for (const id of runningSince.keys()) {
        if (!running.some((task) => task.id === id)) {
          runningSince.delete(id);
        }
      }

      if (
        running.length >= desired &&
        running.every((task) => now - (runningSince.get(task.id) ?? now) >= timing.stableMs)
      ) {
        return;
      }
    }

    if (performance.now() >= deadline) {
      throw new DockerDriverError(
        `The tasks did not settle within ${Math.round(timing.timeoutMs / 1000)} seconds.`,
      );
    }
    await sleep(timing.pollMs, undefined, { signal });
  }
}

/** Waits until none of the service's tasks are running any more. Throws when time runs out. */
export async function waitForShutdown(options: WatchOptions): Promise<void> {
  const { timing, signal, log } = options;
  const deadline = performance.now() + timing.timeoutMs;
  const logStates = createStateLogger(log);
  const watched = new Set<string>();

  for (;;) {
    signal?.throwIfAborted();
    const tasks = await readTasks(options);
    if (tasks !== null) {
      // Tasks that had already stopped before this began are history, not progress.
      for (const task of tasks) {
        if (LIVE_STATES.has(task.state)) {
          watched.add(task.id);
        }
      }
      logStates(tasks.filter((task) => watched.has(task.id)));
      if (!tasks.some((task) => LIVE_STATES.has(task.state))) {
        return;
      }
    }
    if (performance.now() >= deadline) {
      throw new DockerDriverError(
        `The tasks did not stop within ${Math.round(timing.timeoutMs / 1000)} seconds.`,
      );
    }
    await sleep(timing.pollMs, undefined, { signal });
  }
}
