import type { LogLine } from "./driver";

const HEADER_BYTES = 8;
const STREAMS: Record<number, LogLine["stream"]> = { 0: "stdout", 1: "stdout", 2: "stderr" };
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (.*)$/s;
const NO_BYTES = Buffer.alloc(0);

/** A line that never ends is passed on in pieces of this size instead of being held in memory. */
export const MAX_PARTIAL_LINE_CHARS = 64 * 1024;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * Keeps one partial line per stream open across chunks, so that lines never get cut in two.
 * The text already held is never looked at again: each chunk is searched on its own, and the
 * pieces are only joined when a line is complete.
 */
class LineSplitter {
  private readonly partial: Record<LogLine["stream"], { pieces: string[]; length: number }> = {
    stdout: { pieces: [], length: 0 },
    stderr: { pieces: [], length: 0 },
  };

  constructor(private readonly timestamps: boolean) {}

  push(stream: LogLine["stream"], text: string, out: LogLine[]): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      this.hold(stream, text.slice(start, end), out);
      if (newline === -1) {
        return;
      }
      out.push(this.takeLine(stream));
      start = newline + 1;
    }
  }

  flush(out: LogLine[]): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.partial[stream].length > 0) {
        out.push(this.takeLine(stream));
      }
    }
  }

  /** Adds text with no newline in it, emitting whatever goes past the limit. */
  private hold(stream: LogLine["stream"], text: string, out: LogLine[]): void {
    const partial = this.partial[stream];
    let rest = text;
    while (partial.length + rest.length > MAX_PARTIAL_LINE_CHARS) {
      let cut = MAX_PARTIAL_LINE_CHARS - partial.length;
      // Never between the two halves of one character. Taking nothing is fine: the partial line
      // is emitted below, which empties it, so the next pass has a full line's worth of room.
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) {
        cut -= 1;
      }
      partial.pieces.push(rest.slice(0, cut));
      partial.length += cut;
      out.push(this.takeLine(stream));
      rest = rest.slice(cut);
    }
    if (rest !== "") {
      partial.pieces.push(rest);
      partial.length += rest.length;
    }
  }

  private takeLine(stream: LogLine["stream"]): LogLine {
    const partial = this.partial[stream];
    const raw = partial.pieces.join("");
    partial.pieces = [];
    partial.length = 0;
    return this.toLine(stream, raw);
  }

  private toLine(stream: LogLine["stream"], raw: string): LogLine {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (this.timestamps) {
      const match = TIMESTAMP.exec(text);
      if (match) {
        return { stream, line: match[2] ?? "", timestamp: match[1] };
      }
    }
    return { stream, line: text };
  }
}

/**
 * Turns Docker's log stream into lines. Without a TTY, Docker frames output with an 8-byte
 * header (stream id, three zero bytes, big-endian length). With a TTY the stream is raw.
 * Only a header can be left waiting between chunks: a payload is passed on as it arrives,
 * however large its frame claims to be.
 */
export class DockerLogParser {
  private readonly splitter: LineSplitter;
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private header: Buffer = NO_BYTES;
  private frame: { stream: LogLine["stream"]; remaining: number } | null = null;
  private framed: boolean | null = null;

  constructor(options: { timestamps?: boolean } = {}) {
    this.splitter = new LineSplitter(options.timestamps === true);
  }

  push(chunk: Buffer): LogLine[] {
    const out: LogLine[] = [];
    let data = chunk;

    if (this.framed === null) {
      data = this.header.length === 0 ? chunk : Buffer.concat([this.header, chunk]);
      this.framed = detectFraming(data);
      if (this.framed === null) {
        this.header = data;
        return out;
      }
      this.header = NO_BYTES;
    }

    if (!this.framed) {
      this.decodeInto("stdout", data, out);
      return out;
    }

    let offset = 0;
    while (offset < data.length) {
      if (this.frame === null) {
        offset += this.readHeader(data.subarray(offset));
        continue;
      }
      const length = Math.min(this.frame.remaining, data.length - offset);
      this.decodeInto(this.frame.stream, data.subarray(offset, offset + length), out);
      offset += length;
      this.frame.remaining -= length;
      if (this.frame.remaining === 0) {
        this.frame = null;
      }
    }
    return out;
  }

  flush(): LogLine[] {
    const out: LogLine[] = [];
    if (this.framed === null && this.header.length > 0) {
      this.decodeInto("stdout", this.header, out);
    }
    this.header = NO_BYTES;
    this.frame = null;
    for (const stream of ["stdout", "stderr"] as const) {
      this.splitter.push(stream, this.decoders[stream].decode(), out);
    }
    this.splitter.flush(out);
    return out;
  }

  /** Takes in as much of the next header as `data` holds, and returns how many bytes that was. */
  private readHeader(data: Buffer): number {
    const taken = data.subarray(0, HEADER_BYTES - this.header.length);
    this.header = Buffer.concat([this.header, taken]);
    if (this.header.length === HEADER_BYTES) {
      const remaining = this.header.readUInt32BE(4);
      if (remaining > 0) {
        this.frame = { stream: STREAMS[this.header[0] ?? 1] ?? "stdout", remaining };
      }
      this.header = NO_BYTES;
    }
    return taken.length;
  }

  private decodeInto(stream: LogLine["stream"], bytes: Buffer, out: LogLine[]): void {
    this.splitter.push(stream, this.decoders[stream].decode(bytes, { stream: true }), out);
  }
}

/** Decides as soon as the bytes allow, so a short first line on a TTY is not held back. */
function detectFraming(buffer: Buffer): boolean | null {
  const [stream, ...rest] = buffer.subarray(0, 4);
  if (stream === undefined) {
    return null;
  }
  if (stream > 2 || rest.some((byte) => byte !== 0)) {
    return false;
  }
  return rest.length === 3 ? true : null;
}
