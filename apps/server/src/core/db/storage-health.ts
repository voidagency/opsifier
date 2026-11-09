import { closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { StorageFailureReason, StorageHealth as StorageHealthState } from "@opsifier/contract";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { AppError, serviceUnavailable } from "../errors";

/** How often a storage that failed is tried again, to notice as soon as it has been fixed. */
const RECHECK_MS = 5_000;
/** Big enough that a disk with a few crumbs left doesn't pass for one that has been fixed. */
const CHECK_BYTES = 256 * 1024;
const CHECK_FILE = ".storage-check";
const CHECK_KEY = "storage-check";

const SQLITE_FAILURES: ReadonlyArray<readonly [RegExp, StorageFailureReason]> = [
  [/^SQLITE_FULL/, "full"],
  [/^SQLITE_READONLY/, "read_only"],
  [/^SQLITE_(?:BUSY|LOCKED)/, "locked"],
  [/^SQLITE_(?:IOERR|CORRUPT|CANTOPEN|NOTADB|NOLFS|PROTOCOL)/, "failed"],
];

const DISK_FAILURES: Readonly<Record<string, StorageFailureReason>> = {
  ENOSPC: "full",
  EDQUOT: "full",
  EROFS: "read_only",
  EIO: "failed",
};

function codeOf(error: unknown): string {
  const { code } = (error ?? {}) as { code?: unknown };
  return typeof code === "string" ? code : "";
}

function databaseFailureReason(error: unknown): StorageFailureReason | null {
  const code = codeOf(error);
  return SQLITE_FAILURES.find(([pattern]) => pattern.test(code))?.[1] ?? null;
}

function failureReason(error: unknown): StorageFailureReason | null {
  return databaseFailureReason(error) ?? DISK_FAILURES[codeOf(error)] ?? null;
}

/** The database itself refused or lost a write. A statement that is merely wrong is not this. */
export function isDatabaseFailure(error: unknown): boolean {
  return databaseFailureReason(error) !== null;
}

/** The database or the disk under it failed, rather than the thing being attempted being wrong. */
export function isStorageFailure(error: unknown): boolean {
  return failureReason(error) !== null;
}

const FAILURE_MESSAGES: Readonly<Record<StorageFailureReason, string>> = {
  full: "The panel's disk is full, so it cannot save its state. Changes are blocked until there is room again.",
  read_only:
    "The panel's storage has become read-only, so it cannot save its state. Changes are blocked until it can be written again.",
  locked:
    "The panel's database is locked by another program, so it cannot save its state. Changes are blocked until that program lets go.",
  failed:
    "The panel could not write to its storage, so it cannot save its state. Changes are blocked until the storage is fixed.",
};

export interface StorageHealthOptions {
  client: Database.Database;
  dataDir: string;
  logger: Logger;
  now?: () => number;
}

/**
 * Keeps track of whether the panel can still record what happens. The first write of its state that
 * fails, by anyone, stops further changes, so that nothing is done which could not be written down.
 * While that lasts a real write is tried every few seconds, and the block lifts when one succeeds.
 */
export class StorageHealth {
  private readonly client: Database.Database;
  private readonly dataDir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private failure: { reason: StorageFailureReason; since: number } | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly recoveredListeners = new Set<() => void>();

  constructor(options: StorageHealthOptions) {
    this.client = options.client;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.watchStatements();
  }

  isFailing(): boolean {
    return this.failure !== null;
  }

  state(): StorageHealthState {
    return {
      writable: this.failure === null,
      reason: this.failure?.reason ?? null,
      since: this.failure === null ? null : new Date(this.failure.since).toISOString(),
    };
  }

  /** Throws the answer a request gets for a change while state cannot be written. */
  assertWritable(): void {
    if (this.failure !== null) {
      throw serviceUnavailable("storage_failing", FAILURE_MESSAGES[this.failure.reason]);
    }
  }

  /** A storage failure blocks further changes. Anything else that went wrong is none of its business. */
  report(error: unknown): boolean {
    const reason = failureReason(error);
    if (reason === null) {
      return false;
    }
    const first = this.failure === null;
    this.failure = { reason, since: this.failure?.since ?? this.now() };
    if (first) {
      this.logger.error({ err: error }, "The panel could not write its state: changes are blocked");
      // Next tick, not now: a statement can fail inside a transaction, where no check can run.
      this.schedule(0);
    }
    return true;
  }

  /** What a request should answer when this error is the reason it failed. */
  asAppError(error: Error): Error {
    if (error instanceof AppError || !this.report(error)) {
      return error;
    }
    return serviceUnavailable("storage_failing", FAILURE_MESSAGES[failureReason(error) ?? "failed"]);
  }

  onRecovered(listener: () => void): void {
    this.recoveredListeners.add(listener);
  }

  /** Tries a real write. Lifts the block if it works, and tells whoever was waiting for that. */
  check(): boolean {
    if (this.failure === null) {
      return true;
    }
    try {
      this.writeTestFile();
      this.writeTestRow();
    } catch (error) {
      this.report(error);
      this.schedule(RECHECK_MS);
      return false;
    }
    this.failure = null;
    clearTimeout(this.timer);
    this.logger.info("The panel can write its state again: changes are allowed");
    for (const listener of this.recoveredListeners) {
      listener();
    }
    return true;
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), delayMs);
    this.timer.unref();
  }

  private writeTestFile(): void {
    const file = join(this.dataDir, CHECK_FILE);
    try {
      const descriptor = openSync(file, "w", 0o600);
      try {
        if (writeSync(descriptor, Buffer.alloc(CHECK_BYTES)) < CHECK_BYTES) {
          throw Object.assign(new Error("The disk took only part of a write."), { code: "ENOSPC" });
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Committed for real, because a transaction that rolls back never finds out the disk is full. */
  private writeTestRow(): void {
    const busyTimeout = this.client.pragma("busy_timeout", { simple: true });
    this.client.pragma("busy_timeout = 0");
    try {
      this.client.transaction(() => {
        this.client
          .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 0)")
          .run(CHECK_KEY, Buffer.alloc(CHECK_BYTES));
        this.client.prepare("DELETE FROM settings WHERE key = ?").run(CHECK_KEY);
      })();
    } finally {
      this.client.pragma(`busy_timeout = ${String(busyTimeout)}`);
    }
  }

  /**
   * Every statement goes through here, so a failure counts whoever it happened to: a background sampler
   * filling the last of the disk has to stop the next deployment just as much as a request would.
   */
  private watchStatements(): void {
    const prepare = this.client.prepare.bind(this.client) as (source: string) => Database.Statement;
    this.client.prepare = ((source: string) => {
      const statement = prepare(source);
      for (const method of ["run", "get", "all"] as const) {
        const original = statement[method] as (...args: unknown[]) => unknown;
        (statement[method] as unknown) = this.watched(original.bind(statement));
      }
      return statement;
    }) as typeof this.client.prepare;

    // A transaction reaches the disk at its COMMIT, which better-sqlite3 runs itself.
    const transaction = this.client.transaction.bind(this.client);
    this.client.transaction = ((run: (...args: unknown[]) => unknown) => {
      const wrapped = transaction(run);
      return Object.assign(this.watched(wrapped), {
        default: this.watched(wrapped.default),
        deferred: this.watched(wrapped.deferred),
        immediate: this.watched(wrapped.immediate),
        exclusive: this.watched(wrapped.exclusive),
      });
    }) as typeof this.client.transaction;
  }

  private watched<Fn extends (...args: never[]) => unknown>(operation: Fn): Fn {
    return ((...args: Parameters<Fn>) => {
      try {
        return operation(...args);
      } catch (error) {
        this.report(error);
        throw error;
      }
    }) as Fn;
  }
}
