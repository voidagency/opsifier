import { setTimeout as sleep } from "node:timers/promises";
import {
  deployActionType,
  MAX_SCRIPT_OUTPUT_CHARS,
  type ScriptRun,
  type ScriptRunNoteCode,
  type ScriptRunOrigin,
  type ScriptRunStatus,
  type ScriptSpec,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type ActionContext, type ActionRow, currentSource, runAs } from "../../../core/actions";
import type { AppDeps } from "../../../core/context";
import { actions } from "../../../core/db/schema";
import type { ExecSession, ExecState, TaskInfo } from "../../../core/docker";
import { DockerLogParser } from "../../../core/docker/log-parser";
import { conflict, notFound } from "../../../core/errors";
import { listServiceScripts } from "../../service-runtime/repo";
import { qualifiedName } from "../../services/compile";
import type { ServiceTarget } from "../../services/service";
import {
  activeRunOf,
  findRun,
  findRunById,
  insertRun,
  listRunsInStatus,
  pruneRuns,
  type ScriptRunRow,
  updateRun,
} from "./repo";

export const SCRIPT_ACTION_TYPE = "service.script";

/** How often what a run has printed is written down, so a dead panel keeps almost all of it. */
const OUTPUT_FLUSH_MS = 2000;
/** How often a process the panel can no longer read is asked after. */
const POLL_MS = 1000;
/** Docker reports a process gone within moments of its end. Past this it did not end, or Docker isn't saying. */
const END_CONFIRMATION_MS = 10_000;

/** Why a run is the way it is. The interface says it again in its own language from the code. */
interface Note {
  code: ScriptRunNoteCode;
  message: string;
}

const note = (code: ScriptRunNoteCode, message: string): Note => ({ code, message });
const NOT_STARTED = note("not_started", "The panel restarted before this run could start.");
const NO_RUNNING_TASK = note("no_running_task", "The service had no running task to run this script in.");
const SCRIPT_DELETED = note("script_deleted", "This script was deleted before the run could start.");
const CONNECTION_LOST = note(
  "connection_lost",
  "The panel lost its connection to this process. Output after that moment was not captured.",
);
const SKIPPED_OVERLAP = note(
  "skipped_overlap",
  "Not started: the previous run of this script was still in progress.",
);
const PANEL_RESTARTED_RUNNING = note(
  "panel_restarted_running",
  "The panel restarted during this run. The process is still running: output since the restart is not being captured.",
);
const PANEL_RESTARTED_FINISHED = note(
  "panel_restarted_finished",
  "The panel restarted during this run. It ended while the panel was not watching, with the exit code Docker reported. Output after the restart was not captured.",
);
const PANEL_RESTARTED_UNKNOWN = note(
  "panel_restarted_unknown",
  "The panel restarted during this run and Docker no longer knows this process. How it ended is not known, and output after the restart was not captured.",
);
const PANEL_RESTARTED_STARTING = note(
  "panel_restarted",
  "The panel restarted as this run was starting. Anything that had started was ended, and what it did is not known.",
);
const CONSOLE_OUTPUT = note(
  "console_output",
  "Run from the console: its output went to the terminal and was not kept.",
);
const CONSOLE_CLOSED = note(
  "console_closed",
  "Run from the console: the session was closed while it was running.",
);

const timeLimitNote = (seconds: number) =>
  note("time_limit", `It was still running at its limit of ${seconds} seconds, so the panel ended it.`);
const unconfirmedEnd = note(
  "end_unconfirmed",
  "The panel told this process to end, but could not confirm that it did.",
);

/** A run as the API shows it. */
export function toScriptRun(row: ScriptRunRow): ScriptRun {
  return {
    id: row.id,
    scriptName: row.scriptName,
    status: row.status,
    origin: row.origin,
    actorEmail: row.actorEmail,
    originDetail: row.originDetail,
    exitCode: row.exitCode,
    task: row.taskId === null ? null : { id: row.taskId, slot: row.taskSlot },
    maxDurationSeconds: row.maxDurationSeconds,
    dueAt: row.dueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    note: row.noteCode === null ? null : { code: row.noteCode as ScriptRunNoteCode, message: row.note ?? "" },
    outputComplete: row.outputComplete,
    outputTruncated: row.outputTruncated,
  };
}

const targetOf = (run: ScriptRunRow): ServiceTarget => ({
  projectName: run.projectName,
  serviceName: run.serviceName,
});

/** What this process is reading right now. A `running` row outside it was left by an earlier one. */
const watching = new WeakMap<AppDeps, Set<string>>();

function watchedRuns(deps: AppDeps): Set<string> {
  let runs = watching.get(deps);
  if (runs === undefined) {
    runs = new Set();
    watching.set(deps, runs);
  }
  return runs;
}

interface Outcome {
  status: Exclude<ScriptRunStatus, "queued" | "running" | "skipped">;
  exitCode: number | null;
  note?: Note;
}

function outcomeOfExit(exitCode: number | null, unknown: Note): Outcome {
  if (exitCode === null) {
    return { status: "unknown", exitCode: null, note: unknown };
  }
  return { status: exitCode === 0 ? "succeeded" : "failed", exitCode };
}

/** Writes how a run ended. A failure of the bookkeeping itself must not take the panel down with it. */
function writeOutcome(
  deps: AppDeps,
  run: ScriptRunRow,
  outcome: Outcome,
  output: { output?: string; outputTruncated?: boolean; outputComplete?: boolean } = {},
): void {
  try {
    updateRun(deps.db, run.id, {
      status: outcome.status,
      exitCode: outcome.exitCode,
      noteCode: outcome.note?.code ?? null,
      note: outcome.note?.message ?? null,
      finishedAt: new Date(deps.now()),
      ...output,
    });
    pruneRuns(deps.db, targetOf(run), run.scriptName);
  } catch (error) {
    deps.logger.warn({ err: error, run: run.id }, "Could not record how a script run ended");
  } finally {
    watchedRuns(deps).delete(run.id);
  }
}

/** Keeps the end of what a run printed and no more, whatever it prints. */
class OutputTail {
  private text = "";
  private cut = false;

  add(line: string): void {
    this.text += `${line}\n`;
    if (this.text.length > 2 * MAX_SCRIPT_OUTPUT_CHARS) {
      this.trim();
    }
  }

  private trim(): void {
    const excess = this.text.length - MAX_SCRIPT_OUTPUT_CHARS;
    if (excess <= 0) {
      return;
    }
    // Starting from the next whole line, unless the excess is one enormous line.
    const nextLine = this.text.indexOf("\n", excess);
    this.text = this.text.slice(nextLine === -1 ? excess : nextLine + 1);
    this.cut = true;
  }

  value(): { output: string; outputTruncated: boolean } {
    this.trim();
    return { output: this.text, outputTruncated: this.cut };
  }
}

async function firstRunningTask(deps: AppDeps, service: string): Promise<TaskInfo | undefined> {
  const tasks = await deps.docker.listTasks({ service });
  return tasks
    .filter((task) => task.state === "running" && task.desiredState === "running")
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0];
}

type Interruption = "limit" | "cancel" | "shutdown";

/**
 * Resolves when the run's time is up or someone wants it stopped, or after `pollMs` when given. `clear`
 * must be called once it is no longer waited for, so nothing lingers until the limit that never came.
 */
function interruption(
  deps: AppDeps,
  signal: AbortSignal,
  limitAt: number,
  pollMs?: number,
): { reached: Promise<Interruption | "poll">; clear: () => void } {
  let clear = () => {};
  const reached = new Promise<Interruption | "poll">((resolve) => {
    const interrupted = () => {
      clearTimeout(timer);
      resolve(deps.actions.isStopping() ? "shutdown" : "cancel");
    };
    const remaining = Math.max(0, limitAt - deps.now());
    const timer = setTimeout(
      () => resolve(pollMs !== undefined && pollMs < remaining ? "poll" : "limit"),
      pollMs === undefined ? remaining : Math.min(pollMs, remaining),
    );
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", interrupted);
    };
    if (signal.aborted) {
      interrupted();
    } else {
      signal.addEventListener("abort", interrupted, { once: true });
    }
  });
  return { reached, clear };
}

/** What Docker says about the process. When it can't be reached, the run is treated as still going. */
async function askDocker(deps: AppDeps, execId: string | undefined): Promise<ExecState | null> {
  if (execId === undefined) {
    return null;
  }
  try {
    return await deps.docker.inspectExec(execId);
  } catch (error) {
    deps.logger.debug({ err: error }, "Docker could not say how a script run is doing");
    return { running: true, exitCode: null };
  }
}

/** Ends the process, and only then reports it ended: telling it to is not the same as it having. */
async function endProcess(
  deps: AppDeps,
  run: ScriptRunRow,
  session: ExecSession,
): Promise<{ ended: boolean; exitCode: number | null }> {
  try {
    await (session.terminate?.() ??
      deps.docker.terminateExec({
        service: qualifiedName(run.projectName, run.serviceName),
        taskId: run.taskId ?? undefined,
        marker: run.id,
      }));
  } catch (error) {
    deps.logger.debug({ err: error, run: run.id }, "Could not end a script run");
  }
  return confirmEnded(deps, session.id ?? null);
}

async function confirmEnded(
  deps: AppDeps,
  execId: string | null,
): Promise<{ ended: boolean; exitCode: number | null }> {
  if (execId === null) {
    return { ended: false, exitCode: null };
  }
  const giveUpAt = deps.now() + END_CONFIRMATION_MS;
  for (;;) {
    const state = await askDocker(deps, execId);
    if (state === null) {
      return { ended: true, exitCode: null };
    }
    if (!state.running) {
      return { ended: true, exitCode: state.exitCode };
    }
    if (deps.now() >= giveUpAt) {
      return { ended: false, exitCode: null };
    }
    await sleep(100);
  }
}

/** The work of a run's Action. Its row exists by now, and the Action's id is the run's. */
async function performRun(deps: AppDeps, ctx: ActionContext): Promise<void> {
  const run = findRunById(deps.db, ctx.id);
  if (run === undefined) {
    throw new Error("This run no longer exists.");
  }

  const fail = (outcome: Outcome, reason = outcome.note?.message ?? "The run failed."): never => {
    writeOutcome(deps, run, outcome);
    ctx.log(reason);
    throw new Error(reason);
  };

  /** Docker's own words, for the record, with the sentence around them left to whoever shows it. */
  const failToStart = (error: unknown): never => {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      { status: "failed", exitCode: null, note: note("start_failed", detail) },
      `Docker could not start this script: ${detail}`,
    );
  };

  const script = listServiceScripts(deps.db, targetOf(run)).find(({ name }) => name === run.scriptName);
  if (script === undefined) {
    fail({ status: "failed", exitCode: null, note: SCRIPT_DELETED });
    return;
  }
  const service = qualifiedName(run.projectName, run.serviceName);
  let task: TaskInfo | undefined;
  try {
    task = await firstRunningTask(deps, service);
  } catch (error) {
    failToStart(error);
    return;
  }
  if (ctx.signal.aborted) {
    writeOutcome(deps, run, { status: "cancelled", exitCode: null });
    return;
  }
  if (task === undefined) {
    fail({ status: "failed", exitCode: null, note: NO_RUNNING_TASK });
    return;
  }

  const startedAt = deps.now();
  const limitAt = startedAt + script.maxDurationSeconds * 1000;
  // Written before the process exists: from here on a dead panel leaves the next one a way to find it.
  updateRun(deps.db, run.id, {
    status: "running",
    startedAt: new Date(startedAt),
    taskId: task.id,
    taskSlot: task.slot,
    maxDurationSeconds: script.maxDurationSeconds,
  });
  watchedRuns(deps).add(run.id);
  ctx.log(`Task: ${task.id}`);

  let session: ExecSession;
  try {
    session = await deps.docker.execAttach({
      service,
      taskId: task.id,
      marker: run.id,
      command: ["/bin/sh", "-c", script.script],
      tty: false,
    });
  } catch (error) {
    // Whatever failed may have started something: the marker reaches it either way.
    await deps.docker.terminateExec({ service, taskId: task.id, marker: run.id }).catch(() => {});
    failToStart(error);
    return;
  }
  // Second half of the record: Docker's own id for the process, for asking about it later.
  updateRun(deps.db, run.id, { execId: session.id ?? null });

  const tail = new OutputTail();
  const parser = new DockerLogParser();
  let outputComplete = true;
  const onOutput = (chunk: Buffer) => {
    for (const { line } of parser.push(Buffer.from(chunk))) {
      tail.add(line);
      ctx.log(line);
    }
  };
  session.stream.on("data", onOutput);
  session.stream.on("error", (error: Error) => {
    deps.logger.debug({ err: error, run: run.id }, "Script run stream error");
  });
  // Closes the write side only: anything reading its input sees the end of it, and output keeps coming.
  session.stream.end();

  const flush = () => {
    try {
      updateRun(deps.db, run.id, tail.value());
    } catch (error) {
      deps.logger.debug({ err: error, run: run.id }, "Could not store a script run's output");
    }
  };
  const flusher = setInterval(flush, OUTPUT_FLUSH_MS);
  flusher.unref();

  const finishWith = (outcome: Outcome): void => {
    clearInterval(flusher);
    for (const { line } of parser.flush()) {
      tail.add(line);
      ctx.log(line);
    }
    writeOutcome(deps, run, outcome, { ...tail.value(), outputComplete });
  };

  try {
    const closed = new Promise<"closed">((resolve) => session.stream.once("close", () => resolve("closed")));
    const first = interruption(deps, ctx.signal, limitAt);
    let event: Interruption | "poll" | "closed" = await Promise.race([closed, first.reached]);
    first.clear();

    // The stream ending only says the connection did. Docker says what became of the process.
    while (event === "closed" || event === "poll") {
      const state = await askDocker(deps, session.id);
      if (state === null) {
        finishWith(outcomeOfExit(null, CONNECTION_LOST));
        ctx.log(CONNECTION_LOST.message);
        throw new Error(CONNECTION_LOST.message);
      }
      if (!state.running) {
        const exited = outcomeOfExit(state.exitCode, CONNECTION_LOST);
        const outcome = outputComplete ? exited : { ...exited, note: exited.note ?? CONNECTION_LOST };
        finishWith(outcome);
        if (outcome.status === "unknown") {
          ctx.log(CONNECTION_LOST.message);
          throw new Error(CONNECTION_LOST.message);
        }
        if (outcome.status === "failed") {
          throw new Error(`Exited with code ${outcome.exitCode}.`);
        }
        return;
      }
      if (outputComplete) {
        // Still running with nothing left to read: from here on the output is out of the panel's reach.
        outputComplete = false;
        flush();
        updateRun(deps.db, run.id, {
          outputComplete: false,
          noteCode: CONNECTION_LOST.code,
          note: CONNECTION_LOST.message,
        });
        ctx.log(CONNECTION_LOST.message);
      }
      const next = interruption(deps, ctx.signal, limitAt, POLL_MS);
      event = await next.reached;
      next.clear();
    }

    if (event === "shutdown") {
      // Left running: the next start finds it through its marker and the id Docker gave it.
      clearInterval(flusher);
      flush();
      ctx.handOver();
      return;
    }

    const { ended, exitCode } = await endProcess(deps, run, session);
    const reason = event === "limit" ? timeLimitNote(script.maxDurationSeconds) : undefined;
    const outcome: Outcome = {
      status: event === "limit" ? "timed_out" : "cancelled",
      exitCode,
      note: ended ? (reason ?? (outputComplete ? undefined : CONNECTION_LOST)) : unconfirmedEnd,
    };
    finishWith(outcome);
    if (event === "limit") {
      ctx.log(reason?.message ?? "");
      throw new Error(reason?.message);
    }
    if (!ended) {
      ctx.log(unconfirmedEnd.message);
    }
  } finally {
    clearInterval(flusher);
    session.stream.off("data", onOutput);
  }
}

export interface RunSource {
  origin: ScriptRunOrigin;
  actorEmail?: string;
  originDetail?: string;
  /** The occurrence of the schedule this run is for. */
  dueAt?: number;
}

/** Starts one run. Whatever calls this has already looked at overlap, in this same tick. */
function enqueueRun(
  deps: AppDeps,
  target: ServiceTarget,
  script: ScriptSpec,
  source: RunSource,
): { action: ActionRow; run: ScriptRunRow } {
  const action = deps.actions.enqueue({
    type: SCRIPT_ACTION_TYPE,
    title: `Run ${script.name} on ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail: source.actorEmail,
    run: (ctx) => performRun(deps, ctx),
  });
  const run = insertRun(deps.db, {
    id: action.id,
    ...target,
    scriptName: script.name,
    origin: source.origin,
    actorEmail: source.actorEmail ?? null,
    originDetail: source.originDetail ?? null,
    status: "queued",
    maxDurationSeconds: script.maxDurationSeconds,
    dueAt: source.dueAt === undefined ? null : new Date(source.dueAt),
    createdAt: new Date(deps.now()),
  });
  return { action, run };
}

const lookUpScript = (deps: AppDeps, target: ServiceTarget, name: string): ScriptSpec | undefined =>
  listServiceScripts(deps.db, target).find((script) => script.name === name);

/** A person or an API key asking for a run. Refused while one is already in progress, on any panel. */
export function startRun(
  deps: AppDeps,
  target: ServiceTarget,
  scriptName: string,
): { action: ActionRow; run: ScriptRunRow } {
  const script = lookUpScript(deps, target, scriptName);
  if (script === undefined) {
    throw notFound("This script does not exist.");
  }
  if (activeRunOf(deps.db, target, script.name) !== undefined) {
    throw conflict(
      "script_already_running",
      `"${script.name}" is already running. Wait for it to finish or cancel it, then try again.`,
    );
  }
  const source = currentSource();
  return enqueueRun(deps, target, script, {
    origin: source?.origin === "api_key" ? "api" : "manual",
    actorEmail: source?.actorEmail,
    originDetail: source?.detail,
  });
}

/** A due time that was not started, recorded so that it did not simply fail to happen. */
function recordSkip(
  deps: AppDeps,
  target: ServiceTarget,
  script: ScriptSpec,
  source: RunSource,
  reason: Note,
): void {
  const now = new Date(deps.now());
  insertRun(deps.db, {
    id: nanoid(),
    ...target,
    scriptName: script.name,
    origin: source.origin,
    actorEmail: source.actorEmail ?? null,
    status: "skipped",
    maxDurationSeconds: script.maxDurationSeconds,
    noteCode: reason.code,
    note: reason.message,
    dueAt: source.dueAt === undefined ? null : new Date(source.dueAt),
    createdAt: now,
    finishedAt: now,
    outputComplete: true,
  });
  pruneRuns(deps.db, target, script.name);
}

/**
 * A schedule or a hook asking for a run. The policy on an overlap is to skip: nothing starts, and the
 * skip goes on record, so a due time that finds the script still running never starts a second job.
 * It holds across a restart because it reads rows: a run left over from an earlier panel is still one.
 */
export function startAutomaticRun(
  deps: AppDeps,
  target: ServiceTarget,
  script: ScriptSpec,
  source: RunSource,
): boolean {
  if (activeRunOf(deps.db, target, script.name) !== undefined) {
    recordSkip(deps, target, script, source, SKIPPED_OVERLAP);
    return false;
  }
  try {
    enqueueRun(deps, target, script, source);
    return true;
  } catch (error) {
    // The service is being deleted, the panel is updating itself: the reason belongs in the history.
    const reason = error instanceof Error ? error.message : String(error);
    recordSkip(deps, target, script, source, note("skipped_refused", reason));
    deps.logger.warn({ err: error, script: script.name }, "A scheduled script could not start");
    return false;
  }
}

/** Runs the scripts of a service marked to follow its deployments, once one has succeeded. */
export function runDeployHooks(deps: AppDeps, deployment: ActionRow): void {
  if (
    deployment.type !== deployActionType ||
    deployment.status !== "succeeded" ||
    deployment.projectName === null ||
    deployment.serviceName === null
  ) {
    return;
  }
  const target = { projectName: deployment.projectName, serviceName: deployment.serviceName };
  const source: RunSource = { origin: "hook", actorEmail: deployment.actorEmail ?? undefined };
  for (const script of listServiceScripts(deps.db, target)) {
    if (script.runAfterDeploy) {
      // Keeps the deployment's account on the Action too, which no request is around to name.
      runAs({ origin: "system", actorEmail: source.actorEmail, detail: "After a deployment" }, () =>
        startAutomaticRun(deps, target, script, source),
      );
    }
  }
}

/** Keeps a run's row in step with an Action that ended without its `run` ever being called. */
export function concludeUnstartedRun(deps: AppDeps, action: ActionRow): void {
  if (action.type !== SCRIPT_ACTION_TYPE) {
    return;
  }
  const run = findRunById(deps.db, action.id);
  if (run?.status === "queued") {
    writeOutcome(deps, run, {
      status: action.status === "cancelled" ? "cancelled" : "failed",
      exitCode: null,
      note: action.status === "cancelled" ? undefined : NOT_STARTED,
    });
  }
}

/** Ends a run left by an earlier panel, once it is confirmed gone. */
async function endLeftover(
  deps: AppDeps,
  run: ScriptRunRow,
  outcomeOf: (result: { ended: boolean; exitCode: number | null }) => Outcome,
): Promise<ScriptRunRow> {
  await deps.docker.terminateExec({
    service: qualifiedName(run.projectName, run.serviceName),
    taskId: run.taskId ?? undefined,
    marker: run.id,
  });
  const result = await confirmEnded(deps, run.execId);
  const outcome = outcomeOf(result);
  writeOutcome(deps, run, outcome, { outputComplete: false });
  concludeAction(deps, run, outcome);
  return findRunById(deps.db, run.id) ?? run;
}

/** What the Activity log says about a run that ended like this. */
function actionStatusOf(status: ScriptRunStatus): "succeeded" | "failed" | "cancelled" | "uncertain" {
  if (status === "succeeded" || status === "cancelled") {
    return status;
  }
  return status === "unknown" ? "uncertain" : "failed";
}

function concludeAction(deps: AppDeps, run: ScriptRunRow, outcome: Outcome): void {
  const action = deps.db.select({ status: actions.status }).from(actions).where(eq(actions.id, run.id)).get();
  if (action?.status !== "running") {
    return;
  }
  const failed = outcome.status !== "succeeded" && outcome.status !== "cancelled";
  deps.actions.note(run.id, outcome.note?.message ?? `Finished: ${outcome.status}`);
  deps.actions.conclude(run.id, {
    status: actionStatusOf(outcome.status),
    error: failed ? (outcome.note?.message ?? `Exited with code ${outcome.exitCode}.`) : undefined,
  });
}

/** One run left by an earlier panel, or whose watcher lost it. Docker failing leaves it for the next pass. */
async function settleLeftover(deps: AppDeps, run: ScriptRunRow): Promise<void> {
  const limitAt = (run.startedAt?.getTime() ?? run.createdAt.getTime()) + run.maxDurationSeconds * 1000;
  const state = run.execId === null ? null : await deps.docker.inspectExec(run.execId);

  if (state?.running) {
    if (deps.now() >= limitAt) {
      await endLeftover(deps, run, ({ ended, exitCode }) => ({
        status: "timed_out",
        exitCode,
        note: ended ? timeLimitNote(run.maxDurationSeconds) : unconfirmedEnd,
      }));
    } else if (run.noteCode !== PANEL_RESTARTED_RUNNING.code) {
      updateRun(deps.db, run.id, {
        noteCode: PANEL_RESTARTED_RUNNING.code,
        note: PANEL_RESTARTED_RUNNING.message,
        outputComplete: false,
      });
    }
    return;
  }

  // Whatever Docker cannot tell apart anymore is ended, so nothing keeps running unwatched.
  if (state === null) {
    await deps.docker.terminateExec({
      service: qualifiedName(run.projectName, run.serviceName),
      taskId: run.taskId ?? undefined,
      marker: run.id,
    });
  }
  const unknownNote = run.execId === null ? PANEL_RESTARTED_STARTING : PANEL_RESTARTED_UNKNOWN;
  const outcome = settleOutcome(run, state, unknownNote);
  writeOutcome(deps, run, outcome, { outputComplete: false });
  concludeAction(deps, run, outcome);
}

function settleOutcome(run: ScriptRunRow, state: ExecState | null, unknownNote: Note): Outcome {
  if (run.origin === "console") {
    return { status: "cancelled", exitCode: state?.exitCode ?? null, note: CONSOLE_CLOSED };
  }
  if (state === null) {
    return { status: "unknown", exitCode: null, note: unknownNote };
  }
  const outcome = outcomeOfExit(state.exitCode, unknownNote);
  return outcome.status === "unknown" ? outcome : { ...outcome, note: PANEL_RESTARTED_FINISHED };
}

const settling = new WeakSet<AppDeps>();

/**
 * What the panel knows about every run it is not watching: left behind by an earlier process, nobody's
 * stream to read. Runs on every pass of the scheduler, so it is both the first look after a restart and
 * the way a process left running is still held to its limit and still ends up with an exit code.
 */
export async function settleLeftoverRuns(deps: AppDeps): Promise<void> {
  if (settling.has(deps)) {
    return;
  }
  settling.add(deps);
  try {
    const left = listRunsInStatus(deps.db, "running").filter((run) => !watchedRuns(deps).has(run.id));
    for (const run of left) {
      await settleLeftover(deps, run).catch((error: unknown) => {
        deps.logger.debug({ err: error, run: run.id }, "Could not settle a script run yet");
      });
    }
  } finally {
    settling.delete(deps);
  }
}

/**
 * Runs for `recover` to leave alone at boot. A `running` Action has a run row saying what became of it,
 * and only this feature can still find that out. Queued ones never started, and `recover` is right.
 */
export function claimRunActions(deps: AppDeps): void {
  deps.actions.claimInterrupted((row) => row.type === SCRIPT_ACTION_TYPE && row.status === "running");
}

/** At boot, once `recover` has run: runs that never started, then what the last panel left running. */
export async function settleAfterRestart(deps: AppDeps): Promise<void> {
  for (const run of listRunsInStatus(deps.db, "queued")) {
    writeOutcome(deps, run, { status: "failed", exitCode: null, note: NOT_STARTED });
  }
  await settleLeftoverRuns(deps);
  // A row can end up concluded here and its Action still running if the panel died between the two.
  for (const action of deps.db.select().from(actions).where(eq(actions.status, "running")).all()) {
    if (action.type === SCRIPT_ACTION_TYPE) {
      const run = findRunById(deps.db, action.id);
      if (run === undefined || run.status !== "running") {
        deps.actions.conclude(action.id, {
          status: run === undefined ? "failed" : actionStatusOf(run.status),
          error: run?.note ?? undefined,
        });
      }
    }
  }
}

/** Stops a run where it stands, whoever started it and however it is being watched. */
export async function cancelRun(deps: AppDeps, target: ServiceTarget, id: string): Promise<ScriptRunRow> {
  const run = findRun(deps.db, target, id);
  if (run === undefined) {
    throw notFound("This run does not exist.");
  }
  if (run.origin === "console" && run.status === "running") {
    throw conflict("script_run_in_console", "This run is in a console session. Close the session to end it.");
  }
  if (run.status === "queued" || (run.status === "running" && watchedRuns(deps).has(run.id))) {
    deps.actions.cancel(run.id);
    return findRunById(deps.db, run.id) ?? run;
  }
  if (run.status === "running") {
    return endLeftover(deps, run, ({ ended, exitCode }) => ({
      status: "cancelled",
      exitCode,
      note: ended ? undefined : unconfirmedEnd,
    }));
  }
  throw conflict("script_run_finished", "This run has already finished.");
}

/** Goes on record before a console session of a saved script starts. */
export function beginConsoleRun(
  deps: AppDeps,
  target: ServiceTarget,
  values: {
    id: string;
    script: ScriptSpec;
    actorEmail: string;
    taskId: string;
  },
): void {
  const now = new Date(deps.now());
  insertRun(deps.db, {
    id: values.id,
    ...target,
    scriptName: values.script.name,
    origin: "console",
    actorEmail: values.actorEmail,
    status: "running",
    taskId: values.taskId,
    maxDurationSeconds: values.script.maxDurationSeconds,
    noteCode: CONSOLE_OUTPUT.code,
    note: CONSOLE_OUTPUT.message,
    outputComplete: false,
    createdAt: now,
    startedAt: now,
  });
  watchedRuns(deps).add(values.id);
}

export function attachConsoleRunExec(deps: AppDeps, id: string, execId: string | undefined): void {
  try {
    updateRun(deps.db, id, { execId: execId ?? null });
  } catch (error) {
    // A console can outlive the database by a moment at shutdown, and the run is on record already.
    deps.logger.debug({ err: error, run: id }, "Could not note a console run's process");
  }
}

export type ConsoleRunEnd =
  | { kind: "exited"; exitCode: number | null }
  | { kind: "time-limit"; exitCode: number | null; maxDurationSeconds: number }
  | { kind: "closed"; exitCode: number | null };

/** The console session of a saved script is over. Its output was a terminal's and is not stored. */
export function endConsoleRun(deps: AppDeps, id: string, end: ConsoleRunEnd): void {
  let run: ScriptRunRow | undefined;
  try {
    run = findRunById(deps.db, id);
  } catch (error) {
    // During shutdown the database may already be closed. The next boot finds the run and says so.
    deps.logger.debug({ err: error, run: id }, "Could not end a console run");
    return;
  }
  if (run?.status !== "running") {
    return;
  }
  let outcome: Outcome;
  if (end.kind === "time-limit") {
    outcome = { status: "timed_out", exitCode: end.exitCode, note: timeLimitNote(end.maxDurationSeconds) };
  } else if (end.kind === "closed") {
    outcome = { status: "cancelled", exitCode: end.exitCode, note: CONSOLE_CLOSED };
  } else {
    const ended = outcomeOfExit(end.exitCode, CONSOLE_OUTPUT);
    outcome = { ...ended, note: ended.note ?? CONSOLE_OUTPUT };
  }
  writeOutcome(deps, run, outcome);
}

export const hasActiveRun = (deps: AppDeps, target: ServiceTarget, scriptName: string): boolean =>
  activeRunOf(deps.db, target, scriptName) !== undefined;
