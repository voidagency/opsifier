import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerLogParser, MAX_PARTIAL_LINE_CHARS } from "./log-parser";

const LIMIT = MAX_PARTIAL_LINE_CHARS;

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a line that never ends", () => {
  it("is passed on at about 64 KiB instead of being held in memory", () => {
    expect(LIMIT).toBe(64 * 1024);
    const parser = new DockerLogParser();
    const out = parser.push(frame(1, "x".repeat(LIMIT * 2 + 10)));

    expect(out.map((entry) => entry.line.length)).toEqual([LIMIT, LIMIT]);
    expect(parser.flush().map((entry) => entry.line.length)).toEqual([10]);
  });

  it("is flushed however small the chunks it arrives in", () => {
    const parser = new DockerLogParser();
    const lines = [];
    for (let chunk = 0; chunk < 200; chunk += 1) {
      lines.push(...parser.push(frame(1, "y".repeat(1024))));
    }
    expect(lines.map((entry) => entry.line.length)).toEqual([LIMIT, LIMIT, LIMIT]);
  });

  it("does the same on a TTY stream", () => {
    const parser = new DockerLogParser();
    const out = parser.push(Buffer.from("z".repeat(LIMIT + 1)));
    expect(out.map((entry) => entry.line.length)).toEqual([LIMIT]);
  });

  it("does not add an empty line when a line ends exactly at the limit", () => {
    const parser = new DockerLogParser();
    expect(parser.push(frame(1, `${"x".repeat(LIMIT)}\n`)).map((entry) => entry.line.length)).toEqual([
      LIMIT,
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it("counts each stream on its own", () => {
    const parser = new DockerLogParser();
    const out = [...parser.push(frame(1, "o".repeat(LIMIT))), ...parser.push(frame(2, "e".repeat(LIMIT)))];
    expect(out).toEqual([]);
    expect(parser.flush().map((entry) => entry.stream)).toEqual(["stdout", "stderr"]);
  });

  it("is never cut through the middle of a character", () => {
    const parser = new DockerLogParser();
    const pieces = parser.push(frame(1, `${"x".repeat(LIMIT - 1)}😀end\n`));

    expect(pieces.map((entry) => entry.line)).toEqual(["x".repeat(LIMIT - 1), "😀end"]);
  });

  it("stays whole when the character falls right after what is already held", () => {
    const parser = new DockerLogParser();
    const first = parser.push(frame(1, "x".repeat(LIMIT - 1)));
    const pieces = parser.push(frame(1, "😀end\n"));

    expect(first).toEqual([]);
    expect(pieces.map((entry) => entry.line)).toEqual(["x".repeat(LIMIT - 1), "😀end"]);
  });

  it("keeps the timestamp on the first piece of a long line", () => {
    const parser = new DockerLogParser({ timestamps: true });
    const [first, second] = parser.push(frame(1, `2026-01-02T03:04:05Z ${"x".repeat(LIMIT)}\n`));

    expect(first?.timestamp).toBe("2026-01-02T03:04:05Z");
    expect(second?.timestamp).toBeUndefined();
  });
});

describe("the work done per chunk", () => {
  /** Records the length of every string a newline is searched for in. */
  function watchNewlineSearches(): number[] {
    const searched: number[] = [];
    const { indexOf, split } = String.prototype;
    vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, position) {
      if (search === "\n") {
        searched.push(this.length);
      }
      return indexOf.call(this, search, position);
    });
    vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number,
    ) {
      if (separator === "\n") {
        searched.push(this.length);
      }
      return split.call(this, separator as never, limit);
    } as typeof String.prototype.split);
    return searched;
  }

  it("never searches text it has already searched", () => {
    const parser = new DockerLogParser();
    const chunk = frame(1, "x".repeat(4096));
    parser.push(chunk);

    const searched = watchNewlineSearches();
    for (let index = 0; index < 8; index += 1) {
      parser.push(chunk);
    }

    expect(searched).toHaveLength(8);
    expect(Math.max(...searched)).toBe(4096);
  });
});

describe("a frame", () => {
  it("is passed on as it arrives, not held back until it is complete", () => {
    const parser = new DockerLogParser();
    const bytes = frame(1, `first\n${"x".repeat(1000)}`);

    expect(parser.push(bytes.subarray(0, 8 + 10)).map((entry) => entry.line)).toEqual(["first"]);
  });

  it("can claim any size without being buffered", () => {
    const parser = new DockerLogParser();
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(0xffffffff, 4);

    const out = parser.push(Buffer.concat([header, Buffer.from("a\n")]));

    expect(out).toEqual([{ stream: "stdout", line: "a" }]);
    expect((parser as unknown as { header: Buffer }).header).toHaveLength(0);
  });

  it("may be empty", () => {
    const parser = new DockerLogParser();
    expect(parser.push(Buffer.concat([frame(1, ""), frame(1, "after\n")]))).toEqual([
      { stream: "stdout", line: "after" },
    ]);
  });

  it("may have its header split across chunks", () => {
    const parser = new DockerLogParser();
    const bytes = Buffer.concat([frame(1, "a\n"), frame(2, "b\n")]);
    const out = [];
    for (let index = 0; index < bytes.length; index += 1) {
      out.push(...parser.push(bytes.subarray(index, index + 1)));
    }
    expect(out).toEqual([
      { stream: "stdout", line: "a" },
      { stream: "stderr", line: "b" },
    ]);
  });

  it("may split a multi-byte character", () => {
    const parser = new DockerLogParser();
    const payload = Buffer.from("héllo\n");
    const first = payload.subarray(0, 2);
    const second = payload.subarray(2);
    const wrap = (part: Buffer) => {
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(part.length, 4);
      return Buffer.concat([header, part]);
    };

    expect([...parser.push(wrap(first)), ...parser.push(wrap(second))]).toEqual([
      { stream: "stdout", line: "héllo" },
    ]);
  });
});

describe("flush", () => {
  it("emits a short undecided stream as text", () => {
    const parser = new DockerLogParser();
    expect(parser.push(Buffer.from([1]))).toEqual([]);
    expect(parser.flush()).toEqual([{ stream: "stdout", line: "\u0001" }]);
  });

  it("leaves nothing behind for a second flush", () => {
    const parser = new DockerLogParser();
    parser.push(frame(1, "partial"));
    expect(parser.flush()).toEqual([{ stream: "stdout", line: "partial" }]);
    expect(parser.flush()).toEqual([]);
  });
});
