import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, chown, lstat, mkdir, open, opendir, utimes } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable, Transform, Writable } from "node:stream";

/**
 * Our own tar. A backup of a volume is a tar archive this module writes and reads, so that every rule
 * about what may go into one is in one place: nothing leaves the volume, and a hostile archive cannot
 * reach outside the folder it is unpacked into.
 *
 * Only regular files and directories are stored. A hard link is stored as a plain copy of the file.
 * Sockets are skipped, because they mean nothing at rest. A symbolic link or a device is refused
 * outright, on the way in and on the way out, so a backup is either complete or it does not exist.
 */

const BLOCK = 512;
const MAX_OCTAL_FILE_SIZE = 8 ** 11 - 1;
const MAX_OCTAL_ID = 8 ** 7 - 1;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
/** Only what the writer below produces is accepted back. */
const ALLOWED_PAX_KEYS = new Set(["path", "size", "uid", "gid", "mtime"]);
const READ_CHUNK_BYTES = 256 * 1024;

export class ArchiveRefused extends Error {
  override readonly name = "ArchiveRefused";
}

interface TarEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(header, offset, 0, Math.min(bytes.length, length));
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field counts as if it were filled with spaces.
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum;
}

function buildHeader(entry: {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, entry.mode & 0o7777);
  writeOctal(header, 108, 8, Math.min(entry.uid, MAX_OCTAL_ID));
  writeOctal(header, 116, 8, Math.min(entry.gid, MAX_OCTAL_ID));
  writeOctal(header, 124, 12, Math.min(entry.size, MAX_OCTAL_FILE_SIZE));
  writeOctal(header, 136, 12, Math.max(0, Math.floor(entry.mtime)));
  header.write(entry.typeflag, 156, 1, "ascii");
  writeString(header, 157, 100, entry.linkname);
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, 148, 7, headerChecksum(header));
  header[155] = 0x20;
  return header;
}

const ascii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  // The length prefix counts its own digits, so it may need a second pass to settle.
  let length = Buffer.byteLength(body, "utf8") + 1;
  for (;;) {
    const candidate = Buffer.byteLength(body, "utf8") + String(length).length;
    if (candidate === length) {
      return `${length}${body}`;
    }
    length = candidate;
  }
}

function padded(buffer: Buffer): Buffer[] {
  const remainder = buffer.length % BLOCK;
  return remainder === 0 ? [buffer] : [buffer, Buffer.alloc(BLOCK - remainder)];
}

function headersFor(entry: TarEntry, name: string, counter: { value: number }): Buffer[] {
  const records: string[] = [];
  if (Buffer.byteLength(name, "utf8") > 100 || !ascii(name)) {
    records.push(paxRecord("path", name));
  }
  if (entry.size > MAX_OCTAL_FILE_SIZE) {
    records.push(paxRecord("size", String(entry.size)));
  }
  if (entry.uid > MAX_OCTAL_ID) {
    records.push(paxRecord("uid", String(entry.uid)));
  }
  if (entry.gid > MAX_OCTAL_ID) {
    records.push(paxRecord("gid", String(entry.gid)));
  }

  const blocks: Buffer[] = [];
  if (records.length > 0) {
    counter.value += 1;
    const body = Buffer.from(records.join(""), "utf8");
    blocks.push(
      buildHeader({
        name: `./PaxHeaders/${counter.value}`,
        mode: 0o644,
        uid: 0,
        gid: 0,
        size: body.length,
        mtime: 0,
        typeflag: "x",
        linkname: "",
      }),
      ...padded(body),
    );
  }

  // Pax readers ignore these fields whenever the extended header overrides them.
  blocks.push(
    buildHeader({
      name: ascii(name) ? name.slice(0, 100) : "./non-ascii-name",
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      size: Math.min(entry.size, MAX_OCTAL_FILE_SIZE),
      mtime: entry.mtime,
      typeflag: entry.type === "file" ? "0" : "5",
      linkname: "",
    }),
  );
  return blocks;
}

function statMode(stats: Stats): number {
  return stats.mode & 0o7777;
}

export interface ArchiveProgress {
  /** A socket was left out: it can only exist while its server is running. */
  onSkip?: (path: string, reason: string) => void;
  /** A file changed size while it was being read, so the copy of it is not a snapshot. */
  onChanged?: (path: string) => void;
}

/** Everything under `root`, parents first, in a stable order. */
async function* walk(
  root: string,
  relative: string,
  progress: ArchiveProgress,
  signal?: AbortSignal,
): AsyncGenerator<{ relative: string; stats: Stats; absolute: string }> {
  const directory = relative === "" ? root : join(root, relative);
  const names: string[] = [];
  for await (const entry of await opendir(directory)) {
    names.push(entry.name);
  }
  names.sort();
  for (const name of names) {
    signal?.throwIfAborted();
    const child = relative === "" ? name : `${relative}/${name}`;
    const absolute = join(root, child);
    const stats = await lstat(absolute);
    if (stats.isSocket()) {
      progress.onSkip?.(child, "socket");
    } else if (stats.isFIFO() || stats.isBlockDevice() || stats.isCharacterDevice()) {
      throw new ArchiveRefused(`${child} is a device or a named pipe, which can't be part of a backup.`);
    } else if (stats.isSymbolicLink()) {
      throw new ArchiveRefused(
        `${child} is a symbolic link, which can't be part of a backup. Replace it with what it points to.`,
      );
    } else if (stats.isDirectory()) {
      yield { relative: child, stats, absolute };
      yield* walk(root, child, progress, signal);
    } else {
      yield { relative: child, stats, absolute };
    }
  }
}

/** Reads one file, tolerating a live application shrinking it underneath the backup. */
async function* fileChunks(
  absolute: string,
  size: number,
  relative: string,
  progress: ArchiveProgress,
): AsyncGenerator<Buffer> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let remaining = size;
    while (remaining > 0) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - remaining);
      if (bytesRead === 0) {
        break;
      }
      yield buffer.subarray(0, bytesRead);
      remaining -= bytesRead;
    }
    if (remaining > 0) {
      progress.onChanged?.(relative);
      yield Buffer.alloc(remaining);
    }
  } finally {
    await handle.close();
  }
}

/** The tar stream of a directory: one async sequence of blocks, read as the output is consumed. */
export async function* archiveBlocks(
  root: string,
  progress: ArchiveProgress = {},
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const counter = { value: 0 };
  for await (const { relative, stats, absolute } of walk(root, "", progress, signal)) {
    const base = {
      path: relative,
      mode: statMode(stats),
      uid: stats.uid,
      gid: stats.gid,
      mtime: stats.mtimeMs / 1000,
    };
    if (stats.isDirectory()) {
      yield* headersFor({ ...base, type: "directory", size: 0 }, `${relative}/`, counter);
    } else {
      yield* headersFor({ ...base, type: "file", size: stats.size }, relative, counter);
      let written = 0;
      for await (const chunk of fileChunks(absolute, stats.size, relative, progress)) {
        written += chunk.length;
        yield chunk;
      }
      const remainder = written % BLOCK;
      if (remainder !== 0) {
        yield Buffer.alloc(BLOCK - remainder);
      }
    }
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

/** Counts the bytes and computes the SHA-256 of what goes through it. */
export class HashingTransform extends Transform {
  private readonly hash = createHash("sha256");
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

export const readableBlocks = (blocks: AsyncGenerator<Buffer>): Readable =>
  Readable.from(blocks, { objectMode: false, highWaterMark: 1 << 20 });

function parseOctal(field: Buffer, what: string): number {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new ArchiveRefused(`The archive has an invalid ${what}.`);
  }
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function fieldText(field: Buffer): string {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

function assertSafePath(path: string): void {
  if (path === "" || posix.isAbsolute(path) || hasControlCharacter(path)) {
    throw new ArchiveRefused("The archive contains an entry with an unusable path.");
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ArchiveRefused("The archive contains an entry that would leave its folder.");
    }
  }
}

interface PaxOverrides {
  path?: string;
  size?: number;
  uid?: number;
  gid?: number;
  mtime?: number;
}

function parsePaxRecords(body: Buffer): PaxOverrides {
  const overrides: PaxOverrides = {};
  const text = body.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) {
      throw new ArchiveRefused("The archive has a malformed extended header.");
    }
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length <= 0) {
      throw new ArchiveRefused("The archive has a malformed extended header.");
    }
    const record = body.subarray(Buffer.byteLength(text.slice(0, offset), "utf8"));
    const recordText = record.subarray(0, length).toString("utf8");
    offset += recordText.length;
    if (!recordText.endsWith("\n")) {
      throw new ArchiveRefused("The archive has a malformed extended header.");
    }
    const firstSpace = recordText.indexOf(" ");
    const equals = recordText.indexOf("=", firstSpace);
    const key = recordText.slice(firstSpace + 1, equals);
    const value = recordText.slice(equals + 1, -1);
    if (equals === -1 || !ALLOWED_PAX_KEYS.has(key)) {
      throw new ArchiveRefused(`The archive uses an unsupported extension: ${key}.`);
    }
    if (key === "path") {
      overrides.path = value;
    } else {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        throw new ArchiveRefused(`The archive has an invalid ${key}.`);
      }
      overrides[key as "size" | "uid" | "gid" | "mtime"] = number;
    }
  }
  return overrides;
}

export interface ExtractorOptions {
  /** An existing, empty folder. Nothing is ever written outside it. */
  root: string;
  /** How much the archive's files may add up to. Null when the manifest did not say. */
  maxBytes: number | null;
  /** Set when not running as root, where changing an owner would fail for every file. */
  ignoreOwners: boolean;
}

interface ActiveFile {
  entry: TarEntry;
  remaining: number;
  padding: number;
  handle: Awaited<ReturnType<typeof open>>;
}

/**
 * Unpacks one archive into an empty folder. Everything is validated as it is read, entry by entry: a
 * bad checksum, a path that escapes, a type outside the short allowed list, or a duplicate name
 * stops the extraction immediately. The caller discards the folder on failure.
 */
export class VolumeExtractor extends Writable {
  private buffered: Buffer = Buffer.alloc(0);
  private pendingPax: PaxOverrides | null = null;
  private expectingPaxBody: { remaining: number; padding: number; pieces: Buffer[] } | null = null;
  private activeFile: ActiveFile | null = null;
  private zeroBlocksSeen = 0;
  private ended = false;
  private readonly seen = new Set<string>();
  private readonly directories: TarEntry[] = [];
  private totalBytes = 0;
  private entryCount = 0;

  constructor(private readonly options: ExtractorOptions) {
    super({ highWaterMark: 1 << 20 });
  }

  get entries(): number {
    return this.entryCount;
  }

  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.consume(chunk).then(
      () => callback(),
      (error: Error) => callback(error),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (
      !this.ended ||
      this.activeFile !== null ||
      this.expectingPaxBody !== null ||
      this.buffered.length > 0
    ) {
      callback(new ArchiveRefused("The archive is incomplete."));
      return;
    }
    this.applyDirectories().then(
      () => callback(),
      (error: Error) => callback(error),
    );
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    const handle = this.activeFile?.handle;
    this.activeFile = null;
    if (handle === undefined) {
      callback(error);
      return;
    }
    handle.close().then(
      () => callback(error),
      () => callback(error),
    );
  }

  private async consume(chunk: Buffer): Promise<void> {
    let data = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    this.buffered = Buffer.alloc(0);

    while (data.length > 0) {
      if (this.activeFile !== null) {
        const file = this.activeFile;
        const take = Math.min(file.remaining, data.length);
        if (take > 0) {
          await file.handle.write(data.subarray(0, take));
          file.remaining -= take;
          data = data.subarray(take);
        }
        if (file.remaining === 0) {
          if (data.length < file.padding) {
            file.padding -= data.length;
            this.buffered = Buffer.alloc(0);
            return;
          }
          data = data.subarray(file.padding);
          await this.finishFile(file);
          this.activeFile = null;
        }
        continue;
      }

      if (this.expectingPaxBody !== null) {
        const body = this.expectingPaxBody;
        const take = Math.min(body.remaining, data.length);
        body.pieces.push(data.subarray(0, take));
        body.remaining -= take;
        data = data.subarray(take);
        if (body.remaining === 0) {
          if (data.length < body.padding) {
            body.padding -= data.length;
            return;
          }
          data = data.subarray(body.padding);
          this.pendingPax = parsePaxRecords(Buffer.concat(body.pieces));
          this.expectingPaxBody = null;
        }
        continue;
      }

      if (data.length < BLOCK) {
        this.buffered = Buffer.from(data);
        return;
      }
      const header = data.subarray(0, BLOCK);
      data = data.subarray(BLOCK);
      await this.handleHeader(header);
    }
  }

  private async handleHeader(header: Buffer): Promise<void> {
    if (header.every((byte) => byte === 0)) {
      this.zeroBlocksSeen += 1;
      if (this.zeroBlocksSeen >= 2) {
        this.ended = true;
      }
      return;
    }
    if (this.zeroBlocksSeen > 0 || this.ended) {
      throw new ArchiveRefused("The archive has data after its end.");
    }

    const stored = parseOctal(header.subarray(148, 156), "checksum");
    if (stored !== headerChecksum(header)) {
      throw new ArchiveRefused("The archive failed its header checksum.");
    }
    if (header.subarray(257, 263).toString("latin1") !== "ustar\0") {
      throw new ArchiveRefused("The archive is not in a format the panel can read.");
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "x") {
      const size = parseOctal(header.subarray(124, 136), "size");
      if (this.pendingPax !== null || size > 16 * 1024 * 1024) {
        throw new ArchiveRefused("The archive has a malformed extended header.");
      }
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (size === 0) {
        this.pendingPax = {};
      } else {
        this.expectingPaxBody = { remaining: size, padding, pieces: [] };
      }
      return;
    }
    if (typeflag === "1" || typeflag === "2") {
      throw new ArchiveRefused("The archive contains a link, which can't be restored safely.");
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      throw new ArchiveRefused("The archive contains a type of entry that can't be restored safely.");
    }

    const pax = this.pendingPax;
    this.pendingPax = null;
    const rawPath = pax?.path ?? fieldText(header.subarray(0, 100));
    const path = rawPath.replace(/\/+$/, "");
    const size = pax?.size ?? parseOctal(header.subarray(124, 136), "size");
    if (!Number.isInteger(size) || size < 0) {
      throw new ArchiveRefused("The archive has an invalid size.");
    }

    assertSafePath(path);
    if (this.seen.has(path)) {
      throw new ArchiveRefused("The archive names the same path twice.");
    }
    this.seen.add(path);

    this.entryCount += 1;
    const entry: TarEntry = {
      path,
      type: typeflag === "5" ? "directory" : "file",
      size,
      mode: parseOctal(header.subarray(100, 108), "mode") & 0o7777,
      uid: pax?.uid ?? parseOctal(header.subarray(108, 116), "owner"),
      gid: pax?.gid ?? parseOctal(header.subarray(116, 124), "group"),
      mtime: pax?.mtime ?? parseOctal(header.subarray(136, 148), "date"),
    };

    if (entry.type === "directory") {
      if (size !== 0) {
        throw new ArchiveRefused("The archive has an invalid size.");
      }
      await mkdir(join(this.options.root, path), { recursive: true, mode: 0o700 });
      this.directories.push(entry);
      return;
    }

    this.totalBytes += size;
    if (this.options.maxBytes !== null && this.totalBytes > this.options.maxBytes) {
      throw new ArchiveRefused("The archive holds more data than its manifest says it should.");
    }
    await mkdir(dirname(join(this.options.root, path)), { recursive: true, mode: 0o700 });
    const handle = await open(
      join(this.options.root, path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    this.activeFile = {
      entry,
      remaining: size,
      padding: (BLOCK - (size % BLOCK)) % BLOCK,
      handle,
    };
    if (size === 0) {
      await this.finishFile(this.activeFile);
      this.activeFile = null;
    }
  }

  private async finishFile(file: ActiveFile): Promise<void> {
    await file.handle.close();
    const target = join(this.options.root, file.entry.path);
    await chmod(target, file.entry.mode);
    if (!this.options.ignoreOwners) {
      await chown(target, file.entry.uid, file.entry.gid);
    }
    await utimes(target, file.entry.mtime, file.entry.mtime);
  }

  /** Directories come last, deepest first, so that a read-only one can still receive its files. */
  private async applyDirectories(): Promise<void> {
    for (const entry of [...this.directories].reverse()) {
      const target = join(this.options.root, entry.path);
      await chmod(target, entry.mode);
      if (!this.options.ignoreOwners) {
        await chown(target, entry.uid, entry.gid);
      }
      await utimes(target, entry.mtime, entry.mtime);
    }
  }
}
