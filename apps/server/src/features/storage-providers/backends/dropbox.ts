import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isRetryableStatus, type OAuthSession, retryDelayMs } from "./oauth";
import {
  assertRemotePath,
  delay,
  isAbortError,
  type RemoteFile,
  type StorageBackend,
  StorageError,
  type TransferOptions,
  verifyRoundTrip,
} from "./types";

export interface DropboxEndpoints {
  apiBase: string;
  contentBase: string;
}

export const DROPBOX_ENDPOINTS: DropboxEndpoints = {
  apiBase: "https://api.dropboxapi.com",
  contentBase: "https://content.dropboxapi.com",
};

const CHUNK_BYTES = 8 * 1024 * 1024;
const REQUEST_ATTEMPTS = 5;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

/** Dropbox wants this header in plain ASCII, so anything else is written as a JSON escape. */
const headerJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

interface DropboxMetadata {
  ".tag": "file" | "folder" | "deleted";
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

/** A Dropbox app folder, or the whole account, as the app's permissions say. */
export class DropboxBackend implements StorageBackend {
  constructor(
    private readonly session: OAuthSession,
    private readonly endpoints: DropboxEndpoints = DROPBOX_ENDPOINTS,
    private readonly rootPath = "",
  ) {}

  private absolute(remotePath: string): string {
    return `${this.rootPath}/${remotePath}`;
  }

  /** Runs one request, waiting out rate limits and retrying server errors. */
  private async call(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.session.request(url, init);
      if (!isRetryableStatus(response.status) || attempt === REQUEST_ATTEMPTS - 1) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      await delay(retryDelayMs(response, attempt), init.signal);
    }
  }

  private async api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.call(`${this.endpoints.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === null ? "null" : JSON.stringify(body),
      signal: this.withTimeout(signal, 60_000),
    });
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as T;
  }

  private withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  private async toError(response: Response): Promise<StorageError> {
    const text = await response.text().catch(() => "");
    let summary = text;
    try {
      const parsed = JSON.parse(text) as { error_summary?: string };
      summary = parsed.error_summary ?? text;
    } catch {
      // Dropbox sends plain text for some failures.
    }
    if (summary.startsWith("path/not_found") || summary.startsWith("path_lookup/not_found")) {
      return new StorageError("not_found", "This file does not exist at the destination.");
    }
    if (summary.includes("insufficient_space")) {
      return new StorageError("failed", "This Dropbox account is out of space.");
    }
    if (response.status === 403) {
      return new StorageError("denied", "Dropbox refused this: check the app's permissions.");
    }
    return new StorageError(
      response.status >= 500 ? "unreachable" : "failed",
      `Dropbox said: ${summary.slice(0, 200) || `error ${response.status}`}`,
    );
  }

  /** The display name of the account the token belongs to. */
  async accountName(signal?: AbortSignal): Promise<string> {
    const account = await this.api<{ email?: string; name?: { display_name?: string } }>(
      "/2/users/get_current_account",
      null,
      signal,
    );
    return account.email ?? account.name?.display_name ?? "Dropbox";
  }

  async check(signal?: AbortSignal): Promise<void> {
    await this.api("/2/files/list_folder", { path: this.rootPath, limit: 1 }, signal);
    await verifyRoundTrip(this, signal);
  }

  private async content(path: string, arg: unknown, body: Buffer, signal?: AbortSignal): Promise<Response> {
    const response = await this.call(`${this.endpoints.contentBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "dropbox-api-arg": headerJson(arg),
      },
      body: body as RequestInit["body"],
      signal: this.withTimeout(signal, TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw await this.toError(response);
    }
    return response;
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const target = this.absolute(remotePath);
    const commit = { path: target, mode: "add", autorename: false, mute: true };
    const handle = await open(localPath, "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = async (offset: number, length: number) => {
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
          throw new StorageError("failed", "The file changed while it was being uploaded.");
        }
        return buffer.subarray(0, length);
      };

      if (size <= CHUNK_BYTES) {
        await this.content("/2/files/upload", commit, await read(0, size), options.signal);
        options.onProgress?.(size);
        return;
      }

      // Only the finish call makes the file appear, so an interrupted upload leaves nothing behind.
      const started = await this.content(
        "/2/files/upload_session/start",
        { close: false },
        await read(0, CHUNK_BYTES),
        options.signal,
      );
      const { session_id: sessionId } = (await started.json()) as { session_id: string };
      let offset = CHUNK_BYTES;
      options.onProgress?.(offset);
      while (size - offset > CHUNK_BYTES) {
        await this.content(
          "/2/files/upload_session/append_v2",
          { cursor: { session_id: sessionId, offset }, close: false },
          await read(offset, CHUNK_BYTES),
          options.signal,
        );
        offset += CHUNK_BYTES;
        options.onProgress?.(offset);
      }
      await this.content(
        "/2/files/upload_session/finish",
        { cursor: { session_id: sessionId, offset }, commit },
        await read(offset, size - offset),
        options.signal,
      );
      options.onProgress?.(size);
    } finally {
      await handle.close();
    }
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const response = await this.call(`${this.endpoints.contentBase}/2/files/download`, {
      method: "POST",
      headers: { "dropbox-api-arg": headerJson({ path: this.absolute(remotePath) }) },
      signal: this.withTimeout(options.signal, TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) {
      throw await this.toError(response);
    }
    let transferred = 0;
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).on("data", (chunk) => {
      transferred += chunk.length;
      options.onProgress?.(transferred);
    });
    try {
      await pipeline(body, createWriteStream(localPath, { mode: 0o600 }), { signal: options.signal });
    } catch (error) {
      await rm(localPath, { force: true }).catch(() => {});
      if (isAbortError(error)) {
        throw error;
      }
      throw new StorageError("unreachable", "The download was interrupted.");
    }
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    assertRemotePath(remotePath);
    try {
      const metadata = await this.api<DropboxMetadata>(
        "/2/files/get_metadata",
        { path: this.absolute(remotePath) },
        signal,
      );
      return metadata[".tag"] === "file"
        ? { path: remotePath, size: metadata.size ?? 0, modifiedAt: dateOf(metadata) }
        : null;
    } catch (error) {
      if (error instanceof StorageError && error.kind === "not_found") {
        return null;
      }
      throw error;
    }
  }

  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    const root = this.absolute(prefix);
    let page: { entries: DropboxMetadata[]; cursor: string; has_more: boolean };
    try {
      page = await this.api("/2/files/list_folder", { path: root, recursive: true, limit: 2000 }, signal);
    } catch (error) {
      if (error instanceof StorageError && error.kind === "not_found") {
        return;
      }
      throw error;
    }
    const strip = this.rootPath.length + 1;
    for (;;) {
      for (const entry of page.entries) {
        if (entry[".tag"] === "file" && entry.path_display !== undefined) {
          yield { path: entry.path_display.slice(strip), size: entry.size ?? 0, modifiedAt: dateOf(entry) };
        }
      }
      if (!page.has_more) {
        return;
      }
      page = await this.api("/2/files/list_folder/continue", { cursor: page.cursor }, signal);
    }
  }

  async remove(remotePath: string, signal?: AbortSignal): Promise<void> {
    assertRemotePath(remotePath);
    try {
      await this.api("/2/files/delete_v2", { path: this.absolute(remotePath) }, signal);
    } catch (error) {
      if (!(error instanceof StorageError) || error.kind !== "not_found") {
        throw error;
      }
    }
  }
}

function dateOf(metadata: DropboxMetadata): Date | null {
  return metadata.server_modified === undefined ? null : new Date(metadata.server_modified);
}
