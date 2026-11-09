import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../../core/config";

/**
 * What the panel knows about an update while it can't remember anything else: this file outlives the
 * process that started the update, and is read by whichever version starts next. It is plain JSON on
 * disk and needs no database, because the first thing it may have to do is replace the database.
 */

export type JournalKind = "update" | "rollback";
export type JournalState = "applying" | "verifying" | "succeeded" | "failed" | "rolled-back";

export interface UpdateJournal {
  id: string;
  /** The Action showing this update. Whichever process concludes it reads it from here. */
  actionId: string | null;
  kind: JournalKind;
  state: JournalState;
  fromVersion: string;
  fromImage: string;
  toVersion: string;
  toImage: string;
  /** The delivered image, once it has been pulled. */
  digest: string | null;
  sizeBytes: number | null;
  /** The saved copy of the state, and how many migrations it had seen. */
  snapshotId: string;
  migrationsAtSnapshot: number;
  /** For a rollback: put the saved copy back, because the newer version changed its schema. */
  restoreData: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Set when an update did not go through. */
  error: string | null;
  /** The version the process was on when it concluded the Action, set once that has happened. */
  concluded: boolean;
}

type Paths = Pick<Config, "dataDir">;

const updateDir = ({ dataDir }: Paths) => join(dataDir, "panel-update");
const journalFile = (paths: Paths) => join(updateDir(paths), "journal.json");
const snapshotsDir = (paths: Paths) => join(updateDir(paths), "snapshots");

export const snapshotDir = (paths: Paths, id: string): string => join(snapshotsDir(paths), id);
export const SNAPSHOT_DATABASE = "opsifier.db";
const SNAPSHOT_KEY = "secret.key";
/** The newest copies kept, so a bad update two versions back can still be undone. */
const SNAPSHOTS_KEPT = 3;

export function readJournal(paths: Paths): UpdateJournal | null {
  try {
    return JSON.parse(readFileSync(journalFile(paths), "utf8")) as UpdateJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function writeJournal(paths: Paths, journal: UpdateJournal): void {
  const file = journalFile(paths);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function clearJournal(paths: Paths): void {
  rmSync(journalFile(paths), { force: true });
}

/** Copies the key beside the database copy that was made while the key was this one. */
export function saveSnapshotKey(paths: Pick<Config, "dataDir" | "secretKeyFile">, id: string): void {
  const directory = snapshotDir(paths, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(paths.secretKeyFile)) {
    const copy = join(directory, SNAPSHOT_KEY);
    copyFileSync(paths.secretKeyFile, copy);
    chmodSync(copy, 0o600);
  }
}

export function hasSnapshot(paths: Paths, id: string): boolean {
  return existsSync(join(snapshotDir(paths, id), SNAPSHOT_DATABASE));
}

export function pruneSnapshots(paths: Paths): void {
  const root = snapshotsDir(paths);
  if (!existsSync(root)) {
    return;
  }
  const names = readdirSync(root)
    .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of names.slice(SNAPSHOTS_KEPT)) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

/**
 * Puts a saved copy back. Only ever runs with nothing using the database. The sidecars are removed
 * first, so that an interruption here can only ever be repaired by running this again.
 */
export function restoreSnapshot(
  paths: Pick<Config, "dataDir" | "databaseFile" | "secretKeyFile">,
  id: string,
): void {
  const directory = snapshotDir(paths, id);
  const database = join(directory, SNAPSHOT_DATABASE);
  if (!existsSync(database)) {
    throw new Error(`The saved copy ${id} is missing, so the panel cannot go back to it.`);
  }
  const temporary = `${paths.databaseFile}.restoring`;
  copyFileSync(database, temporary);
  chmodSync(temporary, 0o600);
  for (const sidecar of ["-wal", "-shm"]) {
    rmSync(`${paths.databaseFile}${sidecar}`, { force: true });
  }
  renameSync(temporary, paths.databaseFile);

  const key = join(directory, SNAPSHOT_KEY);
  if (existsSync(key)) {
    copyFileSync(key, paths.secretKeyFile);
    chmodSync(paths.secretKeyFile, 0o600);
  }
}

/** Only one of the versions in a journal can ever be the one reading it. */
const isOnTarget = (journal: UpdateJournal, version: string) => version === journal.toVersion;

/**
 * Runs before the database is opened, because migrations start the moment it is.
 *
 * An old version waking up under an update's journal means Swarm brought it back after the new one
 * failed: whatever the new version did to the database has to go. A rollback's target waking up is
 * the moment to put back the copy, while nothing has written to the database yet.
 */
export function restoreInterruptedUpdate(
  paths: Pick<Config, "dataDir" | "databaseFile" | "secretKeyFile" | "version">,
  logger: Pick<Logger, "warn" | "info">,
): void {
  const journal = readJournal(paths);
  if (journal === null || (journal.state !== "applying" && journal.state !== "verifying")) {
    return;
  }

  if (journal.kind === "rollback") {
    if (isOnTarget(journal, paths.version) && journal.restoreData && journal.state === "applying") {
      logger.warn({ snapshot: journal.snapshotId }, "Restoring the state saved before the update");
      restoreSnapshot(paths, journal.snapshotId);
    }
    return;
  }

  if (isOnTarget(journal, paths.version)) {
    return;
  }
  if (paths.version !== journal.fromVersion) {
    logger.warn(
      { version: paths.version, journal: journal.id },
      "An update journal names other versions than this one. Leaving it alone.",
    );
    return;
  }
  logger.warn(
    { version: paths.version, failed: journal.toVersion },
    "The update did not take. Restoring the state saved before it.",
  );
  restoreSnapshot(paths, journal.snapshotId);
  writeJournal(paths, {
    ...journal,
    state: "rolled-back",
    error: `Version ${journal.toVersion} failed to start or stay up, so Swarm went back to ${journal.fromVersion}.`,
    finishedAt: new Date().toISOString(),
  });
}
