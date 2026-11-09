import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
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

export interface SftpBackendConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  rootPath: string;
  /** The server's key fingerprint from the first connection. Null accepts and records one. */
  hostKey: string | null;
  /** Called the first time a server is seen, so its key can be remembered for next time. */
  onHostKey?: (fingerprint: string) => void;
}

const READY_TIMEOUT_MS = 20_000;
const NO_SUCH_FILE = 2;

export const fingerprintOf = (key: Buffer): string =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

interface Session {
  sftp: SFTPWrapper;
  close(): void;
}

const code = (error: unknown): number | undefined => (error as { code?: number }).code;

function connectionError(error: unknown): StorageError {
  const level = (error as { level?: string }).level;
  if (level === "client-authentication") {
    return new StorageError("denied", "The server refused this username or password.");
  }
  const message = (error as Error).message ?? "";
  if (message.includes("Timed out")) {
    return new StorageError("unreachable", "The SFTP server did not answer in time.");
  }
  return new StorageError("unreachable", networkMessage(error, "The SFTP server"));
}

function operationError(error: unknown, what: string): StorageError {
  const status = code(error);
  if (status === 3) {
    return new StorageError("denied", `The server refused to ${what}.`);
  }
  return new StorageError("failed", `The server could not ${what}: ${(error as Error).message}`);
}

/** Password-based SFTP. The server's key is remembered at first contact and checked every time after. */
export class SftpBackend implements StorageBackend {
  constructor(private readonly config: SftpBackendConfig) {}

  private absolute(remotePath: string): string {
    return this.config.rootPath === "" ? remotePath : posix.join(this.config.rootPath, remotePath);
  }

  private connect(signal?: AbortSignal): Promise<Session> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const client = new Client();
      let settled = false;
      let hostKeyProblem: StorageError | null = null;

      const finish = (work: () => void) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          work();
        }
      };
      const onAbort = () => {
        finish(() => reject(signal?.reason));
        client.end();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      client.once("ready", () => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            client.end();
            finish(() => reject(new StorageError("failed", "The server does not offer SFTP.")));
            return;
          }
          finish(() => resolve({ sftp, close: () => client.end() }));
        });
      });
      client.once("error", (error) => {
        client.end();
        finish(() => reject(hostKeyProblem ?? connectionError(error)));
      });
      client.once("close", () =>
        finish(() => reject(new StorageError("unreachable", "The SFTP connection closed."))),
      );

      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        readyTimeout: READY_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          const fingerprint = fingerprintOf(key);
          if (this.config.hostKey === null) {
            this.config.onHostKey?.(fingerprint);
            return true;
          }
          if (fingerprint === this.config.hostKey) {
            return true;
          }
          hostKeyProblem = new StorageError(
            "host_key",
            `The server's key changed. Expected ${this.config.hostKey}, got ${fingerprint}.`,
          );
          return false;
        },
      });
    });
  }

  private async withSession<T>(
    signal: AbortSignal | undefined,
    work: (session: Session) => Promise<T>,
  ): Promise<T> {
    const session = await this.connect(signal);
    const onAbort = () => session.close();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await work(session);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.close();
    }
  }

  private call<T>(run: (callback: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      run((error, value) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
  }

  private async ensureFolders(sftp: SFTPWrapper, folder: string): Promise<void> {
    if (folder === "" || folder === "." || folder === "/") {
      return;
    }
    await this.ensureFolders(sftp, posix.dirname(folder));
    try {
      await this.call<void>((callback) => sftp.mkdir(folder, (error) => callback(error, undefined)));
    } catch (error) {
      // Most servers say "failure" when the folder exists, so only a real check can tell.
      const info = await this.call<{ isDirectory(): boolean }>((callback) =>
        sftp.stat(folder, callback),
      ).catch(() => null);
      if (info === null || !info.isDirectory()) {
        throw operationError(error, `create the folder ${folder}`);
      }
    }
  }

  async check(signal?: AbortSignal): Promise<void> {
    await this.withSession(signal, async ({ sftp }) => {
      const root = this.config.rootPath === "" ? "." : this.config.rootPath;
      if (root !== ".") {
        await this.ensureFolders(sftp, root);
      }
      await this.call<unknown>((callback) => sftp.readdir(root, callback));
    });
    await verifyRoundTrip(this, signal);
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const target = this.absolute(remotePath);
    const partial = `${target}.partial`;
    await this.withSession(options.signal, async ({ sftp }) => {
      await this.ensureFolders(sftp, posix.dirname(target));
      try {
        await this.call<void>((callback) =>
          sftp.fastPut(
            localPath,
            partial,
            {
              // Fewer parallel writes than the default: slower on a fast link, kinder to small servers.
              concurrency: 8,
              chunkSize: 32_768,
              step: (transferred) => options.onProgress?.(transferred),
            },
            (error) => callback(error ?? undefined, undefined),
          ),
        );
        await this.call<void>((callback) =>
          sftp.rename(partial, target, (error) => callback(error, undefined)),
        );
      } catch (error) {
        await this.call<void>((callback) => sftp.unlink(partial, () => callback(undefined, undefined))).catch(
          () => {},
        );
        if (isAbortError(error) || options.signal?.aborted === true) {
          throw options.signal?.reason ?? error;
        }
        throw operationError(error, "store the file");
      }
    });
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const source = this.absolute(remotePath);
    await this.withSession(options.signal, async ({ sftp }) => {
      try {
        await this.call<void>((callback) =>
          sftp.fastGet(
            source,
            localPath,
            { concurrency: 8, chunkSize: 32_768, step: (transferred) => options.onProgress?.(transferred) },
            (error) => callback(error ?? undefined, undefined),
          ),
        );
      } catch (error) {
        await rm(localPath, { force: true }).catch(() => {});
        if (options.signal?.aborted === true) {
          throw options.signal.reason ?? error;
        }
        if (code(error) === NO_SUCH_FILE) {
          throw new StorageError("not_found", `${remotePath} does not exist.`);
        }
        throw operationError(error, "read the file");
      }
    });
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    assertRemotePath(remotePath);
    const target = this.absolute(remotePath);
    return this.withSession(signal, async ({ sftp }) => {
      try {
        const info = await this.call<{ size: number; mtime: number; isFile(): boolean }>((callback) =>
          sftp.lstat(target, callback),
        );
        return info.isFile()
          ? { path: remotePath, size: info.size, modifiedAt: new Date(info.mtime * 1000) }
          : null;
      } catch (error) {
        if (code(error) === NO_SUCH_FILE) {
          return null;
        }
        throw operationError(error, "read the file's details");
      }
    });
  }

  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    const session = await this.connect(signal);
    try {
      yield* this.walk(session.sftp, this.absolute(prefix), prefix);
    } finally {
      session.close();
    }
  }

  private async *walk(sftp: SFTPWrapper, folder: string, relative: string): AsyncGenerator<RemoteFile> {
    let entries: Array<{
      filename: string;
      attrs: { size: number; mtime: number; isFile(): boolean; isDirectory(): boolean };
    }>;
    try {
      entries = await this.call((callback) => sftp.readdir(folder, callback));
    } catch (error) {
      if (code(error) === NO_SUCH_FILE) {
        return;
      }
      throw operationError(error, "list the folder");
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.filename}`;
      if (entry.attrs.isDirectory()) {
        yield* this.walk(sftp, posix.join(folder, entry.filename), child);
      } else if (entry.attrs.isFile()) {
        yield { path: child, size: entry.attrs.size, modifiedAt: new Date(entry.attrs.mtime * 1000) };
      }
    }
  }

  async remove(remotePath: string, signal?: AbortSignal): Promise<void> {
    assertRemotePath(remotePath);
    const target = this.absolute(remotePath);
    await this.withSession(signal, async ({ sftp }) => {
      try {
        await this.call<void>((callback) => sftp.unlink(target, (error) => callback(error, undefined)));
      } catch (error) {
        if (code(error) !== NO_SUCH_FILE) {
          throw operationError(error, "remove the file");
        }
      }
    });
  }
}
