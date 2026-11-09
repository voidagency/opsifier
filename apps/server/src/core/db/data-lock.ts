import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ConfigError } from "../config";

const LOCK_FILE = "panel.lock";

/**
 * Keeps a second panel off a data directory for as long as this one is running. The lock is an
 * exclusive transaction on a file of its own that is never committed: the kernel lets go of it when
 * the process ends, however it ends, so a crash cannot leave a stale lock behind the way a PID file
 * would, and it holds across containers, where a PID means nothing. Returns what releases it.
 */
export function lockDataDirectory(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = new Database(join(dataDir, LOCK_FILE), { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) {
      throw new ConfigError(
        `Another Opsifier panel is already using the data directory ${dataDir}. Two panels cannot share one: stop the other, or give this one its own OPSIFIER_DATA_DIR.`,
      );
    }
    throw error;
  }
  return () => lock.close();
}
