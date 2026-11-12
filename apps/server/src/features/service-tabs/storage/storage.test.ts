import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ActionEntry, CreatedApiKey, StorageDocument } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
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
    // Not /tmp: on Linux the test's own data directory is under it, which makes the mount a risk.
    await api(MOUNTS, "POST", { type: "bind", hostPath: "/srv/shared", mountPath: "/mnt/bind" });
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    const added = await api<StorageDocument>(MOUNTS, "POST", {
      type: "file",
      mountPath: "/etc/probe/config.txt",
      content: "hello\n",
    });

    expect(added.status).toBe(201);
    expect(added.body.mounts).toEqual([
      { type: "bind", hostPath: "/srv/shared", mountPath: "/mnt/bind", acknowledgeRisk: false, risk: null },
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

describe("who may give a service a path on the host", () => {
  let operator: string;
  const asOperator = <T = unknown>(path: string, method: string, body?: unknown) =>
    call<T>(context.app, path, { method, body, cookie: operator, origin: TEST_ORIGIN });
  const SOCKET = { type: "bind", hostPath: "/var/run/docker.sock", mountPath: "/d.sock" };

  beforeEach(async () => {
    operator = await signInMember(context.app, cookie, "op@example.com", [
      { project: "shop", role: "operator" },
    ]);
  });

  it.each([
    ["the Docker socket, with the flag set", { ...SOCKET, acknowledgeRisk: true }],
    ["the Docker socket, without it", SOCKET],
    ["an ordinary host path", { type: "bind", hostPath: "/etc", mountPath: "/host-etc" }],
    [
      "the panel's data directory, with the flag set",
      () => ({
        type: "bind",
        hostPath: context.dataDir,
        mountPath: "/data",
        acknowledgeRisk: true,
      }),
    ],
  ])("refuses an operator %s", async (_label, mount) => {
    const body = typeof mount === "function" ? mount() : mount;

    const refused = await asOperator(MOUNTS, "POST", body);

    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("admin_required");
    expect((await api<StorageDocument>(PATH)).body.mounts).toEqual([]);
  });

  it("still lets an operator add a volume or a file", async () => {
    expect(
      (await asOperator(MOUNTS, "POST", { type: "volume", name: "data", mountPath: "/data" })).status,
    ).toBe(201);
    expect((await asOperator(MOUNTS, "POST", { type: "file", mountPath: "/etc/x.conf" })).status).toBe(201);
  });

  it("lets an operator keep or remove what an administrator gave, but not point it elsewhere", async () => {
    await api(MOUNTS, "POST", { type: "bind", hostPath: "/srv/app", mountPath: "/data" });
    const edit = (hostPath: string, mountPath: string) =>
      asOperator(`${MOUNTS}/0`, "PUT", { type: "bind", hostPath, mountPath });

    expect((await edit("/srv/app", "/moved")).status).toBe(200);

    const repointed = await edit("/etc", "/moved");
    expect(repointed.status).toBe(403);
    expect((await api<StorageDocument>(PATH)).body.mounts[0]).toMatchObject({
      hostPath: "/srv/app",
      mountPath: "/moved",
    });

    expect((await asOperator(`${MOUNTS}/0`, "DELETE")).status).toBe(200);
  });

  it("refuses to turn a volume into a host path for an operator", async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "data", mountPath: "/data" });

    const changed = await asOperator(`${MOUNTS}/0`, "PUT", {
      type: "bind",
      hostPath: "/etc",
      mountPath: "/data",
    });

    expect(changed.status).toBe(403);
  });

  it("holds keys to the same rule: a key narrowed to projects can't, even an administrator's", async () => {
    const issue = async (body: object) =>
      (
        await call<CreatedApiKey>(context.app, "/api/v1/me/api-keys", {
          method: "POST",
          cookie,
          origin: TEST_ORIGIN,
          body: { name: "k", level: "write", ...body },
        })
      ).body.token;
    const add = async (token: string, mountPath: string) =>
      call(context.app, MOUNTS, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: { ...SOCKET, mountPath, acknowledgeRisk: true },
      });

    expect((await add(await issue({ projects: ["shop"] }), "/a.sock")).status).toBe(403);
    expect((await add(await issue({}), "/b.sock")).status).toBe(201);
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
    await api(MOUNTS, "POST", { type: "bind", hostPath: "/srv/shared", mountPath: "/mnt/bind" });
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    await api(MOUNTS, "POST", { type: "file", mountPath: "/etc/probe/config.txt", content: "hello\n" });

    // Nothing happens at save time.
    expect(await context.docker.listVolumes()).toEqual([]);

    const deployed = await deploy();
    expect(deployed.status).toBe("succeeded");

    const inspected = await context.docker.inspectService("shop_web");
    expect(inspected?.spec.TaskTemplate.ContainerSpec.Mounts).toEqual([
      { Type: "bind", Source: "/srv/shared", Target: "/mnt/bind" },
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

  async function destroy(path = SERVICE, confirm = "web"): Promise<ActionEntry & { log: string }> {
    const accepted = await api<ActionEntry>(path, "DELETE", { confirm });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await api<ActionEntry & { log: string }>(`/api/v1/actions/${accepted.body.id}`);
      if (body.status !== "queued" && body.status !== "running") {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The removal did not finish");
  }

  it("leaves a service's volumes and their data behind when it is destroyed", async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    await api(MOUNTS, "POST", { type: "file", mountPath: "/etc/app.conf", content: "x" });
    await deploy();
    const data = join(context.dataDir, "projects/shop/web/volumes/probe-vol");
    writeFileSync(join(data, "keep.txt"), "still here");

    const destroyed = await destroy();

    expect(destroyed.status).toBe("succeeded");
    expect(destroyed.log).toContain("Keeping the volume shop_web_probe-vol");
    expect(destroyed.log).toContain("Backups stay at their destination");
    expect(readFileSync(join(data, "keep.txt"), "utf8")).toBe("still here");
    expect((await context.docker.listVolumes()).map((volume) => volume.name)).toEqual(["shop_web_probe-vol"]);
    // Configuration and generated files go with the service.
    expect(existsSync(join(context.dataDir, "projects/shop/web/files"))).toBe(false);
    expect((await api(SERVICE)).status).toBe(404);
  });

  it("touches no other project when it keeps a service's volumes", async () => {
    await api("/api/v1/projects", "POST", { name: "other" });
    await api("/api/v1/projects/other/services", "POST", { name: "web" });
    await api("/api/v1/projects/other/services/web/storage/mounts", "POST", {
      type: "volume",
      name: "probe-vol",
      mountPath: "/data/vol",
    });
    await api("/api/v1/projects/other/services/web/source", "PUT", { image: "nginx:alpine" });
    const other = await api<ActionEntry>("/api/v1/projects/other/services/web/deploy", "POST");
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await api<ActionEntry>(`/api/v1/actions/${other.body.id}`);
      if (body.status !== "queued" && body.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await api(MOUNTS, "POST", { type: "volume", name: "probe-vol", mountPath: "/data/vol" });
    await deploy();

    await destroy();

    expect(await context.docker.inspectVolume("other_web_probe-vol")).not.toBeNull();
    expect(await context.docker.inspectService("other_web")).not.toBeNull();
    expect((await api("/api/v1/projects/other/services/web")).status).toBe(200);
  });
});

describe("checking a volume against the user its image runs as", () => {
  const IMAGE = "nginx:alpine";
  const volume = (...parts: string[]) =>
    join(context.dataDir, "projects", "shop", "web", "volumes", "data", ...parts);
  const someoneElse = () => String((process.getuid?.() ?? 1000) + 1);

  beforeEach(async () => {
    await api(MOUNTS, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();
  });

  function keepFile(mode: number, name = "kept.txt"): void {
    writeFileSync(volume(name), "old");
    chmodSync(volume(name), mode);
  }

  it("names what that user could not write, and carries on", async () => {
    keepFile(0o644);
    context.docker.imageUsers.set(IMAGE, someoneElse());

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toMatch(
      /Volume shop_web_data: the user this image runs as \(\d+\) can't write 1 of the/,
    );
    expect(deployed.log).toContain("kept.txt");
    expect(deployed.log).toMatch(/Give them to that user/);
  });

  it("looks inside folders too", async () => {
    mkdirSync(volume("nested"));
    chmodSync(volume("nested"), 0o777);
    writeFileSync(volume("nested", "deep.txt"), "old");
    chmodSync(volume("nested", "deep.txt"), 0o600);
    context.docker.imageUsers.set(IMAGE, someoneElse());

    expect((await deploy()).log).toContain("deep.txt");
  });

  it("is happy when that user is the owner", async () => {
    keepFile(0o644);
    context.docker.imageUsers.set(IMAGE, String(process.getuid?.() ?? 0));

    expect((await deploy()).log).not.toMatch(/can't write/);
  });

  it("is happy with a file anyone may write", async () => {
    keepFile(0o666);
    context.docker.imageUsers.set(IMAGE, someoneElse());

    expect((await deploy()).log).not.toMatch(/can't write/);
  });

  it("is happy when the image runs as root", async () => {
    keepFile(0o600);

    expect((await deploy()).log).not.toMatch(/can't write|whose number/);
  });

  it("counts a group the service adds", async () => {
    keepFile(0o664);
    context.docker.imageUsers.set(IMAGE, someoneElse());
    expect((await deploy()).log).toMatch(/can't write/);

    await api(`${SERVICE}/advanced/deploy`, "PUT", { groups: [String(process.getgid?.() ?? 0)] });

    expect((await deploy()).log).not.toMatch(/can't write/);
  });

  it("reads the user out of a user:group line", async () => {
    keepFile(0o644);
    context.docker.imageUsers.set(IMAGE, `${someoneElse()}:100`);

    expect((await deploy()).log).toMatch(/can't write/);
  });

  it("says when it can't tell, because the image only names its user", async () => {
    keepFile(0o644);
    context.docker.imageUsers.set(IMAGE, "www-data");

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toMatch(/runs as the user www-data, whose number only the image knows/);
  });

  it("stops looking after a bounded number of files", async () => {
    for (let index = 0; index < 1100; index += 1) {
      keepFile(0o644, `file-${index}.txt`);
    }
    context.docker.imageUsers.set(IMAGE, someoneElse());

    expect((await deploy()).log).toMatch(/can't write 1000 of the 1000 files/);
  });
});
