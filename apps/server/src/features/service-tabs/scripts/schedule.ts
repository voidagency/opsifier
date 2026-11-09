import type { ScriptSchedule } from "@opsifier/contract";
import { nextCronOccurrence, parseCron } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { listServiceScripts } from "../../service-runtime/repo";
import { deleteSchedule, listDueSchedules, type ScriptScheduleRow, saveSchedule } from "./repo";
import { concludeUnstartedRun, runDeployHooks, settleLeftoverRuns, startAutomaticRun } from "./run";

/** How often due schedules are looked for: small compared to a minute, cheap compared to a run. */
const TICK_MS = 15_000;
/** After a restart, nothing overdue starts until Docker's tasks have had time to come back. */
export const DEFAULT_BOOT_GRACE_MS = 60_000;

export interface ScriptSchedulerOptions {
  /** Delays everything after boot. Tests use 0. */
  bootGraceMs?: number;
  tickMs?: number;
}

/** The next occurrence of a schedule strictly after `after`. Saved schedules can always be evaluated. */
export function nextRunOf(schedule: ScriptSchedule, after: number): number | null {
  return nextCronOccurrence(parseCron(schedule.cron), after, schedule.timeZone);
}

/**
 * Runs scripts at their scheduled times. Nothing is kept in memory: the next due time of each is a
 * column, so schedules survive restarts by construction. A missed run is not replayed: a schedule due
 * while the panel was down runs once after the boot delay, then returns to its calendar.
 */
export class ScriptScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly readyAt: number;
  private stopped = false;

  constructor(
    private readonly deps: AppDeps,
    private readonly options: ScriptSchedulerOptions = {},
  ) {
    this.readyAt = deps.now() + (options.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** One pass over everything that is due. Safe to call at any time. */
  tick(): number {
    if (this.stopped) {
      return 0;
    }
    void settleLeftoverRuns(this.deps).catch((error: unknown) => {
      this.deps.logger.debug({ err: error }, "Could not look over the scripts left running");
    });
    const now = this.deps.now();
    if (now < this.readyAt) {
      return 0;
    }
    let due: ScriptScheduleRow[];
    try {
      due = listDueSchedules(this.deps.db, new Date(now));
    } catch (error) {
      // The database is already closed at the very end of shutdown, and nothing should run then.
      this.stop();
      this.deps.logger.debug({ err: error }, "The script scheduler stopped");
      return 0;
    }
    let started = 0;
    for (const entry of due) {
      if (this.fire(entry, now)) {
        started += 1;
      }
    }
    return started;
  }

  private fire(entry: ScriptScheduleRow, now: number): boolean {
    const target = { projectName: entry.projectName, serviceName: entry.serviceName };
    const script = listServiceScripts(this.deps.db, target).find((item) => item.name === entry.scriptName);
    const next = script?.schedule === null || script === undefined ? null : nextRunOf(script.schedule, now);
    if (script === undefined || next === null) {
      deleteSchedule(this.deps.db, target, entry.scriptName);
      return false;
    }
    // Stored before the run exists, so that a crash in between can't start this occurrence twice.
    saveSchedule(this.deps.db, target, entry.scriptName, new Date(next));
    return startAutomaticRun(this.deps, target, script, {
      origin: "schedule",
      dueAt: entry.nextRunAt.getTime(),
    });
  }
}

const schedulers = new WeakMap<AppDeps, ScriptScheduler>();
const unsubscribers = new WeakMap<AppDeps, () => void>();

/** Called once at boot, after the database is ready. */
export function startScriptScheduler(deps: AppDeps, options?: ScriptSchedulerOptions): ScriptScheduler {
  const scheduler = new ScriptScheduler(deps, options);
  schedulers.set(deps, scheduler);
  scheduler.start();
  unsubscribers.set(
    deps,
    deps.actions.onFinished((action) => {
      concludeUnstartedRun(deps, action);
      runDeployHooks(deps, action);
    }),
  );
  return scheduler;
}

export function stopScriptScheduler(deps: AppDeps): void {
  schedulers.get(deps)?.stop();
  schedulers.delete(deps);
  unsubscribers.get(deps)?.();
  unsubscribers.delete(deps);
}

export const scriptSchedulerFor = (deps: AppDeps): ScriptScheduler | undefined => schedulers.get(deps);
