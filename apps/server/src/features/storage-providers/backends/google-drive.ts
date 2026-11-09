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

export interface GoogleDriveEndpoints {
  apiBase: string;
  uploadBase: string;
}

export const GOOGLE_DRIVE_ENDPOINTS: GoogleDriveEndpoints = {
  apiBase: "https://www.googleapis.com/drive/v3",
  uploadBase: "https://www.googleapis.com/upload/drive/v3",
};

/** Everything the panel uploads lives under one folder of the Drive, so the rest stays untouched. */
const ROOT_FOLDER_NAME = "Opsifier";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Google requires multiples of 256 KiB. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const REQUEST_ATTEMPTS = 5;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

const queryValue = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** A folder tree inside Google Drive. Paths are walked one folder at a time. */
export class GoogleDriveBackend implements StorageBackend {
  constructor(
    private readonly session: OAuthSession,
    private readonly endpoints: GoogleDriveEndpoints = GOOGLE_DRIVE_ENDPOINTS,
  ) {}

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

  private withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  private async toError(response: Response): Promise<StorageError> {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      message = parsed.error?.message ?? text;
    } catch {
      // Not JSON: keep the text as it is.
    }
    const detail = message.slice(0, 200) || `error ${response.status}`;
    if (response.status === 404) {
      return new StorageError("not_found", "This file does not exist at the destination.");
    }
    if (response.status === 403) {
      return new StorageError("denied", `Google Drive refused this: ${detail}`);
    }
    return new StorageError(
      response.status >= 500 ? "unreachable" : "failed",
      `Google Drive said: ${detail}`,
    );
  }

  private async json<T>(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<T> {
    const response = await this.call(url, init);
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as T;
  }

  /** The files in one folder matching `filter`, following every page of results. */
  private async *children(folderId: string, filter: string, signal?: AbortSignal): AsyncGenerator<DriveFile> {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `${queryValue(folderId)} in parents and trashed = false${filter === "" ? "" : ` and ${filter}`}`,
        spaces: "drive",
        pageSize: "1000",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      if (pageToken !== undefined) {
        params.set("pageToken", pageToken);
      }
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(
        `${this.endpoints.apiBase}/files?${params}`,
        { method: "GET", signal: this.withTimeout(signal, 60_000) },
      );
      yield* page.files;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
  }

  private async findChild(folderId: string, name: string, signal?: AbortSignal): Promise<DriveFile | null> {
    for await (const file of this.children(folderId, `name = ${queryValue(name)}`, signal)) {
      return file;
    }
    return null;
  }

  private async createFolder(parentId: string, name: string, signal?: AbortSignal): Promise<DriveFile> {
    return this.json<DriveFile>(`${this.endpoints.apiBase}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      signal: this.withTimeout(signal, 60_000),
    });
  }

  private async rootFolder(create: boolean, signal?: AbortSignal): Promise<string | null> {
    const found = await this.findChild("root", ROOT_FOLDER_NAME, signal);
    if (found !== null) {
      return found.id;
    }
    return create ? (await this.createFolder("root", ROOT_FOLDER_NAME, signal)).id : null;
  }

  /** Walks a chain of folder names, making the missing ones when `create` is set. */
  private async folderFor(
    names: readonly string[],
    create: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let current = await this.rootFolder(create, signal);
    for (const name of names) {
      if (current === null) {
        return null;
      }
      const child: DriveFile | null = await this.findChild(current, name, signal);
      if (child !== null) {
        current = child.mimeType === FOLDER_MIME ? child.id : null;
      } else {
        current = create ? (await this.createFolder(current, name, signal)).id : null;
      }
    }
    return current;
  }

  private splitPath(remotePath: string): { folders: string[]; name: string } {
    assertRemotePath(remotePath);
    const segments = remotePath.split("/");
    const name = segments.pop();
    if (name === undefined) {
      throw new StorageError("failed", `This path is not usable: ${remotePath}`);
    }
    return { folders: segments, name };
  }

  private async fileFor(remotePath: string, signal?: AbortSignal): Promise<DriveFile | null> {
    const { folders, name } = this.splitPath(remotePath);
    const folder = await this.folderFor(folders, false, signal);
    if (folder === null) {
      return null;
    }
    const file = await this.findChild(folder, name, signal);
    return file === null || file.mimeType === FOLDER_MIME ? null : file;
  }

  /** The address of the account the token belongs to. */
  async accountName(signal?: AbortSignal): Promise<string> {
    const about = await this.json<{ user?: { emailAddress?: string; displayName?: string } }>(
      `${this.endpoints.apiBase}/about?fields=user`,
      { method: "GET", signal: this.withTimeout(signal, 60_000) },
    );
    return about.user?.emailAddress ?? about.user?.displayName ?? "Google Drive";
  }

  async check(signal?: AbortSignal): Promise<void> {
    const root = await this.rootFolder(true, signal);
    if (root === null) {
      throw new StorageError("failed", "The backup folder could not be created.");
    }
    for await (const _file of this.children(root, "", signal)) {
      break;
    }
    await verifyRoundTrip(this, signal);
  }

  private async deleteById(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.call(`${this.endpoints.apiBase}/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: this.withTimeout(signal, 60_000),
    });
    if (!response.ok && response.status !== 404) {
      throw await this.toError(response);
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    const { folders, name } = this.splitPath(remotePath);
    const { signal } = options;
    const parent = await this.folderFor(folders, true, signal);
    if (parent === null) {
      throw new StorageError("failed", "The destination folder could not be created.");
    }

    const handle = await open(localPath, "r");
    try {
      const { size } = await handle.stat();
      const session = await this.call(`${this.endpoints.uploadBase}/files?uploadType=resumable`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "application/octet-stream",
          "x-upload-content-length": String(size),
        },
        body: JSON.stringify({ name, parents: [parent] }),
        signal: this.withTimeout(signal, 60_000),
      });
      const sessionUrl = session.headers.get("location");
      if (!session.ok || sessionUrl === null) {
        throw await this.toError(session);
      }
      await session.body?.cancel().catch(() => {});

      // The file only exists once the last chunk is in, so an interrupted upload leaves nothing.
      if (size === 0) {
        await this.putChunk(sessionUrl, Buffer.alloc(0), "bytes */0", signal);
        options.onProgress?.(0);
        return;
      }
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(CHUNK_BYTES, size - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
          throw new StorageError("failed", "The file changed while it was being uploaded.");
        }
        await this.putChunk(
          sessionUrl,
          buffer.subarray(0, length),
          `bytes ${offset}-${offset + length - 1}/${size}`,
          signal,
        );
        offset += length;
        options.onProgress?.(offset);
      }
    } finally {
      await handle.close();
    }
  }

  private async putChunk(url: string, body: Buffer, range: string, signal?: AbortSignal): Promise<void> {
    const response = await this.call(url, {
      method: "PUT",
      headers: { "content-range": range },
      body: body as RequestInit["body"],
      signal: this.withTimeout(signal, TRANSFER_TIMEOUT_MS),
    });
    // 308 means "keep going", 200 and 201 mean the file is complete.
    if (response.status !== 308 && !response.ok) {
      throw await this.toError(response);
    }
    await response.body?.cancel().catch(() => {});
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    const file = await this.fileFor(remotePath, options.signal);
    if (file === null) {
      throw new StorageError("not_found", `${remotePath} does not exist.`);
    }
    const response = await this.call(
      `${this.endpoints.apiBase}/files/${encodeURIComponent(file.id)}?alt=media`,
      {
        method: "GET",
        signal: this.withTimeout(options.signal, TRANSFER_TIMEOUT_MS),
      },
    );
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
    const file = await this.fileFor(remotePath, signal);
    return file === null
      ? null
      : {
          path: remotePath,
          size: Number(file.size ?? 0),
          modifiedAt: file.modifiedTime === undefined ? null : new Date(file.modifiedTime),
        };
  }

  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    const folder = await this.folderFor(prefix.split("/"), false, signal);
    if (folder !== null) {
      yield* this.walk(folder, prefix, signal);
    }
  }

  private async *walk(folderId: string, relative: string, signal?: AbortSignal): AsyncGenerator<RemoteFile> {
    for await (const file of this.children(folderId, "", signal)) {
      const path = `${relative}/${file.name}`;
      if (file.mimeType === FOLDER_MIME) {
        yield* this.walk(file.id, path, signal);
      } else {
        yield {
          path,
          size: Number(file.size ?? 0),
          modifiedAt: file.modifiedTime === undefined ? null : new Date(file.modifiedTime),
        };
      }
    }
  }

  async remove(remotePath: string, signal?: AbortSignal): Promise<void> {
    const file = await this.fileFor(remotePath, signal);
    if (file !== null) {
      await this.deleteById(file.id, signal);
    }
  }
}
