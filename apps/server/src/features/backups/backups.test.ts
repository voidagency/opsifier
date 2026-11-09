import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  ActionEntry,
  BackupConfigEntry,
  BackupEntry,
  BackupManifest,
  BackupsDocument,
  DatabaseDetail,
  RestoreEntry,
  ServiceDetail,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupConfigs, backupRestores, backups } from "../../core/db/schema";
import { FakeDriver } from "../../core/docker";
import { authPost, call, TEST_ORIGIN, TEST_PASSWORD } from "../../testing/harness";
import { apiErrorOf, type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../databases/testing";
import { findProviderRow } from "../storage-providers/repo";
import { BUILT_IN_PROVIDER_ID, backendForProvider } from "../storage-providers/service";
import { updateRestore } from "./repo";
import { recoverInterruptedRestores } from "./restore";
import { humanSize } from "./run";
import { BackupScheduler } from "./schedule";
import { type FakeEngine, fakeEngine, unzip } from "./testing";

let suite: DatabaseTestContext;

const service = (name = "db") => `/projects/${PROJECT}/services/${name}`;
const backupsPath = `${service()}/backups`;

async function deployedDatabase(
  engine: "postgres" | "mysql" | "mongo" | "redis" = "postgres",
): Promise<ServiceDetail> {
  return suite.deployed({
    engine,
    databaseName: engine === "mongo" || engine === "redis" ? undefined : "app",
  });
}

const backupRoot = () => join(suite.context.dataDir, "backups");

async function createConfig(overrides: Record<string, unknown> = {}) {
  const result = await suite.api<BackupConfigEntry>(`${backupsPath}/configs`, "POST", {
    kind: "database",
    enabled: true,
    schedule: "0 2 * * *",
    retention: null,
    databaseName: "app",
    storageProviderId: BUILT_IN_PROVIDER_ID,
    path: "shop/db",
    ...overrides,
  });
  return result;
}

async function document(): Promise<BackupsDocument> {
  return (await suite.api<BackupsDocument>(backupsPath)).body;
}

const latest = async () => (await document()).backups[0] as BackupEntry;

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(predicate()).toBe(true);
}

beforeEach(async () => {
  suite = await setupDatabaseTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await suite.close();
});

const dirnameOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

function tarHeader(name: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "latin1");
  block.write("0000000\0", 108, 8, "latin1");
  block.write("0000000\0", 116, 8, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  block.write("00000000000\0", 136, 12, "latin1");
  block.write("0", 156, 1, "latin1");
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

function paddedBlock(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function tmpEntries(): string[] {
  const directory = join(suite.context.dataDir, "tmp");
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("backup configurations", () => {
  beforeEach(async () => {
    await deployedDatabase();
    fakeEngine(suite.context);
  });

  it("are rejected without a destination, with the problem on the field", async () => {
    const result = await createConfig({ storageProviderId: "" });
    expect(result.status).toBe(400);
    expect(
      (result.body as unknown as { error: { fields: Record<string, string> } }).error.fields
        .storageProviderId,
    ).toBe("Required");
  });

  it("are rejected with an invalid schedule", async () => {
    const result = await createConfig({ schedule: "nonsense" });
    expect(result.status).toBe(400);
    expect(
      (result.body as unknown as { error: { fields: Record<string, string> } }).error.fields.schedule,
    ).toMatch(/five fields/);
  });

  it("refuse an unknown provider", async () => {
    const result = await createConfig({ storageProviderId: "no-such-provider" });
    expect(result.status).toBe(400);
  });

  it("refuse a path with disallowed characters", async () => {
    const result = await createConfig({ path: "bad path!" });
    expect(result.status).toBe(400);
  });

  it("refuse a retention of zero", async () => {
    const result = await createConfig({ retention: 0 });
    expect(result.status).toBe(400);
  });

  it("store the schedule and its next run, which survive being read again", async () => {
    const created = (await createConfig()).body;
    expect(created.schedule).toBe("0 2 * * *");
    expect(created.nextRunAt).not.toBeNull();
    const doc = await document();
    expect(doc.configs).toHaveLength(1);
    expect(doc.configs[0]?.nextRunAt).toBe(created.nextRunAt);
  });

  it("have no next run while disabled", async () => {
    const created = (await createConfig({ enabled: false })).body;
    expect(created.nextRunAt).toBeNull();
  });

  it("are removed without touching stored files", async () => {
    const created = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${created.id}/run`, "POST", {});
    const stored = (await latest()).path;
    expect((await suite.api(`${backupsPath}/configs/${created.id}`, "DELETE")).status).toBe(200);
    expect((await document()).configs).toEqual([]);
    expect(existsSync(join(backupRoot(), stored))).toBe(true);
  });
});

describe("a database with no backups", () => {
  it("refuses a configuration on Redis", async () => {
    await deployedDatabase("redis");
    const result = await createConfig();
    expect(result.status).toBe(409);
  });
});

describe("running a backup", () => {
  let engine: FakeEngine;

  beforeEach(async () => {
    await deployedDatabase();
    engine = fakeEngine(suite.context);
  });

  it("stores exactly one dated file with a manifest, reports path, size and checksum, and cleans up", async () => {
    const config = (await createConfig()).body;
    const action = await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {
      name: "before upgrade",
    });

    expect(action.status).toBe("succeeded");
    expect(action.title).toContain("before upgrade");
    expect(action.log).toMatch(/Backup path: Local Disk: shop\/db\/.*Z\.sql\.gz/);
    expect(action.log).toMatch(/Exported/);
    expect(action.log).toMatch(/Checksum: sha256:[0-9a-f]{64}/);
    expect(action.log).toContain("Success");

    const backup = await latest();
    expect(backup).toMatchObject({
      status: "succeeded",
      origin: "manual",
      name: "before upgrade",
      kind: "database",
      format: "postgres-sql-gz-v1",
      engine: "postgres",
      engineVersion: "18.1",
      databaseName: "app",
      storageProviderName: "Local Disk",
      restorable: true,
    });
    expect(backup.path).toMatch(/^shop\/db\/.*Z\.sql\.gz$/);

    const stored = readFileSync(join(backupRoot(), backup.path));
    expect(backup.sizeBytes).toBe(stored.length);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(backup.sha256);
    expect(unzip(stored)).toContain("CREATE TABLE items");

    const directory = readdirSync(join(backupRoot(), "shop", "db")).sort();
    expect(directory).toHaveLength(2);
    expect(directory.filter((name) => name.endsWith(".sql.gz"))).toHaveLength(1);
    const manifest = JSON.parse(
      readFileSync(join(backupRoot(), `${backup.path}.manifest.json`), "utf8"),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      opsifierBackup: 1,
      format: "postgres-sql-gz-v1",
      engine: "postgres",
      engineVersion: "18.1",
      sha256: backup.sha256,
      sizeBytes: stored.length,
      scope: "database",
    });
    expect(tmpEntries()).toEqual([]);
  });

  it("keeps the backups when the service is destroyed", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", { name: "keep me" });
    const backup = await latest();

    expect((await suite.run(service(), "DELETE", { confirm: "db" })).status).toBe("succeeded");

    expect(readFileSync(join(backupRoot(), backup.path)).length).toBe(backup.sizeBytes);
    expect(suite.context.deps.db.select().from(backups).where(eq(backups.id, backup.id)).get()?.status).toBe(
      "succeeded",
    );
  });

  it("keeps the secrets out of the log", async () => {
    const config = (await createConfig()).body;
    engine.options.dump = "ok\n";
    const action = await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const { rows } = { rows: suite.context.deps.db.select().from(backupConfigs).all() };
    expect(rows).toHaveLength(1);
    expect(action.log).not.toMatch(/PGPASSWORD|MYSQL_PWD/);
  });

  it("fails visibly when the dump tool fails, leaving nothing stored and no temporary files", async () => {
    engine.options.dumpExit = 2;
    const config = (await createConfig()).body;
    const action = await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/exited with code 2/);
    const backup = await latest();
    expect(backup.status).toBe("failed");
    expect(backup.restorable).toBe(false);
    expect(existsSync(join(backupRoot(), backup.path))).toBe(false);
    expect(tmpEntries()).toEqual([]);
  });

  it("cleans up after being cancelled while the dump runs", async () => {
    engine.holdDumps = true;
    const config = (await createConfig()).body;
    const accepted = await suite.api<{ id: string }>(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    expect(accepted.status).toBe(202);

    await until(() => engine.held() === 1);
    await suite.api(`/actions/${accepted.body.id}/cancel`, "POST");
    const finished = await suite.waitFor(accepted.body.id);

    expect(finished.status).toBe("cancelled");
    expect(engine.terminated).toBe(1);
    expect((await latest()).status).toBe("cancelled");
    expect(tmpEntries()).toEqual([]);
  });

  it("is refused while a restore on this service needs attention", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const backup = await latest();
    await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    const restore = (await document()).restores[0] as RestoreEntry;
    updateRestore(suite.context.deps.db, restore.id, { unresolved: true });

    const refused = await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    expect(refused.status).toBe(409);
  });

  it("follows the service when it is renamed", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    // The service must be stopped before a rename.
    await suite.run(`${service()}/stop`);
    const renamed = await suite.api(`${service()}/rename`, "POST", {
      projectName: PROJECT,
      name: "renamed",
    });
    expect(renamed.status).toBe(200);
    const moved = await suite.api<BackupsDocument>(`${service("renamed")}/backups`);
    expect(moved.status).toBe(200);
    expect(moved.body.configs.map((row) => row.id)).toEqual([config.id]);
    expect(moved.body.backups).toHaveLength(1);
  });
});

describe("downloading a backup", () => {
  beforeEach(async () => {
    await deployedDatabase();
    fakeEngine(suite.context);
  });

  const download = (id: string) =>
    suite.context.app.request(`/api/v1${backupsPath}/${id}/download`, {
      headers: { cookie: suite.cookie },
    });

  const run = async (name?: string): Promise<BackupEntry> => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", name === undefined ? {} : { name });
    return latest();
  };

  it("sends the stored file byte for byte, named after the backup and not after its label", async () => {
    const backup = await run("nightly");
    const stored = readFileSync(join(backupRoot(), backup.path));

    const response = await download(backup.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(stored.length));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-backup-sha256")).toBe(backup.sha256);
    const disposition = response.headers.get("content-disposition");
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.sql\.gz"$/);
    expect(disposition).toContain(backup.id);
    expect(disposition).not.toContain("nightly");
    expect(Buffer.from(await response.arrayBuffer()).equals(stored)).toBe(true);
    await until(() => tmpEntries().length === 0);
  });

  it("keeps two copies with the same title apart, each with its own identifier and its own file", async () => {
    const first = await run("same title");
    suite.context.advance(60_000);
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", { name: "same title" });
    const second = await latest();

    expect(second.name).toBe("same title");
    expect(second.id).not.toBe(first.id);
    expect(second.path).not.toBe(first.path);

    for (const backup of [first, second]) {
      const response = await download(backup.id);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(readFileSync(join(backupRoot(), backup.path)))).toBe(true);
    }
    expect((await download(first.id)).headers.get("content-disposition")).not.toEqual(
      (await download(second.id)).headers.get("content-disposition"),
    );
  });

  it("writes who took a copy in the activity log", async () => {
    const backup = await run();
    await (await download(backup.id)).arrayBuffer();

    const list = await suite.api<{ items: Array<{ type: string; title: string; actorEmail: string }> }>(
      "/actions?limit=20",
    );
    const entry = list.body.items.find((item) => item.type === "backup.download");
    expect(entry?.title).toContain(backup.path.split("/").at(-1));
    expect(entry?.actorEmail).toBe("admin@example.com");
  });

  it("refuses what is not a finished, stored backup", async () => {
    const backup = await run();
    await suite.run(`${backupsPath}/${backup.id}`, "DELETE");

    const removed = await download(backup.id);
    expect(removed.status).toBe(409);
    expect(((await removed.json()) as { error: { code: string } }).error.code).toBe(
      "backup_not_downloadable",
    );

    const missing = await download("does-not-exist");
    expect(missing.status).toBe(404);
  });

  it("does not send a file that changed since it was stored, and leaves nothing behind", async () => {
    const backup = await run();
    const file = join(backupRoot(), backup.path);
    const stored = readFileSync(file);
    stored[0] = (stored[0] as number) ^ 0xff;
    writeFileSync(file, stored);

    const response = await download(backup.id);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("backup_corrupt");
    expect(tmpEntries()).toEqual([]);
  });

  it("does not send a file of the wrong size", async () => {
    const backup = await run();
    writeFileSync(join(backupRoot(), backup.path), "short");

    const response = await download(backup.id);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("backup_corrupt");
  });

  it("says so when the file is gone from its destination", async () => {
    const backup = await run();
    rmSync(join(backupRoot(), backup.path));

    const response = await download(backup.id);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "no longer exists",
    );
    expect(tmpEntries()).toEqual([]);
  });

  it("removes the temporary copy when the client stops reading partway", async () => {
    // Noise does not compress, so this stays far larger than what a stream reads ahead.
    fakeEngine(suite.context, { dump: randomBytes(8 * 1024 * 1024) });
    const backup = await run();

    const response = await download(backup.id);
    expect(tmpEntries()).toHaveLength(1);
    await response.body?.cancel();

    await until(() => tmpEntries().length === 0);
  });
});

describe("what a backup holds (REQ-667)", () => {
  const pgDump = [
    "\\restrict abc",
    "SET default_transaction_read_only = off;",
    "CREATE ROLE reader;",
    "ALTER ROLE reader WITH NOSUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$hash';",
    "CREATE ROLE owner;",
    "ALTER ROLE owner WITH SUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$old';",
    "GRANT writers TO reader;",
    "\\unrestrict abc",
    "\\connect template1",
    "CREATE DATABASE app;",
    "\\connect app",
    "CREATE TABLE items (id int);",
    "",
  ].join("\n");

  const config = (scope?: string, overrides: Record<string, unknown> = {}) =>
    createConfig({ ...(scope === undefined ? {} : { scope }), ...overrides });

  describe("a configuration", () => {
    it("keeps one database as the default and only then needs a database name", async () => {
      await deployedDatabase();
      expect((await config()).body).toMatchObject({ scope: "database", databaseName: "app" });

      const missing = await config("database", { databaseName: "" });
      expect(missing.status).toBe(400);
      expect(apiErrorOf(missing).fields?.databaseName).toBe("Required");

      const instance = await config("instance", { databaseName: "ignored" });
      expect(instance.body).toMatchObject({ scope: "instance", databaseName: null });

      const accounts = await config("accounts", { databaseName: undefined });
      expect(accounts.body).toMatchObject({ scope: "accounts", databaseName: null });
    });

    it("does not offer a scope that does not exist", async () => {
      await deployedDatabase();
      const refused = await config("everything");
      expect(refused.status).toBe(400);
      expect(apiErrorOf(refused).fields?.scope).toBeDefined();
    });
  });

  describe.each([
    [
      "postgres",
      "pg_dumpall",
      "postgres-instance-sql-gz-v1",
      "postgres-accounts-sql-gz-v1",
      ".accounts.sql.gz",
    ],
    ["mysql", "mysqldump", "mysql-instance-sql-gz-v1", "mysql-accounts-sql-gz-v1", ".accounts.sql.gz"],
    ["mongo", "mongodump", "mongo-instance-archive-v1", "mongo-accounts-jsonl-gz-v1", ".accounts.jsonl.gz"],
  ] as const)("on %s", (engine, _tool, instanceFormat, accountsFormat, accountsSuffix) => {
    let fake: FakeEngine;

    beforeEach(async () => {
      await deployedDatabase(engine);
      fake = fakeEngine(suite.context, {
        dump: engine === "mongo" ? gzipSync('{"c":"users","d":{"user":"x"}}\n') : pgDump,
        version: engine === "mongo" ? "8.0.0" : "18.1",
      });
    });

    const run = async (scope: string) => {
      const body = (await config(scope)).body;
      const action = await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      expect(action.status).toBe("succeeded");
      return latest();
    };

    it("exports the whole server with its own format, and no single database's name", async () => {
      const backup = await run("instance");
      expect(backup).toMatchObject({ scope: "instance", format: instanceFormat, databaseName: null });
      expect(backup.path).toMatch(/\.instance\./);
      const manifest = JSON.parse(
        readFileSync(join(backupRoot(), `${backup.path}.manifest.json`), "utf8"),
      ) as BackupManifest;
      expect(manifest).toMatchObject({ scope: "instance", format: instanceFormat, databaseName: null });
    });

    it("exports users and roles with their own format, and no data", async () => {
      const backup = await run("accounts");
      expect(backup).toMatchObject({ scope: "accounts", format: accountsFormat, databaseName: null });
      expect(backup.path.endsWith(accountsSuffix)).toBe(true);
    });

    it("uses another engine command for each scope, so the three cannot be confused", async () => {
      await run("database");
      await run("instance");
      await run("accounts");
      const dumped = fake.dumps.map((call) => `${call.command[0]} ${call.command.join(" ")}`);
      expect(new Set(dumped).size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("restoring users and roles", () => {
    const restoreAccounts = async (engine: "postgres" | "mysql" | "mongo", dump: string, confirm = "db") => {
      const fake = fakeEngine(suite.context, { dump, version: engine === "mongo" ? "8.0.0" : "18.1" });
      const body = (await config("accounts")).body;
      await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      const backup = await latest();
      fake.imports = [];
      const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm });
      return { action, fake, backup };
    };

    it("keeps the panel's own role out, and does not fall over a role that already exists", async () => {
      await suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });
      const { action, fake } = await restoreAccounts("postgres", pgDump);

      expect(action.status).toBe("succeeded");
      expect(action.log).toMatch(/users and roles/);
      const script = fake.imports[0]?.stdin.toString("utf8") ?? "";
      expect(script).not.toMatch(/CREATE ROLE owner/);
      expect(script).not.toMatch(/ALTER ROLE owner/);
      expect(script).toContain(
        "DO $opsifier$ BEGIN CREATE ROLE reader; EXCEPTION WHEN duplicate_object THEN NULL; END $opsifier$;",
      );
      expect(script).toContain("ALTER ROLE reader WITH NOSUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$hash';");
      expect(script.startsWith("BEGIN;")).toBe(true);
      expect(script).toContain("COMMIT;");
      expect(script).toContain("\\echo opsifier-restore-complete");
    });

    it("needs the service's name typed, not a database's", async () => {
      await suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });
      fakeEngine(suite.context, { dump: pgDump });
      const body = (await config("accounts")).body;
      await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      const backup = await latest();

      const refused = await suite.api(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("confirmation_mismatch");
    });

    it("keeps MySQL's panel account out and stops the import from reaching the data lines", async () => {
      await suite.deployed({ engine: "mysql", databaseName: "app", user: "appuser" });
      const dump = [
        "DROP USER IF EXISTS 'appuser'@'%';",
        "CREATE USER `appuser`@`%` IDENTIFIED WITH 'caching_sha2_password' AS 0xaa;",
        "GRANT ALL PRIVILEGES ON `app`.* TO `appuser`@`%`;",
        "DROP USER IF EXISTS 'reader'@'%';",
        "CREATE USER `reader`@`%` IDENTIFIED WITH 'caching_sha2_password' AS 0xbb;",
        "GRANT SELECT ON `app`.* TO `reader`@`%`;",
        "-- opsifier: end of accounts",
        "",
      ].join("\n");
      const { action, fake } = await restoreAccounts("mysql", dump);

      expect(action.status).toBe("succeeded");
      const script = fake.imports[0]?.stdin.toString("utf8") ?? "";
      expect(script).not.toContain("appuser");
      expect(script).toContain("CREATE USER `reader`@`%`");
      expect(script).toContain("GRANT SELECT ON `app`.* TO `reader`@`%`;");
      expect(script).toContain("SELECT 'opsifier-restore-complete';");
    });

    it("leaves out the panel's account from Mongo's users and merges the rest", async () => {
      await suite.deployed({ engine: "mongo", user: "root1" });
      const dump = `${[
        JSON.stringify({ c: "users", d: { _id: "admin.root1", user: "root1", db: "admin" } }),
        JSON.stringify({ c: "users", d: { _id: "admin.reporter", user: "reporter", db: "admin" } }),
        JSON.stringify({ c: "roles", d: { _id: "admin.view", role: "view", db: "admin" } }),
      ].join("\n")}\n`;
      const fake = fakeEngine(suite.context, { dump, version: "8.0.0" });
      const body = (await config("accounts")).body;
      await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      const backup = await latest();

      const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "db" });

      expect(action.status).toBe("succeeded");
      const script = fake.scripts.find((text) => text.includes("_mergeAuthzCollections")) ?? "";
      expect(script).toContain("admin.reporter");
      expect(script).toContain("admin.view");
      expect(script).not.toContain("admin.root1");
    });

    it("refuses a whole-server file named for a users-and-roles restore, before fetching it", async () => {
      await suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });
      fakeEngine(suite.context, { dump: pgDump });
      const body = (await config("instance")).body;
      await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      const backup = await latest();

      const accepted = await suite.api<ActionEntry>(`${backupsPath}/restore`, "POST", {
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path: backup.path,
        scope: "accounts",
        confirm: "db",
      });
      const action = await suite.waitFor(accepted.body.id);

      expect(action.status).toBe("failed");
      expect(action.error).toMatch(/instance data.*accounts data/);
      expect(action.log).not.toMatch(/Downloading/);
    });
  });

  describe("restoring a whole server", () => {
    const docker = () => suite.context.docker;

    const instanceBackup = async () => {
      await suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });
      const fake = fakeEngine(suite.context, { dump: pgDump });
      const body = (await config("instance")).body;
      await suite.run(`${backupsPath}/configs/${body.id}/run`, "POST", {});
      const backup = await latest();
      fake.imports = [];
      return { fake, backup };
    };

    const restoreOf = (id: string, confirm = "db") =>
      suite.api<ActionEntry>(`${backupsPath}/${id}/restore`, "POST", { confirm });

    it("imports into an isolated server on a new volume, then moves the service over and keeps the old one", async () => {
      const { fake, backup } = await instanceBackup();
      await docker().createVolume({ name: "shop_db_data" });
      const created = vi.spyOn(docker(), "createService");

      const accepted = await restoreOf(backup.id);
      expect(accepted.status).toBe(202);
      const action = await suite.waitFor(accepted.body.id);
      expect(action.status).toBe("succeeded");

      const isolated = created.mock.calls.at(-1)?.[0];
      expect(isolated?.Name).toMatch(/^opsifier-restore-/);
      expect(isolated?.TaskTemplate.Networks).toEqual([]);
      expect(isolated?.EndpointSpec).toEqual({ Mode: "dnsrr" });
      expect(isolated?.TaskTemplate.ContainerSpec.Env).toContain("POSTGRES_DB=postgres");
      const volumeMount = isolated?.TaskTemplate.ContainerSpec.Mounts?.find(
        (mount) => mount.Target === "/var/lib/postgresql/data",
      );
      expect(volumeMount?.Source).toMatch(/^shop_db_data_restored_/);

      expect(fake.imports).toHaveLength(1);
      expect(fake.imports[0]?.options.service).toBe(isolated?.Name);
      const script = fake.imports[0]?.stdin.toString("utf8") ?? "";
      expect(script).not.toMatch(/CREATE ROLE owner|ALTER ROLE owner/);
      expect(script).toContain("CREATE DATABASE app;");
      expect(script.startsWith("BEGIN;")).toBe(false);

      expect(await docker().inspectService(isolated?.Name as string)).toBeNull();
      const swarm = await docker().inspectService("shop_db");
      const mount = swarm?.spec.TaskTemplate.ContainerSpec.Mounts?.[0];
      expect(mount?.Source).toBe(volumeMount?.Source);
      expect((await suite.api<DatabaseDetail>(`${service()}/database`)).body.volume).toBe(
        volumeMount?.Source,
      );

      const retained = await suite.api<{ volumes: Array<{ name: string; kind: string }> }>(
        "/retained-volumes",
      );
      expect(retained.body.volumes).toContainEqual(
        expect.objectContaining({ name: "shop_db_data", kind: "database" }),
      );

      const doc = await document();
      expect(doc.restores[0]).toMatchObject({ scope: "instance", status: "succeeded", phase: "done" });
      expect(doc.backups[0]).toMatchObject({ origin: "safety", scope: "instance" });
      expect(tmpEntries()).toEqual([]);
    });

    it("leaves the service on its own volume when the import fails, and removes what it prepared", async () => {
      const { fake, backup } = await instanceBackup();
      fake.options.importExit = 1;
      const created = vi.spyOn(docker(), "createService").mockImplementation(async (spec, options) => {
        const info = await FakeDriver.prototype.createService.call(docker(), spec, options);
        const source = spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source;
        if (source?.includes("_restored_")) {
          await docker().createVolume({ name: source });
        }
        return info;
      });

      const accepted = await restoreOf(backup.id);
      const action = await suite.waitFor(accepted.body.id);

      expect(action.status).toBe("failed");
      const isolated = created.mock.calls.at(-1)?.[0];
      expect(await docker().inspectService(isolated?.Name as string)).toBeNull();
      expect(
        (await docker().inspectService("shop_db"))?.spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source,
      ).toBe("shop_db_data");
      const restored = isolated?.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source as string;
      expect(await docker().inspectVolume(restored)).toBeNull();
      expect((await suite.api<DatabaseDetail>(`${service()}/database`)).body.volume).toBe("shop_db_data");
      expect(tmpEntries()).toEqual([]);
    });

    it("moves back to the old volume when the restored server does not come up", async () => {
      const { backup } = await instanceBackup();
      const real = docker().updateService.bind(docker());
      let moves = 0;
      vi.spyOn(docker(), "updateService").mockImplementation(async (name, spec, options) => {
        const mount = spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source ?? "";
        if (name === "shop_db" && mount.includes("_restored_") && moves === 0) {
          moves += 1;
          throw new Error("no such task");
        }
        return real(name, spec, options);
      });

      const accepted = await restoreOf(backup.id);
      const action = await suite.waitFor(accepted.body.id);

      expect(action.status).toBe("failed");
      expect(action.log).toMatch(/Moving the service back to its previous volume/);
      expect((await suite.api<DatabaseDetail>(`${service()}/database`)).body.volume).toBe("shop_db_data");
    });

    it("still moves back when the restore is cancelled during the move", async () => {
      const { backup } = await instanceBackup();
      const real = docker().updateService.bind(docker());
      let accepted: ActionEntry | undefined;
      let moves = 0;
      vi.spyOn(docker(), "updateService").mockImplementation(async (name, spec, options) => {
        const mount = spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source ?? "";
        if (name === "shop_db" && mount.includes("_restored_") && moves === 0) {
          moves += 1;
          await suite.api(`/actions/${accepted?.id}/cancel`, "POST");
          throw new Error("cancelled while moving");
        }
        return real(name, spec, options);
      });

      const started = await restoreOf(backup.id);
      accepted = started.body;
      const action = await suite.waitFor(started.body.id);

      expect(action.status).toBe("cancelled");
      expect((await suite.api<DatabaseDetail>(`${service()}/database`)).body.volume).toBe("shop_db_data");
    });

    it("needs the service's name typed", async () => {
      const { backup } = await instanceBackup();
      const refused = await restoreOf(backup.id, "app");
      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("confirmation_mismatch");
    });

    it("needs the database to be running", async () => {
      const { backup } = await instanceBackup();
      await suite.run(`${service()}/stop`, "POST", {});
      const refused = await restoreOf(backup.id);
      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("service_stopped");
    });

    it("cleans up after a panel crash while preparing, without touching the service", async () => {
      await instanceBackup();
      const id = "crashed1restore1234567";
      suite.context.deps.db
        .insert(backupRestores)
        .values({
          id,
          projectName: PROJECT,
          serviceName: "db",
          kind: "database",
          scope: "instance",
          storageProviderName: "Local Disk",
          sourcePath: "x",
          status: "running",
          phase: "importing",
          createdAt: new Date(suite.context.deps.now()),
        })
        .run();
      await docker().createService({
        ...(await docker().inspectService("shop_db"))?.spec,
        Name: `opsifier-restore-${id}`,
      } as never);

      await recoverInterruptedRestores(suite.context.deps, [
        suite.context.deps.db.select().from(backupRestores).where(eq(backupRestores.id, id)).get() as never,
      ]);

      expect(await docker().inspectService(`opsifier-restore-${id}`)).toBeNull();
      const row = suite.context.deps.db.select().from(backupRestores).where(eq(backupRestores.id, id)).get();
      expect(row).toMatchObject({ status: "failed", unresolved: false });
      expect(row?.error).toMatch(/Nothing had been changed/);
    });

    it("holds the service when the panel died while moving it over", async () => {
      await instanceBackup();
      const id = "crashed2restore1234567";
      suite.context.deps.db
        .insert(backupRestores)
        .values({
          id,
          projectName: PROJECT,
          serviceName: "db",
          kind: "database",
          scope: "instance",
          storageProviderName: "Local Disk",
          sourcePath: "x",
          status: "running",
          phase: "swapping",
          createdAt: new Date(suite.context.deps.now()),
        })
        .run();

      await recoverInterruptedRestores(suite.context.deps, [
        suite.context.deps.db.select().from(backupRestores).where(eq(backupRestores.id, id)).get() as never,
      ]);

      const row = suite.context.deps.db.select().from(backupRestores).where(eq(backupRestores.id, id)).get();
      expect(row).toMatchObject({ status: "failed", unresolved: true });
      expect(row?.error).toMatch(/shop_db_data/);
    });
  });
});

describe("retention", () => {
  let engine: FakeEngine;

  beforeEach(async () => {
    await deployedDatabase();
    engine = fakeEngine(suite.context);
  });

  function schedulerAt(deps = suite.context.deps): BackupScheduler {
    return new BackupScheduler(deps, { bootGraceMs: 0 });
  }

  /** Makes the configuration due and fires it, waiting for the backup to finish. */
  async function runScheduled(config: BackupConfigEntry) {
    suite.context.deps.db
      .update(backupConfigs)
      .set({ nextRunAt: new Date(suite.context.deps.now() - 1000) })
      .where(eq(backupConfigs.id, config.id))
      .run();
    expect(schedulerAt().tick()).toBe(1);
    await waitForIdle();
  }

  async function waitForIdle() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const running = (await document()).backups.filter((row) => row.status === "running");
      const detail = await suite.api<ServiceDetail>(service());
      if (running.length === 0 && detail.body.activeAction === null) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("still busy");
  }

  describe("when a configuration changes between runs (REQ-675)", () => {
    const update = (id: string, overrides: Record<string, unknown>) =>
      suite.api<BackupConfigEntry>(`${backupsPath}/configs/${id}`, "PUT", {
        kind: "database",
        enabled: true,
        schedule: "0 2 * * *",
        retention: null,
        databaseName: "app",
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path: "shop/db",
        ...overrides,
      });

    it("applies a lower retention at the next run, taking each old file from where it was stored", async () => {
      const config = (await createConfig({ retention: 5 })).body;
      for (let run = 0; run < 4; run += 1) {
        await runScheduled(config);
        suite.context.advance(1000);
      }
      const before = (await document()).backups.filter((row) => row.configId === config.id);
      expect(before.filter((row) => row.deletedAt === null)).toHaveLength(4);

      expect((await update(config.id, { retention: 2, path: "moved/db" })).status).toBe(200);
      await runScheduled(config);

      const after = (await document()).backups.filter((row) => row.configId === config.id);
      const [newest] = after;
      expect(newest?.path).toMatch(/^moved\/db\//);
      expect(existsSync(join(backupRoot(), newest?.path as string))).toBe(true);

      const kept = after.filter((row) => row.deletedAt === null);
      expect(kept).toHaveLength(2);
      for (const row of after) {
        expect(existsSync(join(backupRoot(), row.path)), row.path).toBe(row.deletedAt === null);
      }
      // What was removed came from the old folder, and what stays there is listed as still there.
      expect(
        readdirSync(join(backupRoot(), "shop", "db")).filter((name) => name.endsWith(".sql.gz")),
      ).toHaveLength(1);
    });

    it("leaves a file in the new folder alone when no record says it belongs to the configuration", async () => {
      const config = (await createConfig({ retention: 1 })).body;
      await runScheduled(config);
      suite.context.advance(1000);

      mkdirSync(join(backupRoot(), "moved", "db"), { recursive: true });
      const foreign = join(backupRoot(), "moved", "db", "someone-elses.sql.gz");
      writeFileSync(foreign, "not ours");

      await update(config.id, { retention: 1, path: "moved/db" });
      await runScheduled(config);

      expect(readFileSync(foreign, "utf8")).toBe("not ours");
    });

    it("stops deleting anything once its limit is removed", async () => {
      const config = (await createConfig({ retention: 1 })).body;
      await runScheduled(config);
      suite.context.advance(1000);
      await update(config.id, { retention: null });
      await runScheduled(config);
      suite.context.advance(1000);
      await runScheduled(config);

      const rows = (await document()).backups.filter((row) => row.configId === config.id);
      expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(3);
    });
  });

  it("keeps the newest scheduled backups and names what it deletes", async () => {
    const config = (await createConfig({ retention: 3 })).body;
    for (let run = 0; run < 4; run += 1) {
      await runScheduled(config);
      suite.context.advance(1000);
    }

    const rows = (await document()).backups.filter((row) => row.configId === config.id);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(3);
    const removed = rows.find((row) => row.deletedAt !== null) as BackupEntry;
    expect(existsSync(join(backupRoot(), removed.path))).toBe(false);
    expect(existsSync(join(backupRoot(), `${removed.path}.manifest.json`))).toBe(false);

    const log = (await suite.api<{ log: string }>(`/actions/${rows[0]?.actionId}`)).body.log;
    expect(log).toMatch(/Retention limit: 3, deleting 1 old backup/);
    expect(log).toContain(`Deleted ${removed.path}`);
    expect(log).toContain(`Retention gave back ${humanSize(removed.sizeBytes ?? 0)} from 1 old backup(s)`);
  });

  it("deletes nothing without a limit, and no manual or safety copy ever", async () => {
    const unlimited = (await createConfig({ path: "unlimited" })).body;
    for (let run = 0; run < 4; run += 1) {
      await runScheduled(unlimited);
      suite.context.advance(1000);
    }
    expect((await document()).backups.every((row) => row.deletedAt === null)).toBe(true);

    const limited = (await createConfig({ path: "limited", retention: 1 })).body;
    await suite.run(`${backupsPath}/configs/${limited.id}/run`, "POST", { name: "manual one" });
    await runScheduled(limited);
    suite.context.advance(1000);
    await runScheduled(limited);

    const rows = (await document()).backups;
    expect(rows.find((row) => row.name === "manual one")?.deletedAt).toBeNull();
    // Only one scheduled copy of the limited configuration remains, and the other configuration is untouched.
    expect(
      rows.filter(
        (row) => row.configId === limited.id && row.origin === "schedule" && row.deletedAt === null,
      ),
    ).toHaveLength(1);
    expect(rows.filter((row) => row.configId === unlimited.id && row.deletedAt === null)).toHaveLength(4);
  });

  it("touches only files recorded for this configuration, leaving foreign ones in the folder", async () => {
    const config = (await createConfig({ retention: 1 })).body;
    await runScheduled(config);
    const stranger = join(backupRoot(), "shop", "db", "not-ours.sql.gz");
    writeFileSync(stranger, "someone else's file");
    suite.context.advance(1000);
    await runScheduled(config);
    expect(existsSync(stranger)).toBe(true);
  });

  it("reports a cleanup failure on the backup, which itself still succeeds", async () => {
    const config = (await createConfig({ retention: 1 })).body;
    await runScheduled(config);
    const provider = findProviderRow(suite.context.deps.db, BUILT_IN_PROVIDER_ID);
    expect(provider).toBeDefined();
    // Make the old file impossible to delete by turning it into a folder with something in it.
    const oldest = (await document()).backups[0] as BackupEntry;
    rmSync(join(backupRoot(), oldest.path));
    mkdirSync(join(backupRoot(), oldest.path, "child"), { recursive: true });

    suite.context.advance(1000);
    await runScheduled(config);
    const newest = (await document()).backups[0] as BackupEntry;
    expect(newest.status).toBe("succeeded");
    expect(newest.cleanupError).toMatch(/regular file/);
  });

  it("does not touch old copies when a scheduled run fails", async () => {
    const config = (await createConfig({ retention: 1 })).body;
    await runScheduled(config);
    const kept = (await document()).backups[0] as BackupEntry;

    engine.options.dumpExit = 1;
    suite.context.advance(1000);
    await runScheduled(config);

    expect(existsSync(join(backupRoot(), kept.path))).toBe(true);
    const rows = (await document()).backups;
    expect(rows.find((row) => row.id === kept.id)?.deletedAt).toBeNull();
  });
});

describe("restoring a database", () => {
  let engine: FakeEngine;
  let config: BackupConfigEntry;

  beforeEach(async () => {
    await deployedDatabase();
    engine = fakeEngine(suite.context);
    config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
  });

  const backupRow = async () => {
    const rows = (await document()).backups;
    return rows.find((row) => row.origin === "manual") as BackupEntry;
  };

  it("needs the exact database name typed", async () => {
    const backup = await backupRow();
    const refused = await suite.api(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "wrong" });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused)).toMatchObject({
      code: "confirmation_mismatch",
      fields: { confirm: "This does not match" },
    });
    expect(engine.imports).toHaveLength(0);
  });

  it("verifies, takes a safety copy, imports in one transaction and checks the database", async () => {
    const backup = await backupRow();
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });

    expect(action.status).toBe("succeeded");
    expect(action.log).toMatch(/Checksum verified/);
    expect(action.log).toMatch(/safety backup/);

    expect(engine.imports).toHaveLength(1);
    const sql = (engine.imports[0] as { stdin: Buffer }).stdin.toString("utf8");
    expect(sql.startsWith("BEGIN;\n")).toBe(true);
    expect(sql).toContain("CREATE TABLE items");
    expect(sql).toMatch(/\nCOMMIT;\n\\echo opsifier-restore-complete\n$/);

    const doc = await document();
    const restore = doc.restores[0] as RestoreEntry;
    expect(restore).toMatchObject({
      status: "succeeded",
      phase: "done",
      unresolved: false,
      backupId: backup.id,
      actorEmail: "admin@example.com",
    });
    const safety = doc.backups.find((row) => row.id === restore.safetyBackupId);
    expect(safety).toMatchObject({
      origin: "safety",
      status: "succeeded",
      storageProviderId: BUILT_IN_PROVIDER_ID,
    });
    expect(existsSync(join(backupRoot(), safety?.path ?? ""))).toBe(true);
    expect(tmpEntries()).toEqual([]);
  });

  it("refuses a file that changed since it was stored, before touching the database", async () => {
    const backup = await backupRow();
    writeFileSync(join(backupRoot(), backup.path), gzipSync("-- tampered dump\n"));
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/bytes|integrity/);
    expect(engine.imports).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  it("reports a file that no longer exists at the destination", async () => {
    const backup = await backupRow();
    rmSync(join(backupRoot(), backup.path));
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/no longer exists/);
    expect(engine.imports).toHaveLength(0);
  });

  it("rolls back and reports it when a transactional import fails", async () => {
    const backup = await backupRow();
    engine.options.importExit = 3;
    engine.options.importStderr = "ERROR: relation already exists\n";
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });

    expect(action.status).toBe("failed");
    expect(action.log).toContain("rolled back");
    expect(action.log).toContain("ERROR: relation already exists");
    expect(engine.imports).toHaveLength(1);
    const restore = (await document()).restores[0] as RestoreEntry;
    expect(restore.status).toBe("failed");
    expect(restore.unresolved).toBe(false);
  });

  it("refuses an import that ends without finishing the file", async () => {
    const backup = await backupRow();
    engine.options.noMarker = true;
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/without finishing/);
  });

  it("is refused with another operation running on the service", async () => {
    const backup = await backupRow();
    engine.holdDumps = true;
    const running = await suite.api<{ id: string }>(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    await until(() => engine.held() === 1);
    const refused = await suite.api<{ error: { code: string } }>(
      `${backupsPath}/${backup.id}/restore`,
      "POST",
      { confirm: "app" },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("service_busy");
    engine.release();
    await suite.waitFor(running.body.id);
  });

  it("refuses a backup of another engine before anything changes", async () => {
    const backup = await backupRow();
    // Rewrite the record's engine, as if this file had been made by MySQL.
    const manifestFile = join(backupRoot(), `${backup.path}.manifest.json`);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, engine: "mysql" }));
    const path = await suite.api<{ id: string }>(`${backupsPath}/restore`, "POST", {
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: backup.path,
      databaseName: "app",
      confirm: "app",
    });
    expect(path.status).toBe(202);
    const action = await suite.waitFor(path.body.id);
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/runs postgres/);
    expect(engine.imports).toHaveLength(0);
  });

  it("refuses a backup from a newer server version", async () => {
    const backup = await backupRow();
    engine.options.version = "16.3";
    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/same version or a newer one/);
    expect(engine.imports).toHaveLength(0);
  });

  it("restores a file by path through its manifest, refusing one without any", async () => {
    const backup = await backupRow();
    const good = await suite.api<{ id: string }>(`${backupsPath}/restore`, "POST", {
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: backup.path,
      databaseName: "app",
      confirm: "app",
    });
    expect((await suite.waitFor(good.body.id)).status).toBe("succeeded");

    const naked = join(backupRoot(), "shop", "stray.sql.gz");
    mkdirSync(join(backupRoot(), "shop"), { recursive: true });
    writeFileSync(naked, gzipSync("-- no manifest\n"));
    const refused = await suite.api<{ id: string }>(`${backupsPath}/restore`, "POST", {
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: "shop/stray.sql.gz",
      databaseName: "app",
      confirm: "app",
    });
    const action = await suite.waitFor(refused.body.id);
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/no manifest|integrity/);
  });

  it("does not offer a deleted backup for restore", async () => {
    const backup = await backupRow();
    const removed = await suite.api<{ id: string }>(`${backupsPath}/${backup.id}`, "DELETE");
    await suite.waitFor(removed.body.id);
    const row = (await document()).backups.find((entry) => entry.id === backup.id) as BackupEntry;
    expect(row.deletedAt).not.toBeNull();
    expect(row.restorable).toBe(false);
    const refused = await suite.api(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(refused.status).toBe(409);
  });
});

describe("restoring on an engine with no transactional import", () => {
  let engine: FakeEngine;

  beforeEach(async () => {
    await suite.deployed({ engine: "mysql", databaseName: "app" });
    engine = fakeEngine(suite.context, {
      version: "9.1.0",
      dump: "-- mysql dump\nINSERT INTO t VALUES (1);\n",
    });
  });

  it("puts the previous data back from the safety copy, removing what the failed import added", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const backup = (await document()).backups[0] as BackupEntry;

    // The first import fails partway; the reload of the safety copy succeeds.
    engine.beforeImport = (_options, index) => {
      engine.options.importExit = index === 0 ? 1 : 0;
      engine.options.importStderr = index === 0 ? "ERROR 1064: syntax error\n" : "";
    };

    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/put back/);
    expect(action.log).toMatch(/Putting the previous data back/);
    expect(action.log).toMatch(/Nothing was lost/);
    // The reload dropped what the failed import had added: "orders" was not there before it.
    expect(engine.commands.filter((name) => name === "mysql").length).toBeGreaterThan(2);
    const restore = (await document()).restores[0] as RestoreEntry;
    expect(restore.status).toBe("failed");
    expect(restore.unresolved).toBe(false);
  });

  it("blocks the service when even the safety copy cannot be put back", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const backup = (await document()).backups[0] as BackupEntry;
    engine.options.importExit = 1;

    const action = await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/could not be put back/);

    const doc = await document();
    const restore = doc.restores[0] as RestoreEntry;
    expect(restore.unresolved).toBe(true);
    // Everything that touches the data waits for a person.
    expect((await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {})).status).toBe(409);
    expect((await suite.api(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" })).status).toBe(
      409,
    );

    const resolved = await suite.api<RestoreEntry>(`${backupsPath}/restores/${restore.id}/resolve`, "POST", {
      confirm: "app",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.unresolved).toBe(false);
    expect((await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {})).status).toBe(202);
  });

  it("lets the safety backup be restored while unresolved, which settles it", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const backup = (await document()).backups[0] as BackupEntry;
    engine.options.importExit = 1;
    await suite.run(`${backupsPath}/${backup.id}/restore`, "POST", { confirm: "app" });

    const stuck = (await document()).restores[0] as RestoreEntry;
    expect(stuck.unresolved).toBe(true);
    const safetyId = stuck.safetyBackupId as string;
    engine.options.importExit = 0;

    const action = await suite.run(`${backupsPath}/${safetyId}/restore`, "POST", { confirm: "app" });
    expect(action.status).toBe("succeeded");
    expect(action.log).toMatch(/settled/);
    const settled = (await document()).restores.find((row) => row.id === stuck.id) as RestoreEntry;
    expect(settled.unresolved).toBe(false);
    expect((await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {})).status).toBe(202);
  });

  it("adds the GTID option to MySQL dumps and passes the root password in the environment only", async () => {
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const dump = engine.dumps[0];
    expect(dump?.command).toContain("--set-gtid-purged=OFF");
    expect(dump?.command.join(" ")).not.toMatch(/password/i);
    expect(dump?.env?.some((entry) => entry.startsWith("MYSQL_PWD="))).toBe(true);
  });
});

describe("scheduled runs", () => {
  let engine: FakeEngine;
  let config: BackupConfigEntry;

  beforeEach(async () => {
    await deployedDatabase();
    engine = fakeEngine(suite.context);
    config = (await createConfig({ schedule: "* * * * *" })).body;
  });

  const startedRuns = () => suite.context.deps.db.select().from(backupConfigs).get();
  const makeDue = (when: number) =>
    suite.context.deps.db
      .update(backupConfigs)
      .set({ nextRunAt: new Date(when) })
      .where(eq(backupConfigs.id, config.id))
      .run();

  const scheduler = (options = {}) => new BackupScheduler(suite.context.deps, { bootGraceMs: 0, ...options });

  async function idle() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await suite.api<ServiceDetail>(service())).body.activeAction === null) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("still busy");
  }

  it("does nothing before the next run is due", () => {
    expect(scheduler().tick()).toBe(0);
    expect(engine.dumps).toHaveLength(0);
  });

  it("fires a due backup, marked as scheduled, and moves on to the next time", async () => {
    makeDue(suite.context.deps.now() - 1);
    expect(scheduler().tick()).toBe(1);
    await idle();
    const row = (await document()).backups[0] as BackupEntry;
    expect(row).toMatchObject({ origin: "schedule", status: "succeeded" });
    expect(startedRuns()?.nextRunAt?.getTime()).toBeGreaterThan(suite.context.deps.now());
  });

  it("runs once after three missed occurrences while the panel was down", async () => {
    // Stopped three minutes ago: the next run was due then and everything since was missed.
    const threeMinutesAgo = suite.context.deps.now() - 3 * 60_000;
    makeDue(threeMinutesAgo);

    const restarted = scheduler();
    expect(restarted.tick()).toBe(1);
    await idle();
    expect(restarted.tick()).toBe(0);
    expect((await document()).backups).toHaveLength(1);
    expect(startedRuns()?.nextRunAt?.getTime()).toBeGreaterThan(suite.context.deps.now());
  });

  it("waits out the delay after a restart before running anything overdue", () => {
    makeDue(suite.context.deps.now() - 1000);
    const justStarted = new BackupScheduler(suite.context.deps, { bootGraceMs: 60_000 });
    expect(justStarted.tick()).toBe(0);
    suite.context.advance(60_001);
    expect(justStarted.tick()).toBe(1);
  });

  it("defers while the service is busy instead of piling up", async () => {
    engine.holdDumps = true;
    makeDue(suite.context.deps.now() - 1);
    expect(scheduler().tick()).toBe(1);
    await until(() => engine.held() === 1);

    // Still busy with the first one: nothing else starts, however often it is asked.
    makeDue(suite.context.deps.now() - 1);
    expect(scheduler().tick()).toBe(0);
    expect(scheduler().tick()).toBe(0);

    engine.release();
    await idle();
    expect(scheduler().tick()).toBe(1);
    await until(() => engine.held() === 1);
    engine.release();
    await idle();
    expect((await document()).backups.filter((row) => row.origin === "schedule")).toHaveLength(2);
  });

  it("ignores a configuration that is turned off", async () => {
    await suite.api(`${backupsPath}/configs/${config.id}`, "PUT", {
      kind: "database",
      enabled: false,
      schedule: "* * * * *",
      retention: null,
      databaseName: "app",
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: "shop/db",
    });
    makeDue(suite.context.deps.now() - 1);
    // A disabled row has no next run at all, whatever the column says.
    suite.context.deps.db.update(backupConfigs).set({ enabled: false }).run();
    expect(scheduler().tick()).toBe(0);
  });

  it("keeps the next run across a restart, because it lives in the database", () => {
    const stored = startedRuns()?.nextRunAt?.getTime();
    expect(stored).toBeGreaterThan(suite.context.deps.now());
    expect(new BackupScheduler(suite.context.deps).tick()).toBe(0);
    expect(startedRuns()?.nextRunAt?.getTime()).toBe(stored);
  });

  it("stays quiet about a backup whose destination has gone", async () => {
    const created = await suite.api<{ id: string }>("/storage-providers", "POST", {
      kind: "local",
      name: "external",
      path: join(suite.context.dataDir, "backups", "external"),
    });
    expect(created.status).toBe(201);
    const moved = await suite.api(`${backupsPath}/configs/${config.id}`, "PUT", {
      kind: "database",
      enabled: true,
      schedule: "* * * * *",
      retention: null,
      databaseName: "app",
      storageProviderId: created.body.id,
      path: "elsewhere",
    });
    expect(moved.status).toBe(200);
    const deleted = await suite.api(`/storage-providers/${created.body.id}`, "DELETE");
    expect(deleted.status).toBe(200);

    const after = (await document()).configs[0] as BackupConfigEntry;
    expect(after.storageProviderId).toBeNull();
    expect(after.destinationReady).toBe(false);
    expect(after.enabled).toBe(false);
    expect((await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {})).status).toBe(409);
  });
});

describe("after a restart in the middle of a restore", () => {
  beforeEach(async () => {
    await deployedDatabase();
    fakeEngine(suite.context);
  });

  const insertRunning = (fields: Partial<typeof backupRestores.$inferInsert>) =>
    suite.context.deps.db
      .insert(backupRestores)
      .values({
        id: `r-${Math.random()}`,
        projectName: PROJECT,
        serviceName: "db",
        kind: "database",
        storageProviderName: "Local Disk",
        sourcePath: "x/y.sql.gz",
        status: "running",
        phase: "verifying",
        createdAt: new Date(suite.context.deps.now()),
        ...fields,
      })
      .returning()
      .get();

  it("reports nothing changed before the import started", async () => {
    const row = insertRunning({ phase: "safety", databaseName: "app" });
    await recoverInterruptedRestores(suite.context.deps, [row]);
    const settled = suite.context.deps.db.select().from(backupRestores).get();
    expect(settled).toMatchObject({ status: "failed", unresolved: false });
    expect(settled?.error).toMatch(/Nothing had been changed/);
  });

  it("blocks the service when it stopped during the import", async () => {
    const row = insertRunning({ phase: "importing", databaseName: "app", safetyBackupId: "safety-1" });
    await recoverInterruptedRestores(suite.context.deps, [row]);
    const settled = suite.context.deps.db.select().from(backupRestores).get();
    expect(settled).toMatchObject({ status: "failed", unresolved: true });
    expect(settled?.error).toMatch(/safety backup/);
    const config = (await createConfig()).body;
    expect((await suite.api(`${backupsPath}/configs/${config.id}/run`, "POST", {})).status).toBe(409);
  });
});

describe("a volume restore the panel died in the middle of", () => {
  const volumes = () => join(suite.context.dataDir, "projects", PROJECT, "web", "volumes");
  const restoreRow = (fields: Partial<typeof backupRestores.$inferInsert>) =>
    suite.context.deps.db
      .insert(backupRestores)
      .values({
        id: "restore-1",
        projectName: PROJECT,
        serviceName: "web",
        kind: "volume",
        storageProviderName: "Local Disk",
        sourcePath: "x/y.tar.gz",
        volumeName: "data",
        status: "running",
        phase: "swapping",
        previousReplicas: 2,
        createdAt: new Date(suite.context.deps.now()),
        ...fields,
      })
      .returning()
      .get();
  const settledRow = () => suite.context.deps.db.select().from(backupRestores).get();
  const write = (name: string, marker: string) => {
    mkdirSync(join(volumes(), name), { recursive: true });
    writeFileSync(join(volumes(), name, "marker"), marker);
  };
  const read = (name: string) => readFileSync(join(volumes(), name, "marker"), "utf8");

  it("finishes the job when the swap had completed", async () => {
    write("data", "restored");
    write(".before-restore-data-restore-1", "old");
    const row = restoreRow({});

    await recoverInterruptedRestores(suite.context.deps, [row]);

    expect(settledRow()).toMatchObject({
      status: "succeeded",
      phase: "done",
      earlierCopy: ".before-restore-data-restore-1",
      unresolved: false,
    });
    expect(read("data")).toBe("restored");
    expect(read(".before-restore-data-restore-1")).toBe("old");
  });

  it("puts the old folder back when it died between the two renames", async () => {
    write(".before-restore-data-restore-1", "old");
    write(".restoring-restore-1", "new-but-not-applied");
    const row = restoreRow({});

    await recoverInterruptedRestores(suite.context.deps, [row]);

    expect(settledRow()).toMatchObject({ status: "failed", unresolved: false });
    expect(read("data")).toBe("old");
    expect(existsSync(join(volumes(), ".restoring-restore-1"))).toBe(false);
  });

  it("throws away a half-unpacked copy when the swap never started", async () => {
    write("data", "untouched");
    write(".restoring-restore-1", "half");
    const row = restoreRow({ phase: "staging" });

    await recoverInterruptedRestores(suite.context.deps, [row]);

    expect(settledRow()).toMatchObject({ status: "failed", unresolved: false });
    expect(read("data")).toBe("untouched");
    expect(existsSync(join(volumes(), ".restoring-restore-1"))).toBe(false);
  });

  it("blocks instead of guessing when the volume cannot be found at all", async () => {
    mkdirSync(volumes(), { recursive: true });
    const row = restoreRow({});

    await recoverInterruptedRestores(suite.context.deps, [row]);

    expect(settledRow()).toMatchObject({ status: "failed", unresolved: true });
  });
});

describe("backing up and restoring a volume", () => {
  const appService = (name = "web") => `/projects/${PROJECT}/services/${name}`;
  const volumeDirectory = () => join(suite.context.dataDir, "projects", PROJECT, "web", "volumes", "data");

  async function deployApp(): Promise<void> {
    const created = await suite.api<ServiceDetail>(`/projects/${PROJECT}/services`, "POST", {
      name: "web",
      type: "app",
    });
    expect(created.status).toBe(201);
    expect(
      (await suite.api(`${appService()}/source`, "PUT", { type: "image", image: "alpine:3.20" })).status,
    ).toBe(200);
    expect(
      (
        await suite.api(`${appService()}/storage/mounts`, "POST", {
          type: "volume",
          name: "data",
          mountPath: "/data",
        })
      ).status,
    ).toBe(201);
    const deployed = await suite.run(`${appService()}/deploy`, "POST", {});
    expect(deployed.status).toBe("succeeded");
  }

  const volumeConfig = async (overrides: Record<string, unknown> = {}) =>
    suite.api<BackupConfigEntry>(`${appService()}/backups/configs`, "POST", {
      kind: "volume",
      enabled: false,
      schedule: "0 5 * * *",
      retention: null,
      volumeName: "data",
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: "vol/web",
      ...overrides,
    });

  beforeEach(async () => {
    await deployApp();
  });

  it("is refused for anything but one of the service's own named volumes", async () => {
    expect((await volumeConfig({ volumeName: "not-mounted" })).status).toBe(400);
    expect((await volumeConfig({ path: "bad path" })).status).toBe(400);
    expect((await volumeConfig({ storageProviderId: "" })).status).toBe(400);
  });

  it("goes by what is deployed: a saved volume is not there yet, and a deployed one stays", async () => {
    const documentVolumes = async () =>
      (await suite.api<BackupsDocument>(`${appService()}/backups`)).body.volumes;
    expect(await documentVolumes()).toEqual(["data"]);

    // Saved but never deployed: there is nothing to back up.
    await suite.api(`${appService()}/storage/mounts`, "POST", {
      type: "volume",
      name: "fresh",
      mountPath: "/fresh",
    });
    expect(await documentVolumes()).toEqual(["data"]);
    const notYet = await volumeConfig({ volumeName: "fresh" });
    expect(notYet.status).toBe(400);
    expect(notYet.body as unknown as { error: { fields: Record<string, string> } }).toMatchObject({
      error: { fields: { volumeName: expect.stringContaining("deployed") } },
    });

    // Taken out of the settings but still mounted by what runs: it can still be saved.
    await suite.api(`${appService()}/storage/mounts/0`, "DELETE");
    expect(await documentVolumes()).toEqual(["data"]);
    expect((await volumeConfig()).status).toBe(201);
  });

  it("succeeds on an empty volume, with a real archive and manifest", async () => {
    const config = (await volumeConfig()).body;
    const action = await suite.run(`${appService()}/backups/configs/${config.id}/run`, "POST", {});
    expect(action.status).toBe("succeeded");
    expect(action.log).toContain("Success");
    // Any operator can read this, and where the panel keeps a volume on the host is not theirs to know.
    expect(action.log).not.toContain(suite.context.dataDir);
    expect(action.log).toContain("Source: volume data");
    const backup = (await suite.api<BackupsDocument>(`${appService()}/backups`)).body
      .backups[0] as BackupEntry;
    expect(backup).toMatchObject({
      status: "succeeded",
      kind: "volume",
      volumeName: "data",
      scope: "volume",
      format: "volume-tar-gz-v1",
    });
    expect(existsSync(join(backupRoot(), backup.path))).toBe(true);
    expect(existsSync(join(backupRoot(), `${backup.path}.manifest.json`))).toBe(true);
  });

  it("restores the contents, stops the service for the swap and keeps the earlier copy", async () => {
    const config = (await volumeConfig()).body;
    writeFileSync(join(volumeDirectory(), "keep.txt"), "from the backup");
    mkdirSync(join(volumeDirectory(), "nested"));
    writeFileSync(join(volumeDirectory(), "nested", "file.txt"), "nested");
    await suite.run(`${appService()}/backups/configs/${config.id}/run`, "POST", {});
    const backup = (await suite.api<BackupsDocument>(`${appService()}/backups`)).body
      .backups[0] as BackupEntry;

    writeFileSync(join(volumeDirectory(), "keep.txt"), "overwritten later");
    writeFileSync(join(volumeDirectory(), "extra.txt"), "added after the backup");

    const refused = await suite.api(`${appService()}/backups/${backup.id}/restore`, "POST", {
      confirm: "wrong",
    });
    expect(refused.status).toBe(409);

    const action = await suite.run(`${appService()}/backups/${backup.id}/restore`, "POST", {
      confirm: "data",
    });
    expect(action.status).toBe("succeeded");
    expect(action.log).toMatch(/Checksum verified/);
    expect(action.log).toMatch(/Stopping .* for the swap/);

    expect(readFileSync(join(volumeDirectory(), "keep.txt"), "utf8")).toBe("from the backup");
    expect(readFileSync(join(volumeDirectory(), "nested", "file.txt"), "utf8")).toBe("nested");
    expect(existsSync(join(volumeDirectory(), "extra.txt"))).toBe(false);

    const restore = (await suite.api<BackupsDocument>(`${appService()}/backups`)).body
      .restores[0] as RestoreEntry;
    expect(restore.earlierCopy).toMatch(/^\.before-restore-data-/);
    const earlier = join(dirnameOf(volumeDirectory()), restore.earlierCopy as string);
    expect(readFileSync(join(earlier, "keep.txt"), "utf8")).toBe("overwritten later");
    expect(readFileSync(join(earlier, "extra.txt"), "utf8")).toBe("added after the backup");

    const detail = (await suite.api<ServiceDetail>(appService())).body;
    expect(detail.status).toBe("running");
    expect(detail.replicas).toEqual({ running: 1, desired: 1 });

    const discarded = await suite.api<RestoreEntry>(
      `${appService()}/backups/restores/${restore.id}/discard-earlier-copy`,
      "POST",
      { confirm: "data" },
    );
    expect(discarded.status).toBe(200);
    expect(discarded.body.earlierCopy).toBeNull();
    expect(existsSync(earlier)).toBe(false);
    expect(tmpEntries()).toEqual([]);
  });

  describe("needs a deployed, started service and a backup of the same volume", () => {
    async function backupOfData(): Promise<BackupEntry> {
      const config = (await volumeConfig()).body;
      await suite.run(`${appService()}/backups/configs/${config.id}/run`, "POST", {});
      return (await suite.api<BackupsDocument>(`${appService()}/backups`)).body.backups[0] as BackupEntry;
    }

    const restoreRecorded = (backup: BackupEntry) =>
      suite.api(`${appService()}/backups/${backup.id}/restore`, "POST", { confirm: "data" });

    it("refuses a stopped service, with its name in the reason", async () => {
      const backup = await backupOfData();
      await suite.run(`${appService()}/stop`, "POST", {});

      const refused = await restoreRecorded(backup);

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("service_stopped");
    });

    it("refuses a service that has nothing running", async () => {
      const backup = await backupOfData();
      vi.spyOn(suite.context.docker, "listTasks").mockResolvedValue([]);

      const refused = await restoreRecorded(backup);

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("service_not_running");
    });

    it("checks again when the run starts, because the service may have stopped while it waited", async () => {
      const backup = await backupOfData();
      writeFileSync(join(volumeDirectory(), "live.txt"), "must survive");
      const { docker } = suite.context;
      const real = docker.listTasks.bind(docker);
      vi.spyOn(docker, "listTasks").mockImplementationOnce(real).mockResolvedValue([]);

      const action = await suite.run(`${appService()}/backups/${backup.id}/restore`, "POST", {
        confirm: "data",
      });

      expect(action.status).toBe("failed");
      expect(action.error).toMatch(/no running task/);
      expect(readFileSync(join(volumeDirectory(), "live.txt"), "utf8")).toBe("must survive");
    });

    it("refuses a file whose manifest names another volume, before the file is fetched", async () => {
      const backup = await backupOfData();
      writeFileSync(join(volumeDirectory(), "live.txt"), "must survive");
      const manifestFile = join(backupRoot(), `${backup.path}.manifest.json`);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, volumeName: "uploads" }));

      const accepted = await suite.api<{ id: string }>(`${appService()}/backups/restore`, "POST", {
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path: backup.path,
        databaseName: "data",
        confirm: "data",
      });
      expect(accepted.status).toBe(202);
      const action = await suite.waitFor(accepted.body.id);

      expect(action.status).toBe("failed");
      expect(action.error).toMatch(/backup of the volume uploads, and this restore targets data/);
      expect(action.log).not.toMatch(/Downloading/);
      expect(readFileSync(join(volumeDirectory(), "live.txt"), "utf8")).toBe("must survive");
    });

    it("refuses a database backup pointed at a volume", async () => {
      const backup = await backupOfData();
      const manifestFile = join(backupRoot(), `${backup.path}.manifest.json`);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
      writeFileSync(
        manifestFile,
        JSON.stringify({ ...manifest, kind: "database", scope: "database", volumeName: null }),
      );

      const accepted = await suite.api<{ id: string }>(`${appService()}/backups/restore`, "POST", {
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path: backup.path,
        databaseName: "data",
        confirm: "data",
      });
      expect(accepted.status).toBe(202);
      const action = await suite.waitFor(accepted.body.id);

      expect(action.status).toBe("failed");
      expect(action.error).toMatch(/database backup/);
    });
  });

  it("refuses a hostile archive and leaves the volume exactly as it was", async () => {
    const config = (await volumeConfig()).body;
    await suite.run(`${appService()}/backups/configs/${config.id}/run`, "POST", {});
    const backup = (await suite.api<BackupsDocument>(`${appService()}/backups`)).body
      .backups[0] as BackupEntry;
    writeFileSync(join(volumeDirectory(), "live.txt"), "must survive");

    // Replace the stored file with an archive that tries to climb out, and update the manifest to match.
    const file = join(backupRoot(), backup.path);
    const tar = gzipSync(
      Buffer.concat([
        tarHeader("../../../escaped.txt", 12),
        paddedBlock("hello world\n"),
        Buffer.alloc(1024),
      ]),
    );
    writeFileSync(file, tar);
    const manifestFile = `${file}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as BackupManifest;
    const digest = createHash("sha256").update(tar).digest("hex");
    writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, sha256: digest, sizeBytes: tar.length, uncompressedBytes: 2048 }),
    );

    const accepted = await suite.api<{ id: string }>(`${appService()}/backups/restore`, "POST", {
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: backup.path,
      databaseName: "data",
      confirm: "data",
    });
    expect(accepted.status).toBe(202);
    const action = await suite.waitFor(accepted.body.id);
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/refused/);
    expect(readFileSync(join(volumeDirectory(), "live.txt"), "utf8")).toBe("must survive");
    expect(readdirSync(dirnameOf(volumeDirectory())).some((name) => name.startsWith(".restoring"))).toBe(
      false,
    );
    expect(tmpEntries()).toEqual([]);
  });
});

describe("restoring a file named by hand, across projects", () => {
  let engine: FakeEngine;
  let ownFile: BackupEntry;
  let foreignFile: BackupEntry;

  const operatorOf = async (...projects: string[]): Promise<string> => {
    const email = `${projects.join("-")}@example.com`;
    await suite.api("/users", "POST", {
      email,
      password: TEST_PASSWORD,
      role: "member",
      projects: projects.map((project) => ({ project, role: "operator" })),
    });
    const login = await authPost(suite.context.app, "login", { email, password: TEST_PASSWORD });
    return login.cookie as string;
  };

  const restoreAs = async (cookie: string, path: string, databaseName = "app") => {
    const accepted = await call<{ id: string }>(suite.context.app, `/api/v1${backupsPath}/restore`, {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { storageProviderId: BUILT_IN_PROVIDER_ID, path, databaseName, confirm: databaseName },
    });
    expect(accepted.status).toBe(202);
    return suite.waitFor(accepted.body.id);
  };

  beforeEach(async () => {
    await deployedDatabase();
    engine = fakeEngine(suite.context);
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    ownFile = await latest();

    await suite.api("/projects", "POST", { name: "other" });
    const other = await suite.api<ServiceDetail>("/projects/other/databases", "POST", {
      name: "db",
      engine: "postgres",
      databaseName: "app",
    });
    await suite.waitFor(other.body.activeAction?.id as string);
    const foreignConfig = await suite.api<BackupConfigEntry>(
      "/projects/other/services/db/backups/configs",
      "POST",
      {
        kind: "database",
        enabled: true,
        schedule: "0 2 * * *",
        retention: null,
        databaseName: "app",
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path: "other/db",
      },
    );
    await suite.run(`/projects/other/services/db/backups/configs/${foreignConfig.body.id}/run`, "POST", {});
    const foreign = await suite.api<BackupsDocument>("/projects/other/services/db/backups");
    foreignFile = foreign.body.backups[0] as BackupEntry;
    engine.imports.length = 0;
  });

  it("refuses another project's backup, and answers as if the file were not there", async () => {
    const operator = await operatorOf("shop");

    const foreign = await restoreAs(operator, foreignFile.path);
    const absent = await restoreAs(operator, "other/db/no-such-file.sql.gz");

    expect(foreign.status).toBe("failed");
    expect(foreign.error).toBe(`The file ${foreignFile.path} no longer exists at the destination.`);
    expect(absent.error).toBe("The file other/db/no-such-file.sql.gz no longer exists at the destination.");
    expect(foreign.log).not.toContain("manifest");
    expect(engine.imports).toHaveLength(0);
  });

  it("lets an operator of the project it came from restore it", async () => {
    const operator = await operatorOf("shop", "other");

    expect((await restoreAs(operator, foreignFile.path)).status).toBe("succeeded");
    expect(engine.imports).toHaveLength(1);
  });

  it("lets an operator restore their own project's file by path", async () => {
    const operator = await operatorOf("shop");

    expect((await restoreAs(operator, ownFile.path)).status).toBe("succeeded");
    expect(engine.imports).toHaveLength(1);
  });

  it("takes a file with no record at its manifest's word", async () => {
    const operator = await operatorOf("shop");
    suite.context.deps.db.delete(backups).run();

    expect((await restoreAs(operator, ownFile.path)).status).toBe("succeeded");
    expect((await restoreAs(operator, foreignFile.path)).status).toBe("failed");
    expect(engine.imports).toHaveLength(1);
  });

  it("refuses a file nobody can vouch for, in the same words", async () => {
    const operator = await operatorOf("shop");
    mkdirSync(join(backupRoot(), "shop"), { recursive: true });
    writeFileSync(join(backupRoot(), "shop", "stray.sql.gz"), gzipSync("-- no manifest\n"));

    const action = await restoreAs(operator, "shop/stray.sql.gz");

    expect(action.error).toBe("The file shop/stray.sql.gz no longer exists at the destination.");
    expect(action.log).not.toContain("manifest");
  });

  it("follows a service that moved, whatever its manifest still says", async () => {
    const operator = await operatorOf("shop");
    await suite.run("/projects/other/services/db/stop");
    const moved = await suite.api("/projects/other/services/db/rename", "POST", {
      projectName: PROJECT,
      name: "moved",
    });
    expect(moved.status).toBe(200);

    expect((await restoreAs(operator, foreignFile.path)).status).toBe("succeeded");
  });

  it("is open to an administrator, who reaches every project", async () => {
    const accepted = await suite.api<{ id: string }>(`${backupsPath}/restore`, "POST", {
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: foreignFile.path,
      databaseName: "app",
      confirm: "app",
    });

    expect((await suite.waitFor(accepted.body.id)).status).toBe("succeeded");
  });
});

describe("the provider files a restore relies on", () => {
  it("are readable through the same backend the backup used", async () => {
    await deployedDatabase();
    fakeEngine(suite.context);
    const config = (await createConfig()).body;
    await suite.run(`${backupsPath}/configs/${config.id}/run`, "POST", {});
    const backup = (await document()).backups[0] as BackupEntry;
    const provider = findProviderRow(suite.context.deps.db, BUILT_IN_PROVIDER_ID);
    const backend = backendForProvider(suite.context.deps, provider as NonNullable<typeof provider>);
    expect(await backend.stat(backup.path)).toMatchObject({ size: backup.sizeBytes });
    const listed: string[] = [];
    for await (const file of backend.list("shop")) {
      listed.push(file.path);
    }
    expect(listed.sort()).toEqual([backup.path, `${backup.path}.manifest.json`].sort());
  });
});
