import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerDriver } from "../core/docker";
import { Redactor, ToolNotFoundError, type ToolRunner } from "../core/tools";
import {
  type PendingRestore,
  pendingRestoreFile,
  restoreDirectory,
  restoreDumpsDirectory,
} from "../features/server-backup/pending";
import { PANEL_SWARM_SERVICE } from "./specs";

/**
 * Puts a server backup back on this server, before setup starts the panel on it: the panel's state,
 * its key and every volume's files go where they were, and each database's export waits in
 * `restore/dumps` for the panel, which imports them and redeploys what was running once it starts.
 */

export class RestoreError extends Error {}

export interface RestoreBackupOptions {
  /** A snapshot id, whole or its first characters, or `latest`. */
  snapshot: string;
  /** Goes ahead on a server whose panel already has accounts. Its state is moved aside, never deleted. */
  force: boolean;
}

export interface RestoreBackupDeps {
  tools: ToolRunner;
  docker: Pick<DockerDriver, "inspectService">;
  dataDir: string;
  databaseFile: string;
  secretKeyFile: string;
  /** Where restic and the destination's keys come from: RESTIC_* and AWS_* variables. */
  env: Readonly<Record<string, string | undefined>>;
  hasAccounts: () => boolean;
  log: (line: string) => void;
  now: () => number;
}

/** What restic and an S3-compatible destination read from the environment. */
const PASSED_THROUGH = [
  "RESTIC_REPOSITORY",
  "RESTIC_PASSWORD",
  "RESTIC_PASSWORD_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_DEFAULT_REGION",
];
const SECRETS = ["RESTIC_PASSWORD", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

/** Where the backup kept the panel's state, under the data directory it backed up. */
const STAGING = join("server-backup", "staging");
const RESTORE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface Snapshot {
  id: string;
  time: string;
  hostname: string;
  paths: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resticRunner(deps: RestoreBackupDeps) {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(deps.dataDir, "server-backup", "cache"),
    RESTIC_CACHE_DIR: join(deps.dataDir, "server-backup", "cache"),
  };
  const redact = new Redactor();
  for (const name of PASSED_THROUGH) {
    const value = deps.env[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
      if (SECRETS.includes(name)) {
        redact.addSecret(value);
      }
    }
  }
  return async (args: readonly string[], options: { timeoutMs?: number; echo?: boolean } = {}) => {
    const lines: string[] = [];
    let result: Awaited<ReturnType<ToolRunner["run"]>>;
    try {
      result = await deps.tools.run({
        command: "restic",
        args,
        env,
        redact,
        timeoutMs: options.timeoutMs ?? 5 * 60_000,
        onLine: (line) => {
          lines.push(line);
          if (options.echo === true) {
            deps.log(line);
          }
        },
      });
    } catch (error) {
      if (error instanceof ToolNotFoundError) {
        throw new RestoreError(
          "restic is not in this image: use a version of Opsifier that has server backups.",
        );
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      const detail =
        result.tail.filter((line) => !line.startsWith("{")).at(-1) ?? `exit code ${result.exitCode}`;
      throw new RestoreError(`restic ${args[0]} failed: ${detail}`);
    }
    return lines;
  };
}

/** The snapshot asked for, among those a server backup made. */
function pickSnapshot(snapshots: readonly Snapshot[], wanted: string): Snapshot {
  if (snapshots.length === 0) {
    throw new RestoreError("This repository holds no server backup.");
  }
  if (wanted === "latest") {
    return [...snapshots].sort((a, b) => b.time.localeCompare(a.time))[0] as Snapshot;
  }
  const matches = snapshots.filter((snapshot) => snapshot.id.startsWith(wanted.toLowerCase()));
  if (matches.length !== 1) {
    throw new RestoreError(
      matches.length === 0
        ? `No server backup has the id ${wanted}. The panel lists them under Settings, Server, Server backup.`
        : `Several server backups start with ${wanted}: give more of the id.`,
    );
  }
  return matches[0] as Snapshot;
}

/** The data directory the backup was taken from, read off where it kept the panel's state. */
function sourceDataDir(snapshot: Snapshot): string {
  const suffix = `/${STAGING}`;
  const staging = snapshot.paths.find((path) => path.endsWith(suffix));
  if (staging === undefined) {
    throw new RestoreError(`Snapshot ${snapshot.id.slice(0, 8)} was not made by an Opsifier server backup.`);
  }
  return staging.slice(0, -suffix.length) || "/";
}

export async function runRestoreBackup(
  options: RestoreBackupOptions,
  deps: RestoreBackupDeps,
): Promise<Snapshot | null> {
  const { dataDir } = deps;
  if ((deps.env.RESTIC_REPOSITORY ?? "") === "") {
    throw new RestoreError(
      "Set RESTIC_REPOSITORY to the backup's repository, as Settings, Server, Server backup shows it.",
    );
  }
  if ((deps.env.RESTIC_PASSWORD ?? "") === "" && (deps.env.RESTIC_PASSWORD_FILE ?? "") === "") {
    throw new RestoreError(
      "Set RESTIC_PASSWORD to the recovery key the panel showed when the backup was set up.",
    );
  }

  const pendingFile = pendingRestoreFile(dataDir);
  if (await exists(pendingFile)) {
    deps.log(
      "A backup was already put back on this server, and the panel has not finished bringing it back: setup carries on from there.",
    );
    return null;
  }
  const panel = await deps.docker.inspectService(PANEL_SWARM_SERVICE);
  if (panel !== null && (panel.spec.Mode?.Replicated?.Replicas ?? 1) > 0) {
    throw new RestoreError(
      `The panel is running on this server. Stop it first, with docker service scale ${PANEL_SWARM_SERVICE}=0, then run this again.`,
    );
  }
  if ((await exists(deps.databaseFile)) && deps.hasAccounts() && !options.force) {
    throw new RestoreError(
      `This server already has a panel with accounts. With --force, its state is moved into ${restoreDirectory(dataDir)} and the backup's takes its place.`,
    );
  }

  const restic = resticRunner(deps);
  const snapshots = JSON.parse(
    (await restic(["snapshots", "--json", "--tag", "opsifier"])).join("\n") || "[]",
  ) as Snapshot[];
  const snapshot = pickSnapshot(snapshots, options.snapshot);
  const source = sourceDataDir(snapshot);
  deps.log(`Backup of ${snapshot.hostname}, taken ${snapshot.time} (snapshot ${snapshot.id.slice(0, 8)})`);

  const work = restoreDirectory(dataDir);
  const files = join(work, "files");
  await mkdir(work, { recursive: true, mode: 0o700 });
  await rm(files, { recursive: true, force: true });
  deps.log("Downloading and decrypting it. This takes as long as the backup is big.");
  await restic(["restore", snapshot.id, "--target", files], { timeoutMs: RESTORE_TIMEOUT_MS, echo: true });

  const root = join(files, source);
  const state = join(root, STAGING, "state");
  for (const name of ["opsifier.db", "secret.key"]) {
    if (!(await exists(join(state, name)))) {
      throw new RestoreError(`The backup has no ${name}, so it cannot bring a panel back.`);
    }
  }
  try {
    const record = JSON.parse(await readFile(join(state, "setup-state.json"), "utf8")) as { image?: unknown };
    if (typeof record.image === "string") {
      deps.log(`That server ran ${record.image}. Run the same version or a later one.`);
    }
  } catch {
    // Older backups and hand-made installs have no setup record: nothing to say then.
  }
  if (source !== dataDir) {
    deps.log(
      `The backup's data was in ${source} and is now in ${dataDir}. A Local Disk destination with its own path may need changing.`,
    );
  }

  // What is in the way is moved aside, never deleted.
  const stamp = new Date(deps.now()).toISOString().replaceAll(/[:.]/g, "-");
  const aside = join(work, `previous-${stamp}`);
  const moveAside = async (path: string, name: string) => {
    if (await exists(path)) {
      await mkdir(aside, { recursive: true, mode: 0o700 });
      await rename(path, join(aside, name));
      return true;
    }
    return false;
  };
  const moved: string[] = [];
  for (const [path, name] of [
    [deps.databaseFile, "opsifier.db"],
    [`${deps.databaseFile}-wal`, "opsifier.db-wal"],
    [`${deps.databaseFile}-shm`, "opsifier.db-shm"],
    [deps.secretKeyFile, "secret.key"],
    [join(dataDir, "traefik"), "traefik"],
    [join(dataDir, "projects"), "projects"],
    [join(dataDir, "actions"), "actions"],
    [restoreDumpsDirectory(dataDir), "dumps"],
  ] as const) {
    if (await moveAside(path, name)) {
      moved.push(name);
    }
  }
  if (moved.length > 0) {
    deps.log(`Moved aside, into ${aside}: ${moved.join(", ")}`);
  }

  await rename(join(state, "opsifier.db"), deps.databaseFile);
  await chmod(deps.databaseFile, 0o600);
  await rename(join(state, "secret.key"), deps.secretKeyFile);
  await chmod(deps.secretKeyFile, 0o600);
  for (const name of ["traefik", "projects", "actions"]) {
    if (await exists(join(root, name))) {
      await rename(join(root, name), join(dataDir, name));
    }
  }
  const dumps = join(root, STAGING, "dumps");
  if (await exists(dumps)) {
    await rename(dumps, restoreDumpsDirectory(dataDir));
  } else {
    await mkdir(restoreDumpsDirectory(dataDir), { recursive: true, mode: 0o700 });
  }
  const pending: PendingRestore = {
    snapshotId: snapshot.id,
    snapshotTime: snapshot.time,
    hostname: snapshot.hostname,
  };
  await writeFile(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  await rm(files, { recursive: true, force: true });

  deps.log("The panel's state and the volumes are back.");
  deps.log(
    "Once the panel starts, it imports each database and deploys what was running: follow it under Activity.",
  );
  return snapshot;
}
