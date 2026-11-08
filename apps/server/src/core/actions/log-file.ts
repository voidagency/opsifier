import { createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Logger } from "pino";

const MAX_LINE_CHARS = 16 * 1024;

/**
 * Appends one action's output to its file and counts lines as they reach the disk, so a reader
 * can be told exactly which lines the file already contains. A write failure, such as a full
 * disk, stops the log but never the action.
 */
export class ActionLogFile {
  private readonly stream: WriteStream;
  private broken = false;
  private bytes = 0;
  private seq = 0;
  private flushedBytes = 0;
  private flushedSeq = 0;
  private truncated = false;
  private closing = false;

  constructor(
    file: string,
    private readonly maxBytes: number,
    private readonly onLine: (seq: number, line: string) => void,
    private readonly logger: Logger,
  ) {
    this.stream = createWriteStream(file, { flags: "a", mode: 0o600 });
    this.stream.on("error", (error) => {
      this.broken = true;
      this.logger.error({ err: error, file }, "Action log could not be written");
    });
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  /** The file contains exactly lines 1..seq, in its first `bytes` bytes. */
  flushed(): { bytes: number; seq: number } {
    return { bytes: this.flushedBytes, seq: this.flushedSeq };
  }

  write(text: string): void {
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    for (const raw of lines) {
      this.writeLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
  }

  private writeLine(raw: string): void {
    if (this.truncated || this.closing) {
      return;
    }
    const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
    let buffer = Buffer.from(`${line}\n`, "utf8");
    let emitted = line;
    if (this.bytes + buffer.length > this.maxBytes) {
      this.truncated = true;
      emitted = "[The log reached its size limit. Later output is not kept.]";
      buffer = Buffer.from(`${emitted}\n`, "utf8");
    }

    this.seq += 1;
    this.bytes += buffer.length;
    const seq = this.seq;
    if (!this.broken) {
      this.stream.write(buffer, (error) => {
        if (!error) {
          this.flushedBytes += buffer.length;
          this.flushedSeq = seq;
        }
      });
    }
    this.onLine(seq, emitted);
  }

  /** Resolves once everything written so far is on disk. */
  close(): Promise<void> {
    this.closing = true;
    return new Promise((resolve) => {
      if (this.stream.closed || this.stream.destroyed) {
        resolve();
        return;
      }
      this.stream.once("close", resolve);
      this.stream.end();
    });
  }
}

export interface LogTail {
  text: string;
  /** True when the start of the log was left out to respect `maxBytes`. */
  clipped: boolean;
}

/** Reads the end of a log, never more than `maxBytes`, stopping at `upTo` when given. */
export async function readLogTail(file: string, maxBytes: number, upTo?: number): Promise<LogTail> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", clipped: false };
    }
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const end = upTo === undefined ? size : Math.min(upTo, size);
    const start = Math.max(0, end - maxBytes);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A tail that starts mid-file starts mid-line too: drop the fragment.
    return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, clipped: start > 0 };
  } finally {
    await handle.close();
  }
}
