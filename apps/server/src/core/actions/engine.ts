import { appendFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActionEntry,
  type ActionOrigin,
  type ActionStatus,
  type ActionStreamEvent,
  actionsTopic,
  actionTopic,
  isDeploymentAction,
  resourceName,
} from "@opsifier/contract";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { type Db, isDatabaseFailure, type StorageHealth } from "../db";
import { actions } from "../db/schema";
import { conflict, notFound, serviceUnavailable } from "../errors";
import { LineRedactor, Redactor, redactLines } from "../tools/redact";
import { ActionLogFile, readLogTail } from "./log-file";
import { panelRefusal, serviceRefusal } from "./policy";
import { type ActionSource, currentSource, runAs } from "./source";

export type ActionRow = typeof actions.$inferSelect;

export const MAX_GLOBAL_CONCURRENCY = 4;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 2000;

/** How many of the newest Actions are kept, with their logs. */
export const RETAINED_ACTIONS = 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const RESTARTED_WHILE_RUNNING = "The panel restarted while this action was running.";
const RESTARTED_DURING_DEPLOYMENT =
  "The panel stopped before it could record how this deployment ended. Check the service, and deploy again if it isn't what you expect.";
const RESTARTED_WHILE_QUEUED = "The panel restarted before this action could start.";
const SHUT_DOWN = "The panel shut down while this action was running.";
const SHUT_DOWN_QUEUED = "The panel shut down before this action could start.";
const SIMULATED = "Simulated: this panel runs on its simulated Docker driver, so nothing here is real.";

export interface ActionContext {
  readonly id: string;
  /** Appends to the action's log and streams to anyone watching. Never throws. */
  log(line: string): void;
  /** Aborted when the action is cancelled. Pass it to everything that can block. */
  readonly signal: AbortSignal;
  /** Names the step under way, with a short key the interface has words for. */
  phase(name: string): void;
  /**
   * For the kinds of work that outlive this process: restarting the panel into another version, and a
   * script left running in its container when the panel shuts down. Once `run` returns, the row stays
   * `running` and nothing more can be queued, until the next start finds the row through
   * {@link ActionEngine.claimInterrupted} and concludes it.
   */
  handOver(): void;
}

export type ActionRun = (ctx: ActionContext) => void | Promise<void>;

export interface EnqueueInput {
  type: string;
  title: string;
  projectName?: string;
  serviceName?: string;
  actorEmail?: string;
  run: ActionRun;
  /**
   * Marks work that one more run of would change nothing about, like a deployment. A request that
   * finds such an Action of its own type still waiting on the same service gets that row back instead
   * of adding another. The waiting Action does the work of both, and `join` receives its `run` and
   * returns what it should run from now on, so that what this request asked for is not lost.
   */
  join?: (waiting: ActionRun) => ActionRun;
}

export type RecordInput = Omit<EnqueueInput, "run" | "join"> & {
  status?: "succeeded" | "failed";
  error?: string;
};

export interface ActionPublisher {
  publish(topic: string, payload: unknown): void;
}

/** What an Action's output has to hide, depending on what it is about. */
export type ActionRedaction = (scope: Pick<ActionRow, "projectName" | "serviceName">) => Redactor;

export interface ActionEngineOptions {
  db: Db;
  actionsDir: string;
  publisher: ActionPublisher;
  logger: Logger;
  /** Holds new work back while the panel cannot record it, and says when that has been fixed. */
  storage: StorageHealth;
  now?: () => number;
  maxGlobalConcurrency?: number;
  maxLogBytes?: number;
  maxReadBytes?: number;
  /** True on the simulated Docker driver: every log then says that none of it was real. */
  simulated?: boolean;
}

export interface ActionLogView {
  log: string;
  logTruncated: boolean;
  /** Stream events numbered up to this are already part of `log`. */
  logSeq: number;
}

/** How an Action ended, kept here while the database will not take it. */
interface HeldOutcome {
  status: ActionStatus;
  error: string | null;
  finishedAt: Date;
  logTruncated: boolean;
}

interface Job {
  id: string;
  type: string;
  title: string;
  /** `project/service`, or null for the bounded pool of service-less actions. */
  key: string | null;
  run: ActionRun;
  join: EnqueueInput["join"];
  /** How many later requests this one is also doing the work of. */
  joined: number;
  /** Who asked for it, which is who a nested Action is on behalf of too. */
  source: ActionSource;
  handedOver: boolean;
  controller: AbortController;
  log: ActionLogFile | null;
  done: Promise<void>;
  resolveDone: () => void;
}

/** Rows from before origins were recorded: a person if one was named, otherwise the panel. */
function originOf(row: ActionRow): ActionOrigin {
  return row.origin ?? (row.actorEmail === null ? "system" : "session");
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
    origin: originOf(row),
    originDetail: row.originDetail,
    hasLog: row.hasLog,
    phase: row.phase,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    error: row.error,
  };
}

function describeError(error: unknown, redactor: Redactor): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactor.apply(message || "The action failed.").slice(0, MAX_ERROR_CHARS);
}

function stamp(now: number, text: string): string {
  return `[${new Date(now).toISOString()}] ${text}`;
}

function describeHeldOutcome({ status, error }: HeldOutcome): string {
  const ended =
    status === "succeeded"
      ? "It finished without an error"
      : status === "cancelled"
        ? "It was cancelled"
        : `It ended with: ${error ?? "no details"}`;
  return `The panel could not record how this ended, because its storage is failing. ${ended}, but that is not saved yet and will be once storage is fixed.`;
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
  private readonly simulated: boolean;
  private readonly storage: StorageHealth;

  private readonly queue: Job[] = [];
  private readonly running = new Map<string, Job>();
  private readonly busyServices = new Set<string>();
  private globalRunning = 0;
  private stopping = false;
  /** Set once the panel has been told to replace itself: nothing can start any more. */
  private handedOver: Job | null = null;
  private retentionTimer: NodeJS.Timeout | undefined;
  private redaction: ActionRedaction | undefined;
  private readonly interruptedClaims: Array<(row: ActionRow) => boolean> = [];
  private readonly finishListeners = new Set<(row: ActionRow) => void>();
  /** Outcomes the database refused. The row still says `running`, so {@link current} is what is shown. */
  private readonly heldOutcomes = new Map<string, HeldOutcome>();

  constructor(options: ActionEngineOptions) {
    this.db = options.db;
    this.actionsDir = options.actionsDir;
    this.publisher = options.publisher;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxGlobalConcurrency = options.maxGlobalConcurrency ?? MAX_GLOBAL_CONCURRENCY;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.simulated = options.simulated ?? false;
    this.storage = options.storage;
    mkdirSync(this.actionsDir, { recursive: true, mode: 0o700 });
    this.storage.onRecovered(() => {
      this.recordHeldOutcomes();
      this.pump();
    });
  }

  /** Everything an Action writes passes through this, so that no feature can forget a secret. */
  redactWith(redaction: ActionRedaction): void {
    this.redaction = redaction;
  }

  /** A failure to work out what to hide is worth a log line, but never worth stopping the work. */
  private redactorFor(row: ActionRow): Redactor {
    try {
      return this.redaction?.(row) ?? new Redactor();
    } catch (error) {
      this.logger.warn({ err: error, actionId: row.id }, "Could not work out what an action has to hide");
      return new Redactor();
    }
  }

  /**
   * Call once at boot, before anything is enqueued. Whatever was in flight when the last
   * process died can never finish, because its closure died with it. A deployment caught running
   * has no recorded end: Docker may have finished it, so it is uncertain rather than failed.
   */
  recover(): number {
    const stranded = this.db
      .select()
      .from(actions)
      .where(inArray(actions.status, ["running", "queued"]))
      .all()
      .filter((row) => !this.interruptedClaims.some((claim) => claim(row)));

    for (const row of stranded) {
      const uncertain = row.status === "running" && isDeploymentAction(row.type);
      const reason = uncertain
        ? RESTARTED_DURING_DEPLOYMENT
        : row.status === "running"
          ? RESTARTED_WHILE_RUNNING
          : RESTARTED_WHILE_QUEUED;
      this.db
        .update(actions)
        .set({ status: uncertain ? "uncertain" : "failed", error: reason, finishedAt: new Date(this.now()) })
        .where(eq(actions.id, row.id))
        .run();
      if (row.hasLog) {
        this.appendToClosedLog(
          row.id,
          stamp(this.now(), `${uncertain ? "Outcome unknown" : "Failed"}: ${reason}`),
        );
      }
    }
    if (stranded.length > 0) {
      this.logger.warn({ count: stranded.length }, "Concluded the actions interrupted by the last restart");
    }
    return stranded.length;
  }

  /**
   * Leaves a row out of {@link recover}, for work that a feature concludes itself after a restart.
   * Whoever claims a row must conclude it: nothing else ever will.
   */
  claimInterrupted(claim: (row: ActionRow) => boolean): void {
    this.interruptedClaims.push(claim);
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

  /** Calls `listener` once for each Action that reaches a final status. Failures are logged and ignored. */
  onFinished(listener: (row: ActionRow) => void): () => void {
    this.finishListeners.add(listener);
    return () => this.finishListeners.delete(listener);
  }

  /** Stores the action and returns its row at once. The work starts on a later tick. */
  enqueue(input: EnqueueInput): ActionRow {
    if (this.stopping) {
      throw serviceUnavailable("shutting_down", "The panel is shutting down.");
    }
    this.storage.assertWritable();
    const key = this.queueKey(input);
    const joined = this.joinWaiting(key, input);
    if (joined !== null) {
      return joined;
    }
    this.assertAdmissible(key, input);
    const row = this.insert(input, "queued", null);
    const source = this.sourceOf(input);

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.queue.push({
      id: row.id,
      type: input.type,
      title: input.title,
      key,
      run: input.run,
      join: input.join,
      joined: 0,
      source,
      handedOver: false,
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
  conclude(
    id: string,
    outcome: { status: "succeeded" | "failed" | "cancelled" | "uncertain"; error?: string },
  ): ActionRow {
    return this.finish(id, outcome.status, outcome.error ?? null);
  }

  /** Corrects what an entry made with {@link record} says it is, once that is known for certain. */
  retitle(id: string, title: string): void {
    this.announce(this.db.update(actions).set({ title }).where(eq(actions.id, id)).returning().get());
  }

  /** Adds a line to the log of an Action that is no longer being written by this process. */
  note(id: string, line: string): void {
    this.appendToClosedLog(id, stamp(this.now(), line));
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
      // What a log was written with is not what it is read with: since then, a value may have become known.
      log: redactLines(this.redactorFor(row), tail.text),
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

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((job) => job.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    // A last chance. Anything left is read as uncertain at the next boot.
    this.recordHeldOutcomes();
  }

  /**
   * A row as it should be read. While its outcome is only held in memory the row still says it is
   * running, which is no longer true, and the outcome is not safe yet: that is what uncertain means.
   */
  current<Row extends Pick<ActionRow, "id" | "status">>(row: Row): Row {
    const held = this.heldOutcomes.get(row.id);
    return held === undefined
      ? row
      : { ...row, status: "uncertain", error: describeHeldOutcome(held), finishedAt: held.finishedAt };
  }

  /** True once {@link stop} has been called: what is running is being asked to stop because the panel is. */
  isStopping(): boolean {
    return this.stopping;
  }

  /** True when nothing is queued or running in this process. */
  isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0;
  }

  /** Housekeeping: a failure is worth a log line, but never worth stopping the panel. */
  private async pruneSafely(): Promise<void> {
    try {
      await this.prune();
    } catch (error) {
      this.logger.error({ err: error }, "Could not prune old actions");
    }
  }

  /** Everything on this service, or anywhere for `null`, that has not finished. */
  private active(key?: string | null): Job[] {
    const jobs = [...this.running.values(), ...this.queue];
    return key === undefined ? jobs : jobs.filter((job) => job.key === key);
  }

  /** Waiting work of the same kind already covers this request. Oldest first, so FIFO holds. */
  private joinWaiting(key: string | null, input: EnqueueInput): ActionRow | null {
    if (input.join === undefined || key === null) {
      return null;
    }
    const job = this.queue.find(
      (candidate) => candidate.key === key && candidate.type === input.type && candidate.join !== undefined,
    );
    if (job === undefined) {
      return null;
    }
    job.run = input.join(job.run);
    job.joined += 1;
    return this.db.select().from(actions).where(eq(actions.id, job.id)).get() ?? null;
  }

  /** Checked in the same tick as the insert: there is nothing to race with. */
  private assertAdmissible(key: string | null, input: EnqueueInput): void {
    if (this.handedOver !== null) {
      throw conflict("panel_restarting", "The panel is restarting. Try again once it is back.");
    }
    const refused =
      panelRefusal(input.type, this.active()) ??
      (key === null ? null : serviceRefusal(input.type, key, this.active(key)));
    if (refused !== null) {
      throw refused;
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

  /**
   * Who is asking, as the middleware saw it. Outside a request nothing is ambient: a socket session
   * names its person itself, and anything else is the panel's own work.
   */
  private sourceOf(input: Pick<EnqueueInput, "actorEmail">): ActionSource {
    const asked = currentSource();
    return {
      origin: asked?.origin ?? (input.actorEmail === undefined ? "system" : "session"),
      actorEmail: input.actorEmail ?? asked?.actorEmail,
      detail: asked?.detail,
    };
  }

  private insert(
    input: Omit<EnqueueInput, "run" | "join">,
    status: ActionStatus,
    error: string | null,
  ): ActionRow {
    if (input.type === "" || input.title === "") {
      throw new TypeError("An action needs a type and a title.");
    }
    const now = new Date(this.now());
    const finished = status !== "queued" && status !== "running";
    const source = this.sourceOf(input);
    return this.db
      .insert(actions)
      .values({
        id: nanoid(),
        type: input.type,
        title: input.title,
        status,
        projectName: input.projectName ?? null,
        serviceName: input.serviceName ?? null,
        actorEmail: source.actorEmail ?? null,
        origin: source.origin,
        originDetail: source.detail ?? null,
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
    // A job waits for as long as the panel could not record what it does.
    while (index < this.queue.length && !this.storage.isFailing()) {
      const job = this.queue[index];
      if (job === undefined || !this.canStart(job)) {
        index += 1;
        continue;
      }
      const row = this.markRunning(job);
      if (row !== null) {
        this.queue.splice(index, 1);
        this.start(job, row);
      }
    }
  }

  /** Null if that could not be written, in which case nothing has happened and the job stays queued. */
  private markRunning(job: Job): ActionRow | null {
    try {
      return this.db
        .update(actions)
        .set({ status: "running", startedAt: new Date(this.now()), hasLog: true })
        .where(eq(actions.id, job.id))
        .returning()
        .get();
    } catch (error) {
      if (!this.storage.report(error)) {
        // Waiting cannot fix this, so the job is given up on rather than left stuck in the queue.
        this.logger.error({ err: error, actionId: job.id }, "Action bookkeeping failed");
        this.queue.splice(this.queue.indexOf(job), 1);
        job.resolveDone();
        this.finish(job.id, "failed", describeError(error, new Redactor()));
      }
      return null;
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

  private start(job: Job, row: ActionRow): void {
    this.occupy(job);
    void this.execute(job, row)
      .catch((error: unknown) => {
        this.logger.error({ err: error, actionId: job.id }, "Action bookkeeping failed");
      })
      .finally(() => {
        this.release(job);
        this.pump();
      });
  }

  private async execute(job: Job, row: ActionRow): Promise<void> {
    this.announce(row);

    const log = new ActionLogFile(
      this.logPath(job.id),
      this.maxLogBytes,
      (seq, line) => this.publishEvent(job.id, { kind: "log", seq, line }),
      this.logger,
    );
    job.log = log;
    const redactor = this.redactorFor(row);
    const lines = new LineRedactor(redactor, (line: string) => log.write(line));
    log.write(stamp(this.now(), `Started: ${row.title}`));
    if (this.simulated) {
      log.write(stamp(this.now(), SIMULATED));
    }
    if (job.joined > 0) {
      log.write(stamp(this.now(), `Also covers ${job.joined} later request${job.joined === 1 ? "" : "s"}`));
    }

    const ctx: ActionContext = {
      id: job.id,
      signal: job.controller.signal,
      log: (line) => {
        // A late callback from a finished run must not reopen or corrupt the record.
        if (this.running.has(job.id)) {
          for (const part of String(line)
            .replace(/\r?\n$/, "")
            .split("\n")) {
            lines.write(part.endsWith("\r") ? part.slice(0, -1) : part, undefined);
          }
        }
      },
      phase: (name) => {
        if (this.running.has(job.id)) {
          this.announce(
            this.db.update(actions).set({ phase: name }).where(eq(actions.id, job.id)).returning().get(),
          );
        }
      },
      handOver: () => {
        job.handedOver = true;
        this.handedOver = job;
      },
    };

    let failure: string | null = null;
    let stateLost = false;
    try {
      await runAs(job.source, () => job.run(ctx));
    } catch (error) {
      failure = describeError(error, redactor);
      stateLost = isDatabaseFailure(error);
      this.storage.report(error);
    }
    lines.flush();

    if (job.handedOver && failure === null) {
      log.write(
        stamp(this.now(), "Handed over: the panel restarts now, and its next start reports the outcome"),
      );
      await log.close();
      return;
    }
    if (job.handedOver) {
      this.handedOver = null;
    }

    // An aborted run counts as cancelled however it ended: returning early is what a
    // well-behaved run does, and it did not get to finish its work.
    let status: ActionStatus = failure === null ? "succeeded" : "failed";
    if (stateLost) {
      // Whatever this changed outside the panel happened, and the panel could not note it down.
      status = "uncertain";
      failure = `The panel could not save its state while this was running (${failure}). How far it got is not known, so check what it was working on.`;
    } else if (job.controller.signal.aborted) {
      status = this.stopping ? "failed" : "cancelled";
      failure = this.stopping ? SHUT_DOWN : null;
    }

    const outcome =
      status === "succeeded"
        ? "Succeeded"
        : status === "cancelled"
          ? "Cancelled"
          : status === "uncertain"
            ? `Outcome unknown: ${failure}`
            : `Failed: ${failure}`;
    log.write(stamp(this.now(), outcome));
    await log.close();

    this.finish(job.id, status, failure, log.isTruncated);
  }

  /**
   * Records how an Action ended. If the database refuses, the outcome is kept in memory and is written
   * as soon as storage is fixed: until then the Action reads as uncertain, and if the panel dies
   * first, `recover` finds it still running.
   */
  private finish(id: string, status: ActionStatus, error: string | null, logTruncated = false): ActionRow {
    const outcome: HeldOutcome = { status, error, finishedAt: new Date(this.now()), logTruncated };
    try {
      return this.recordOutcome(id, outcome);
    } catch (failure) {
      if (!this.storage.report(failure)) {
        throw failure;
      }
      this.logger.error({ err: failure, actionId: id }, "Could not record how an action ended");
      this.heldOutcomes.set(id, outcome);
      const row = this.current(this.db.select().from(actions).where(eq(actions.id, id)).get() as ActionRow);
      this.announce(row);
      return row;
    }
  }

  private recordOutcome(id: string, outcome: HeldOutcome): ActionRow {
    const row = this.db.update(actions).set(outcome).where(eq(actions.id, id)).returning().get();
    this.announce(row);
    for (const listener of this.finishListeners) {
      try {
        listener(row);
      } catch (error) {
        this.logger.warn({ err: error, actionId: id }, "An action listener failed");
      }
    }
    return row;
  }

  private recordHeldOutcomes(): void {
    for (const [id, outcome] of this.heldOutcomes) {
      try {
        this.recordOutcome(id, outcome);
      } catch (failure) {
        if (!this.storage.report(failure)) {
          this.logger.error({ err: failure, actionId: id }, "Could not record how an action ended");
        }
        return;
      }
      this.heldOutcomes.delete(id);
      this.appendToClosedLog(id, stamp(this.now(), "Storage is working again: this outcome is now recorded"));
    }
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
