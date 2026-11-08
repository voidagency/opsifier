import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETAINED_ACTIONS } from "./core/actions";
import { hashPassword } from "./core/auth";
import { type Config, loadConfig } from "./core/config";
import { actions, users } from "./core/db/schema";
import { FakeDriver } from "./core/docker";
import { SecretsError } from "./core/secrets";
import { createRuntime, type Runtime } from "./runtime";

let dataDir: string;
let config: Config;
let lines: string[];
const opened: Runtime[] = [];

function boot(): Promise<Runtime> {
  const logger = pino({ level: "debug" }, { write: (line) => lines.push(line) });
  const runtime = createRuntime(config, { docker: new FakeDriver({ tickMs: 60_000 }), logger });
  opened.push(runtime);
  return runtime.boot().then(() => runtime);
}

async function shutDown(runtime: Runtime): Promise<void> {
  opened.splice(opened.indexOf(runtime), 1);
  await runtime.close();
}

async function addUser(runtime: Runtime): Promise<void> {
  const now = new Date();
  runtime.deps.db
    .insert(users)
    .values({
      id: "u1",
      email: "admin@example.com",
      passwordHash: await hashPassword("a test password here"),
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-runtime-"));
  config = loadConfig({ NODE_ENV: "test", OPSIFIER_DATA_DIR: dataDir, OPSIFIER_DRIVER: "fake" });
  lines = [];
});

afterEach(async () => {
  for (const runtime of opened.splice(0)) {
    await runtime.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the setup token at boot", () => {
  const stored = () => readFileSync(config.setupTokenFile, "utf8").trim();

  it("is created with mode 0600 while no user exists", async () => {
    await boot();
    expect(stored()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(config.setupTokenFile).mode & 0o777).toBe(0o600);
  });

  it("is printed once, with the path that uses it", async () => {
    await boot();
    const mentions = lines.filter((line) => line.includes(stored()));

    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain(`/setup?token=${stored()}`);
  });

  it("survives a restart until it has been used", async () => {
    const first = await boot();
    const token = stored();
    await shutDown(first);

    await boot();
    expect(stored()).toBe(token);
  });

  it("is not issued once a user exists", async () => {
    const first = await boot();
    await addUser(first);
    rmSync(config.setupTokenFile);
    await shutDown(first);
    lines = [];

    await boot();

    expect(existsSync(config.setupTokenFile)).toBe(false);
    expect(lines.join("")).not.toContain("/setup?token=");
  });

  it("is removed if one was left behind and a user exists", async () => {
    const first = await boot();
    await addUser(first);
    await shutDown(first);
    expect(existsSync(config.setupTokenFile)).toBe(true);

    await boot();

    expect(existsSync(config.setupTokenFile)).toBe(false);
  });
});

describe("the secret key at boot", () => {
  it("is created for a panel with no users", async () => {
    await boot();
    expect(existsSync(config.secretKeyFile)).toBe(true);
  });

  it("survives being deleted before anyone has signed up", async () => {
    const first = await boot();
    await shutDown(first);
    rmSync(config.secretKeyFile);

    await boot();

    expect(existsSync(config.secretKeyFile)).toBe(true);
  });

  it("is required once users exist, with a message that says what to do", async () => {
    const first = await boot();
    await addUser(first);
    await shutDown(first);
    rmSync(config.secretKeyFile);

    expect(() => createRuntime(config, { docker: new FakeDriver() })).toThrow(SecretsError);
    expect(() => createRuntime(config, { docker: new FakeDriver() })).toThrow(/missing.*users.*backup/s);
    expect(existsSync(config.secretKeyFile)).toBe(false);
  });

  it("keeps working when present", async () => {
    const first = await boot();
    await addUser(first);
    const key = readFileSync(config.secretKeyFile);
    await shutDown(first);

    await boot();

    expect(readFileSync(config.secretKeyFile).equals(key)).toBe(true);
  });
});

describe("action retention at boot", () => {
  it("prunes what is over the limit, after recovering interrupted work", async () => {
    const first = await boot();
    const db = first.deps.db;
    const row = (id: string) => ({
      id,
      type: "deploy",
      title: "t",
      status: "succeeded" as const,
      hasLog: true,
      createdAt: new Date(0),
    });
    db.transaction((tx) => {
      tx.insert(actions).values(row("oldest")).run();
      for (let index = 0; index < RETAINED_ACTIONS; index += 1) {
        tx.insert(actions)
          .values(row(`newer-${index}`))
          .run();
      }
    });
    writeFileSync(join(config.actionsDir, "oldest.log"), "output\n");
    await shutDown(first);

    const second = await boot();

    expect(second.deps.db.select().from(actions).all()).toHaveLength(RETAINED_ACTIONS);
    expect(existsSync(join(config.actionsDir, "oldest.log"))).toBe(false);
  });
});
