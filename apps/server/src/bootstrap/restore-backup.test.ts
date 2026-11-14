import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDriver, type SwarmServiceSpec } from "../core/docker";
import { FakeTools, type ToolRequest } from "../core/tools";
import { pendingRestoreFile, restoreDumpsDirectory } from "../features/server-backup/pending";
import { parseArgs } from "./cli";
import { type RestoreBackupDeps, RestoreError, runRestoreBackup } from "./restore-backup";
import { PANEL_SWARM_SERVICE } from "./specs";

/** Where the backed-up server kept its data, which is not where this one does. */
const SOURCE = "/var/lib/opsifier";
const NEWEST = "4f1c0b2a9d8e7f60aabbccddeeff00112233445566778899aabbccddeeff0011";
const OLDER = "9a8b7c6d5e4f30211223344556677889900aabbccddeeff0011223344556677";

let dataDir: string;
let tools: FakeTools;
let docker: FakeDriver;
let restic: ToolRequest[];
let log: string[];
let accounts: boolean;

function snapshot(id: string, time: string) {
  return {
    id,
    time,
    hostname: "old-server",
    paths: [`${SOURCE}/server-backup/staging`, `${SOURCE}/traefik`, `${SOURCE}/projects`],
  };
}

/** Writes what `restic restore` would: the backed-up paths, under the target. */
function restoreInto(target: string): void {
  const write = (path: string, content: string) => {
    const file = join(target, SOURCE, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write("server-backup/staging/state/opsifier.db", "the panel's state");
  write("server-backup/staging/state/secret.key", "the panel's key");
  write(
    "server-backup/staging/state/setup-state.json",
    JSON.stringify({ image: "ghcr.io/example/opsifier:0.6.0" }),
  );
  write("server-backup/staging/dumps/shop/db.instance.sql", "CREATE DATABASE app;\n");
  write("traefik/acme.json", "{}");
  write("projects/shop/web/volumes/uploads/photo.jpg", "jpeg");
  write("actions/a1.log", "Deploy shop/web");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-restore-"));
  tools = new FakeTools();
  docker = new FakeDriver();
  restic = [];
  log = [];
  accounts = false;
  tools.handler = async (request) => {
    if (request.command !== "restic") {
      return undefined;
    }
    restic.push(request);
    if (request.args[0] === "snapshots") {
      request.onLine?.(
        JSON.stringify([snapshot(OLDER, "2026-11-13T02:30:00Z"), snapshot(NEWEST, "2026-11-14T02:30:00Z")]),
      );
    }
    if (request.args[0] === "restore") {
      restoreInto(request.args[request.args.indexOf("--target") + 1] as string);
    }
    return { exitCode: 0, tail: [] };
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const ENV = {
  RESTIC_REPOSITORY: "s3:https://s3.eu-west-3.amazonaws.com/acme-backups/opsifier-server",
  RESTIC_PASSWORD: "kq3Yx0b8n2c-recovery-key",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret-access-key",
  AWS_DEFAULT_REGION: "eu-west-3",
  UNRELATED: "left out",
};

function deps(env: Record<string, string> = ENV): RestoreBackupDeps {
  return {
    tools,
    docker,
    dataDir,
    databaseFile: join(dataDir, "opsifier.db"),
    secretKeyFile: join(dataDir, "secret.key"),
    env,
    hasAccounts: () => accounts,
    log: (line) => log.push(line),
    now: () => Date.parse("2026-11-15T09:00:00Z"),
  };
}

const read = (path: string) => readFileSync(join(dataDir, path), "utf8");

describe("putting a server backup back", () => {
  it("puts the panel's state, its key and the volumes where they go, and leaves the databases to the panel", async () => {
    const restored = await runRestoreBackup({ snapshot: "latest", force: false }, deps());

    expect(restored?.id).toBe(NEWEST);
    expect(read("opsifier.db")).toBe("the panel's state");
    expect(read("secret.key")).toBe("the panel's key");
    expect(statSync(join(dataDir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(read("traefik/acme.json")).toBe("{}");
    expect(read("projects/shop/web/volumes/uploads/photo.jpg")).toBe("jpeg");
    expect(read("actions/a1.log")).toBe("Deploy shop/web");
    expect(readFileSync(join(restoreDumpsDirectory(dataDir), "shop", "db.instance.sql"), "utf8")).toContain(
      "CREATE DATABASE app;",
    );
    expect(JSON.parse(readFileSync(pendingRestoreFile(dataDir), "utf8"))).toEqual({
      snapshotId: NEWEST,
      snapshotTime: "2026-11-14T02:30:00Z",
      hostname: "old-server",
    });
    // What restic unpacked is gone once everything is in place.
    expect(readdirSync(join(dataDir, "restore")).sort()).toEqual(["dumps", "pending.json"]);
    expect(existsSync(join(dataDir, "setup-state.json"))).toBe(false);

    const restore = restic.find((request) => request.args[0] === "restore");
    expect(restore?.args.slice(0, 2)).toEqual(["restore", NEWEST]);
    expect(restore?.env).toMatchObject({
      RESTIC_REPOSITORY: ENV.RESTIC_REPOSITORY,
      RESTIC_PASSWORD: ENV.RESTIC_PASSWORD,
      AWS_SECRET_ACCESS_KEY: ENV.AWS_SECRET_ACCESS_KEY,
    });
    expect(restore?.env.UNRELATED).toBeUndefined();
    expect(log.join("\n")).toContain("That server ran ghcr.io/example/opsifier:0.6.0");
    expect(log.join("\n")).toContain(`The backup's data was in ${SOURCE}`);
  });

  it("takes a snapshot by the start of its id, and says so when none or several match", async () => {
    expect((await runRestoreBackup({ snapshot: OLDER.slice(0, 8), force: false }, deps()))?.id).toBe(OLDER);
    rmSync(pendingRestoreFile(dataDir));

    await expect(runRestoreBackup({ snapshot: "ffff", force: true }, deps())).rejects.toThrow(
      /No server backup has the id ffff/,
    );
    await expect(runRestoreBackup({ snapshot: "", force: true }, deps())).rejects.toThrow(
      /Several server backups/,
    );
  });

  it("needs the repository and the recovery key", async () => {
    await expect(runRestoreBackup({ snapshot: "latest", force: false }, deps({}))).rejects.toThrow(
      /RESTIC_REPOSITORY/,
    );
    await expect(
      runRestoreBackup(
        { snapshot: "latest", force: false },
        deps({ RESTIC_REPOSITORY: ENV.RESTIC_REPOSITORY }),
      ),
    ).rejects.toThrow(/recovery key/);
    expect(restic).toEqual([]);
  });

  it("leaves a panel that has accounts alone, unless forced, and then moves its state aside", async () => {
    writeFileSync(join(dataDir, "opsifier.db"), "the panel already here");
    mkdirSync(join(dataDir, "projects", "blog"), { recursive: true });
    accounts = true;

    await expect(runRestoreBackup({ snapshot: "latest", force: false }, deps())).rejects.toBeInstanceOf(
      RestoreError,
    );
    expect(read("opsifier.db")).toBe("the panel already here");
    expect(restic).toEqual([]);

    await runRestoreBackup({ snapshot: "latest", force: true }, deps());
    expect(read("opsifier.db")).toBe("the panel's state");
    const aside = readdirSync(join(dataDir, "restore")).find((name) =>
      name.startsWith("previous-"),
    ) as string;
    expect(read(join("restore", aside, "opsifier.db"))).toBe("the panel already here");
    expect(existsSync(join(dataDir, "restore", aside, "projects", "blog"))).toBe(true);
  });

  it("refuses to run under a panel that is running", async () => {
    await docker.createService({
      Name: PANEL_SWARM_SERVICE,
      Mode: { Replicated: { Replicas: 1 } },
      TaskTemplate: { ContainerSpec: { Image: "ghcr.io/example/opsifier:0.6.0" } },
    } as SwarmServiceSpec);

    await expect(runRestoreBackup({ snapshot: "latest", force: true }, deps())).rejects.toThrow(
      /docker service scale opsifier=0/,
    );
  });

  it("lets setup carry on when a backup is already back and waiting for the panel", async () => {
    mkdirSync(join(dataDir, "restore"), { recursive: true });
    writeFileSync(pendingRestoreFile(dataDir), "{}");

    expect(await runRestoreBackup({ snapshot: "latest", force: false }, deps())).toBeNull();
    expect(restic).toEqual([]);
  });

  it("refuses a snapshot that a server backup did not make", async () => {
    tools.handler = async (request) => {
      if (request.args[0] === "snapshots") {
        request.onLine?.(JSON.stringify([{ ...snapshot(NEWEST, "2026-11-14T02:30:00Z"), paths: ["/home"] }]));
      }
      return { exitCode: 0, tail: [] };
    };
    await expect(runRestoreBackup({ snapshot: "latest", force: false }, deps())).rejects.toThrow(
      /not made by an Opsifier server backup/,
    );
  });
});

describe("the restore-backup command", () => {
  it("takes --snapshot and --force", () => {
    expect(parseArgs(["--snapshot", "4f1c0b2a", "--force"])).toMatchObject({
      snapshot: "4f1c0b2a",
      force: true,
    });
  });
});
