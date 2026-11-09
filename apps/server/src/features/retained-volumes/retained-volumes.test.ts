import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, PanelUser, RetainedVolumeList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerDriverError } from "../../core/docker";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { saveRetainedVolume } from "./repo";

const SERVICE = "/projects/shop/services/web";
const VOLUME = "shop_web_uploads";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext({ rollout: { timeoutMs: 40, pollMs: 1 } });
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  await context.close();
});

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });

type Finished = ActionEntry & { log: string };

async function waitFor(id: string): Promise<Finished> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<Finished>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The action did not finish");
}

async function run(path: string, method = "POST", body?: unknown): Promise<Finished> {
  const accepted = await api<ActionEntry>(path, method, body);
  expect(accepted.status).toBe(202);
  return waitFor(accepted.body.id);
}

const dataDirectory = () => join(context.dataDir, "projects/shop/web/volumes/uploads");

/** Deploys a service with one volume, puts something in it, and destroys the service. */
async function keepVolume(): Promise<void> {
  await api(`${SERVICE}/storage/mounts`, "POST", {
    type: "volume",
    name: "uploads",
    mountPath: "/data/uploads",
  });
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
  await run(`${SERVICE}/deploy`);
  writeFileSync(join(dataDirectory(), "photo.jpg"), "x".repeat(4096));
  await run(SERVICE, "DELETE", { confirm: "web" });
}

const list = async () => (await api<RetainedVolumeList>("/retained-volumes")).body.volumes;

async function recreateService(mount: boolean): Promise<void> {
  await api("/projects/shop/services", "POST", { name: "web" });
  if (mount) {
    await api(`${SERVICE}/storage/mounts`, "POST", {
      type: "volume",
      name: "uploads",
      mountPath: "/data/uploads",
    });
  }
}

describe("volumes kept from destroyed services", () => {
  it("lists what a destroyed service left behind", async () => {
    await keepVolume();

    expect(await list()).toEqual([
      expect.objectContaining({
        name: VOLUME,
        projectName: "shop",
        serviceName: "web",
        kind: "app",
      }),
    ]);
  });

  it("stops listing a volume that is gone from Docker and from the disk", async () => {
    await keepVolume();
    await context.docker.removeVolume(VOLUME);
    expect(await list()).toHaveLength(1);

    const { rm } = await import("node:fs/promises");
    await rm(dataDirectory(), { recursive: true });

    expect(await list()).toEqual([]);
  });

  it("is for administrators only", async () => {
    await keepVolume();
    await api<PanelUser>("/users", "POST", {
      email: "member@example.com",
      password: TEST_PASSWORD,
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
    });
    const login = await authPost(context.app, "login", {
      email: "member@example.com",
      password: TEST_PASSWORD,
    });
    const member = login.cookie as string;

    expect((await api("/retained-volumes", "GET", undefined, member)).status).toBe(403);
    expect((await api(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: VOLUME }, member)).status).toBe(
      403,
    );
  });
});

describe("deleting a kept volume", () => {
  beforeEach(keepVolume);

  it("takes the volume's exact name, checked on the server", async () => {
    const wrong = await api(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: "other" });
    expect(wrong.status).toBe(409);
    expect(apiErrorOf(wrong).code).toBe("confirmation_mismatch");
    expect((await api(`/retained-volumes/${VOLUME}`, "DELETE", {})).status).toBe(400);
    expect(await context.docker.inspectVolume(VOLUME)).not.toBeNull();
  });

  it("answers 404 for anything the panel is not keeping", async () => {
    await context.docker.createVolume({ name: "somebody_elses_data" });
    const result = await api("/retained-volumes/somebody_elses_data", "DELETE", {
      confirm: "somebody_elses_data",
    });
    expect(result.status).toBe(404);
    expect(await context.docker.inspectVolume("somebody_elses_data")).not.toBeNull();
  });

  it("removes the volume, its data and its record, and reports the space it gave back", async () => {
    const finished = await run(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: VOLUME });

    expect(finished.status).toBe("succeeded");
    expect(await context.docker.inspectVolume(VOLUME)).toBeNull();
    expect(existsSync(dataDirectory())).toBe(false);
    expect(existsSync(join(context.dataDir, "projects/shop/web"))).toBe(false);
    expect(await list()).toEqual([]);
    expect(finished.log).toContain("(about 4.1 KB)");
    expect(finished.log).toContain("Expected back: 4.1 KB");
    expect(finished.log).toContain("Free space on its disk went from");
    expect(finished.type).toBe("volume.delete");
  });

  it("keeps the other volumes of the same service", async () => {
    const other = join(context.dataDir, "projects/shop/web/volumes/other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "keep.txt"), "stay");

    await run(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: VOLUME });

    expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("stay");
  });

  it("fails, says why and keeps its record when Docker won't let go", async () => {
    context.docker.removeVolume = () => Promise.reject(new DockerDriverError("volume is in use", 409));

    const finished = await run(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: VOLUME });

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("could not be deleted");
    expect(finished.error).toContain("volume is in use");
    expect(await list()).toHaveLength(1);
    expect(existsSync(dataDirectory())).toBe(true);
  });

  it("reports what Docker gave back for a volume that lives in Docker", async () => {
    await context.docker.createVolume({ name: "shop_db_data" });
    context.docker.disk = { ...context.docker.disk, volumesBytes: 2_000_000 };
    context.docker.volumeBytesFreed.set("shop_db_data", 2_000_000);
    saveRetainedVolume(context.deps.db, {
      name: "shop_db_data",
      projectName: "shop",
      serviceName: "db",
      kind: "database",
      retainedAt: new Date(),
    });

    const finished = await run("/retained-volumes/shop_db_data", "DELETE", { confirm: "shop_db_data" });

    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Docker reports 2.0 MB given back");
  });
});

describe("a kept volume and a new service of the same name", () => {
  beforeEach(keepVolume);

  it("is picked up again by a service that mounts the same volume", async () => {
    await recreateService(true);
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
    await run(`${SERVICE}/deploy`);

    expect(readFileSync(join(dataDirectory(), "photo.jpg"), "utf8")).toHaveLength(4096);
    expect(await list()).toEqual([]);
    const refused = await api(`/retained-volumes/${VOLUME}`, "DELETE", { confirm: VOLUME });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("volume_in_use");
  });

  it("stays listed while the new service does not use it", async () => {
    await recreateService(false);
    expect(await list()).toHaveLength(1);
  });

  it("is not overwritten by a rename onto its name", async () => {
    await api("/projects/shop/services", "POST", { name: "api" });

    const renamed = await api(`/projects/shop/services/api/rename`, "POST", {
      projectName: "shop",
      name: "web",
    });

    expect(renamed.status).toBe(409);
    expect(apiErrorOf(renamed).code).toBe("name_holds_kept_data");
    expect(readFileSync(join(dataDirectory(), "photo.jpg"), "utf8")).toHaveLength(4096);
    expect((await api("/projects/shop/services/api")).status).toBe(200);
  });
});
