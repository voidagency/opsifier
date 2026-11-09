import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createGunzip } from "node:zlib";
import {
  type BackupFormat,
  type BackupKind,
  type BackupManifest,
  type BackupScope,
  backupManifest,
  type DatabaseBackupScope,
  type DatabaseEngine,
  databaseEngineInfo,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { type ServiceInfo, type SwarmServiceSpec, waitForRollout, waitForShutdown } from "../../core/docker";
import { type OpsTarget, opsFor } from "../databases/engine-ops";
import { type ExecPlan, redactSecrets, runInDatabase } from "../databases/exec";
import { rolloutDatabase } from "../databases/rollout";
import { compileDatabaseRecord, requireDatabase } from "../databases/service";
import { saveRetainedVolume } from "../retained-volumes/repo";
import { qualifiedName } from "../services/compile";
import { saveServiceSpec } from "../services/repo";
import { requireService, type ServiceTarget } from "../services/service";
import type { StorageBackend } from "../storage-providers/backends/types";
import { findProviderRow, type ProviderRow } from "../storage-providers/repo";
import {
  BUILT_IN_PROVIDER_ID,
  backendForProvider,
  safeStorageMessage,
  toStorageError,
} from "../storage-providers/service";
import { ArchiveRefused, VolumeExtractor } from "./archive";
import {
  backupOpsFor,
  type EngineBackupOps,
  type EngineCredentials,
  type InstanceExportOps,
  majorVersionOf,
  type ServerExportOps,
  systemDatabaseFilter,
} from "./engines";
import { runBinaryExec } from "./exec-stream";
import { findBackupOfFile, insertRestore, type RestoreRow, updateRestore } from "./repo";
import {
  credentialsOf,
  DUMP_TIMEOUT_MS,
  describeFailure,
  describeScope,
  engineVersionOf,
  freeBytes,
  humanSize,
  makeWorkDir,
  manifestPathOf,
  queryEngine,
  redactorFor,
  secretsOf,
  sha256Of,
  takeDatabaseBackup,
  volumeDirectory,
} from "./run";

const RESTORE_COMPLETE_MARKER = "opsifier-restore-complete";

/** What a backup is, however it was found: from its record, from its manifest, or from both. */
interface ResolvedSource {
  kind: BackupKind;
  format: BackupFormat;
  scope: BackupScope;
  engine: DatabaseEngine | null;
  engineVersion: string | null;
  databaseName: string | null;
  volumeName: string | null;
  sha256: string;
  sizeBytes: number;
  uncompressedBytes: number | null;
}

export interface RestoreSource {
  backupId: string | null;
  provider: ProviderRow;
  remotePath: string;
  /** The expected figures from the panel's own record, when it has one. */
  recorded: ResolvedSource | null;
  /**
   * For a file named by hand, whether the caller may restore what belongs to a project. Null when
   * the caller reaches every project, or when the source is a record of the target service itself.
   */
  mayTakeFrom: ((project: string) => boolean) | null;
}

/**
 * The project a file named by hand belongs to. The panel's record comes first, since it follows a
 * service that moved, and only a file the panel has no record of is taken at its manifest's word.
 */
function ownerOfFile(
  deps: Pick<AppDeps, "db">,
  source: RestoreSource,
  manifest: BackupManifest | null,
): string | null {
  const record = findBackupOfFile(deps.db, source.provider.id, source.remotePath);
  return record?.projectName ?? manifest?.source.project ?? null;
}

/**
 * Fetches the file and proves it is the one that was stored, before anything else happens. `fits` is
 * asked first, with what the record or the manifest says, so an unusable file is never even fetched.
 */
async function fetchVerified(
  deps: AppDeps,
  source: RestoreSource,
  backend: StorageBackend,
  temp: string,
  ctx: ActionContext,
  fits: (resolved: ResolvedSource) => void,
): Promise<{ file: string; resolved: ResolvedSource }> {
  const safeError = (error: unknown): Error =>
    new Error(
      `Could not read the backup: ${safeStorageMessage(deps, source.provider, toStorageError(error))}`,
    );

  const missing = () => new Error(`The file ${source.remotePath} no longer exists at the destination.`);

  const present = await backend.stat(source.remotePath, ctx.signal).catch((error: unknown) => {
    throw safeError(error);
  });
  if (present === null) {
    throw missing();
  }

  const manifestFile = join(temp, "manifest.json");
  let manifest: BackupManifest | null = null;
  let manifestProblem: string | null = null;
  try {
    await backend.download(manifestPathOf(source.remotePath), manifestFile, { signal: ctx.signal });
    manifest = backupManifest.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  } catch (error) {
    ctx.signal.throwIfAborted();
    manifestProblem = describeFailure(error);
  }

  // Someone else's file answers exactly as an absent one does, so naming paths reveals nothing.
  if (source.mayTakeFrom !== null) {
    const owner = ownerOfFile(deps, source, manifest);
    if (owner === null || !source.mayTakeFrom(owner)) {
      throw missing();
    }
  }
  if (manifestProblem !== null) {
    ctx.log(`No usable manifest next to the file: ${manifestProblem}`);
  }

  const resolved = source.recorded ?? manifest;
  if (resolved === null) {
    throw new Error("This file has no manifest, so its integrity can't be verified. Refusing to restore it.");
  }
  if (source.recorded !== null && manifest !== null && source.recorded.sha256 !== manifest.sha256) {
    throw new Error("The manifest at the destination does not match this backup's record.");
  }
  fits(resolved);
  if (present.size !== resolved.sizeBytes) {
    throw new Error(
      `The file at the destination is ${present.size} bytes, but ${resolved.sizeBytes} were stored. Refusing to restore it.`,
    );
  }

  const file = join(temp, "backup");
  ctx.log(`Downloading ${humanSize(present.size)} from ${source.provider.name}`);
  await backend.download(source.remotePath, file, { signal: ctx.signal }).catch((error: unknown) => {
    throw safeError(error);
  });
  ctx.log("Checking the file's integrity");
  const digest = await sha256Of(file, ctx.signal);
  if (digest !== resolved.sha256) {
    throw new Error(
      `The file failed its integrity check: expected sha256:${resolved.sha256}, got sha256:${digest}.`,
    );
  }
  ctx.log(`Checksum verified: sha256:${digest}`);

  return { file, resolved };
}

function assertSameKind(resolved: ResolvedSource, kind: BackupKind): void {
  if (resolved.kind !== kind) {
    throw new Error(`This file is a ${resolved.kind} backup, so it can't be restored here.`);
  }
}

/** A volume backup goes back into a volume of the same name, and into nothing else. */
function assertFitsVolume(resolved: ResolvedSource, volumeName: string): void {
  assertSameKind(resolved, "volume");
  if (resolved.volumeName !== volumeName) {
    throw new Error(
      `This file is a backup of the volume ${resolved.volumeName ?? "with no name"}, and this restore targets ${volumeName}.`,
    );
  }
}

/** A file holds what its record or manifest says, so it can only be put back as exactly that. */
function assertSameScope(resolved: ResolvedSource, scope: BackupScope): void {
  if (resolved.scope !== scope) {
    throw new Error(`This file holds ${resolved.scope} data, and this restore is for ${scope} data.`);
  }
}

function assertVersionCompatible(
  resolved: ResolvedSource,
  engine: DatabaseEngine,
  runningVersion: string | null,
): void {
  if (resolved.engine !== engine) {
    throw new Error(
      `This backup came from ${resolved.engine ?? "another engine"}, and this database runs ${engine}.`,
    );
  }
  const from = resolved.engineVersion === null ? null : majorVersionOf(resolved.engineVersion);
  const to = runningVersion === null ? null : majorVersionOf(runningVersion);
  if (from !== null && to !== null && to < from) {
    throw new Error(
      `This backup came from version ${resolved.engineVersion} and this server runs ${runningVersion}. An export can only go to the same version or a newer one.`,
    );
  }
}

/** A small buffer for the tail of the client's stdout, where the completion marker appears. */
class TailCollector extends Writable {
  text = "";

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.text = (this.text + chunk.toString("utf8")).slice(-4096);
    callback();
  }
}

function dumpStream(file: string, gzipped: boolean): Readable {
  const source = createReadStream(file);
  if (!gzipped) {
    return source;
  }
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  // Whatever reads this may stop early: the file must not stay open behind it.
  gunzip.once("close", () => source.destroy());
  return source.pipe(gunzip);
}

/**
 * Wraps a SQL dump in one transaction and a final marker. Without the explicit COMMIT, the client
 * would quietly commit a dump that was cut short, because the end of its input looks like the end of
 * the script. The marker proves the whole script ran.
 */
async function* transactionalSql(source: AsyncIterable<Buffer>, marker: string): AsyncGenerator<Buffer> {
  yield Buffer.from("BEGIN;\n", "utf8");
  for await (const chunk of source) {
    yield chunk;
  }
  yield Buffer.from(`\nCOMMIT;\n${marker}\n`, "utf8");
}

async function* markedSql(source: AsyncIterable<Buffer>, marker: string): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    yield chunk;
  }
  yield Buffer.from(`\n${marker}\n`, "utf8");
}

/** How one kind of file gets fed to its client. */
interface ImportShape {
  gzipInPanel: boolean;
  transactional: boolean;
  /** psql proves it reached the end with `\\echo`, and the MySQL clients with a `SELECT`. */
  psqlMarker: boolean;
}

/** The longest line of accounts worth reading: names and hashes, never data. */
const MAX_ACCOUNT_LINE_BYTES = 1 << 20;

/**
 * Passes each line of the accounts at the head of an export through `rewrite`, and everything after
 * the first line `isEnd` recognises as it is. Only that head is ever split into lines: the rest can
 * hold single lines of any length, and goes through untouched in its own chunks.
 */
async function* rewritingAccounts(
  source: AsyncIterable<Buffer>,
  rewrite: (line: string) => string | null,
  isEnd: (line: string) => boolean,
): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0);
  let inAccounts = true;
  for await (const chunk of source) {
    if (!inAccounts) {
      yield chunk;
      continue;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0;
    for (;;) {
      const newline = pending.indexOf(0x0a, start);
      if (newline === -1) {
        break;
      }
      const lineStart = start;
      const line = pending.subarray(lineStart, newline).toString("utf8");
      start = newline + 1;
      if (isEnd(line)) {
        inAccounts = false;
        yield pending.subarray(lineStart);
        start = pending.length;
        break;
      }
      const kept = rewrite(line);
      if (kept !== null) {
        yield Buffer.from(`${kept}\n`, "utf8");
      }
    }
    pending = pending.subarray(start);
    if (pending.length > MAX_ACCOUNT_LINE_BYTES) {
      throw new Error("The accounts in this file are not in the form the panel expects.");
    }
  }
  if (inAccounts && pending.length > 0) {
    const kept = rewrite(pending.toString("utf8"));
    if (kept !== null) {
      yield Buffer.from(kept, "utf8");
    }
  }
}

async function feedClient(
  deps: AppDeps,
  service: string,
  plan: ExecPlan,
  shape: ImportShape,
  body: Readable | AsyncIterable<Buffer>,
  onStderr: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  let stdin: Readable;
  const tail = new TailCollector();
  if (shape.gzipInPanel) {
    const marker = shape.psqlMarker
      ? `\\echo ${RESTORE_COMPLETE_MARKER}`
      : `SELECT '${RESTORE_COMPLETE_MARKER}';`;
    const script = body as AsyncIterable<Buffer>;
    stdin = Readable.from(
      shape.transactional ? transactionalSql(script, marker) : markedSql(script, marker),
      {
        objectMode: false,
        highWaterMark: 1 << 20,
      },
    );
  } else {
    stdin = body as Readable;
  }

  const { exitCode, stdinFailed } = await runBinaryExec({
    docker: deps.docker,
    service,
    plan,
    stdin,
    stdout: shape.gzipInPanel ? tail : null,
    onStderr,
    signal,
    timeoutMs: DUMP_TIMEOUT_MS,
  });
  if (exitCode !== 0) {
    throw new Error(`The import stopped with exit code ${exitCode ?? "unknown"}.`);
  }
  if (stdinFailed) {
    throw new Error("The import ended before the whole file had been read.");
  }
  if (shape.gzipInPanel && !tail.text.includes(RESTORE_COMPLETE_MARKER)) {
    throw new Error("The import ended without finishing the file.");
  }
}

async function importDump(
  deps: AppDeps,
  service: string,
  plan: ExecPlan,
  ops: EngineBackupOps,
  file: string,
  onStderr: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  await feedClient(
    deps,
    service,
    plan,
    {
      gzipInPanel: ops.gzipInPanel,
      transactional: ops.transactional,
      psqlMarker: ops.format === "postgres-sql-gz-v1",
    },
    dumpStream(file, ops.gzipInPanel),
    onStderr,
    signal,
  );
}

/** Imports an export of a whole server or of its accounts. The panel's own account stays out of it. */
async function importServerExport(
  deps: AppDeps,
  service: string,
  exported: ServerExportOps,
  credentials: EngineCredentials,
  file: string,
  onStderr: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (exported.restoreFromLines !== undefined) {
    const lines = (await gunzipped(file)).split("\n").filter((line) => line !== "");
    const outcome = await runInDatabase(deps, service, exported.restoreFromLines(credentials, lines), {
      signal,
      timeoutMs: DUMP_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      throw new Error(`The import failed: ${redactSecrets(outcome.output, secretsOf(credentials))}`);
    }
    return;
  }
  const raw = dumpStream(file, exported.gzipInPanel);
  const rewrite = exported.rewriteAccountLine;
  const body =
    rewrite === null
      ? raw
      : rewritingAccounts(
          raw as AsyncIterable<Buffer>,
          (line) => rewrite(line, credentials.user),
          exported.isAccountsEnd ?? (() => false),
        );
  await feedClient(
    deps,
    service,
    exported.restore(credentials),
    {
      gzipInPanel: exported.gzipInPanel,
      transactional: exported.transactional,
      psqlMarker: exported.format.startsWith("postgres"),
    },
    body,
    onStderr,
    signal,
  );
}

async function gunzipped(file: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of dumpStream(file, true)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const opsTargetOf = (target: ServiceTarget, user: string, databaseName: string | null): OpsTarget => ({
  host: qualifiedName(target.projectName, target.serviceName),
  user,
  databaseName,
});

/** After the import: the engine still answers, and still accepts the panel's credentials. */
async function probeAfterRestore(
  deps: AppDeps,
  target: ServiceTarget,
  engine: DatabaseEngine,
  credentials: EngineCredentials,
  databaseName: string,
  ctx: ActionContext,
): Promise<void> {
  const service = qualifiedName(target.projectName, target.serviceName);
  const plans = opsFor(engine).probe(opsTargetOf(target, credentials.user, databaseName), {
    password: credentials.password,
    rootPassword: credentials.rootPassword,
  });
  for (const plan of plans) {
    const outcome = await runInDatabase(deps, service, plan, { timeoutMs: 30_000 });
    if (!outcome.ok) {
      throw new Error(
        `The database did not answer after the restore: ${redactSecrets(outcome.output, secretsOf(credentials))}`,
      );
    }
  }
  ctx.log("The database answers and accepts the panel's credentials");
}

export interface DatabaseRestoreRequest {
  target: ServiceTarget;
  /** A whole server has its own path, {@link performInstanceRestore}. */
  scope: Exclude<DatabaseBackupScope, "instance">;
  /** Which database. Null unless the scope is one database. */
  databaseName: string | null;
  source: RestoreSource;
  actorEmail: string | undefined;
}

function listObjectLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

async function currentObjects(
  deps: AppDeps,
  service: string,
  ops: EngineBackupOps,
  credentials: EngineCredentials,
  databaseName: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (ops.listObjects === null) {
    return null;
  }
  const lines = await queryEngine(
    deps,
    service,
    ops.listObjects(credentials, databaseName),
    "Could not list what the database holds",
    secretsOf(credentials),
    signal,
  );
  return listObjectLines(lines);
}

/**
 * Undoes a failed import on an engine that can't do it in one transaction: objects the import brought
 * in are dropped, then the safety backup taken moments earlier is loaded over what remains.
 */
async function reloadSafetyCopy(
  deps: AppDeps,
  service: string,
  ops: EngineBackupOps,
  scope: Exclude<DatabaseBackupScope, "instance">,
  credentials: EngineCredentials,
  databaseName: string,
  before: readonly string[] | null,
  safetyFile: string,
  ctx: ActionContext,
): Promise<void> {
  const redactor = redactorFor(credentials);
  if (scope === "accounts") {
    ctx.log("Loading the safety backup");
    await importServerExport(
      deps,
      service,
      ops.accounts,
      credentials,
      safetyFile,
      (line) => ctx.log(redactor.apply(line)),
      undefined,
    );
    return;
  }
  if (ops.listObjects !== null && ops.dropObjects !== null && before !== null) {
    const now = await currentObjects(deps, service, ops, credentials, databaseName);
    if (now !== null) {
      const extras = now.filter((name) => !before.includes(name));
      if (extras.length > 0) {
        ctx.log(`Removing ${extras.length} object(s) the failed import created`);
        await queryEngine(
          deps,
          service,
          ops.dropObjects(credentials, databaseName, extras),
          "Could not remove what the failed import created",
          secretsOf(credentials),
        );
      }
    }
  }
  ctx.log("Loading the safety backup");
  await importDump(
    deps,
    service,
    ops.restore(credentials, databaseName, databaseName),
    ops,
    safetyFile,
    (line) => ctx.log(redactor.apply(line)),
    undefined,
  );
}

/**
 * Checks everything once more, takes a safety backup, imports, and verifies the database afterwards.
 * Current data stays in service until the import starts. A failed import rolls back by itself on
 * Postgres, and on the other engines the safety backup is loaded straight back.
 */
export async function performDatabaseRestore(
  deps: AppDeps,
  request: DatabaseRestoreRequest,
  ctx: ActionContext,
): Promise<void> {
  const { target, scope, databaseName, source, actorEmail } = request;
  const service = qualifiedName(target.projectName, target.serviceName);
  const record = requireDatabase(deps, target);
  const { engine } = record.spec.database;
  const ops = backupOpsFor(engine);
  if (ops === null) {
    throw new Error("This engine has no backups.");
  }
  // The accounts of a server are not in a database of their own, so they have nothing to name here.
  const accounts = scope === "accounts" ? ops.accounts : null;
  const importTarget = databaseName ?? record.spec.database.databaseName ?? "admin";

  const row = insertRestore(deps.db, {
    id: nanoid(),
    projectName: target.projectName,
    serviceName: target.serviceName,
    kind: "database",
    scope,
    backupId: source.backupId,
    storageProviderName: source.provider.name,
    sourcePath: source.remotePath,
    databaseName,
    volumeName: null,
    status: "running",
    phase: "verifying",
    actorEmail: actorEmail ?? null,
    actionId: ctx.id,
    createdAt: new Date(deps.now()),
  });
  ctx.phase("verifying");
  const temp = await makeWorkDir(deps);

  let importing = false;
  let safetyFile: string | null = null;
  let before: string[] | null = null;
  const credentials = credentialsOf(deps, record);
  const redactor = redactorFor(credentials);

  const fail = (error: unknown): void => {
    updateRestore(deps.db, row.id, {
      status: ctx.signal.aborted ? "cancelled" : "failed",
      error: ctx.signal.aborted ? null : describeFailure(error),
      finishedAt: new Date(deps.now()),
    });
  };

  try {
    ctx.log(`Restore of ${source.remotePath} into ${describeScope(scope, databaseName)}`);

    // The target must exist and be running, and the backup must fit it, before anything else.
    const runningVersion = await engineVersionOf(deps, target, ops, credentials, ctx.signal);
    if (scope === "database") {
      const known = systemDatabaseFilter(
        engine,
        await queryEngine(
          deps,
          service,
          ops.listDatabases(credentials),
          "Could not list the databases on this server",
          secretsOf(credentials),
          ctx.signal,
        ),
      );
      if (!known.includes(databaseName as string) && engine !== "mongo") {
        throw new Error(`This server has no database named ${databaseName}.`);
      }
    }

    const backend = backendForProvider(deps, source.provider);
    const { file, resolved } = await fetchVerified(deps, source, backend, temp, ctx, (candidate) => {
      assertSameKind(candidate, "database");
      assertSameScope(candidate, scope);
      assertVersionCompatible(candidate, engine, runningVersion);
    });

    ctx.phase("safety");

    updateRestore(deps.db, row.id, { phase: "safety" });
    ctx.log("Taking a safety backup of the current data");
    const local = findProviderRow(deps.db, BUILT_IN_PROVIDER_ID);
    if (local === undefined) {
      throw new Error("The built-in Local Disk is missing, so no safety backup can be taken.");
    }
    safetyFile = join(temp, `safety${accounts === null ? ops.extension : accounts.extension}`);
    const safety = await takeDatabaseBackup(
      deps,
      {
        target,
        scope,
        databaseName,
        provider: local,
        directory: `safety/${target.projectName}/${target.serviceName}`,
        origin: "safety",
        configId: null,
        name: "Before restore",
        localCopy: safetyFile,
      },
      ctx,
    );
    ctx.phase("importing");
    updateRestore(deps.db, row.id, { safetyBackupId: safety.id, phase: "importing" });

    if (scope === "database") {
      before = await currentObjects(deps, service, ops, credentials, databaseName as string, ctx.signal);
    }

    ctx.log("Importing the backup");
    importing = true;
    if (accounts === null) {
      await importDump(
        deps,
        service,
        ops.restore(credentials, databaseName as string, resolved.databaseName),
        ops,
        file,
        (line) => ctx.log(redactor.apply(line)),
        ctx.signal,
      );
    } else {
      await importServerExport(
        deps,
        service,
        accounts,
        credentials,
        file,
        (line) => ctx.log(redactor.apply(line)),
        ctx.signal,
      );
    }
    importing = false;

    ctx.phase("checking");

    updateRestore(deps.db, row.id, { phase: "checking" });
    ctx.log("Checking the database");
    await probeAfterRestore(deps, target, engine, credentials, importTarget, ctx);

    updateRestore(deps.db, row.id, {
      phase: "done",
      status: "succeeded",
      finishedAt: new Date(deps.now()),
    });
    ctx.log(`Restored ${describeScope(scope, databaseName)} from ${source.remotePath}`);
  } catch (error) {
    if (importing && (accounts === null ? ops.transactional : accounts.transactional)) {
      // Nothing to put back: the transaction never committed, and the server has already undone it.
      ctx.log("The import failed and was rolled back. The database is as it was before.");
      fail(error);
      throw error;
    }
    if (importing && safetyFile !== null) {
      ctx.log(`The import failed: ${describeFailure(error)}`);
      ctx.log("Putting the previous data back");
      try {
        await reloadSafetyCopy(deps, service, ops, scope, credentials, importTarget, before, safetyFile, ctx);
        await probeAfterRestore(deps, target, engine, credentials, importTarget, ctx);
      } catch (restoreError) {
        const reason = describeFailure(restoreError);
        ctx.log(`The previous data could not be put back: ${reason}`);
        updateRestore(deps.db, row.id, {
          status: "failed",
          unresolved: true,
          error: `The import failed and the previous data could not be put back automatically. A safety backup was kept. ${reason}`,
          finishedAt: new Date(deps.now()),
        });
        throw new Error(
          `The import failed and the previous data could not be put back automatically: ${reason}. A safety backup is available in the list of backups.`,
        );
      }
      ctx.log("The previous data was put back. Nothing was lost.");
      fail(error);
      throw new Error(
        ctx.signal.aborted
          ? "The restore was cancelled and the previous data was put back."
          : `The import failed and the previous data was put back: ${describeFailure(error)}`,
      );
    }
    fail(error);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface InstanceRestoreRequest {
  target: ServiceTarget;
  source: RestoreSource;
  actorEmail: string | undefined;
}

/** Where an instance restore is put together, kept apart from the service it will replace. */
export const isolatedServerName = (restoreId: string): string => `opsifier-restore-${restoreId}`;

export const restoredVolumeName = (volume: string, restoreId: string): string =>
  `${volume}_restored_${restoreId}`;

function isolatedServerSpec(
  compiled: SwarmServiceSpec,
  engine: DatabaseEngine,
  exported: InstanceExportOps,
  name: string,
  volume: string,
  restoreId: string,
): SwarmServiceSpec {
  const container = compiled.TaskTemplate.ContainerSpec;
  const { dataPath } = databaseEngineInfo[engine];
  return {
    ...compiled,
    Name: name,
    Labels: { "opsifier.restore": restoreId },
    TaskTemplate: {
      ...compiled.TaskTemplate,
      ContainerSpec: {
        ...container,
        Env: exported.isolatedEnv(container.Env ?? []),
        Mounts: (container.Mounts ?? []).map((mount) =>
          mount.Target === dataPath ? { ...mount, Source: volume } : mount,
        ),
      },
      // No network and no published port: nothing can reach it, and it reaches nothing.
      Networks: [],
    },
    EndpointSpec: { Mode: "dnsrr" },
  };
}

/** Stops the temporary server and removes it, so that its volume is free. */
async function removeIsolatedServer(deps: AppDeps, name: string, ctx: ActionContext): Promise<void> {
  const swarm = await deps.docker.inspectService(name);
  if (swarm === null) {
    return;
  }
  await deps.docker.updateService(name, withReplicas(swarm.spec, 0));
  await waitForShutdown({ docker: deps.docker, timing: deps.rollout, service: name, log: ctx.log });
  await deps.docker.removeService(name);
}

/** A volume stays busy for a moment after its container goes. */
async function removeRestoredVolume(
  deps: AppDeps,
  target: ServiceTarget,
  volume: string,
  ctx: ActionContext,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await deps.docker.inspectVolume(volume)) === null) {
      return;
    }
    try {
      await deps.docker.removeVolume(volume);
      return;
    } catch {
      await sleep(deps.rollout.pollMs);
    }
  }
  // Better a volume nobody needs in the Storage list than one that only Docker knows about.
  saveRetainedVolume(deps.db, {
    name: volume,
    kind: "database",
    projectName: target.projectName,
    serviceName: target.serviceName,
    retainedAt: new Date(deps.now()),
  });
  ctx.log(`The volume ${volume} is still in use. It stays under Monitor, Storage until it is deleted.`);
}

function pointDatabaseAtVolume(deps: AppDeps, target: ServiceTarget, volume: string): void {
  const { spec } = requireDatabase(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...spec, database: { ...spec.database, volume } },
    new Date(deps.now()),
  );
}

/**
 * Puts a whole server back from a backup of it. The backup goes into a new, empty server on a new
 * volume, with no network, where nothing can get in its way, and the real service only moves over
 * to it once the import has succeeded and the old contents are safe. The old volume is kept: it is
 * the earlier copy, and the safety backup is a second one. A failure at any point leaves the
 * service exactly as it was.
 */
export async function performInstanceRestore(
  deps: AppDeps,
  request: InstanceRestoreRequest,
  ctx: ActionContext,
): Promise<void> {
  const { target, source, actorEmail } = request;
  const record = requireDatabase(deps, target);
  const { engine } = record.spec.database;
  const ops = backupOpsFor(engine);
  if (ops === null) {
    throw new Error("This engine has no backups.");
  }

  const row = insertRestore(deps.db, {
    id: nanoid()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, "0"),
    projectName: target.projectName,
    serviceName: target.serviceName,
    kind: "database",
    scope: "instance",
    backupId: source.backupId,
    storageProviderName: source.provider.name,
    sourcePath: source.remotePath,
    databaseName: null,
    volumeName: null,
    status: "running",
    phase: "verifying",
    actorEmail: actorEmail ?? null,
    actionId: ctx.id,
    createdAt: new Date(deps.now()),
  });
  const temp = await makeWorkDir(deps);
  const credentials = credentialsOf(deps, record);
  const redactor = redactorFor(credentials);
  const isolated = isolatedServerName(row.id);
  const volume = record.spec.database.volume;
  const restoredVolume = restoredVolumeName(volume, row.id);

  let isolatedExists = false;
  let isolatedWasCreated = false;
  let switched = false;
  const fail = (error: unknown): void => {
    updateRestore(deps.db, row.id, {
      status: ctx.signal.aborted ? "cancelled" : "failed",
      error: ctx.signal.aborted ? null : describeFailure(error),
      finishedAt: new Date(deps.now()),
    });
  };

  try {
    ctx.log(`Restore of ${source.remotePath} into the whole server`);
    const runningVersion = await engineVersionOf(deps, target, ops, credentials, ctx.signal);
    const backend = backendForProvider(deps, source.provider);
    const { file } = await fetchVerified(deps, source, backend, temp, ctx, (candidate) => {
      assertSameKind(candidate, "database");
      assertSameScope(candidate, "instance");
      assertVersionCompatible(candidate, engine, runningVersion);
    });

    updateRestore(deps.db, row.id, { phase: "safety" });
    ctx.log("Taking a safety backup of the current server");
    const local = findProviderRow(deps.db, BUILT_IN_PROVIDER_ID);
    if (local === undefined) {
      throw new Error("The built-in Local Disk is missing, so no safety backup can be taken.");
    }
    const safety = await takeDatabaseBackup(
      deps,
      {
        target,
        scope: "instance",
        databaseName: null,
        provider: local,
        directory: `safety/${target.projectName}/${target.serviceName}`,
        origin: "safety",
        configId: null,
        name: "Before restore",
      },
      ctx,
    );

    updateRestore(deps.db, row.id, { safetyBackupId: safety.id, phase: "staging" });
    ctx.log("Starting an empty server on a new volume, with no network");
    const compiled = compileDatabaseRecord(deps, target, record, 0, { stopped: false });
    if (compiled.swarmSpec === null) {
      throw new Error("This database could not be compiled.");
    }
    await deps.docker.createService(
      isolatedServerSpec(compiled.swarmSpec, engine, ops.instance, isolated, restoredVolume, row.id),
    );
    isolatedExists = true;
    isolatedWasCreated = true;
    await waitForRollout({
      docker: deps.docker,
      timing: deps.rollout,
      service: isolated,
      desired: 1,
      previousTaskIds: new Set(),
      signal: ctx.signal,
      log: ctx.log,
    });

    updateRestore(deps.db, row.id, { phase: "importing" });
    ctx.log("Importing the backup");
    await importServerExport(
      deps,
      isolated,
      ops.instance,
      credentials,
      file,
      (line) => ctx.log(redactor.apply(line)),
      ctx.signal,
    );
    const after = ops.instance.afterImport(credentials);
    if (after !== null) {
      const outcome = await runInDatabase(deps, isolated, after, { signal: ctx.signal, timeoutMs: 30_000 });
      if (!outcome.ok) {
        throw new Error(
          `The panel's own account could not be set: ${redactSecrets(outcome.output, secretsOf(credentials))}`,
        );
      }
    }

    updateRestore(deps.db, row.id, { phase: "swapping" });
    ctx.log("Moving the service over to the restored server");
    await removeIsolatedServer(deps, isolated, ctx);
    isolatedExists = false;
    ctx.signal.throwIfAborted();
    pointDatabaseAtVolume(deps, target, restoredVolume);
    switched = true;
    await rolloutDatabase(deps, target, ctx);

    updateRestore(deps.db, row.id, { phase: "checking" });
    ctx.log("Checking the database");
    await probeAfterRestore(
      deps,
      target,
      engine,
      credentials,
      record.spec.database.databaseName ?? "admin",
      ctx,
    );

    saveRetainedVolume(deps.db, {
      name: volume,
      kind: "database",
      projectName: target.projectName,
      serviceName: target.serviceName,
      retainedAt: new Date(deps.now()),
    });
    ctx.log(`The previous contents stay in the volume ${volume}, listed under Monitor, Storage.`);

    updateRestore(deps.db, row.id, {
      phase: "done",
      status: "succeeded",
      finishedAt: new Date(deps.now()),
    });
    ctx.log(`Restored the whole server from ${source.remotePath}`);
  } catch (error) {
    if (isolatedExists) {
      await removeIsolatedServer(deps, isolated, ctx).catch((removeError: unknown) =>
        ctx.log(`The temporary server could not be removed: ${describeFailure(removeError)}`),
      );
    }
    if (switched) {
      ctx.log("Moving the service back to its previous volume");
      try {
        pointDatabaseAtVolume(deps, target, volume);
        // Whatever was cancelled, this has to finish, or the service is left on a volume nobody chose.
        await rolloutDatabase(deps, target, { ...ctx, signal: new AbortController().signal });
        ctx.log("The service is back on its previous volume. Nothing was lost.");
      } catch (restoreError) {
        const reason = describeFailure(restoreError);
        updateRestore(deps.db, row.id, {
          status: "failed",
          unresolved: true,
          error: `The restored server did not come up and the service could not be moved back: ${reason}. The previous contents are in the volume ${volume}, the restored ones in ${restoredVolume}.`,
          finishedAt: new Date(deps.now()),
        });
        throw new Error(
          `The restored server did not come up and the service could not be moved back: ${reason}`,
        );
      }
    }
    if (isolatedWasCreated) {
      await removeRestoredVolume(deps, target, restoredVolume, ctx);
    }
    fail(error);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export interface VolumeRestoreRequest {
  target: ServiceTarget;
  volumeName: string;
  source: RestoreSource;
  actorEmail: string | undefined;
}

const earlierCopyName = (volumeName: string, restoreId: string): string =>
  `.before-restore-${volumeName}-${restoreId}`;

const stagingName = (restoreId: string): string => `.restoring-${restoreId}`;

const replicasOf = (spec: ServiceInfo["spec"]): number => spec.Mode?.Replicated?.Replicas ?? 0;

function withReplicas(spec: ServiceInfo["spec"], replicas: number): ServiceInfo["spec"] {
  return { ...spec, Mode: { Replicated: { Replicas: replicas } } };
}

const pathExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Empties nothing: the old folder keeps its name for the earlier copy, and is only ever renamed. */
async function swapDirectories(current: string, staging: string, earlier: string): Promise<void> {
  await rename(current, earlier);
  try {
    await rename(staging, current);
  } catch (error) {
    await rename(earlier, current).catch(() => {});
    throw error;
  }
}

/**
 * Unpacks into a folder next to the volume, stops the service only for the moment of the swap, keeps
 * the old folder and starts the service again. Until the swap the volume is untouched, and any
 * problem up to that point simply discards the new folder.
 */
export async function performVolumeRestore(
  deps: AppDeps,
  request: VolumeRestoreRequest,
  ctx: ActionContext,
): Promise<void> {
  const { target, volumeName, source, actorEmail } = request;
  const record = requireService(deps, target);
  const service = qualifiedName(target.projectName, target.serviceName);
  const current = volumeDirectory(deps, target, volumeName);

  const row = insertRestore(deps.db, {
    id: nanoid(),
    projectName: target.projectName,
    serviceName: target.serviceName,
    kind: "volume",
    scope: "volume",
    backupId: source.backupId,
    storageProviderName: source.provider.name,
    sourcePath: source.remotePath,
    volumeName,
    status: "running",
    phase: "verifying",
    actorEmail: actorEmail ?? null,
    actionId: ctx.id,
    createdAt: new Date(deps.now()),
  });
  ctx.phase("verifying");
  const temp = await makeWorkDir(deps);
  const staging = join(dirname(current), stagingName(row.id));
  const earlier = join(dirname(current), earlierCopyName(volumeName, row.id));

  let swapped = false;
  let stoppedFrom: number | null = null;
  const fail = (error: unknown): void => {
    updateRestore(deps.db, row.id, {
      status: ctx.signal.aborted ? "cancelled" : "failed",
      error: ctx.signal.aborted ? null : describeFailure(error),
      finishedAt: new Date(deps.now()),
    });
  };

  try {
    ctx.log(`Restore of ${source.remotePath} into volume ${volumeName}`);
    // The checks made before queueing may be stale by now: nothing here is taken on trust.
    if (record.spec.stopped) {
      throw new Error("This service is stopped. Start it before restoring into it.");
    }
    const tasks = await deps.docker.listTasks({ service });
    if (!tasks.some((task) => task.state === "running" && task.desiredState === "running")) {
      throw new Error("This service has no running task. Deploy and start it before restoring into it.");
    }
    if (!(await pathExists(current))) {
      throw new Error("This volume has not been created yet. Deploy the service first.");
    }

    const backend = backendForProvider(deps, source.provider);
    const { file, resolved } = await fetchVerified(deps, source, backend, temp, ctx, (candidate) =>
      assertFitsVolume(candidate, volumeName),
    );

    ctx.phase("staging");

    updateRestore(deps.db, row.id, { phase: "staging" });
    if (resolved.uncompressedBytes !== null) {
      const free = await freeBytes(deps.config.dataDir);
      if (free < resolved.uncompressedBytes) {
        throw new Error(
          `Not enough disk space to unpack this backup: ${humanSize(resolved.uncompressedBytes)} is needed and ${humanSize(free)} is free.`,
        );
      }
    }

    ctx.log("Unpacking next to the volume. The application keeps running.");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const ignoreOwners = process.getuid?.() !== 0;
    if (ignoreOwners) {
      ctx.log("Not running as root, so files keep the panel's owner instead of their original one.");
    }
    const extractor = new VolumeExtractor({
      root: staging,
      maxBytes: resolved.uncompressedBytes,
      ignoreOwners,
    });
    await pipeline(createReadStream(file), createGunzip(), extractor, { signal: ctx.signal }).catch(
      (error: unknown) => {
        if (error instanceof ArchiveRefused) {
          throw new Error(`The archive was refused: ${error.message}`);
        }
        throw error;
      },
    );
    await chmod(staging, 0o777);
    ctx.log(`Unpacked ${extractor.entries} entries`);

    ctx.phase("swapping");

    updateRestore(deps.db, row.id, { phase: "swapping" });
    ctx.signal.throwIfAborted();

    const swarm = await deps.docker.inspectService(service);
    const replicas = swarm === null ? 0 : replicasOf(swarm.spec);
    const previousTaskIds =
      swarm === null
        ? new Set<string>()
        : new Set((await deps.docker.listTasks({ service })).map((task) => task.id));
    if (swarm !== null && replicas > 0) {
      updateRestore(deps.db, row.id, { previousReplicas: replicas });
      stoppedFrom = replicas;
      ctx.log(`Stopping ${service} for the swap`);
      await deps.docker.updateService(service, withReplicas(swarm.spec, 0));
      await waitForShutdown({
        docker: deps.docker,
        timing: deps.rollout,
        service,
        signal: ctx.signal,
        log: ctx.log,
      });
    }

    await swapDirectories(current, staging, earlier);
    swapped = true;
    ctx.phase("starting");
    updateRestore(deps.db, row.id, { earlierCopy: earlierCopyName(volumeName, row.id), phase: "starting" });
    ctx.log(`The old contents stay in ${earlierCopyName(volumeName, row.id)}`);

    if (stoppedFrom !== null && swarm !== null) {
      const again = await deps.docker.inspectService(service);
      if (again !== null) {
        ctx.log(`Starting ${service} again`);
        await deps.docker.updateService(service, withReplicas(again.spec, stoppedFrom));
        await waitForRollout({
          docker: deps.docker,
          timing: deps.rollout,
          service,
          desired: stoppedFrom,
          previousTaskIds,
          log: ctx.log,
        });
        stoppedFrom = null;
      }
    }

    updateRestore(deps.db, row.id, {
      phase: "done",
      status: "succeeded",
      finishedAt: new Date(deps.now()),
    });
    ctx.log(`Restored volume ${volumeName}`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (stoppedFrom !== null) {
      try {
        ctx.log("Bringing the service back up");
        const swarm = await deps.docker.inspectService(service);
        if (swarm !== null) {
          await deps.docker.updateService(service, withReplicas(swarm.spec, stoppedFrom));
        }
      } catch (restartError) {
        ctx.log(`The service could not be started again: ${describeFailure(restartError)}`);
      }
    }
    if (swapped) {
      ctx.log("The files were restored, but the service did not come back. Deploy it again to finish.");
    }
    fail(error);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * At boot, for a restore the panel died in the middle of. A volume's folder names say exactly where
 * it stopped, so it is finished or rolled back. A database gives no such signal, so it stays blocked
 * until a person has checked it: guessing could lose data.
 */
export async function recoverInterruptedRestores(deps: AppDeps, rows: readonly RestoreRow[]): Promise<void> {
  for (const row of rows) {
    try {
      if (row.kind === "volume") {
        await recoverVolumeRestore(deps, row);
      } else if (row.scope === "instance") {
        await recoverInstanceRestore(deps, row);
      } else {
        recoverDatabaseRestore(deps, row);
      }
    } catch (error) {
      deps.logger.error({ err: error, restore: row.id }, "Could not settle an interrupted restore");
      updateRestore(deps.db, row.id, {
        status: "failed",
        unresolved: true,
        error: `The panel restarted during this restore and could not work out where it stopped: ${describeFailure(error)}`,
        finishedAt: new Date(deps.now()),
      });
    }
  }
}

const RESTARTED = "The panel restarted during this restore.";

/** Before the swap the real service never changed, and what was prepared for it can simply go. */
async function recoverInstanceRestore(deps: AppDeps, row: RestoreRow): Promise<void> {
  const target = { projectName: row.projectName, serviceName: row.serviceName };
  const finishedAt = new Date(deps.now());
  if (row.phase === "swapping" || row.phase === "starting" || row.phase === "checking") {
    const record = requireDatabase(deps, target);
    updateRestore(deps.db, row.id, {
      status: "failed",
      unresolved: true,
      error: `${RESTARTED} The database was being moved to its restored volume and now uses ${record.spec.database.volume}. Check that it is the right one.`,
      finishedAt,
    });
    deps.logger.warn({ restore: row.id, phase: row.phase }, "An instance restore needs a person");
    return;
  }

  const isolated = isolatedServerName(row.id);
  if ((await deps.docker.inspectService(isolated)) !== null) {
    await deps.docker.removeService(isolated);
  }
  const record = requireDatabase(deps, target);
  // Its container may take a moment to go. It stays visible under Monitor, Storage until someone deletes it.
  saveRetainedVolume(deps.db, {
    name: restoredVolumeName(record.spec.database.volume, row.id),
    kind: "database",
    projectName: row.projectName,
    serviceName: row.serviceName,
    retainedAt: finishedAt,
  });
  updateRestore(deps.db, row.id, {
    status: "failed",
    error: `${RESTARTED} Nothing had been changed yet.`,
    finishedAt,
  });
}

function recoverDatabaseRestore(deps: AppDeps, row: RestoreRow): void {
  const finishedAt = new Date(deps.now());
  if (row.phase === "verifying" || row.phase === "safety") {
    updateRestore(deps.db, row.id, {
      status: "failed",
      error: `${RESTARTED} Nothing had been changed yet.`,
      finishedAt,
    });
    return;
  }
  const detail =
    row.safetyBackupId === null
      ? ""
      : " Use the safety backup to put the previous data back, or confirm the current data is fine.";
  updateRestore(deps.db, row.id, {
    status: "failed",
    unresolved: true,
    error: `${RESTARTED} The database may hold either the old or the restored data.${detail}`,
    finishedAt,
  });
  deps.logger.warn(
    { restore: row.id, phase: row.phase },
    "A database restore was interrupted and needs a person",
  );
}

async function recoverVolumeRestore(deps: AppDeps, row: RestoreRow): Promise<void> {
  if (row.volumeName === null) {
    throw new Error("A volume restore without a volume name cannot be recovered.");
  }
  const target = { projectName: row.projectName, serviceName: row.serviceName };
  const service = qualifiedName(target.projectName, target.serviceName);
  const current = volumeDirectory(deps, target, row.volumeName);
  const staging = join(dirname(current), stagingName(row.id));
  const earlier = join(dirname(current), earlierCopyName(row.volumeName, row.id));

  const hasCurrent = await pathExists(current);
  const hasStaging = await pathExists(staging);
  const hasEarlier = await pathExists(earlier);

  const startAgain = async (replicas: number): Promise<void> => {
    const swarm = await deps.docker.inspectService(service);
    if (swarm !== null && replicasOf(swarm.spec) === 0 && replicas > 0) {
      await deps.docker.updateService(service, withReplicas(swarm.spec, replicas));
    }
  };

  const finishedAt = new Date(deps.now());

  // Rule out the states that can't come from this code first: they would mean someone else moved folders.
  if (!hasCurrent && !hasEarlier) {
    throw new Error("Neither the volume nor its earlier copy can be found.");
  }

  if (hasCurrent && hasEarlier) {
    // The swap finished. Only the service's restart, and the row, are unfinished.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (row.previousReplicas !== null) {
      await startAgain(row.previousReplicas);
    }
    updateRestore(deps.db, row.id, {
      status: "succeeded",
      phase: "done",
      earlierCopy: earlierCopyName(row.volumeName, row.id),
      error: null,
      finishedAt,
    });
    deps.logger.warn({ restore: row.id }, "Finished a volume restore interrupted after its swap");
    return;
  }

  if (!hasCurrent && hasEarlier) {
    // Died between the two renames: the old folder goes back and the restore is reported as failed.
    await rename(earlier, current);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (row.previousReplicas !== null) {
      await startAgain(row.previousReplicas);
    }
    updateRestore(deps.db, row.id, {
      status: "failed",
      error: `${RESTARTED} The volume was left as it was.`,
      finishedAt,
    });
    return;
  }

  // The swap never happened. Whatever was unpacked is thrown away and the volume is untouched.
  if (hasStaging) {
    await rm(staging, { recursive: true, force: true });
  }
  if (row.previousReplicas !== null) {
    await startAgain(row.previousReplicas);
  }
  updateRestore(deps.db, row.id, {
    status: "failed",
    error: `${RESTARTED} The volume was left as it was.`,
    finishedAt,
  });
}
