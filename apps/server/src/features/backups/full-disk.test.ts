import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { BackupConfigEntry, BackupEntry, BackupsDocument } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../databases/testing";
import { BUILT_IN_PROVIDER_ID } from "../storage-providers/service";
import { fakeEngine } from "./testing";

const disk = vi.hoisted(() => ({ full: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      if (disk.full && String(args[0]).includes("backup-")) {
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
          },
        }) as unknown as ReturnType<typeof actual.createWriteStream>;
      }
      return actual.createWriteStream(...args);
    },
  };
});

let suite: DatabaseTestContext;
const backupsPath = `/projects/${PROJECT}/services/db/backups`;

async function config(overrides: Record<string, unknown> = {}): Promise<BackupConfigEntry> {
  return (
    await suite.api<BackupConfigEntry>(`${backupsPath}/configs`, "POST", {
      kind: "database",
      enabled: true,
      schedule: "0 2 * * *",
      retention: null,
      databaseName: "app",
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: "shop/db",
      ...overrides,
    })
  ).body;
}

const latest = async () => (await suite.api<BackupsDocument>(backupsPath)).body.backups[0] as BackupEntry;
const tmpEntries = () => {
  const directory = join(suite.context.dataDir, "tmp");
  return existsSync(directory) ? readdirSync(directory) : [];
};

beforeEach(async () => {
  disk.full = false;
  suite = await setupDatabaseTests();
  await suite.deployed({ engine: "postgres", databaseName: "app" });
  fakeEngine(suite.context);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await suite.close();
});

describe("a backup that cannot be completed", () => {
  it("reports a full disk during the dump, with no false success and nothing left behind", async () => {
    const backup = await config();
    disk.full = true;
    const action = await suite.run(`${backupsPath}/configs/${backup.id}/run`, "POST", {});

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/ran out of space/);
    expect(await latest()).toMatchObject({ status: "failed", restorable: false });
    expect(tmpEntries()).toEqual([]);
    expect(existsSync(join(suite.context.dataDir, "backups", "shop"))).toBe(false);
  });

  it("reports a destination that stopped accepting writes", async () => {
    const dest = join(suite.context.dataDir, "backups", "readonly");
    mkdirSync(dest, { recursive: true });
    const created = await suite.api<{ id: string }>("/storage-providers", "POST", {
      kind: "local",
      name: "readonly",
      path: dest,
    });
    expect(created.status).toBe(201);
    const target = await config({ storageProviderId: created.body.id, path: "kept" });
    chmodSync(dest, 0o500);
    try {
      const action = await suite.run(`${backupsPath}/configs/${target.id}/run`, "POST", {});
      expect(action.status).toBe("failed");
      expect(action.error).toMatch(/may not write/);
      expect(await latest()).toMatchObject({ status: "failed" });
      expect(tmpEntries()).toEqual([]);
    } finally {
      chmodSync(dest, 0o700);
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("removes a stored file that disappeared without complaining, when retention looks for it", async () => {
    const target = await config();
    await suite.run(`${backupsPath}/configs/${target.id}/run`, "POST", {});
    const first = await latest();
    rmSync(join(suite.context.dataDir, "backups", first.path), { force: true });

    const removed = await suite.api<{ id: string }>(`${backupsPath}/${first.id}`, "DELETE");
    const action = await suite.waitFor(removed.body.id);
    expect(action.status).toBe("succeeded");
    expect((await latest()).deletedAt).not.toBeNull();
  });
});
