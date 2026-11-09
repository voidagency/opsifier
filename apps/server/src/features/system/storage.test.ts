import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActionDetail,
  type ActionEntry,
  type ActionPage,
  type DeploymentPage,
  deployActionType,
  type ServiceDetail,
  type StorageDocument,
  type StorageHealth,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerDriverError } from "../../core/docker";
import type { FakeTools } from "../../core/tools/fake";
import {
  apiErrorOf,
  type CallResult,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { openEnv } from "../services/env-store";
import { findService } from "../services/repo";

const disk = vi.hoisted(() => ({ fileWritesFail: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (disk.fileWritesFail && String(args[0]).includes("/files/")) {
        throw Object.assign(new Error("ENOSPC: no space left on device, open"), { code: "ENOSPC" });
      }
      return actual.open(...args);
    },
  };
});

const SERVICE = "/projects/shop/services/web";
const IMAGE = "traefik/whoami:v1.10";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown): Promise<CallResult<T>> =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

/** Full for real: SQLite answers SQLITE_FULL for anything that needs one more page. */
function fillTheDisk(): void {
  const client = context.deps.db.$client;
  client.pragma(`max_page_count = ${String(client.pragma("page_count", { simple: true }))}`);
}

function makeRoom(): void {
  context.deps.db.$client.pragma("max_page_count = 1073741823");
  expect(context.deps.storage.check()).toBe(true);
}

/** Stops every write to the panel's own database, as a disk gone read-only would. */
function freezeState(): void {
  context.deps.db.$client.pragma("query_only = ON");
}

function thawState(): void {
  context.deps.db.$client.pragma("query_only = OFF");
  expect(context.deps.storage.check()).toBe(true);
}

const saveMoreThanFits = () =>
  api(`${SERVICE}/storage/mounts`, "POST", {
    type: "file",
    mountPath: "/too/big",
    content: "x".repeat(800 * 1024),
  });

async function action(id: string): Promise<ActionDetail> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { body } = await api<ActionDetail>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The action did not finish");
}

async function deploy(): Promise<ActionDetail> {
  const { body } = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
  return action(body.id);
}

/** Straight from the row: reading a value through the API is a change on the record, and those are refused here. */
const envOf = () => openEnv(context.deps, findService(context.deps.db, "shop", "web")?.spec.sealedEnv ?? "");
const swarm = () => context.docker.inspectService("shop_web");
const health = async () => (await api<StorageHealth>("/system/storage")).body;

beforeEach(async () => {
  disk.fileWritesFail = false;
  context = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
  await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
  context.docker.helperResult = () => ({
    exitCode: 0,
    stdout:
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 4194304 2097152 2097152 50% /host\n",
    stderr: "",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context.close();
});

describe("a state save that does not fit on the disk", () => {
  it("is reported as what it is, stores nothing, and leaves the running service alone", async () => {
    await api(`${SERVICE}/environment`, "PUT", { env: "BEFORE=1" });
    expect((await deploy()).status).toBe("succeeded");
    const running = await swarm();

    fillTheDisk();
    const refused = await saveMoreThanFits();

    expect(refused.status).toBe(503);
    expect(apiErrorOf(refused)).toMatchObject({ code: "storage_failing" });
    expect(apiErrorOf(refused).message).toMatch(/disk is full/);
    expect((await api<StorageDocument>(`${SERVICE}/storage`)).body.mounts).toEqual([]);
    expect(envOf()).toBe("BEFORE=1");
    expect(await swarm()).toEqual(running);
    expect(context.deps.db.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });
});

describe("after a state write has failed", () => {
  beforeEach(async () => {
    fillTheDisk();
    await saveMoreThanFits();
  });

  it("says so, to anyone who is signed in", async () => {
    expect(await health()).toMatchObject({ writable: false, reason: "full" });
    expect((await health()).since).not.toBeNull();
  });

  it("refuses every further change, including one that would still have fitted", async () => {
    const small = await api(`${SERVICE}/environment`, "PUT", { env: "SMALL=1" });
    const created = await api("/projects", "POST", { name: "another" });
    const deployment = await api(`${SERVICE}/deploy`, "POST");

    for (const result of [small, created, deployment]) {
      expect(result.status).toBe(503);
      expect(apiErrorOf(result).code).toBe("storage_failing");
    }
    expect(envOf()).toBe("");
    expect((await api("/projects/another")).status).toBe(404);
    expect(await swarm()).toBeNull();
  });

  it("does not let a deployment trigger through either", async () => {
    makeRoom();
    const trigger = await api<{ token: string }>(`${SERVICE}/deployments/trigger/rotate`, "POST");
    context.deps.storage.report(Object.assign(new Error("full"), { code: "SQLITE_FULL" }));

    const response = await call(context.app, "/api/v1/deploy", {
      method: "POST",
      headers: { authorization: `Bearer ${trigger.body.token}` },
    });

    expect(response.status).toBe(503);
    expect(apiErrorOf(response).code).toBe("storage_failing");
  });

  it("keeps answering what can be read", async () => {
    expect((await api("/projects")).status).toBe(200);
    expect((await api<ActionPage>("/actions")).status).toBe(200);
    expect((await api<ServiceDetail>(SERVICE)).status).toBe(200);
  });

  it("does not refuse someone who was never allowed in the first place", async () => {
    const stranger = await call(context.app, `/api/v1${SERVICE}/environment`, {
      method: "PUT",
      body: { env: "X=1" },
    });

    expect(stranger.status).toBe(401);
  });

  it("allows changes again once storage is fixed, and only then", async () => {
    expect((await api(`${SERVICE}/environment`, "PUT", { env: "AFTER=1" })).status).toBe(503);

    makeRoom();

    expect(await health()).toEqual({ writable: true, reason: null, since: null });
    expect((await api(`${SERVICE}/environment`, "PUT", { env: "AFTER=1" })).status).toBe(200);
    expect(envOf()).toBe("AFTER=1");
  });
});

describe("stopping work while storage is failing", () => {
  it("is still allowed, because it is the one change that can only help", async () => {
    const started = context.deps.actions.enqueue({
      type: "test.wait",
      title: "Wait",
      projectName: "shop",
      serviceName: "web",
      run: (ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
    });
    await vi.waitFor(() => expect(context.deps.actions.isIdle()).toBe(false), { timeout: 10_000 });
    await new Promise((resolve) => setImmediate(resolve));
    context.deps.storage.report(Object.assign(new Error("full"), { code: "SQLITE_FULL" }));

    const cancelled = await api<ActionEntry>(`/actions/${started.id}/cancel`, "POST");

    expect(cancelled.status).toBe(200);
    await vi.waitFor(() => expect(context.deps.actions.isIdle()).toBe(true), { timeout: 10_000 });
    expect((await action(started.id)).status).toBe("cancelled");
  });
});

describe("a deployment whose ending could not be recorded", () => {
  /** Freezes the panel's state the moment Docker has been told what to run. */
  function freezeOnceDockerHasIt(): void {
    const create = context.docker.createService.bind(context.docker);
    vi.spyOn(context.docker, "createService").mockImplementation(async (...args) => {
      const created = await create(...args);
      freezeState();
      return created;
    });
  }

  async function deployAndWaitToFinishRunning(): Promise<string> {
    const { body } = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await vi.waitFor(() => expect(context.deps.actions.isIdle()).toBe(true), {
      timeout: 10_000,
      interval: 5,
    });
    return body.id;
  }

  it("reads as uncertain everywhere, not as failed and not as still running", async () => {
    freezeOnceDockerHasIt();

    const id = await deployAndWaitToFinishRunning();

    const detail = (await api<ActionDetail>(`/actions/${id}`)).body;
    expect(detail.status).toBe("uncertain");
    expect(detail.error).toMatch(/could not save its state/);
    expect(detail.finishedAt).not.toBeNull();

    const activity = (await api<ActionPage>("/actions")).body.items.find((item) => item.id === id);
    expect(activity?.status).toBe("uncertain");

    const deployments = (await api<DeploymentPage>(`${SERVICE}/deployments`)).body;
    expect(deployments.items.map((item) => item.status)).toEqual(["uncertain"]);

    const service = (await api<ServiceDetail>(SERVICE)).body;
    expect(service.wake).toEqual(["uncertain"]);
    expect(service.activeAction).toBeNull();
  });

  it("stays uncertain once it can be written, because what Docker did was never noted down", async () => {
    freezeOnceDockerHasIt();
    const id = await deployAndWaitToFinishRunning();

    thawState();

    const detail = (await api<ActionDetail>(`/actions/${id}`)).body;
    expect(detail.status).toBe("uncertain");
    expect((await api<ServiceDetail>(SERVICE)).body.wake).toEqual(["uncertain"]);
    expect(await health()).toMatchObject({ writable: true });
  });

  it("is what a restart finds when the panel died before recording anything", async () => {
    context.deps.db.$client
      .prepare(
        "INSERT INTO actions (id, type, title, status, project_name, service_name, created_at, started_at) VALUES ('died', ?, 'Deploy', 'running', 'shop', 'web', ?, ?)",
      )
      .run(deployActionType, Date.now(), Date.now());

    context.deps.actions.recover();

    expect((await api<ActionDetail>("/actions/died")).body).toMatchObject({ status: "uncertain" });
  });
});

describe("a full disk while a new deployment is being prepared", () => {
  beforeEach(async () => {
    await api(`${SERVICE}/storage/mounts`, "POST", {
      type: "file",
      mountPath: "/etc/app.conf",
      content: "version=1",
    });
    expect((await deploy()).status).toBe("succeeded");
  });

  const mountFile = () => join(context.dataDir, "projects", "shop", "web", "files", "0.txt");

  async function expectNothingChanged(finished: ActionDetail, before: unknown): Promise<void> {
    expect(finished.status).toBe("failed");
    expect(finished.error).not.toBe("");
    expect(await swarm()).toEqual(before);
    expect((await api<ServiceDetail>(SERVICE)).body.wake).toEqual(["succeeded", "failed"]);
  }

  it("fails on the image pull, with no false success and the old runtime untouched", async () => {
    const before = await swarm();
    context.docker.failNext(
      "pullImage",
      new DockerDriverError("write /var/lib/docker/tmp/GetImageBlob: no space left on device", 500),
    );

    const finished = await deploy();

    await expectNothingChanged(finished, before);
    expect(finished.error).toMatch(/no space left on device/);
  });

  it("fails on writing the service's files, and the file the old task has mounted is still whole", async () => {
    const before = await swarm();
    await api(`${SERVICE}/storage/mounts/0`, "PUT", {
      type: "file",
      mountPath: "/etc/app.conf",
      content: "version=2",
    });
    disk.fileWritesFail = true;

    const finished = await deploy();

    await expectNothingChanged(finished, before);
    expect(finished.error).toMatch(/ENOSPC/);
    expect(readFileSync(mountFile(), "utf8")).toBe("version=1");
    expect(existsSync(mountFile())).toBe(true);

    // Nothing of what was attempted is left lying around for the next deployment to trip on.
    disk.fileWritesFail = false;
    expect(context.deps.storage.check()).toBe(true);
    expect((await deploy()).status).toBe("succeeded");
    expect(readFileSync(mountFile(), "utf8")).toBe("version=2");
  });

  it("fails on building the image", async () => {
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM alpine:3.21\n" });
    const before = await swarm();
    (context.deps.tools as FakeTools).handler = (request) =>
      request.command === "docker"
        ? { exitCode: 1, tail: ["failed to copy: write /var/lib/docker: no space left on device"] }
        : undefined;

    const finished = await deploy();

    await expectNothingChanged(finished, before);
    expect(finished.error).toMatch(/build failed/);
  });
});
