import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { DockerDriver, ExecSession } from "../../core/docker";

const HEADER_BYTES = 8;

/**
 * Splits Docker's exec stream into stdout, which may be gigabytes of a dump, and stderr, which is
 * reported line by line. Output is passed on as it arrives, and waits while its destination catches up,
 * so memory stays bounded however large the dump is.
 */
class ExecDemuxer extends Writable {
  private header: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private streamKind: "stdout" | "stderr" = "stdout";
  private framed: boolean | null = null;
  private stderrPartial = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly stdout: Writable | null,
    private readonly onStderr: (line: string) => void,
  ) {
    super({ highWaterMark: 1 << 20 });
  }

  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.process(chunk).then(
      () => callback(),
      (error: Error) => callback(error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.flushStderr();
    callback();
  }

  private async process(chunk: Buffer): Promise<void> {
    if (this.framed === null) {
      const buffered = this.header.length === 0 ? chunk : Buffer.concat([this.header, chunk]);
      if (buffered.length < 4) {
        this.header = buffered;
        return;
      }
      this.header = Buffer.alloc(0);
      this.framed = isFramed(buffered);
      await this.deliver(buffered);
      return;
    }
    await this.deliver(chunk);
  }

  private async deliver(data: Buffer): Promise<void> {
    if (this.framed === false) {
      await this.toStdout(data);
      return;
    }
    let offset = 0;
    while (offset < data.length) {
      if (this.remaining === 0) {
        const taken = data.subarray(offset, offset + HEADER_BYTES - this.header.length);
        this.header = Buffer.concat([this.header, taken]);
        offset += taken.length;
        if (this.header.length === HEADER_BYTES) {
          this.streamKind = this.header[0] === 2 ? "stderr" : "stdout";
          this.remaining = this.header.readUInt32BE(4);
          this.header = Buffer.alloc(0);
        }
        continue;
      }
      const length = Math.min(this.remaining, data.length - offset);
      const payload = data.subarray(offset, offset + length);
      offset += length;
      this.remaining -= length;
      if (this.streamKind === "stderr") {
        this.feedStderr(payload);
      } else {
        await this.toStdout(payload);
      }
    }
  }

  private async toStdout(data: Buffer): Promise<void> {
    if (this.stdout === null || data.length === 0) {
      return;
    }
    if (!this.stdout.write(data)) {
      await once(this.stdout, "drain");
    }
  }

  private feedStderr(data: Buffer): void {
    const lines = (this.stderrPartial + this.decoder.decode(data, { stream: true })).split(/\r?\n/);
    this.stderrPartial = lines.pop() ?? "";
    for (const line of lines) {
      if (line !== "") {
        this.onStderr(line);
      }
    }
  }

  private flushStderr(): void {
    const rest = this.stderrPartial + this.decoder.decode();
    this.stderrPartial = "";
    if (rest !== "") {
      this.onStderr(rest);
    }
  }
}

/** The header of Docker's framing. Real exec streams always have it; test doubles often don't. */
function isFramed(data: Buffer): boolean {
  const [kind, a, b, c] = data;
  return kind !== undefined && kind <= 2 && a === 0 && b === 0 && c === 0;
}

export interface BinaryExecOptions {
  docker: Pick<DockerDriver, "execAttach">;
  service: string;
  plan: { command: string[]; env?: string[] };
  /** Sent to the process's stdin. Null closes stdin straight away. */
  stdin?: Readable | null;
  /** Receives stdout. Never ended here: the caller decides when its pipeline is done. */
  stdout?: Writable | null;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** What Docker said the process exited with. Non-zero is for the caller to report. */
export interface BinaryExecResult {
  exitCode: number | null;
  /** Set when the process ended before reading all of its input. */
  stdinFailed: boolean;
}

/**
 * Runs one process in a service's container with its stdin and stdout attached to streams. Docker keeps
 * an orphaned exec running after its client goes away, so cancelling or timing out ends it explicitly.
 */
export async function runBinaryExec(options: BinaryExecOptions): Promise<BinaryExecResult> {
  const { docker, service, plan, stdin = null, stdout = null, signal, timeoutMs } = options;
  signal?.throwIfAborted();

  const session: ExecSession = await docker.execAttach({
    service,
    command: plan.command,
    env: plan.env,
    tty: false,
  });
  session.stream.on("error", () => {});

  const demuxer = new ExecDemuxer(stdout, options.onStderr ?? (() => {}));
  session.stream.pipe(demuxer);

  let stdinFailed = false;
  if (stdin === null) {
    session.stream.end();
  } else {
    // Not `pipeline`, which would tear the socket down on a read error and lose the process's stderr.
    stdin.on("error", () => {
      stdinFailed = true;
      session.stream.end();
    });
    session.stream.on("close", () => {
      if (stdin instanceof Readable && !stdin.destroyed) {
        stdinFailed = !stdin.readableEnded;
        stdin.destroy();
      }
    });
    stdin.pipe(session.stream);
  }

  const timer = new AbortController();
  let exitCode: number | null;
  try {
    const outcome = await Promise.race([
      session.exited().catch(() => null),
      sleep(timeoutMs, "timeout" as const, { signal: anySignal([signal, timer.signal]), ref: false }).catch(
        () => "aborted" as const,
      ),
    ]);
    if (outcome === "timeout" || outcome === "aborted") {
      await stopExec(session);
      if (outcome === "timeout") {
        throw new Error(`The command was stopped after running for ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    exitCode = outcome;
  } finally {
    timer.abort();
  }

  // With a real daemon the stream has already ended by now. Test doubles only end it on request.
  await new Promise((resolve) => setImmediate(resolve));
  if (!demuxer.writableEnded) {
    demuxer.end();
  }
  await finished(demuxer).catch(() => {});
  session.stream.destroy();
  return { exitCode, stdinFailed };
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

async function stopExec(session: ExecSession): Promise<void> {
  try {
    await session.terminate?.();
  } catch {
    // The container may already be gone, which ended the process as well.
  }
  session.stream.destroy();
}
