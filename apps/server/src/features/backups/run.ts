import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, opendir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type {
  BackupFormat,
  BackupManifest,
  BackupOrigin,
  DatabaseBackupScope,
  DatabaseEngine,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { Redactor } from "../../core/tools";
import { type ExecPlan, redactSecrets, runInDatabase, SUCCESS_MARKER } from "../databases/exec";
import { type DatabaseRecord, requireDatabase, unsealSecrets } from "../databases/service";
import { qualifiedName } from "../services/compile";
import { requireService, type ServiceTarget, serviceDir } from "../services/service";
import type { StorageBackend } from "../storage-providers/backends/types";
import { findProviderRow, type ProviderRow } from "../storage-providers/repo";
import { backendForProvider, safeStorageMessage, toStorageError } from "../storage-providers/service";
import { archiveBlocks, HashingTransform, readableBlocks } from "./archive";
import {
  backupOpsFor,
  type EngineBackupOps,
  type EngineCredentials,
  serverExportOps,
  systemDatabaseFilter,
} from "./engines";
import { runBinaryExec } from "./exec-stream";
import {
  type BackupConfigRow,
  type BackupRow,
  insertBackup,
  listRetentionCandidates,
  updateBackup,
} from "./repo";

/** A dump that runs longer than this has something wrong with it. */
export const DUMP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const QUERY_TIMEOUT_MS = 60_000;
const PROGRESS_INTERVAL_MS = 10_000;

/** Beyond the estimate below, room for the file system's own overhead. */
const SPACE_MARGIN_BYTES = 128 * 1024 * 1024;
/** Dumps compress well, so half the size of the data is enough to start. A full disk is caught anyway. */
const SPACE_RATIO = 0.5;

export const MANIFEST_SUFFIX = ".manifest.json";
export const manifestPathOf = (remotePath: string): string => `${remotePath}${MANIFEST_SUFFIX}`;

export const volumeDirectory = (
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  volumeName: string,
): string => join(serviceDir(deps, target.projectName, target.serviceName), "volumes", volumeName);

export async function makeWorkDir(deps: Pick<AppDeps, "config">): Promise<string> {
  const parent = join(deps.config.dataDir, "tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, "backup-"));
}

export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export const describeFailure = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSPC") {
    return "The disk ran out of space.";
  }
  return error instanceof Error ? error.message : String(error);
};

export function credentialsOf(deps: Pick<AppDeps, "secrets">, record: DatabaseRecord): EngineCredentials {
  const { password, rootPassword } = unsealSecrets(deps, record.spec.database);
  return { user: record.spec.database.user, password, rootPassword };
}

export function redactorFor(credentials: EngineCredentials): Redactor {
  const redactor = new Redactor();
  redactor.add(credentials.password);
  if (credentials.rootPassword !== null) {
    redactor.add(credentials.rootPassword);
  }
  return redactor;
}

/** Runs a short query in the database's container and returns its output lines. */
export async function queryEngine(
  deps: Pick<AppDeps, "docker">,
  service: string,
  plan: ExecPlan,
  what: string,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const outcome = await runInDatabase(deps, service, plan, { signal, timeoutMs: QUERY_TIMEOUT_MS });
  // mongosh reading a script from stdin still prints its prompt, so every line may start with one.
  const prompt = plan.command[0] === "mongosh" ? /^[\w-]+>\s*/ : null;
  const lines = redactSecrets(outcome.output, secrets)
    .split("\n")
    .map((line) => (prompt === null ? line : line.replace(prompt, "")).trim())
    .filter((line) => line !== "");
  if (!outcome.ok) {
    throw new Error(
      `${what}: ${lines.find((line) => line !== SUCCESS_MARKER) ?? "the database did not answer."}`,
    );
  }
  return lines.filter((line) => line !== SUCCESS_MARKER);
}

function serviceNameOf(target: ServiceTarget): string {
  return qualifiedName(target.projectName, target.serviceName);
}

export async function engineVersionOf(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  ops: EngineBackupOps,
  credentials: EngineCredentials,
  signal?: AbortSignal,
): Promise<string | null> {
  const lines = await queryEngine(
    deps,
    serviceNameOf(target),
    ops.version(credentials),
    "Could not read the server's version",
    secretsOf(credentials),
    signal,
  );
  return lines.find((line) => /^\d/.test(line)) ?? null;
}

export const secretsOf = (credentials: EngineCredentials): string[] =>
  [credentials.password, credentials.rootPassword].filter((value): value is string => value !== null);

interface DumpResult {
  sizeBytes: number;
  sha256: string;
  /** Before compression, when the panel did the compressing. */
  uncompressedBytes: number | null;
}

/** Counts what goes through it, without holding on to any of it. */
class ByteCounter extends Transform {
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

/** Streams an export into a file, each plan after the last: through gzip and a hash, with bounded memory. */
async function dumpToFile(
  deps: Pick<AppDeps, "docker">,
  service: string,
  plans: readonly ExecPlan[],
  gzip: boolean,
  file: string,
  onStderr: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<DumpResult> {
  const failure = new AbortController();
  const entry = new PassThrough({ highWaterMark: 1 << 20 });
  const counter = new ByteCounter();
  const hasher = new HashingTransform();
  const output = createWriteStream(file, { mode: 0o600, flags: "wx" });

  const flowing = gzip
    ? pipeline(entry, counter, createGzip({ level: 6 }), hasher, output)
    : pipeline(entry, hasher, output);
  const written = flowing.catch((error: unknown) => {
    failure.abort(error);
    throw error;
  });
  written.catch(() => {});

  const combined = signal === undefined ? failure.signal : AbortSignal.any([signal, failure.signal]);
  try {
    for (const plan of plans) {
      const { exitCode } = await runBinaryExec({
        docker: deps.docker,
        service,
        plan,
        stdout: entry,
        onStderr,
        signal: combined,
        timeoutMs: DUMP_TIMEOUT_MS,
      });
      if (exitCode !== 0) {
        throw new Error(`The dump tool exited with code ${exitCode ?? "unknown"}.`);
      }
    }
  } catch (error) {
    entry.destroy();
    await written.catch(() => {});
    throw error;
  }

  entry.end();
  await written;
  return {
    sizeBytes: hasher.bytes,
    sha256: hasher.digest(),
    uncompressedBytes: gzip ? counter.bytes : null,
  };
}

function progressLogger(ctx: Pick<ActionContext, "log">, label: string): (bytes: number) => void {
  let last = 0;
  return (bytes) => {
    const now = Date.now();
    if (now - last >= PROGRESS_INTERVAL_MS) {
      last = now;
      ctx.log(`${label}: ${humanSize(bytes)}`);
    }
  };
}

/** The file's bytes went up. Only now is it worth saying so. */
async function verifyUpload(
  backend: StorageBackend,
  remotePath: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const uploaded = await backend.stat(remotePath, signal);
  if (uploaded === null) {
    throw new Error("The destination does not show the uploaded file.");
  }
  if (uploaded.size !== sizeBytes) {
    throw new Error(
      `The destination holds ${uploaded.size} bytes of ${sizeBytes}: the upload did not complete.`,
    );
  }
}

async function uploadBackup(
  deps: AppDeps,
  provider: ProviderRow,
  backend: StorageBackend,
  localFile: string,
  remotePath: string,
  manifest: BackupManifest,
  ctx: ActionContext,
): Promise<void> {
  ctx.phase("upload");
  ctx.log(`Uploading ${humanSize(manifest.sizeBytes)} to ${provider.name}`);
  try {
    await backend.upload(localFile, remotePath, {
      signal: ctx.signal,
      onProgress: progressLogger(ctx, "Uploaded"),
    });
    await verifyUpload(backend, remotePath, manifest.sizeBytes, ctx.signal);
    const manifestFile = `${localFile}${MANIFEST_SUFFIX}`;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await backend.upload(manifestFile, manifestPathOf(remotePath), { signal: ctx.signal });
  } catch (error) {
    await backend.remove(remotePath).catch(() => {});
    throw new Error(
      `Could not store the backup: ${safeStorageMessage(deps, provider, toStorageError(error))}`,
    );
  }
}

export function assertDisk(needed: number, free: number): void {
  if (free < needed) {
    throw new Error(
      `Not enough disk space to run this backup: about ${humanSize(needed)} is needed and ${humanSize(free)} is free.`,
    );
  }
}

async function checkSpaceForDump(
  deps: AppDeps,
  target: ServiceTarget,
  plan: ExecPlan | null,
  credentials: EngineCredentials,
  ctx: ActionContext,
): Promise<void> {
  if (plan === null) {
    return;
  }
  const lines = await queryEngine(
    deps,
    serviceNameOf(target),
    plan,
    "Could not read the size of the database",
    secretsOf(credentials),
    ctx.signal,
  );
  const estimate = Number(lines.find((line) => /^\d+$/.test(line)) ?? 0);
  const free = await freeBytes(deps.config.dataDir);
  ctx.log(`Data to export: about ${humanSize(estimate)}. Free disk space: ${humanSize(free)}`);
  assertDisk(estimate * SPACE_RATIO + SPACE_MARGIN_BYTES, free);
}

/** What one scope of an engine is written as. */
interface ScopedExport {
  format: BackupFormat;
  extension: string;
  gzipInPanel: boolean;
  plans(credentials: EngineCredentials): ExecPlan[] | Promise<ExecPlan[]>;
  sizeBytes: ExecPlan | null;
}

function scopedExport(
  deps: AppDeps,
  target: ServiceTarget,
  ops: EngineBackupOps,
  engine: DatabaseEngine,
  scope: DatabaseBackupScope,
  databaseName: string | null,
  credentials: EngineCredentials,
  ctx: ActionContext,
): ScopedExport {
  if (scope === "database") {
    const name = databaseName as string;
    return {
      format: ops.format,
      extension: ops.extension,
      gzipInPanel: ops.gzipInPanel,
      plans: () => [ops.dump(credentials, name)],
      sizeBytes: ops.sizeBytes(credentials, name),
    };
  }
  const exported = serverExportOps(ops, scope);
  return {
    format: exported.format,
    extension: exported.extension,
    gzipInPanel: exported.gzipInPanel,
    plans: async () =>
      exported.dump(
        credentials,
        systemDatabaseFilter(
          engine,
          await queryEngine(
            deps,
            serviceNameOf(target),
            ops.listDatabases(credentials),
            "Could not list the databases on this server",
            secretsOf(credentials),
            ctx.signal,
          ),
        ),
      ),
    sizeBytes: exported.sizeBytes?.(credentials) ?? null,
  };
}

/**
 * Everything a database server holds, every database and its accounts, written to a plain file in
 * `directory`: what a backup of the whole server keeps. Left uncompressed where the panel would
 * compress it, so that restic finds what did not change. Null for an engine with no export.
 */
/**
 * What a server backup calls a database's export: plain, since restic compresses and deduplicates
 * it, where the panel would otherwise have compressed it as it arrived.
 */
export function instanceExportName(serviceName: string, ops: EngineBackupOps): string {
  const { instance } = ops;
  return `${serviceName}${instance.gzipInPanel ? instance.extension.replace(/\.gz$/, "") : instance.extension}`;
}

export async function exportInstanceToFile(
  deps: AppDeps,
  target: ServiceTarget,
  directory: string,
  ctx: ActionContext,
): Promise<{ file: string; bytes: number } | null> {
  const record = requireDatabase(deps, target);
  const { engine } = record.spec.database;
  const ops = backupOpsFor(engine);
  if (ops === null) {
    return null;
  }
  const credentials = credentialsOf(deps, record);
  const scoped = scopedExport(deps, target, ops, engine, "instance", null, credentials, ctx);
  const file = join(directory, instanceExportName(target.serviceName, ops));
  const redactor = redactorFor(credentials);
  const stderrTail: string[] = [];
  const dumped = await dumpToFile(
    deps,
    serviceNameOf(target),
    await scoped.plans(credentials),
    false,
    file,
    (line) => {
      stderrTail.push(redactor.apply(line));
      if (stderrTail.length > 20) {
        stderrTail.shift();
      }
    },
    ctx.signal,
  ).catch((error: unknown) => {
    const reason = describeFailure(error);
    const detail = stderrTail.at(-1);
    throw new Error(detail === undefined ? reason : `${reason} ${detail}`);
  });
  return { file, bytes: dumped.sizeBytes };
}

/** The words for a scope, as an Action's log says it. */
export function describeScope(scope: DatabaseBackupScope, databaseName: string | null): string {
  if (scope === "database") {
    return `database ${databaseName as string}`;
  }
  return scope === "instance" ? "the whole server" : "its users and roles";
}

export interface DatabaseBackupInput {
  target: ServiceTarget;
  scope: DatabaseBackupScope;
  /** Which database. Null unless the scope is one database. */
  databaseName: string | null;
  provider: ProviderRow;
  /** A folder inside the provider. The file name is added here. */
  directory: string;
  origin: BackupOrigin;
  configId: string | null;
  name: string | null;
  /** Keeps a copy of the file here, for a restore that may need to put it straight back. */
  localCopy?: string;
}

function assertProviderReady(provider: ProviderRow): void {
  if (!provider.connected) {
    throw new Error(`The destination ${provider.name} is not connected. Connect it in Settings.`);
  }
}

/** Exports one database, stores it and records it. The row always ends with a final status. */
export async function takeDatabaseBackup(
  deps: AppDeps,
  input: DatabaseBackupInput,
  ctx: ActionContext,
): Promise<BackupRow> {
  const { target, scope, databaseName, provider, directory, origin, configId, name } = input;
  const record = requireDatabase(deps, target);
  const { engine } = record.spec.database;
  const ops = backupOpsFor(engine);
  if (ops === null) {
    throw new Error("This engine has no backups.");
  }
  assertProviderReady(provider);

  const id = nanoid();
  const createdAt = new Date(deps.now());
  const credentials = credentialsOf(deps, record);
  const scoped = scopedExport(deps, target, ops, engine, scope, databaseName, credentials, ctx);
  const fileName = `${createdAt.toISOString()}${scoped.extension}`;
  const remotePath = `${directory}/${fileName}`;
  let row = insertBackup(deps.db, {
    id,
    projectName: target.projectName,
    serviceName: target.serviceName,
    configId,
    kind: "database",
    origin,
    name,
    status: "running",
    databaseName,
    volumeName: null,
    engine,
    engineVersion: null,
    format: scoped.format,
    scope,
    storageProviderId: provider.id,
    storageProviderName: provider.name,
    path: remotePath,
    actionId: ctx.id,
    createdAt,
  });

  const temp = await makeWorkDir(deps);
  try {
    const redactor = redactorFor(credentials);
    const service = serviceNameOf(target);

    ctx.log(`Backup path: ${provider.name}: ${remotePath}`);
    const engineVersion = await engineVersionOf(deps, target, ops, credentials, ctx.signal);
    ctx.log(
      `Source: ${engine} ${engineVersion ?? "(unknown version)"}, ${describeScope(scope, databaseName)}`,
    );
    await checkSpaceForDump(deps, target, scoped.sizeBytes, credentials, ctx);

    ctx.phase("export");
    ctx.log(`Exporting ${describeScope(scope, databaseName)}`);
    const file = join(temp, `dump${scoped.extension}`);
    const stderrTail: string[] = [];
    const dumped = await dumpToFile(
      deps,
      service,
      await scoped.plans(credentials),
      scoped.gzipInPanel,
      file,
      (line) => {
        const safe = redactor.apply(line);
        stderrTail.push(safe);
        if (stderrTail.length > 20) {
          stderrTail.shift();
        }
        ctx.log(safe);
      },
      ctx.signal,
    ).catch((error: unknown) => {
      const reason = describeFailure(error);
      const detail = stderrTail.at(-1);
      throw new Error(detail === undefined ? reason : `${reason} ${detail}`);
    });
    ctx.log(
      `Exported ${humanSize(dumped.sizeBytes)} (${dumped.uncompressedBytes === null ? "compressed by the tool" : `${humanSize(dumped.uncompressedBytes)} before compression`})`,
    );
    ctx.log(`Checksum: sha256:${dumped.sha256}`);

    const manifest: BackupManifest = {
      opsifierBackup: 1,
      id,
      kind: "database",
      format: scoped.format,
      scope,
      engine,
      engineVersion,
      databaseName,
      volumeName: null,
      source: { project: target.projectName, service: target.serviceName },
      createdAt: createdAt.toISOString(),
      sizeBytes: dumped.sizeBytes,
      uncompressedBytes: dumped.uncompressedBytes,
      sha256: dumped.sha256,
      panelVersion: deps.config.version,
    };
    const backend = backendForProvider(deps, provider);
    await uploadBackup(deps, provider, backend, file, remotePath, manifest, ctx);

    if (input.localCopy !== undefined) {
      await rename(file, input.localCopy);
    }

    row = updateBackup(deps.db, id, {
      status: "succeeded",
      engineVersion,
      sizeBytes: dumped.sizeBytes,
      sha256: dumped.sha256,
      finishedAt: new Date(deps.now()),
    }) as BackupRow;
    ctx.log(`Stored: ${remotePath} (${humanSize(dumped.sizeBytes)})`);
    return row;
  } catch (error) {
    const cancelled = ctx.signal.aborted;
    updateBackup(deps.db, id, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : describeFailure(error),
      finishedAt: new Date(deps.now()),
    });
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VolumeBackupInput {
  target: ServiceTarget;
  volumeName: string;
  provider: ProviderRow;
  directory: string;
  origin: BackupOrigin;
  configId: string | null;
  name: string | null;
}

/** How many bytes a directory holds. A rough figure, good for a disk check. */
async function directoryBytes(root: string, signal: AbortSignal): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const directory = pending.pop() as string;
    for await (const entry of await opendir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        total += (await lstat(path)).size;
      }
    }
  }
  return total;
}

/** Packs one named volume, stores it and records it. An empty volume makes a valid, empty archive. */
export async function takeVolumeBackup(
  deps: AppDeps,
  input: VolumeBackupInput,
  ctx: ActionContext,
): Promise<BackupRow> {
  const { target, volumeName, provider, directory, origin, configId, name } = input;
  requireService(deps, target);
  assertProviderReady(provider);

  const id = nanoid();
  const createdAt = new Date(deps.now());
  const remotePath = `${directory}/${createdAt.toISOString()}.tar.gz`;
  let row = insertBackup(deps.db, {
    id,
    projectName: target.projectName,
    serviceName: target.serviceName,
    configId,
    kind: "volume",
    origin,
    name,
    status: "running",
    volumeName,
    format: "volume-tar-gz-v1",
    scope: "volume",
    storageProviderId: provider.id,
    storageProviderName: provider.name,
    path: remotePath,
    actionId: ctx.id,
    createdAt,
  });

  const temp = await makeWorkDir(deps);
  try {
    const source = volumeDirectory(deps, target, volumeName);
    const present = await stat(source).then(
      () => true,
      () => false,
    );
    if (!present) {
      throw new Error("This volume has not been created yet. Deploy the service first.");
    }

    ctx.log(`Backup path: ${provider.name}: ${remotePath}`);
    ctx.log(`Source: volume ${volumeName}`);
    ctx.log(
      "Files are read while the application runs, so a copy made at this moment may not be consistent.",
    );
    const size = await directoryBytes(source, ctx.signal);
    const free = await freeBytes(deps.config.dataDir);
    ctx.log(`Data to pack: about ${humanSize(size)}. Free disk space: ${humanSize(free)}`);
    assertDisk(size * SPACE_RATIO + SPACE_MARGIN_BYTES, free);

    ctx.phase("pack");
    const file = join(temp, "volume.tar.gz");
    const hasher = new HashingTransform();
    const counter = new ByteCounter();
    const blocks = readableBlocks(
      archiveBlocks(
        source,
        {
          onSkip: (path, reason) => ctx.log(`Skipped ${path}: ${reason}`),
          onChanged: (path) => ctx.log(`Changed while being read: ${path}`),
        },
        ctx.signal,
      ),
    );
    await pipeline(
      blocks,
      counter,
      createGzip({ level: 6 }),
      hasher,
      createWriteStream(file, { mode: 0o600, flags: "wx" }),
      {
        signal: ctx.signal,
      },
    );
    const sha256 = hasher.digest();
    ctx.log(`Packed ${humanSize(hasher.bytes)} (${humanSize(counter.bytes)} before compression)`);
    ctx.log(`Checksum: sha256:${sha256}`);

    const manifest: BackupManifest = {
      opsifierBackup: 1,
      id,
      kind: "volume",
      format: "volume-tar-gz-v1",
      scope: "volume",
      engine: null,
      engineVersion: null,
      databaseName: null,
      volumeName,
      source: { project: target.projectName, service: target.serviceName },
      createdAt: createdAt.toISOString(),
      sizeBytes: hasher.bytes,
      uncompressedBytes: counter.bytes,
      sha256,
      panelVersion: deps.config.version,
    };
    const backend = backendForProvider(deps, provider);
    await uploadBackup(deps, provider, backend, file, remotePath, manifest, ctx);

    row = updateBackup(deps.db, id, {
      status: "succeeded",
      sizeBytes: hasher.bytes,
      sha256,
      finishedAt: new Date(deps.now()),
    }) as BackupRow;
    ctx.log(`Stored: ${remotePath} (${humanSize(hasher.bytes)})`);
    return row;
  } catch (error) {
    const cancelled = ctx.signal.aborted;
    updateBackup(deps.db, id, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : describeFailure(error),
      finishedAt: new Date(deps.now()),
    });
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Keeps the newest `config.retention` scheduled backups of one configuration and removes the rest.
 * Rows drive this, never a listing, so nothing outside this configuration can be touched. A file that
 * cannot be removed is reported on the backup that just finished, whose outcome it does not change.
 */
export async function applyRetention(
  deps: AppDeps,
  config: BackupConfigRow,
  latest: BackupRow,
  ctx: ActionContext,
): Promise<void> {
  if (config.retention === null) {
    return;
  }
  const excess = listRetentionCandidates(deps.db, config.id).slice(config.retention);
  if (excess.length === 0) {
    return;
  }
  ctx.log(`Retention limit: ${config.retention}, deleting ${excess.length} old backup(s)`);

  const problems: string[] = [];
  let returned = 0;
  let removed = 0;
  for (const old of excess) {
    try {
      await removeStoredFile(deps, old);
      updateBackup(deps.db, old.id, { deletedAt: new Date(deps.now()) });
      returned += old.sizeBytes ?? 0;
      removed += 1;
      ctx.log(`Deleted ${old.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${old.path}: ${message}`);
      ctx.log(`Could not delete ${old.path}: ${message}`);
    }
  }
  if (removed > 0) {
    ctx.log(`Retention gave back ${humanSize(returned)} from ${removed} old backup(s)`);
  }
  if (problems.length > 0) {
    updateBackup(deps.db, latest.id, { cleanupError: problems.join("; ") });
    ctx.log("The backup itself succeeded, but old copies could not all be removed.");
  }
}

/** Removes a stored file and its manifest. A file already gone counts as removed. */
export async function removeStoredFile(deps: AppDeps, row: BackupRow): Promise<void> {
  if (row.storageProviderId === null) {
    throw new Error("Its storage provider no longer exists.");
  }
  const provider = findProviderRow(deps.db, row.storageProviderId);
  if (provider === undefined) {
    throw new Error("Its storage provider no longer exists.");
  }
  const backend = backendForProvider(deps, provider);
  await backend.remove(row.path).catch((error: unknown) => {
    throw new Error(safeStorageMessage(deps, provider, toStorageError(error)));
  });
  await backend.remove(manifestPathOf(row.path)).catch(() => {});
}

export async function sha256Of(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
