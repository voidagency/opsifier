import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors";
import {
  type DatabaseHandle,
  isDatabaseFailure,
  isStorageFailure,
  openDatabase,
  StorageHealth,
} from "./index";

const disk = vi.hoisted(() => ({ full: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (disk.full) {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      return actual.writeSync(...args);
    },
  };
});

const logger = pino({ level: "silent" });

let directory: string;
let database: DatabaseHandle;
let storage: StorageHealth;

const client = () => database.db.$client;
const failed = (code: string) => Object.assign(new Error("nope"), { code });

/** Makes the next write that needs a new page fail for real, with SQLITE_FULL. */
function fillDatabase() {
  client().pragma(`max_page_count = ${String(client().pragma("page_count", { simple: true }))}`);
}

const roomAgain = () => client().pragma("max_page_count = 1073741823");

beforeEach(() => {
  disk.full = false;
  directory = mkdtempSync(join(tmpdir(), "opsifier-storage-"));
  database = openDatabase(join(directory, "test.db"));
  storage = new StorageHealth({ client: client(), dataDir: directory, logger });
});

afterEach(() => {
  storage.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("telling a storage failure from anything else", () => {
  it.each([
    "SQLITE_FULL",
    "SQLITE_IOERR",
    "SQLITE_IOERR_WRITE",
    "SQLITE_READONLY",
    "SQLITE_READONLY_DIRECTORY",
    "SQLITE_CORRUPT",
    "SQLITE_CANTOPEN",
    "SQLITE_BUSY",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED",
    "SQLITE_NOTADB",
  ])("%s is the database failing", (code) => {
    expect(isDatabaseFailure(failed(code))).toBe(true);
    expect(isStorageFailure(failed(code))).toBe(true);
  });

  it.each(["ENOSPC", "EDQUOT", "EROFS", "EIO"])("%s is the disk failing", (code) => {
    expect(isDatabaseFailure(failed(code))).toBe(false);
    expect(isStorageFailure(failed(code))).toBe(true);
  });

  it.each([
    "SQLITE_CONSTRAINT_UNIQUE",
    "SQLITE_CONSTRAINT_FOREIGNKEY",
    "SQLITE_ERROR",
    "SQLITE_MISMATCH",
    "ENOENT",
    "EACCES",
  ])("%s is not", (code) => {
    expect(isStorageFailure(failed(code))).toBe(false);
  });

  it("does not mistake a plain error or a non-error for one", () => {
    expect(isStorageFailure(new Error("no code"))).toBe(false);
    expect(isStorageFailure(undefined)).toBe(false);
    expect(isStorageFailure("SQLITE_FULL")).toBe(false);
  });
});

describe("noticing", () => {
  it("is on whichever statement fails, even one nobody is waiting on", () => {
    fillDatabase();
    const big = "x".repeat(1024 * 1024);

    expect(() =>
      client().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('big', ?, 0)").run(big),
    ).toThrow(/full/);

    expect(storage.isFailing()).toBe(true);
  });

  it("catches a failure that only shows up at the end of a transaction", () => {
    const commitFails = () => {
      throw failed("SQLITE_IOERR_WRITE");
    };

    expect(() => client().transaction(commitFails)()).toThrow();
    expect(storage.state().reason).toBe("failed");
  });

  it.each(["deferred", "immediate", "exclusive"] as const)("catches it in a %s transaction", (kind) => {
    const commitFails = () => {
      throw failed("SQLITE_FULL");
    };

    expect(() => client().transaction(commitFails)[kind]()).toThrow();
    expect(storage.state().reason).toBe("full");
  });

  it("leaves a transaction that works as it was", () => {
    const write = client().transaction(() => {
      client().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('tx', '1', 0)").run();
      return "done";
    });

    expect(write.immediate()).toBe("done");
    expect(client().prepare("SELECT value FROM settings WHERE key = 'tx'").get()).toEqual({ value: "1" });
    expect(storage.isFailing()).toBe(false);
  });

  it("does not count a statement that was merely wrong", () => {
    client().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('one', '1', 0)").run();

    expect(() =>
      client().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('one', '1', 0)").run(),
    ).toThrow(/UNIQUE/);

    expect(storage.isFailing()).toBe(false);
  });

  it("starts healthy, with nothing to report", () => {
    expect(storage.state()).toEqual({ writable: true, reason: null, since: null });
    expect(() => storage.assertWritable()).not.toThrow();
  });

  it("says what is wrong, and since when, in the shape requests are answered with", () => {
    vi.useFakeTimers({ now: new Date("2026-06-01T10:00:00Z"), toFake: ["Date"] });
    try {
      storage = new StorageHealth({ client: client(), dataDir: directory, logger });
      storage.report(failed("SQLITE_FULL"));
    } finally {
      vi.useRealTimers();
    }

    expect(storage.state()).toEqual({ writable: false, reason: "full", since: "2026-06-01T10:00:00.000Z" });
    expect(() => storage.assertWritable()).toThrow(
      expect.objectContaining({ status: 503, code: "storage_failing" }),
    );
  });

  it.each([
    ["SQLITE_FULL", "full", /disk is full/],
    ["SQLITE_READONLY", "read_only", /read-only/],
    ["SQLITE_BUSY", "locked", /locked by another program/],
    ["SQLITE_IOERR_WRITE", "failed", /could not write/],
  ])("words %s for someone who can act on it", (code, reason, message) => {
    storage.report(failed(code));

    expect(storage.state().reason).toBe(reason);
    const refused = storage.asAppError(failed(code));
    expect(refused).toBeInstanceOf(AppError);
    expect(refused.message).toMatch(message);
  });

  it("turns only a storage failure into a 503", () => {
    const other = new Error("unrelated");

    expect(storage.asAppError(other)).toBe(other);
    expect(storage.isFailing()).toBe(false);
  });

  it("leaves a deliberate answer alone, even one that happens to carry a storage code", () => {
    const answer = new AppError(409, "SQLITE_FULL", "Not really");

    expect(storage.asAppError(answer)).toBe(answer);
    expect(storage.isFailing()).toBe(false);
  });
});

describe("finding out it has been fixed", () => {
  it("keeps refusing until a real write succeeds, then tells whoever was waiting", () => {
    const recovered = vi.fn();
    storage.onRecovered(recovered);
    fillDatabase();
    storage.report(failed("SQLITE_FULL"));

    expect(storage.check()).toBe(false);
    expect(storage.isFailing()).toBe(true);
    expect(recovered).not.toHaveBeenCalled();

    roomAgain();

    expect(storage.check()).toBe(true);
    expect(storage.isFailing()).toBe(false);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("does not take a write that fits in a page for a disk with room", () => {
    client().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('small', '1', 0)").run();
    fillDatabase();
    storage.report(failed("SQLITE_FULL"));

    client().prepare("UPDATE settings SET value = '2' WHERE key = 'small'").run();

    expect(storage.check()).toBe(false);
  });

  it("does not take a database with room for a disk with room", () => {
    disk.full = true;
    storage.report(failed("ENOSPC"));

    expect(storage.check()).toBe(false);

    disk.full = false;

    expect(storage.check()).toBe(true);
  });

  it("leaves nothing behind from checking", () => {
    storage.report(failed("SQLITE_FULL"));

    storage.check();

    expect(client().prepare("SELECT key FROM settings WHERE key = 'storage-check'").get()).toBeUndefined();
  });

  it("does not wait on a database another program is holding", () => {
    const other = new Database(join(directory, "test.db"));
    other.exec("BEGIN IMMEDIATE");
    storage.report(failed("SQLITE_BUSY"));

    const startedAt = Date.now();
    expect(storage.check()).toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(storage.state().reason).toBe("locked");
    other.exec("ROLLBACK");
    other.close();
    expect(storage.check()).toBe(true);
    expect(client().pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("recovers by itself, without anyone asking", async () => {
    const recovered = new Promise<void>((resolve) => {
      storage.onRecovered(resolve);
    });

    storage.report(failed("SQLITE_BUSY"));

    await recovered;
    expect(storage.isFailing()).toBe(false);
  });

  it("checks again until it works", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fillDatabase();
      storage.report(failed("SQLITE_FULL"));
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.isFailing()).toBe(true);

      roomAgain();
      await vi.advanceTimersByTimeAsync(5000);

      expect(storage.isFailing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
