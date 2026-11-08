import { appendFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActionEntry,
  type ActionStatus,
  type ActionStreamEvent,
  actionsTopic,
  actionTopic,
  resourceName,
} from "@opsifier/contract";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { Db } from "../db";
import { actions } from "../db/schema";
import { conflict, notFound, serviceUnavailable } from "../errors";
import { ActionLogFile, readLogTail } from "./log-file";

export type ActionRow = typeof actions.$inferSelect;

export const MAX_GLOBAL_CONCURRENCY = 4;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 2000;

/** How many of the newest Actions are kept, with their logs. */
export const RETAINED_ACTIONS = 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const RESTARTED_WHILE_RUNNING = "The panel restarted while this action was running.";
const RESTARTED_WHILE_QUEUED = "The panel restarted before this action could start.";
const SHUT_DOWN = "The panel shut down while this action was running.";
const SHUT_DOWN_QUEUED = "The panel shut down before this action could start.";

export interface ActionContext {
  readonly id: string;
  /** Appends to the action's log and streams to anyone watching. Never throws. */
  log(line: string): void;
  /** Aborted when the action is cancelled. Pass it to everything that can block. */
  readonly signal: AbortSignal;
}

export type ActionRun = (ctx: ActionContext) => void | Promise<void>;

export interface EnqueueInput {
  type: string;
  title: string;
  projectName?: string;
  serviceName?: string;
  actorEmail?: string;
  run: ActionRun;
}

export type RecordInput = Omit<EnqueueInput, "run"> & { status?: "succeeded" | "failed"; error?: string };

export interface ActionPublisher {
  publish(topic: string, payload: unknown): void;
}

export interface ActionEngineOptions {
  db: Db;
  actionsDir: string;
  publisher: ActionPublisher;
  logger: Logger;
  now?: () => number;
  maxGlobalConcurrency?: number;
  maxLogBytes?: number;
  maxReadBytes?: number;
}

export interface ActionLogView {
  log: string;
  logTruncated: boolean;
  /** Stream events numbered up to this are already part of `log`. */
  logSeq: number;
}

interface Job {
  id: string;
  /** `project/service`, or null for the bounded pool of service-less actions. */
  key: string | null;
  run: ActionRun;
  controller: AbortController;
  log: ActionLogFile | null;
  done: Promise<void>;
  resolveDone: () => void;
}

/** The API shape of a row. Timestamps become ISO strings. */
export function toActionEntry(row: ActionRow): ActionEntry {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status as ActionStatus,
    projectName: row.projectName,
    serviceName: row.serviceName,
    actorEmail: row.actorEmail,
    hasLog: row.hasLog,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "The action failed.").slice(0, MAX_ERROR_CHARS);
}

function stamp(now: number, text: string): string {
  return `[${new Date(now).toISOString()}] ${text}`;
}

/**
 * Runs Actions one per service in FIFO order, and service-less Actions up to a fixed pool.
 * Rows are the record of what happened, the in-memory jobs only carry what cannot be stored:
 * the `run` closures, which is why nothing can resume across a restart.
 */
export class ActionEngine {
  private readonly db: Db;
  private readonly actionsDir: string;
  private readonly publisher: ActionPublisher;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly maxGlobalConcurrency: number;
  private readonly maxLogBytes: number;
  private readonly maxReadBytes: number;

  private readonly queue: Job[] = [];
  private readonly running = new Map<string, Job>();
  private readonly busyServices = new Set<string>();
  private globalRunning = 0;
  private stopping = false;
  private retentionTimer: NodeJS.Timeout | undefined;

  constructor(options: ActionEngineOptions) {
    this.db = options.db;
    this.actionsDir = options.actionsDir;
    this.publisher = options.publisher;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxGlobalConcurrency = options.maxGlobalConcurrency ?? MAX_GLOBAL_CONCURRENCY;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    mkdirSync(this.actionsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Call once at boot, before anything is enqueued. Whatever was in flight when the last
   * process died can never finish, because its closure died with it.
   */
  recover(): number {
    const stranded = this.db
      .select()
      .from(actions)
      .where(inArray(actions.status, ["running", "queued"]))
      .all();

    for (const row of stranded) {
      const reason = row.status === "running" ? RESTARTED_WHILE_RUNNING : RESTARTED_WHILE_QUEUED;
      this.db
        .update(actions)
        .set({ status: "failed", error: reason, finishedAt: new Date(this.now()) })
        .where(eq(actions.id, row.id))
        .run();
      if (row.hasLog) {
        this.appendToClosedLog(row.id, stamp(this.now(), `Failed: ${reason}`));
      }
    }
    if (stranded.length > 0) {
      this.logger.warn({ count: stranded.length }, "Marked interrupted actions as failed");
    }
    return stranded.length;
  }

  /** Prunes once now and then hourly until `stop`. Call once at boot, after `recover`. */
  async startRetention(): Promise<void> {
    await this.pruneSafely();
    this.retentionTimer = setInterval(() => void this.pruneSafely(), RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  /**
   * Deletes the rows and log files of everything older than the newest {@link RETAINED_ACTIONS}.
   * Queued and running actions count towards that number but are never removed, however old.
   */
  async prune(): Promise<number> {
    const oldestKept = this.db
      .select({ seq: actions.seq })
      .from(actions)
      .orderBy(desc(actions.seq))
      .limit(1)
      .offset(RETAINED_ACTIONS - 1)
      .get();
    if (oldestKept === undefined) {
      return 0;
    }

    const removed = this.db
      .delete(actions)
      .where(and(lt(actions.seq, oldestKept.seq), notInArray(actions.status, ["queued", "running"])))
      .returning({ id: actions.id, hasLog: actions.hasLog })
      .all();

    for (const row of removed) {
      if (row.hasLog) {
        await rm(this.logPath(row.id), { force: true }).catch((error: unknown) => {
          this.logger.warn({ err: error, actionId: row.id }, "Could not delete an action log");
        });
      }
    }
    if (removed.length > 0) {
      this.logger.info({ count: removed.length }, "Pruned old actions");
    }
    return removed.length;
  }

  /** Stores the action and returns its row at once. The work starts on a later tick. */
  enqueue(input: EnqueueInput): ActionRow {
    if (this.stopping) {
      throw serviceUnavailable("shutting_down", "The panel is shutting down.");
    }
    const key = this.queueKey(input);
    const row = this.insert(input, "queued", null);

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.queue.push({
      id: row.id,
      key,
      run: input.run,
      controller: new AbortController(),
      log: null,
      done,
      resolveDone,
    });

    this.announce(row);
    queueMicrotask(() => this.pump());
    return row;
  }

  /**
   * Adds a finished entry to the activity log for something that was instantaneous, such as a
   * sign-in. It has no output and never occupies a queue.
   */
  record(input: RecordInput): ActionRow {
    const status = input.status ?? "succeeded";
    const row = this.insert(input, status, input.error ?? null);
    this.announce(row);
    return row;
  }

  /**
   * Finishes an entry made with {@link record}, for something long-lived that must never hold a
   * service's queue, such as a console session. Until then the entry stays as it was recorded.
   */
  conclude(id: string, outcome: { status: "succeeded" | "failed"; error?: string }): ActionRow {
    return this.finish(id, outcome.status, outcome.error ?? null);
  }

  /**
   * A queued action is cancelled on the spot. A running one is asked to stop through its
   * signal and stays `running` until `run` settles, so a service never has two actions at once.
   */
  cancel(id: string): ActionRow {
    const row = this.db.select().from(actions).where(eq(actions.id, id)).get();
    if (row === undefined) {
      throw notFound("This action does not exist.");
    }

    const queueIndex = this.queue.findIndex((job) => job.id === id);
    if (queueIndex !== -1) {
      const [job] = this.queue.splice(queueIndex, 1);
      job?.resolveDone();
      return this.finish(id, "cancelled", null);
    }

    const job = this.running.get(id);
    if (job === undefined) {
      throw conflict("action_finished", "This action has already finished.");
    }
    if (!job.controller.signal.aborted) {
      job.log?.write(stamp(this.now(), "Cancellation requested"));
      job.controller.abort(new DOMException("The action was cancelled.", "AbortError"));
    }
    return row;
  }

  async readLog(row: ActionRow): Promise<ActionLogView> {
    const flushed = this.running.get(row.id)?.log?.flushed();
    let tail: Awaited<ReturnType<typeof readLogTail>>;
    try {
      tail = await readLogTail(this.logPath(row.id), this.maxReadBytes, flushed?.bytes);
    } catch (error) {
      this.logger.error({ err: error, actionId: row.id }, "Action log could not be read");
      tail = { text: "", clipped: false };
    }
    return {
      log: tail.text,
      logTruncated: row.logTruncated || tail.clipped,
      logSeq: flushed?.seq ?? 0,
    };
  }

  /**
   * Graceful shutdown: drops what is queued, signals what is running and waits for it, up to
   * `timeoutMs`. Anything still running afterwards is picked up by `recover` at the next boot.
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    clearInterval(this.retentionTimer);
    for (const job of this.queue.splice(0)) {
      this.finish(job.id, "failed", SHUT_DOWN_QUEUED);
      job.resolveDone();
    }

    const running = [...this.running.values()];
    for (const job of running) {
      job.controller.abort(new DOMException("The panel is shutting down.", "AbortError"));
    }
    if (running.length === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((job) => job.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Housekeeping: a failure is worth a log line, but never worth stopping the panel. */
  private async pruneSafely(): Promise<void> {
    try {
      await this.prune();
    } catch (error) {
      this.logger.error({ err: error }, "Could not prune old actions");
    }
  }

  private queueKey(input: EnqueueInput): string | null {
    if (input.projectName !== undefined) {
      resourceName.parse(input.projectName);
    }
    if (input.serviceName === undefined) {
      return null;
    }
    resourceName.parse(input.serviceName);
    if (input.projectName === undefined) {
      throw new TypeError("An action with a service must also name its project.");
    }
    return `${input.projectName}/${input.serviceName}`;
  }

  private insert(input: Omit<EnqueueInput, "run">, status: ActionStatus, error: string | null): ActionRow {
    if (input.type === "" || input.title === "") {
      throw new TypeError("An action needs a type and a title.");
    }
    const now = new Date(this.now());
    const finished = status !== "queued" && status !== "running";
    return this.db
      .insert(actions)
      .values({
        id: nanoid(),
        type: input.type,
        title: input.title,
        status,
        projectName: input.projectName ?? null,
        serviceName: input.serviceName ?? null,
        actorEmail: input.actorEmail ?? null,
        error,
        createdAt: now,
        startedAt: finished ? now : null,
        finishedAt: finished ? now : null,
      })
      .returning()
      .get();
  }

  private pump(): void {
    if (this.stopping) {
      return;
    }
    let index = 0;
    while (index < this.queue.length) {
      const job = this.queue[index];
      if (job === undefined || !this.canStart(job)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.start(job);
    }
  }

  private canStart(job: Job): boolean {
    return job.key === null
      ? this.globalRunning < this.maxGlobalConcurrency
      : !this.busyServices.has(job.key);
  }

  private occupy(job: Job): void {
    if (job.key === null) {
      this.globalRunning += 1;
    } else {
      this.busyServices.add(job.key);
    }
    this.running.set(job.id, job);
  }

  private release(job: Job): void {
    this.running.delete(job.id);
    if (job.key === null) {
      this.globalRunning -= 1;
    } else {
      this.busyServices.delete(job.key);
    }
    job.resolveDone();
  }

  private start(job: Job): void {
    this.occupy(job);
    void this.execute(job)
      .catch((error: unknown) => {
        this.logger.error({ err: error, actionId: job.id }, "Action bookkeeping failed");
      })
      .finally(() => {
        this.release(job);
        this.pump();
      });
  }

  private async execute(job: Job): Promise<void> {
    const startedAt = new Date(this.now());
    const row = this.db
      .update(actions)
      .set({ status: "running", startedAt, hasLog: true })
      .where(eq(actions.id, job.id))
      .returning()
      .get();
    this.announce(row);

    const log = new ActionLogFile(
      this.logPath(job.id),
      this.maxLogBytes,
      (seq, line) => this.publishEvent(job.id, { kind: "log", seq, line }),
      this.logger,
    );
    job.log = log;
    log.write(stamp(this.now(), `Started: ${row.title}`));

    const ctx: ActionContext = {
      id: job.id,
      signal: job.controller.signal,
      log: (line) => {
        // A late callback from a finished run must not reopen or corrupt the record.
        if (this.running.has(job.id)) {
          log.write(String(line));
        }
      },
    };

    let failure: string | null = null;
    try {
      await job.run(ctx);
    } catch (error) {
      failure = describeError(error);
    }

    // An aborted run counts as cancelled however it ended: returning early is what a
    // well-behaved run does, and it did not get to finish its work.
    let status: ActionStatus = failure === null ? "succeeded" : "failed";
    if (job.controller.signal.aborted) {
      status = this.stopping ? "failed" : "cancelled";
      failure = this.stopping ? SHUT_DOWN : null;
    }

    const outcome =
      status === "succeeded" ? "Succeeded" : status === "cancelled" ? "Cancelled" : `Failed: ${failure}`;
    log.write(stamp(this.now(), outcome));
    await log.close();

    this.finish(job.id, status, failure, log.isTruncated);
  }

  private finish(id: string, status: ActionStatus, error: string | null, logTruncated = false): ActionRow {
    const row = this.db
      .update(actions)
      .set({ status, error, finishedAt: new Date(this.now()), logTruncated })
      .where(eq(actions.id, id))
      .returning()
      .get();
    this.announce(row);
    return row;
  }

  private announce(row: ActionRow): void {
    const entry = toActionEntry(row);
    this.publishEvent(row.id, { kind: "status", action: entry });
    this.safePublish(actionsTopic, entry);
  }

  private publishEvent(id: string, event: ActionStreamEvent): void {
    this.safePublish(actionTopic(id), event);
  }

  private safePublish(topic: string, payload: unknown): void {
    try {
      this.publisher.publish(topic, payload);
    } catch (error) {
      this.logger.warn({ err: error, topic }, "Could not publish an action event");
    }
  }

  private appendToClosedLog(id: string, line: string): void {
    try {
      appendFileSync(this.logPath(id), `${line}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger.warn({ err: error, actionId: id }, "Could not append to an action log");
    }
  }

  /** `id` is generated here and looked up in the database first: it never comes from a request. */
  private logPath(id: string): string {
    return join(this.actionsDir, `${id}.log`);
  }
}
