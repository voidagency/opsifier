import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { Client, type FileInfo, FileType } from "basic-ftp";
import {
  assertRemotePath,
  isAbortError,
  networkMessage,
  type RemoteFile,
  type StorageBackend,
  StorageError,
  type TransferOptions,
  verifyRoundTrip,
} from "./types";

export interface FtpBackendConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  rootPath: string;
  tls: boolean;
}

const CONNECT_TIMEOUT_MS = 20_000;

function connectionError(error: unknown): StorageError {
  const code = (error as { code?: number }).code;
  if (code === 530) {
    return new StorageError("denied", "The server refused this username or password.");
  }
  return new StorageError("unreachable", networkMessage(error, "The FTP server"));
}

function operationError(error: unknown, what: string): StorageError {
  const code = (error as { code?: number }).code;
  if (code === 550 || code === 553 || code === 530) {
    return new StorageError("denied", `The server refused to ${what}.`);
  }
  return new StorageError("failed", `The server could not ${what}: ${(error as Error).message}`);
}

/** A connection per operation: FTP servers are not known for tolerating idle ones. */
export class FtpBackend implements StorageBackend {
  constructor(private readonly config: FtpBackendConfig) {}

  private absolute(start: string, remotePath: string): string {
    const root = this.config.rootPath === "" ? start : posix.join(start, this.config.rootPath);
    return posix.join(root, remotePath);
  }

  private async withClient<T>(
    signal: AbortSignal | undefined,
    work: (client: Client, start: string) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = new Client(CONNECT_TIMEOUT_MS);
    const onAbort = () => client.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        await client.access({
          host: this.config.host,
          port: this.config.port,
          user: this.config.username,
          password: this.config.password,
          secure: this.config.tls,
        });
      } catch (error) {
        throw connectionError(error);
      }
      const start = await client.pwd();
      return await work(client, start);
    } catch (error) {
      if (signal?.aborted === true) {
        throw signal.reason ?? error;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      client.close();
    }
  }

  async check(signal?: AbortSignal): Promise<void> {
    await this.withClient(signal, async (client, start) => {
      const root = this.config.rootPath === "" ? start : posix.join(start, this.config.rootPath);
      try {
        await client.ensureDir(root);
      } catch (error) {
        throw operationError(error, "use this folder");
      }
      await client.list(root);
    });
    await verifyRoundTrip(this, signal);
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    await this.withClient(options.signal, async (client, start) => {
      const target = this.absolute(start, remotePath);
      const partial = `${target}.partial`;
      try {
        await client.ensureDir(posix.dirname(target));
      } catch (error) {
        throw operationError(error, "create the folder");
      }
      client.trackProgress((info) => options.onProgress?.(info.bytesOverall));
      try {
        await client.uploadFrom(localPath, partial);
        await client.rename(partial, target);
      } catch (error) {
        await client.remove(partial, true).catch(() => {});
        if (options.signal?.aborted === true || isAbortError(error)) {
          throw options.signal?.reason ?? error;
        }
        throw operationError(error, "store the file");
      } finally {
        client.trackProgress();
      }
    });
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    await this.withClient(options.signal, async (client, start) => {
      client.trackProgress((info) => options.onProgress?.(info.bytesOverall));
      try {
        await client.downloadTo(localPath, this.absolute(start, remotePath));
      } catch (error) {
        await rm(localPath, { force: true }).catch(() => {});
        if (options.signal?.aborted === true || isAbortError(error)) {
          throw options.signal?.reason ?? error;
        }
        const code = (error as { code?: number }).code;
        if (code === 550) {
          throw new StorageError("not_found", `${remotePath} does not exist.`);
        }
        throw operationError(error, "read the file");
      } finally {
        client.trackProgress();
      }
    });
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    assertRemotePath(remotePath);
    return this.withClient(signal, async (client, start) => {
      try {
        const size = await client.size(this.absolute(start, remotePath));
        return { path: remotePath, size, modifiedAt: null };
      } catch (error) {
        if ((error as { code?: number }).code === 550) {
          return null;
        }
        throw operationError(error, "read the file's details");
      }
    });
  }

  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    const collected: RemoteFile[] = [];
    await this.withClient(signal, async (client, start) => {
      await this.walk(client, this.absolute(start, prefix), prefix, collected);
    });
    yield* collected;
  }

  private async walk(client: Client, folder: string, relative: string, out: RemoteFile[]): Promise<void> {
    let entries: FileInfo[];
    try {
      entries = await client.list(folder);
    } catch (error) {
      if ((error as { code?: number }).code === 550) {
        return;
      }
      throw operationError(error, "list the folder");
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const child = `${relative}/${entry.name}`;
      if (entry.type === FileType.Directory) {
        await this.walk(client, posix.join(folder, entry.name), child, out);
      } else if (entry.type === FileType.File) {
        out.push({ path: child, size: entry.size, modifiedAt: entry.modifiedAt ?? null });
      }
    }
  }

  async remove(remotePath: string, signal?: AbortSignal): Promise<void> {
    assertRemotePath(remotePath);
    await this.withClient(signal, async (client, start) => {
      try {
        await client.remove(this.absolute(start, remotePath), true);
      } catch (error) {
        throw operationError(error, "remove the file");
      }
    });
  }
}
