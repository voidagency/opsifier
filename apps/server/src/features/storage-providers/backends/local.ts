import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  assertRemotePath,
  type RemoteFile,
  type StorageBackend,
  StorageError,
  type TransferOptions,
  verifyRoundTrip,
} from "./types";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const isWithin = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

function denied(error: unknown, path: string): StorageError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new StorageError("denied", `The panel may not write to ${path}.`);
  }
  if (code === "ENOSPC") {
    return new StorageError("failed", `There is no space left on the disk holding ${path}.`);
  }
  return new StorageError("failed", (error as Error).message);
}

/** A folder on this server. Nothing can leave it: symbolic links are never followed out of the root. */
export class LocalBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  /** The real path of a remote path's parent, once it is certain that it stays inside the root. */
  private async resolveDirectory(remotePath: string, create: boolean): Promise<string> {
    assertRemotePath(remotePath);
    const target = join(this.root, remotePath);
    const directory = dirname(target);
    if (create) {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    }
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(directory);
      realRoot = await realpath(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StorageError("not_found", `${remotePath} does not exist.`);
      }
      throw denied(error, this.root);
    }
    if (!isWithin(realRoot, real)) {
      throw new StorageError("failed", `${remotePath} leads outside the destination.`);
    }
    return join(real, target.slice(directory.length + 1));
  }

  async check(signal?: AbortSignal): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
      await (await opendir(this.root)).close();
    } catch (error) {
      throw denied(error, this.root);
    }
    await verifyRoundTrip(this, signal);
    await this.statRoot();
  }

  private async statRoot(): Promise<void> {
    const info = await stat(this.root);
    if (!info.isDirectory()) {
      throw new StorageError("failed", `${this.root} is not a folder.`);
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    let target: string;
    try {
      target = await this.resolveDirectory(remotePath, true);
    } catch (error) {
      throw error instanceof StorageError ? error : denied(error, remotePath);
    }
    // A fixed name, so that a crash leaves something a later cleanup can recognise. Backup names are unique.
    const temporary = `${target}.partial`;
    try {
      let transferred = 0;
      await pipeline(
        createReadStream(localPath).on("data", (chunk) => {
          transferred += chunk.length;
          options.onProgress?.(transferred);
        }),
        createWriteStream(temporary, { mode: FILE_MODE }),
        { signal: options.signal },
      );
      // On disk before it gets its final name, so that a crash can't leave a truncated "finished" file.
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof StorageError || (error as Error).name === "AbortError") {
        throw error;
      }
      throw denied(error, remotePath);
    }
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    const source = await this.resolveDirectory(remotePath, false);
    await this.refuseLink(source, remotePath);
    let transferred = 0;
    await pipeline(
      createReadStream(source).on("data", (chunk) => {
        transferred += chunk.length;
        options.onProgress?.(transferred);
      }),
      createWriteStream(localPath, { mode: FILE_MODE }),
      { signal: options.signal },
    );
  }

  /** A link planted in a backup folder would otherwise make the panel read anywhere on the disk. */
  private async refuseLink(absolute: string, remotePath: string): Promise<void> {
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new StorageError("not_found", `${remotePath} does not exist.`);
      }
      throw denied(error, remotePath);
    });
    if (!info.isFile()) {
      throw new StorageError("failed", `${remotePath} is not a regular file.`);
    }
  }

  async stat(remotePath: string): Promise<RemoteFile | null> {
    let absolute: string;
    try {
      absolute = await this.resolveDirectory(remotePath, false);
    } catch (error) {
      if (error instanceof StorageError && error.kind === "not_found") {
        return null;
      }
      throw error;
    }
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw denied(error, remotePath);
    });
    if (info === null || !info.isFile()) {
      return null;
    }
    return { path: remotePath, size: info.size, modifiedAt: info.mtime };
  }

  async *list(prefix: string): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    yield* this.walk(join(this.root, prefix), prefix);
  }

  private async *walk(directory: string, relative: string): AsyncGenerator<RemoteFile> {
    const entries = await opendir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw denied(error, relative);
    });
    if (entries === null) {
      return;
    }
    for await (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      const absolute = join(directory, entry.name);
      // Links are skipped, not followed: they can't be something the panel wrote.
      if (entry.isDirectory()) {
        yield* this.walk(absolute, child);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        yield { path: child, size: info.size, modifiedAt: info.mtime };
      }
    }
  }

  async remove(remotePath: string): Promise<void> {
    let absolute: string;
    try {
      absolute = await this.resolveDirectory(remotePath, false);
    } catch (error) {
      if (error instanceof StorageError && error.kind === "not_found") {
        return;
      }
      throw error;
    }
    const info = await lstat(absolute).catch(() => null);
    if (info === null) {
      return;
    }
    if (!info.isFile()) {
      throw new StorageError("failed", `${remotePath} is not a regular file, so it was left alone.`);
    }
    await rm(absolute, { force: true }).catch((error: unknown) => {
      throw denied(error, remotePath);
    });
  }
}
