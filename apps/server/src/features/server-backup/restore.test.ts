import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseDetail, ServerBackupState } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEngine } from "../backups/testing";
import { apiErrorOf, type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../databases/testing";
import { pendingRestoreFile, restoreDumpsDirectory } from "./pending";
import { resumeServerRestore } from "./restore";
import { readServerBackup, settleInterruptedRun, writeServerBackup } from "./service";

let suite: DatabaseTestContext;

const SNAPSHOT = "4f1c0b2a9d8e7f60aabbccddeeff00112233445566778899aabbccddeeff0011";
const DUMP = [
  "CREATE ROLE owner;",
  "ALTER ROLE owner WITH SUPERUSER LOGIN PASSWORD 'old';",
  "\\connect postgres",
  "CREATE DATABASE app;",
  "",
].join("\n");

beforeEach(async () => {
  suite = await setupDatabaseTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await suite.close();
});

const docker = () => suite.context.docker;
const dataDir = () => suite.context.dataDir;
const dumpFile = () => join(restoreDumpsDirectory(dataDir()), PROJECT, "db.instance.sql");
/** What went into a temporary restore server, leaving out the probes a deployment makes. */
const importsOf = (fake: ReturnType<typeof fakeEngine>) =>
  fake.imports.filter((entry) => entry.options.service.startsWith("opsifier-restore-"));

/**
 * A new server just after `install.sh --restore`: the panel's state knows a database and an
 * application, both running when the backup was taken, and Docker has neither.
 */
async function freshServer(options: { keepDatabase?: boolean } = {}): Promise<void> {
  await suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });
  await suite.api(`/projects/${PROJECT}/services`, "POST", { name: "web" });
  await suite.api(`/projects/${PROJECT}/services/web/source`, "PUT", { image: "nginx:alpine" });
  expect((await suite.run(`/projects/${PROJECT}/services/web/deploy`)).status).toBe("succeeded");
  await docker().removeService("shop_web");
  if (options.keepDatabase !== true) {
    await docker().removeService("shop_db");
    await docker().removeVolume("shop_db_data");
  }

  mkdirSync(join(restoreDumpsDirectory(dataDir()), PROJECT), { recursive: true });
  writeFileSync(dumpFile(), DUMP);
  writeFileSync(
    pendingRestoreFile(dataDir()),
    JSON.stringify({ snapshotId: SNAPSHOT, snapshotTime: "2026-11-14T02:30:00Z", hostname: "old-server" }),
  );
}

async function restore() {
  resumeServerRestore(suite.context.deps);
  const id = readServerBackup(suite.context.deps).restore?.actionId;
  expect(id).toBeTruthy();
  return suite.waitFor(id as string);
}

describe("bringing a server back from its backup", () => {
  it("imports each database into its volume, deploys it, then deploys every application", async () => {
    await freshServer();
    const fake = fakeEngine(suite.context);
    const created = vi.spyOn(docker(), "createService");

    const action = await restore();

    expect(action.status).toBe("succeeded");
    expect(action.type).toBe("backup.restore-server");
    const isolated = created.mock.calls
      .map(([spec]) => spec)
      .find((spec) => spec.Name.startsWith("opsifier-restore-"));
    expect(isolated?.TaskTemplate.Networks).toEqual([]);
    expect(isolated?.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source).toBe("shop_db_data");
    expect(await docker().inspectService(isolated?.Name as string)).toBeNull();

    const imports = importsOf(fake);
    expect(imports).toHaveLength(1);
    expect(imports[0]?.options.service).toBe(isolated?.Name);
    const script = imports[0]?.stdin.toString("utf8") ?? "";
    expect(script).toContain("CREATE DATABASE app;");
    expect(script).not.toMatch(/CREATE ROLE owner|ALTER ROLE owner/);

    expect(
      (await docker().inspectService("shop_db"))?.spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source,
    ).toBe("shop_db_data");
    expect(await docker().inspectService("shop_web")).not.toBeNull();

    expect(existsSync(pendingRestoreFile(dataDir()))).toBe(false);
    expect(existsSync(restoreDumpsDirectory(dataDir()))).toBe(false);
    const state = await suite.api<ServerBackupState>("/server/backup");
    expect(state.body.restore).toMatchObject({
      status: "succeeded",
      snapshotId: SNAPSHOT,
      hostname: "old-server",
      problems: [],
    });
    expect(state.body.restore?.finishedAt).not.toBeNull();
  });

  it("leaves a database it could not import undeployed, keeps its export, and still brings the rest back", async () => {
    await freshServer();
    fakeEngine(suite.context, { importExit: 1 });

    const action = await restore();

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/shop\/db: the import failed/);
    expect(await docker().inspectService("shop_db")).toBeNull();
    expect(await docker().inspectService("shop_web")).not.toBeNull();
    expect(existsSync(dumpFile())).toBe(true);
    expect(existsSync(pendingRestoreFile(dataDir()))).toBe(false);
    const { restore: outcome } = readServerBackup(suite.context.deps);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.problems).toEqual([expect.stringMatching(/^shop\/db: the import failed/)]);
  });

  it("never writes into a volume that is already there: the data goes into a new one, and the database moves onto it", async () => {
    // A panel was already on this server, its database running on that volume.
    await freshServer({ keepDatabase: true });
    // Docker makes it when the first task starts; the simulated driver leaves that to the test.
    await docker().createVolume({ name: "shop_db_data" });
    const fake = fakeEngine(suite.context);

    expect((await restore()).status).toBe("succeeded");

    const volume = (await suite.api<DatabaseDetail>(`${suite.service("db")}/database`)).body.volume;
    expect(volume).toMatch(/^shop_db_data_restored_/);
    expect(importsOf(fake)).toHaveLength(1);
    expect(
      (await docker().inspectService("shop_db"))?.spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source,
    ).toBe(volume);
    const retained = await suite.api<{ volumes: Array<{ name: string }> }>("/retained-volumes");
    expect(retained.body.volumes).toContainEqual(expect.objectContaining({ name: "shop_db_data" }));
  });

  it("carries on after a restart without importing a database twice", async () => {
    await freshServer();
    writeFileSync(`${dumpFile()}.imported`, "");
    const fake = fakeEngine(suite.context);

    expect((await restore()).status).toBe("succeeded");
    expect(importsOf(fake)).toHaveLength(0);
    expect(await docker().inspectService("shop_db")).not.toBeNull();
  });

  it("holds backups back while it runs", async () => {
    await freshServer();
    fakeEngine(suite.context);
    resumeServerRestore(suite.context.deps);

    const refused = await suite.api("/server/backup/run", "POST");
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("restore_running");

    await suite.waitFor(readServerBackup(suite.context.deps).restore?.actionId as string);
  });

  it("says so when the panel restarted in the middle and nothing is left to carry on", () => {
    writeServerBackup(suite.context.deps, {
      restore: {
        status: "running",
        actionId: "a1",
        snapshotId: SNAPSHOT,
        snapshotTime: "2026-11-14T02:30:00Z",
        hostname: "old-server",
        startedAt: "2026-11-14T10:00:00Z",
        finishedAt: null,
        problems: [],
      },
    });
    resumeServerRestore(suite.context.deps);
    const { restore: outcome } = readServerBackup(suite.context.deps);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.problems).toEqual(["The panel restarted during the restore."]);
  });
});

describe("a backup the panel was in the middle of when it stopped", () => {
  it("counts as failed, so that the schedule is not held back", () => {
    writeServerBackup(suite.context.deps, {
      lastRun: {
        actionId: "a1",
        status: "running",
        startedAt: "2026-11-14T02:30:00Z",
        finishedAt: null,
        snapshotId: null,
        addedBytes: null,
        processedBytes: null,
        error: null,
      },
    });
    settleInterruptedRun(suite.context.deps);
    expect(readServerBackup(suite.context.deps).lastRun).toMatchObject({
      status: "failed",
      error: "The panel restarted during this backup.",
    });
  });
});
