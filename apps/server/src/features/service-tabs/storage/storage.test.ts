import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, StorageDocument } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const SERVICE = "/api/v1/projects/shop/services/web";
const PATH = `${SERVICE}/storage`;
const MOUNTS = `${PATH}/mounts`;

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/api/v1/projects", "POST", { name: "shop" });
  await api("/api/v1/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, path, { method, body, cookie, origin: TEST_ORIGIN });
}

async function deploy(): Promise<ActionEntry & { log: string }> {
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
  const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<ActionEntry & { log: string }>(`/api/v1/actions/${accepted.body.id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The deployment did not finish");
}

describe("the storage tab", () => {
  it("adds, edits and removes the three kinds of mount", async () => {
    await api(MOUNTS, "POST", { type: "bind", hostPath: "/tmp", mountPath: "/mnt/bind" });
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    const added = await api<StorageDocument>(MOUNTS, "POST", {
      type: "file",
      mountPath: "/etc/probe/config.txt",
      content: "hello\n",
    });

    expect(added.status).toBe(201);
    expect(added.body.mounts).toEqual([
      { type: "bind", hostPath: "/tmp", mountPath: "/mnt/bind", acknowledgeRisk: false, risk: null },
      { type: "volume", name: "probe-vol", mountPath: "/data/vol" },
      { type: "file", mountPath: "/etc/probe/config.txt", content: "hello\n" },
    ]);

    const edited = await api<StorageDocument>(`${MOUNTS}/1`, "PUT", {
      type: "volume",
      name: "probe-vol",
      mountPath: "/data/moved",
    });
    expect(edited.body.mounts[1]?.mountPath).toBe("/data/moved");

    const removed = await api<StorageDocument>(`${MOUNTS}/0`, "DELETE");
    expect(removed.body.mounts.map((mount) => mount.type)).toEqual(["volume", "file"]);
  });

  it("accepts a file mount with no content", async () => {
    expect((await api(MOUNTS, "POST", { type: "file", mountPath: "/etc/empty" })).status).toBe(201);
  });

  it.each([
    ["an empty mount path", { type: "volume", name: "a", mountPath: "" }, "mountPath"],
    ["a relative mount path", { type: "volume", name: "a", mountPath: "data" }, "mountPath"],
    ["a mount path with ..", { type: "volume", name: "a", mountPath: "/data/../etc" }, "mountPath"],
    ["a mount path with a double slash", { type: "volume", name: "a", mountPath: "/data//x" }, "mountPath"],
    ["a mount path with a trailing slash", { type: "volume", name: "a", mountPath: "/data/" }, "mountPath"],
    ["a mount over the root", { type: "volume", name: "a", mountPath: "/" }, "mountPath"],
    ["a mount over /proc", { type: "volume", name: "a", mountPath: "/proc" }, "mountPath"],
    ["a mount under /sys", { type: "volume", name: "a", mountPath: "/sys/kernel" }, "mountPath"],
    ["a mount path with a line break", { type: "volume", name: "a", mountPath: "/da\nta" }, "mountPath"],
    ["an empty host path", { type: "bind", hostPath: "", mountPath: "/data" }, "hostPath"],
    ["a relative host path", { type: "bind", hostPath: "srv/app", mountPath: "/data" }, "hostPath"],
    ["a host path with ..", { type: "bind", hostPath: "/srv/../etc", mountPath: "/data" }, "hostPath"],
    ["a volume name with spaces", { type: "volume", name: "my vol", mountPath: "/data" }, "name"],
    ["a volume name with a slash", { type: "volume", name: "../etc", mountPath: "/data" }, "name"],
    ["an empty volume name", { type: "volume", name: "", mountPath: "/data" }, "name"],
    ["an uppercase volume name", { type: "volume", name: "Data", mountPath: "/data" }, "name"],
  ])("refuses %s", async (_label, body, field) => {
    const result = await api(MOUNTS, "POST", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeDefined();
  });

  it("refuses an unknown kind of mount", async () => {
    expect((await api(MOUNTS, "POST", { type: "tmpfs", mountPath: "/data" })).status).toBe(400);
  });

  it("refuses two mounts at the same path", async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "one", mountPath: "/data" });

    const result = await api(MOUNTS, "POST", { type: "volume", name: "two", mountPath: "/data" });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("mount_path_taken");
    expect(apiErrorOf(result).fields?.mountPath).toBeDefined();
  });

  it("lets a mount keep its own path when it is edited", async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "one", mountPath: "/data" });

    expect(
      (await api(`${MOUNTS}/0`, "PUT", { type: "volume", name: "two", mountPath: "/data" })).status,
    ).toBe(200);
  });

  it("answers 404 for a position that does not exist", async () => {
    expect((await api(`${MOUNTS}/9`, "DELETE")).status).toBe(404);
    expect((await api(`${MOUNTS}/9`, "PUT", { type: "volume", name: "x", mountPath: "/y" })).status).toBe(
      404,
    );
  });
});

describe("bind mounts that expose the server", () => {
  it.each([
    ["the data directory", () => context.dataDir, "mount_exposes_data_directory"],
    [
      "a file inside the data directory",
      () => join(context.dataDir, "secret.key"),
      "mount_exposes_data_directory",
    ],
    ["the Docker socket", () => "/var/run/docker.sock", "mount_exposes_docker_socket"],
    ["the socket's other path", () => "/run/docker.sock", "mount_exposes_docker_socket"],
    ["the root of the disk", () => "/", "mount_exposes_docker_socket"],
  ])("need a confirmation for %s", async (_label, hostPath, code) => {
    const body = { type: "bind", hostPath: hostPath(), mountPath: "/host" };

    const refused = await api(MOUNTS, "POST", body);
    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).code).toBe(code);
    expect(apiErrorOf(refused).fields?.hostPath).toBeDefined();
    expect((await api<StorageDocument>(PATH)).body.mounts).toEqual([]);

    const accepted = await api<StorageDocument>(MOUNTS, "POST", { ...body, acknowledgeRisk: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.mounts[0]).toMatchObject({ acknowledgeRisk: true });
    expect(accepted.body.mounts[0]).not.toMatchObject({ risk: null });
  });

  it("do not let a confirmation carry over to a different path", async () => {
    await api(MOUNTS, "POST", {
      type: "bind",
      hostPath: "/var/run/docker.sock",
      mountPath: "/host",
      acknowledgeRisk: true,
    });

    const safe = await api<StorageDocument>(`${MOUNTS}/0`, "PUT", {
      type: "bind",
      hostPath: "/srv/app",
      mountPath: "/host",
      acknowledgeRisk: true,
    });
    expect(safe.body.mounts[0]).toMatchObject({ acknowledgeRisk: false, risk: null });

    expect(
      (await api(`${MOUNTS}/0`, "PUT", { type: "bind", hostPath: "/run/docker.sock", mountPath: "/host" }))
        .status,
    ).toBe(400);
  });

  it("are not stopped for an ordinary host path", async () => {
    expect(
      (await api(MOUNTS, "POST", { type: "bind", hostPath: "/srv/app", mountPath: "/data" })).status,
    ).toBe(201);
  });

  it("include a socket configured for this panel", async () => {
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_DOCKER_SOCKET: "/custom/docker.sock" } });
    cookie = await setupAdmin(context.app);
    await api("/api/v1/projects", "POST", { name: "shop" });
    await api("/api/v1/projects/shop/services", "POST", { name: "web" });

    const result = await api(MOUNTS, "POST", {
      type: "bind",
      hostPath: "/custom/docker.sock",
      mountPath: "/d.sock",
    });

    expect(apiErrorOf(result).code).toBe("mount_exposes_docker_socket");
  });
});

describe("deploying mounts", () => {
  it("writes files, creates volumes and leaves the running service alone until then", async () => {
    await api(MOUNTS, "POST", { type: "bind", hostPath: "/tmp", mountPath: "/mnt/bind" });
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    await api(MOUNTS, "POST", { type: "file", mountPath: "/etc/probe/config.txt", content: "hello\n" });

    // Nothing happens at save time.
    expect(await context.docker.listVolumes()).toEqual([]);

    const deployed = await deploy();
    expect(deployed.status).toBe("succeeded");

    const inspected = await context.docker.inspectService("shop_web");
    expect(inspected?.spec.TaskTemplate.ContainerSpec.Mounts).toEqual([
      { Type: "bind", Source: "/tmp", Target: "/mnt/bind" },
      { Type: "volume", Source: "shop_web_probe-vol", Target: "/data/vol" },
      {
        Type: "bind",
        Source: join(context.dataDir, "projects/shop/web/files/2.txt"),
        Target: "/etc/probe/config.txt",
      },
    ]);

    const file = join(context.dataDir, "projects/shop/web/files/2.txt");
    expect(readFileSync(file, "utf8")).toBe("hello\n");
    expect(statSync(file).mode & 0o777).toBe(0o644);

    const directory = join(context.dataDir, "projects/shop/web/volumes/probe-vol");
    expect(statSync(directory).mode & 0o777).toBe(0o777);
    expect((await context.docker.listVolumes()).map((volume) => volume.name)).toEqual(["shop_web_probe-vol"]);
    expect((await context.docker.listVolumes())[0]?.labels).toMatchObject({ "opsifier.project": "shop" });
  });

  it("cleans up the files of mounts that went away", async () => {
    await api(MOUNTS, "POST", { type: "file", mountPath: "/a", content: "a" });
    await deploy();
    const files = join(context.dataDir, "projects/shop/web/files");
    writeFileSync(join(files, "7.txt"), "left over");

    await deploy();

    expect(readdirSync(files)).toEqual(["0.txt"]);
  });

  it("removes a service's volumes with the service", async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    await deploy();
    expect(existsSync(join(context.dataDir, "projects/shop/web/volumes/probe-vol"))).toBe(true);

    const accepted = await api<ActionEntry>(SERVICE, "DELETE", { confirm: "web" });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await api<ActionEntry>(`/api/v1/actions/${accepted.body.id}`);
      if (body.status !== "queued" && body.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await context.docker.listVolumes()).toEqual([]);
    expect(existsSync(join(context.dataDir, "projects/shop/web"))).toBe(false);
  });
});
