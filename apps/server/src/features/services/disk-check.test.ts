import type { ActionEntry } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";

const SERVICE = "/projects/shop/services/web";
const STACK = "/projects/shop/services/stack";
const MEBIBYTE = 1024 * 1024;

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  await context.close();
});

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

type Finished = ActionEntry & { log: string };

async function deploy(path: string = SERVICE): Promise<Finished> {
  const accepted = await api<ActionEntry>(`${path}/deploy`, "POST");
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<Finished>(`/actions/${accepted.body.id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The deployment did not finish");
}

function dockerDiskHasFree(bytes: number): void {
  const available = Math.floor(bytes / 1024);
  context.docker.helperResult = () => ({
    exitCode: 0,
    stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 ${available * 2} ${available} ${available} 50% /host\n`,
    stderr: "",
  });
}

describe("the space check before a deployment", () => {
  beforeEach(async () => {
    await api(`${SERVICE}/source`, "PUT", { image: "traefik/whoami:v1.10" });
  });

  it("stops before anything changes when the image can't fit on Docker's disk", async () => {
    dockerDiskHasFree(100 * MEBIBYTE);

    const finished = await deploy();

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Not enough disk space to deploy");
    expect(finished.error).toContain("on Docker's disk");
    expect(finished.error).toContain("Nothing was changed");
    expect(await context.docker.inspectService("shop_web")).toBeNull();
    expect(await context.docker.inspectImage("traefik/whoami:v1.10")).toBeNull();
  });

  it("leaves a running service alone when its update can't fit", async () => {
    dockerDiskHasFree(1024 * MEBIBYTE);
    expect((await deploy()).status).toBe("succeeded");
    const before = await context.docker.inspectService("shop_web");

    dockerDiskHasFree(100 * MEBIBYTE);
    const refused = await deploy();

    expect(refused.status).toBe("failed");
    expect(await context.docker.inspectService("shop_web")).toEqual(before);
  });

  it("states what it needs and what is free, in the deployment's own log", async () => {
    dockerDiskHasFree(1024 * MEBIBYTE);

    const finished = await deploy();

    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Disk space this deployment needs: about 671.1 MB");
    expect(finished.log).toContain("an allowance for traefik/whoami:v1.10");
    expect(finished.log).toContain("Free space on Docker's disk (/var/lib/docker): 1.1 GB");
    expect(context.docker.helpers[0]).toMatchObject({
      command: ["df", "-k", "-P", "--", "/host/var/lib/docker"],
    });
  });

  it("bases the figure on the image, once a copy of it is on this server", async () => {
    dockerDiskHasFree(1024 * MEBIBYTE);
    await deploy();

    const again = await deploy();

    expect(again.log).toContain("half of the 1.0 KB that traefik/whoami:v1.10 takes on this server");
  });

  it("goes ahead, and says so, when Docker's disk can't be measured", async () => {
    context.docker.helperResult = () => ({ exitCode: 1, stdout: "", stderr: "no" });

    const finished = await deploy();

    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Docker's disk can't be measured from here");
  });
});

describe("what a build needs", () => {
  beforeEach(async () => {
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM busybox\n" });
  });

  it("uses an allowance, and refuses a disk that can't hold it", async () => {
    dockerDiskHasFree(900 * MEBIBYTE);

    const finished = await deploy();

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("about 1.2 GB is needed");
  });

  it("goes by the size of the last build when that is larger than the allowance", async () => {
    dockerDiskHasFree(2048 * MEBIBYTE);
    context.docker.images.push({
      id: "sha256:last",
      tags: ["opsifier/shop/web:latest"],
      sizeBytes: 6 * 1024 * MEBIBYTE,
      labels: {},
      createdAt: null,
    });

    const finished = await deploy();

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("about 3.4 GB is needed");
    expect(finished.log).toContain("half of the 6.4 GB of its last build");
  });
});

describe("what a Compose stack needs", () => {
  const FILE =
    "services:\n  web:\n    image: traefik/whoami:v1.10\n    restart: unless-stopped\n  cache:\n    image: redis:7-alpine\n    restart: unless-stopped\n";

  it("is the images in its file, and a stack can be refused like any deployment", async () => {
    await api("/projects/shop/compose", "POST", { name: "stack" });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    dockerDiskHasFree(100 * MEBIBYTE);

    const finished = await deploy(STACK);

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Not enough disk space to deploy");
    expect(finished.log).toContain("the 2 services in its Compose file");
    expect(await context.docker.listComposeContainers("shop_stack")).toEqual([]);
  });

  it("deploys when there is room", async () => {
    await api("/projects/shop/compose", "POST", { name: "stack" });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    dockerDiskHasFree(4096 * MEBIBYTE);

    const finished = await deploy(STACK);

    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Disk space this deployment needs");
    expect(await context.docker.listComposeContainers("shop_stack")).toHaveLength(2);
  });
});

describe("a deployment without a way to measure", () => {
  it("goes ahead on a panel with no helper image", async () => {
    const plain = await createTestContext();
    const session = await setupAdmin(plain.app);
    const local = <T = unknown>(path: string, method = "GET", body?: unknown) =>
      call<T>(plain.app, `/api/v1${path}`, { method, body, cookie: session, origin: TEST_ORIGIN });
    await local("/projects", "POST", { name: "shop" });
    await local("/projects/shop/services", "POST", { name: "web" });
    await local(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });

    const accepted = await local<ActionEntry>(`${SERVICE}/deploy`, "POST");
    let finished: Finished | undefined;
    for (let attempt = 0; attempt < 1000 && finished === undefined; attempt += 1) {
      const { body } = await local<Finished>(`/actions/${accepted.body.id}`);
      if (body.status !== "queued" && body.status !== "running") {
        finished = body;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(finished?.status).toBe("succeeded");
    expect(finished?.log).toContain("Docker's disk can't be measured from here");
    expect(plain.docker.helpers).toEqual([]);
    await plain.close();
  });
});
