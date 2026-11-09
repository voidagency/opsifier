import { backupActionTypes } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { listActiveServiceActions } from "../services/repo";
import { type BackupConfigRow, findUnresolvedRestore, listDueConfigs, updateConfig } from "./repo";
import { enqueueConfiguredBackup, nextRunFrom } from "./service";

/** How often due schedules are looked for: small compared to a minute, cheap compared to a backup. */
const TICK_MS = 15_000;
/**
 * After a restart, how long the panel waits before running anything overdue. Docker's tasks take a
 * moment to come back after a server reboot, and a backup started before that would only fail.
 */
export const DEFAULT_BOOT_GRACE_MS = 60_000;

export interface SchedulerOptions {
  /** Delays everything after boot. Tests use 0. */
  bootGraceMs?: number;
  tickMs?: number;
  /** When to start counting from. Defaults to the moment of construction. */
  startedAt?: number;
}

/**
 * Runs configured backups at their scheduled times. Nothing is kept in memory: the next run of each
 * configuration is a column, so schedules survive restarts by construction.
 *
 * Missed runs are not replayed. However many occurrences a downtime covered, a configuration that
 * was due runs once, as soon as the boot delay has passed, and then returns to its schedule. A
 * service with other work in progress is left due until it is free again, so that runs never pile up.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly bootGraceMs: number;
  private readonly tickMs: number;
  private readonly readyAt: number;
  private stopped = false;

  constructor(
    private readonly deps: AppDeps,
    options: SchedulerOptions = {},
  ) {
    this.bootGraceMs = options.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.readyAt = (options.startedAt ?? deps.now()) + this.bootGraceMs;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.tickMs);
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
    const now = this.deps.now();
    if (now < this.readyAt) {
      return 0;
    }

    let due: BackupConfigRow[];
    try {
      due = listDueConfigs(this.deps.db, new Date(now));
    } catch (error) {
      // The database is already closed at the very end of shutdown, and nothing should run then.
      this.stop();
      this.deps.logger.debug({ err: error }, "The backup scheduler stopped");
      return 0;
    }

    let started = 0;
    const busy = new Set(
      listActiveServiceActions(this.deps.db).map((action) => `${action.projectName}/${action.serviceName}`),
    );
    for (const config of due) {
      const key = `${config.projectName}/${config.serviceName}`;
      if (busy.has(key)) {
        continue;
      }
      if (findUnresolvedRestore(this.deps.db, config.projectName, config.serviceName) !== undefined) {
        continue;
      }
      if (this.fire(config, now)) {
        busy.add(key);
        started += 1;
      }
    }
    return started;
  }

  private fire(config: BackupConfigRow, now: number): boolean {
    let next: number;
    try {
      next = nextRunFrom(config.schedule, now);
    } catch (error) {
      this.deps.logger.error({ err: error, config: config.id }, "A saved schedule could not be evaluated");
      updateConfig(this.deps.db, config.id, { enabled: false, nextRunAt: null });
      return false;
    }

    // Stored before the Action exists, so that a crash in between can't run this occurrence twice.
    updateConfig(this.deps.db, config.id, { nextRunAt: new Date(next) });
    const target = { projectName: config.projectName, serviceName: config.serviceName };
    try {
      enqueueConfiguredBackup(this.deps, target, config.id, {
        origin: "schedule",
        name: null,
        actorEmail: undefined,
      });
      return true;
    } catch (error) {
      // A destination that was disconnected, a restore still waiting for a person: the reason belongs
      // in the activity log, or this schedule would just quietly stop producing backups.
      this.deps.actions.record({
        type: config.kind === "database" ? backupActionTypes.database : backupActionTypes.volume,
        title: `Scheduled backup of ${config.projectName}/${config.serviceName} could not start`,
        ...target,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.deps.logger.warn({ err: error, config: config.id }, "A scheduled backup could not start");
      return false;
    }
  }
}

const schedulers = new WeakMap<AppDeps, BackupScheduler>();

/** Called once at boot, after the database is ready. */
export function startScheduler(deps: AppDeps, options?: SchedulerOptions): BackupScheduler {
  const scheduler = new BackupScheduler(deps, options);
  schedulers.set(deps, scheduler);
  scheduler.start();
  return scheduler;
}

export function stopScheduler(deps: AppDeps): void {
  schedulers.get(deps)?.stop();
  schedulers.delete(deps);
}

export const schedulerFor = (deps: AppDeps): BackupScheduler | undefined => schedulers.get(deps);
