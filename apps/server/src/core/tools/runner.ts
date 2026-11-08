import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Redactor } from "./redact";

/** How long a process gets to stop after SIGTERM before the whole group is killed. */
const KILL_GRACE_MS = 3000;
/** How long the pipes may stay open after the process itself has exited. */
const DRAIN_MS = 1000;
const MAX_LINE_CHARS = 1024 * 1024;
/** How much of an overlong line is passed on. The rest is dropped, never cut mid-secret and emitted. */
const MAX_EMITTED_LINE_CHARS = 64 * 1024;
const TAIL_LINES = 40;
/** Colour and cursor codes, which builders send even without a terminal and which mean nothing in a log. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export interface ToolRequest {
  /** A program on the PATH or an absolute path. There is no shell, so nothing here is interpreted. */
  command: string;
  args: readonly string[];
  cwd?: string;
  /** The process's complete environment. Nothing is inherited from the panel. */
  env: Readonly<Record<string, string>>;
  /** Aborting kills the process and everything it started. */
  signal?: AbortSignal;
  /** Kills the process and everything it started once this much time has gone by. */
  timeoutMs?: number;
  /** Receives each line of stdout and stderr, with secrets already removed. */
  onLine?: (line: string) => void;
  redact?: Redactor;
}

export interface ToolResult {
  /** 128 plus the signal number when the process died from a signal. */
  exitCode: number;
  /** The last lines of output, with secrets removed, for use in an error message. */
  tail: string[];
}

/** Runs external programs. `spawnTool` does so for real, and {@link FakeTools} simulates them. */
export interface ToolRunner {
  readonly kind: "real" | "fake";
  run(request: ToolRequest): Promise<ToolResult>;
}

export class ToolNotFoundError extends Error {
  override readonly name = "ToolNotFoundError";

  constructor(readonly command: string) {
    super(`${command} is not installed on this server.`);
  }
}

export class ToolTimeoutError extends Error {
  override readonly name = "ToolTimeoutError";

  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} was stopped after running for ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}

/** Reassembles lines from a stream, treating a carriage return like a newline. */
class LineBuffer {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: Buffer): void {
    const parts = (this.buffer + this.decoder.write(chunk)).split(/\r\n|\n|\r/);
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      this.emit(line);
    }
    // Beyond this the line keeps only its beginning: output with no newline can't fill the memory.
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = this.buffer.slice(0, MAX_LINE_CHARS);
    }
  }

  end(): void {
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    if (rest !== "") {
      this.emit(rest);
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Runs a program as the leader of its own process group, so that a cancel or a timeout reaches
 * everything it started: git's helpers, ssh, a builder's own `docker` child.
 */
export function spawnTool(request: ToolRequest): Promise<ToolResult> {
  const { command, args, cwd, env, signal, timeoutMs, onLine } = request;
  const redactor = request.redact ?? new Redactor();

  return new Promise<ToolResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const child = spawn(command, [...args], {
      cwd,
      env: { ...env },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tail: string[] = [];
    const emit = (raw: string) => {
      const clipped = raw.length > MAX_EMITTED_LINE_CHARS ? raw.slice(0, MAX_EMITTED_LINE_CHARS) : raw;
      const line = redactor.apply(clipped.replace(ANSI_SEQUENCE, ""));
      tail.push(line);
      if (tail.length > TAIL_LINES) {
        tail.shift();
      }
      onLine?.(line);
    };
    const stdout = new LineBuffer(emit);
    const stderr = new LineBuffer(emit);
    child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));

    let stopReason: unknown;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;

    const killGroup = (killSignal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, killSignal);
      } catch (error) {
        // ESRCH: the whole group is already gone. EPERM on macOS: only zombies are left in it.
        const { code } = error as NodeJS.ErrnoException;
        if (code !== "ESRCH" && code !== "EPERM") {
          throw error;
        }
      }
    };

    const stop = (reason: unknown) => {
      if (stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      killGroup("SIGTERM");
      escalation = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };

    const onAbort = () => stop(signal === undefined ? new Error("Aborted") : abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => stop(new ToolTimeoutError(command, timeoutMs)), timeoutMs);
      timeout.unref();
    }

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(escalation);
      clearTimeout(drain);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT" ? new ToolNotFoundError(command) : new Error(redactor.apply(error.message)),
        ),
      );
    });

    child.once("exit", () => {
      // Whatever the leader left behind goes with it when it was told to stop.
      if (stopReason !== undefined) {
        killGroup("SIGKILL");
      }
      // A straggler holding the pipes open must not keep the caller waiting forever.
      drain = setTimeout(() => {
        killGroup("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, DRAIN_MS);
      drain.unref();
    });

    child.once("close", (code, killSignal) => {
      stdout.end();
      stderr.end();
      finish(() => {
        if (stopReason !== undefined) {
          reject(stopReason);
          return;
        }
        resolve({ exitCode: code ?? (killSignal === null ? 1 : 128 + signalNumber(killSignal)), tail });
      });
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 1;
}

export const realTools: ToolRunner = { kind: "real", run: spawnTool };
