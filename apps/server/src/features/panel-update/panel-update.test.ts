import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionEntry, PanelUpdateStatus } from "@opsifier/contract";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelServiceSpec } from "../../bootstrap/specs";
import type { FakeDriver } from "../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { readJournal, restoreInterruptedUpdate, restoreSnapshot } from "./journal";
import { repositoryOf } from "./service";
import { compareVersions, isVersion } from "./version";

const OLD_IMAGE = "ghcr.io/example/opsifier:1.0.0";
const NEW_IMAGE = "ghcr.io/example/opsifier:1.1.0";
const FEED_URL = "https://releases.example/release.json";
const RELEASE = {
  version: "1.1.0",
  image: NEW_IMAGE,
  notes: "## Changes\n- Faster",
  migrations: ["Adds a table"],
  publishedAt: "2026-11-01T00:00:00.000Z",
};

let dataDir: string;
let context: TestContext | null = null;
let cookie: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-update-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context?.close();
  context = null;
  rmSync(dataDir, { recursive: true, force: true });
});

function stubFeed(release: unknown = RELEASE, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(release), { status })),
  );
}

/** A process of the panel at this version, on the data directory shared between versions. */
async function panelAt(version: string, env: Record<string, string> = {}): Promise<TestContext> {
  await context?.close();
  context = await createTestContext({
    env: {
      OPSIFIER_DATA_DIR: dataDir,
      OPSIFIER_VERSION: version,
      OPSIFIER_RELEASES_URL: FEED_URL,
      OPSIFIER_UPDATE_VERIFY_SECONDS: "0",
      ...env,
    },
  });
  return context;
}

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>((context as TestContext).app, `/api/v1${path}`, {
    method,
    body,
    cookie,
    origin: TEST_ORIGIN,
  });
}

async function installPanelService(ctx: TestContext, image = OLD_IMAGE): Promise<void> {
  const docker = ctx.docker as FakeDriver;
  const network = await docker.inspectNetwork("opsifier");
  await docker.createService(
    panelServiceSpec({
      dataDir,
      image,
      networkId: network?.id ?? "n",
      trustedProxies: ["10.0.0.0/24"],
    }),
  );
  docker.advance(8);
}

async function waitForAction(id: string): Promise<ActionEntry> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<ActionEntry>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The action did not finish");
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out");
}

const status = async () => (await api<PanelUpdateStatus>("/system/update")).body;
const check = async () => (await api<PanelUpdateStatus>("/system/update/check", "POST")).body;
const canary = () =>
  (context as TestContext).deps.db.get<{ found: number }>(
    sql`SELECT count(*) AS found FROM sqlite_master WHERE name = 'update_canary'`,
  )?.found;

async function handedOverUpdate(): Promise<string> {
  const ctx = await panelAt("1.0.0");
  cookie = await setupAdmin(ctx.app);
  await installPanelService(ctx);
  stubFeed();
  await check();
  const started = await api<ActionEntry>("/system/update", "POST", { version: "1.1.0", confirm: "update" });
  expect(started.status).toBe(202);
  await until(() => readJournal({ dataDir }) !== null);
  await until(async () =>
    (ctx.docker as FakeDriver)
      .inspectService("opsifier")
      .then(
        (panel) => panel?.spec.TaskTemplate.ContainerSpec.Image.startsWith(`${NEW_IMAGE}@sha256:`) === true,
      ),
  );
  await until(() => ctx.deps.actions.isIdle());
  return started.body.id;
}

/** What Swarm does next: the old process goes away, and one of the two versions starts up. */
async function nextProcess(version: string): Promise<TestContext> {
  const ctx = await panelAt(version);
  cookie = await setupAdmin(ctx.app).catch(() => cookie);
  return ctx;
}

async function signIn(): Promise<void> {
  const login = await call((context as TestContext).app, "/api/v1/auth/login", {
    method: "POST",
    body: { email: "admin@example.com", password: "correct horse battery staple" },
    origin: TEST_ORIGIN,
  });
  cookie = login.cookie as string;
}

describe("versions", () => {
  it.each([
    ["1.0.0", "1.0.1", -1],
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0", "1.0.0", 0],
    ["v1.2.3", "1.2.3", 0],
    ["1.0.0+build", "1.0.0", 0],
  ])("orders %s against %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it("recognizes what is not a version", () => {
    expect(isVersion("latest")).toBe(false);
    expect(isVersion("1.2")).toBe(false);
    expect(isVersion("1.2.3")).toBe(true);
  });

  it.each([
    ["ghcr.io/example/opsifier:1.0.0", "ghcr.io/example/opsifier"],
    ["ghcr.io/example/opsifier:1.0.0@sha256:abc", "ghcr.io/example/opsifier"],
    ["127.0.0.1:5000/opsifier:1.0.0", "127.0.0.1:5000/opsifier"],
    ["127.0.0.1:5000/opsifier", "127.0.0.1:5000/opsifier"],
  ])("finds the repository of %s", (image, repository) => {
    expect(repositoryOf(image)).toBe(repository);
  });
});

describe("the update check", () => {
  it("shows the running version, and never touches the installation", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    await installPanelService(ctx);
    stubFeed({ ...RELEASE, version: "1.0.0", image: OLD_IMAGE });
    const before = await (ctx.docker as FakeDriver).inspectService("opsifier");

    const result = await check();

    expect(result.updateAvailable).toBe(false);
    expect(result.activeVersion).toBe("1.0.0");
    expect((await (ctx.docker as FakeDriver).inspectService("opsifier"))?.version).toBe(before?.version);
    expect(ctx.deps.actions.isIdle()).toBe(true);
  });

  it("offers a newer version with its notes", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    stubFeed();

    const result = await check();

    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toMatchObject({ version: "1.1.0", migrations: ["Adds a table"] });
  });

  it("explains a feed that can't be read, and offers nothing", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    stubFeed({}, 502);

    const result = await check();

    expect(result.updateAvailable).toBe(false);
    expect(result.checkError).toContain("502");
    expect(result.checkedAt).not.toBeNull();
  });

  it("does not go anywhere when the feed is turned off", async () => {
    const ctx = await panelAt("1.0.0", { OPSIFIER_RELEASES_URL: "off" });
    cookie = await setupAdmin(ctx.app);
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);

    const result = await check();

    expect(fetched).not.toHaveBeenCalled();
    expect(result.checksEnabled).toBe(false);
  });

  it("says plainly when the panel can't update itself here", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    stubFeed();
    await check();

    const refused = await api("/system/update", "POST", { version: "1.1.0", confirm: "update" });

    expect((await status()).managed).toBe(false);
    expect(refused.status).toBe(503);
    expect(apiErrorOf(refused).code).toBe("not_managed");
  });
});

describe("applying an update", () => {
  it("takes a typed confirmation and the version on offer", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    await installPanelService(ctx);
    stubFeed();
    await check();

    const wrongWord = await api("/system/update", "POST", { version: "1.1.0", confirm: "yes" });
    const wrongVersion = await api("/system/update", "POST", { version: "9.9.9", confirm: "update" });

    expect(wrongWord.status).toBe(409);
    expect(apiErrorOf(wrongWord).code).toBe("confirmation_mismatch");
    expect(wrongVersion.status).toBe(409);
    expect(apiErrorOf(wrongVersion).code).toBe("update_unavailable");
  });

  it("will not interrupt other work", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    await installPanelService(ctx);
    stubFeed();
    await check();
    let release = () => {};
    const busy = ctx.deps.actions.enqueue({
      type: "service.deploy",
      title: "Deploy shop/web",
      projectName: "shop",
      serviceName: "web",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await until(() => !ctx.deps.actions.isIdle() && release.toString().length > 0);

    const refused = await api("/system/update", "POST", { version: "1.1.0", confirm: "update" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("panel_busy");
    release();
    await waitForAction(busy.id);
  });

  it("saves the database and key, then hands over to Swarm with a way back", async () => {
    await handedOverUpdate();
    const docker = (context as TestContext).docker as FakeDriver;

    const journal = readJournal({ dataDir });
    expect(journal).toMatchObject({
      kind: "update",
      state: "applying",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
    });
    expect(journal?.fromImage).toBe(OLD_IMAGE);
    expect(journal?.digest).toBeTruthy();
    expect(journal?.sizeBytes).toBeGreaterThan(0);
    const snapshot = join(dataDir, "panel-update", "snapshots", journal?.snapshotId as string);
    expect(existsSync(join(snapshot, "opsifier.db"))).toBe(true);
    expect(readFileSync(join(snapshot, "secret.key"))).toEqual(readFileSync(join(dataDir, "secret.key")));

    const panel = await docker.inspectService("opsifier");
    // Held to what was pulled: a tag moved on this server afterwards changes nothing that runs.
    const pulled = (await docker.inspectImage(NEW_IMAGE))?.digests[0]?.split("@")[1];
    expect(pulled).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(panel?.spec.TaskTemplate.ContainerSpec.Image).toBe(`${NEW_IMAGE}@${pulled}`);
    expect(panel?.spec.UpdateConfig).toMatchObject({ FailureAction: "rollback", Order: "stop-first" });
  });

  it("keeps the Action running until the next process says how it went", async () => {
    const id = await handedOverUpdate();

    expect((await api<ActionEntry>(`/actions/${id}`)).body.status).toBe("running");
    expect((await status()).inProgress).toMatchObject({ toVersion: "1.1.0", state: "applying" });
  });

  it("fails the Action and forgets the attempt when Docker refuses the update", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    await installPanelService(ctx);
    stubFeed();
    await check();
    const docker = ctx.docker as FakeDriver;
    docker.failNext("updateService");

    const started = await api<ActionEntry>("/system/update", "POST", { version: "1.1.0", confirm: "update" });
    const finished = await waitForAction(started.body.id);

    expect(finished.status).toBe("failed");
    expect(readJournal({ dataDir })).toBeNull();
  });
});

describe("the process that starts next", () => {
  it("reports success once the new version has stayed up", async () => {
    const id = await handedOverUpdate();

    await nextProcess("1.1.0");
    await signIn();
    await until(async () => (await api<ActionEntry>(`/actions/${id}`)).body.status === "succeeded");

    const current = await status();
    expect(current).toMatchObject({ activeVersion: "1.1.0", inProgress: null });
    expect(current.last).toMatchObject({
      kind: "update",
      result: "succeeded",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
    });
    expect(current.last?.digest).toBeTruthy();
    expect(current.rollback).toMatchObject({ version: "1.0.0", restoresData: false });
  });

  it("restores the saved state when Swarm brings the old version back", async () => {
    const id = await handedOverUpdate();
    // The new version got far enough to change the database before it failed.
    const failed = await panelAt("1.1.0", { OPSIFIER_UPDATE_VERIFY_SECONDS: "3600" });
    failed.deps.db.run(sql`CREATE TABLE update_canary (id INTEGER PRIMARY KEY)`);
    writeFileSync(join(dataDir, "secret.key"), "corrupted by the failed version!");
    expect(canary()).toBe(1);

    const back = await panelAt("1.0.0");
    await signIn();

    expect(canary()).toBe(0);
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).not.toBe("corrupted by the failed version!");
    const finished = (await api<ActionEntry & { log: string }>(`/actions/${id}`)).body;
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("1.1.0");
    const current = await status();
    expect(current.last).toMatchObject({ result: "rolled-back", fromVersion: "1.0.0", toVersion: "1.1.0" });
    expect(current.inProgress).toBeNull();
    expect(back.deps.actions.isIdle()).toBe(true);
  });

  it("does not restore anything on the version it was updating to", async () => {
    await handedOverUpdate();
    const updated = await panelAt("1.1.0");
    updated.deps.db.run(sql`CREATE TABLE update_canary (id INTEGER PRIMARY KEY)`);

    await panelAt("1.1.0");
    await signIn();

    expect(canary()).toBe(1);
  });

  it("does not guess when the journal names other versions than the one starting", async () => {
    await handedOverUpdate();

    await panelAt("5.0.0");
    await signIn();

    expect(readJournal({ dataDir })?.state).toBe("failed");
  });
});

describe("going back by hand", () => {
  async function updated(): Promise<void> {
    const id = await handedOverUpdate();
    await nextProcess("1.1.0");
    await signIn();
    await until(async () => (await api<ActionEntry>(`/actions/${id}`)).body.status === "succeeded");
    // The panel ran from it until the update, so it is on this server.
    ((context as TestContext).docker as FakeDriver).addLocalImage(OLD_IMAGE);
  }

  it("is offered once an update has been verified, and asks for confirmation", async () => {
    await updated();

    const wrong = await api("/system/update/rollback", "POST", { confirm: "nope" });

    expect(wrong.status).toBe(409);
    expect(apiErrorOf(wrong).code).toBe("confirmation_mismatch");
    expect((await status()).rollback).toMatchObject({ version: "1.0.0" });
  });

  it("restarts into the old image and leaves the data alone when no schema changed", async () => {
    await updated();
    const ctx = context as TestContext;
    await installPanelService(ctx, NEW_IMAGE);
    ctx.deps.db.run(sql`CREATE TABLE update_canary (id INTEGER PRIMARY KEY)`);

    const started = await api<ActionEntry>("/system/update/rollback", "POST", { confirm: "rollback" });
    expect(started.status).toBe(202);
    await until(() => readJournal({ dataDir })?.kind === "rollback");
    await until(() => ctx.deps.actions.isIdle());

    const journal = readJournal({ dataDir });
    expect(journal).toMatchObject({
      kind: "rollback",
      toVersion: "1.0.0",
      toImage: OLD_IMAGE,
      restoreData: false,
    });
    expect(
      (await (ctx.docker as FakeDriver).inspectService("opsifier"))?.spec.TaskTemplate.ContainerSpec.Image,
    ).toBe(OLD_IMAGE);

    await panelAt("1.0.0");
    await signIn();
    expect(canary()).toBe(1);
    expect((await status()).last).toMatchObject({ kind: "rollback", result: "succeeded" });
  });

  it("refuses before any change when the old image is no longer on the server", async () => {
    await updated();
    const ctx = context as TestContext;
    await installPanelService(ctx, NEW_IMAGE);
    await (ctx.docker as FakeDriver).removeImage(OLD_IMAGE);
    const pulls = vi.spyOn(ctx.docker as FakeDriver, "pullImage");

    const refused = await api("/system/update/rollback", "POST", { confirm: "rollback" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("rollback_image_missing");
    expect(readJournal({ dataDir })?.kind).toBe("update");
    expect(pulls).not.toHaveBeenCalled();
    expect((await status()).activeVersion).toBe("1.1.0");
  });

  it("refuses when there is nothing to go back to", async () => {
    const ctx = await panelAt("1.0.0");
    cookie = await setupAdmin(ctx.app);
    await installPanelService(ctx);

    const refused = await api("/system/update/rollback", "POST", { confirm: "rollback" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("nothing_to_roll_back");
  });
});

describe("restoring", () => {
  const paths = () => ({
    dataDir,
    databaseFile: join(dataDir, "opsifier.db"),
    secretKeyFile: join(dataDir, "secret.key"),
  });

  it("refuses a saved copy that is not there", () => {
    expect(() => restoreSnapshot(paths(), "missing")).toThrow(/missing/);
  });

  it("does nothing without a journal", () => {
    expect(() =>
      restoreInterruptedUpdate({ ...paths(), version: "1.0.0" }, { warn: () => {}, info: () => {} } as never),
    ).not.toThrow();
  });
});
