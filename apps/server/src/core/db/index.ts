import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export { lockDataDirectory } from "./data-lock";
export {
  isDatabaseFailure,
  isStorageFailure,
  StorageHealth,
  type StorageHealthOptions,
} from "./storage-health";
export { schema };
export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema> & { $client: Database.Database };

/** Either the database or an open transaction: repositories accept both. */
export type DbHandle = Pick<Db, "select" | "insert" | "update" | "delete">;

export interface DatabaseHandle {
  db: Db;
  close(): void;
}

/** Finds the checked-in migrations from the source tree and from a built bundle alike. */
export function findMigrationsFolder(startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  throw new Error(`No migrations folder found above ${startDir}.`);
}

/**
 * Opens the database and brings its schema up to date. A migration that fails throws, and
 * the panel refuses to boot on a half-migrated schema. Passing `null` as the folder only opens it,
 * for a process that doesn't own the schema: the panel running against it may be a different version.
 */
export function openDatabase(
  file: string,
  migrationsFolder: string | null = findMigrationsFolder(),
): DatabaseHandle {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  // The file holds password hashes and session hashes. Create it private; SQLite gives the
  // WAL and shared-memory files the same mode as the main file.
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);

  const sqlite = new Database(file, { timeout: 5000 });
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");

    const db = drizzle(sqlite, { schema });
    if (migrationsFolder !== null) {
      migrate(db, { migrationsFolder });
    }

    return { db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
