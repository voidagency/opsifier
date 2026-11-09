import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One file at a destination. `path` is relative to the provider's own root, with forward slashes. */
export interface RemoteFile {
  path: string;
  size: number;
  modifiedAt: Date | null;
}

export interface TransferOptions {
  signal?: AbortSignal;
  /** Called from time to time with how many bytes have moved so far. */
  onProgress?: (transferred: number) => void;
}

export type StorageErrorKind =
  | "unreachable"
  | "denied"
  | "not_found"
  | "host_key"
  | "disconnected"
  | "failed";

/** Everything a destination can do wrong. The message is safe to show: it never contains a secret. */
export class StorageError extends Error {
  override readonly name = "StorageError";

  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The one way the panel talks to a destination. Uploads are all-or-nothing: an interrupted upload
 * never leaves something that looks like a finished file. Implementations check every path first.
 */
export interface StorageBackend {
  /** Proves that files can be listed, written, read back and removed here. Throws a {@link StorageError}. */
  check(signal?: AbortSignal): Promise<void>;
  upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>;
  /** Writes the whole file to `localPath`, or throws and leaves nothing there. */
  download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>;
  /** Null when there is no such file. */
  stat(remotePath: string, signal?: AbortSignal): Promise<RemoteFile | null>;
  /** Every file under `prefix`, however many requests that takes. */
  list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile>;
  /** Removing a file that is already gone is not an error. */
  remove(remotePath: string, signal?: AbortSignal): Promise<void>;
}

/** The small bit written and removed to prove a destination can be written to. */
export const PROBE_CONTENT = Buffer.from("opsifier\n", "utf8");

/**
 * Sends a small file, reads it back and removes it: the operations a backup, a restore and retention
 * rely on, tried for real. Anything but getting back exactly what was sent is a failed check.
 */
export async function verifyRoundTrip(
  backend: Pick<StorageBackend, "upload" | "download" | "remove">,
  signal?: AbortSignal,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opsifier-check-"));
  const sent = join(directory, "probe");
  const received = join(directory, "probe.back");
  const name = probeName();
  try {
    await writeFile(sent, PROBE_CONTENT, { mode: 0o600 });
    await backend.upload(sent, name, { signal });
    try {
      await backend.download(name, received, { signal });
      if (!(await readFile(received)).equals(PROBE_CONTENT)) {
        throw new StorageError(
          "failed",
          "The destination gave back something other than the file it was sent.",
        );
      }
    } finally {
      await backend.remove(name, signal);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const probeName = (): string => `.opsifier-check-${randomHex(8)}`;

function randomHex(bytes: number): string {
  let out = "";
  for (let index = 0; index < bytes; index += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".." || segment.includes("\\")) {
    return false;
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** Rejects absolute paths, parent references, empty folders, control characters and backslashes. */
export function assertRemotePath(path: string): void {
  if (path === "" || path.length > 2048 || !path.split("/").every(isSafeSegment)) {
    throw new StorageError("failed", `This path is not usable: ${path}`);
  }
}

export function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export const isAbortError = (error: unknown): boolean =>
  (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";

/** The part of a network error worth telling a person, with the host name kept out of it. */
export function networkMessage(error: unknown, what: string): string {
  const code =
    (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
  switch (code) {
    case "ECONNREFUSED":
      return `${what} refused the connection.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${what} could not be found.`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
      return `${what} did not answer in time.`;
    case "ECONNRESET":
    case "EPIPE":
      return `${what} closed the connection.`;
    default:
      return `${what} could not be reached.`;
  }
}

const RETRYABLE_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/**
 * Retries work that can safely be repeated, a few times with a growing pause. `shouldRetry` decides
 * which failures are worth it: a network hiccup is, a refused password is not.
 */
export async function withRetries<T>(
  work: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === RETRYABLE_ATTEMPTS - 1) {
        throw error;
      }
      await delay(RETRY_BASE_MS * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
