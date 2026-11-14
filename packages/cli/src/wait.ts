import { ClientError } from "@opsifier/client";
import type { ActionDetail, ActionEntry } from "@opsifier/contract";
import type { CommandContext, CommandResult } from "./shared";

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const FINISHED = new Set<ActionEntry["status"]>(["succeeded", "failed", "cancelled", "uncertain"]);

/** Often enough that output feels live, rarely enough that a long build costs little. */
const WAIT_POLL_MS = 1_000;

/** `34s`, `2m 05s`, `1h 03m`: how long an action ran. */
export function durationText(from: string | null, to: string | null): string {
  if (from === null || to === null) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  const two = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`;
}

/** How much of a new tail's start is looked for in what was shown, to find where they overlap. */
const HEAD_CHARS = 64;
/** Places tried before giving up: output made of one line repeated could match almost anywhere. */
const MAX_CANDIDATES = 50;

/**
 * Prints what was written since the last look. Past a size, the panel returns only the tail of an
 * output, a window that moves on as it grows: the place where the new window starts inside what was
 * shown is found, and only what follows the overlap is printed. A gap is marked when the window has
 * moved past all of it.
 */
export function showNewOutput(context: CommandContext, shown: string, log: string): string {
  if (log === shown) {
    return shown;
  }
  if (log.startsWith(shown)) {
    context.write(log.slice(shown.length));
    return log;
  }
  const head = log.slice(0, HEAD_CHARS);
  let from = head === "" ? -1 : shown.indexOf(head);
  for (let tries = 0; from !== -1 && tries < MAX_CANDIDATES; tries += 1) {
    if (log.startsWith(shown.slice(from))) {
      context.write(log.slice(shown.length - from));
      return log;
    }
    from = shown.indexOf(head, from + 1);
  }
  context.write(`${shown === "" || shown.endsWith("\n") ? "" : "\n"}${context.styles.dim("[…]")}\n${log}`);
  return log;
}

/** How long the panel may stay out of reach before waiting for it gives up. */
const OUT_OF_REACH_MS = 5 * 60_000;

/** Worth asking again: the panel could not be reached, or failed on its side. */
const passing = (error: unknown) =>
  error instanceof ClientError &&
  ((error.status === undefined && (error.code === "unreachable" || error.code === "timeout")) ||
    (error.status !== undefined && error.status >= 500));

/**
 * Asks every second until `finished` says so, handing each answer to `seen`. A panel out of reach or
 * failing on its side is asked again for five minutes, then the command ends with exit code 7; any
 * other refusal ends it at once. Interrupting stops the waiting only: the work goes on at the panel.
 */
export async function pollUntil<T>(
  context: CommandContext,
  action: string,
  read: (signal: AbortSignal) => Promise<T>,
  finished: (value: T) => boolean,
  seen: (value: T) => void,
): Promise<T> {
  const { t } = context;
  let failingSince: number | undefined;
  for (;;) {
    if (context.signal.aborted) {
      throw new ClientError("cancelled", t("wait.detached", { action }));
    }
    try {
      const value = await read(context.signal);
      failingSince = undefined;
      seen(value);
      if (finished(value)) {
        return value;
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new ClientError("cancelled", t("wait.detached", { action }));
      }
      if (!passing(error)) {
        throw error;
      }
      if (failingSince === undefined) {
        failingSince = Date.now();
        context.warn(t("warn.pollFailed", { reason: (error as Error).message }));
      } else if (Date.now() - failingSince > OUT_OF_REACH_MS) {
        throw new ClientError("unreachable", t("wait.gaveUp", { action }));
      }
    }
    await sleep(WAIT_POLL_MS, context.signal);
  }
}

/**
 * Follows an action until it ends, its output printed as it comes when a person is watching. A failure
 * ends the command with exit code 1. Interrupting stops the waiting only: the action goes on.
 */
export async function waitForAction(
  context: CommandContext,
  started: ActionEntry,
  target: string,
): Promise<CommandResult> {
  const { t } = context;
  if (context.mode === "text") {
    context.print(
      context.styles.dim(t("wait.following", { title: started.title, target, action: started.id })),
    );
  }
  let shown = "";
  const detail: ActionDetail = await pollUntil(
    context,
    started.id,
    (signal) => context.api.action(started.id, signal),
    (value) => FINISHED.has(value.status),
    (value) => {
      if (context.mode === "text") {
        shown = showNewOutput(context, shown, value.log);
      }
    },
  );
  if (shown !== "" && !shown.endsWith("\n")) {
    context.write("\n");
  }
  const finished = detail;
  const duration = durationText(finished.startedAt, finished.finishedAt);
  if (finished.status === "succeeded") {
    return {
      data: finished,
      text: () => t("wait.succeeded", { title: finished.title, target, duration }),
    };
  }
  // Whoever runs this from a script still gets the action, with its error, on standard output.
  if (context.mode === "json") {
    context.print(JSON.stringify(finished, null, 2));
  }
  throw new ClientError(
    "action_failed",
    t("wait.failed", {
      title: finished.title,
      target,
      status: finished.status,
      reason: finished.error ?? "-",
      action: finished.id,
    }),
  );
}
