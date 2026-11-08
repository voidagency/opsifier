import { createHmac } from "node:crypto";
import type { ActionEntry, DeploymentTrigger, SourceSettings } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTools } from "../../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const SERVICE = "/projects/shop/services/web";
const TRIGGER = `${SERVICE}/deployments/trigger`;

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:1.28" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

const triggerPath = async () => (await api<DeploymentTrigger>(TRIGGER)).body.path;
const anonymous = <T = unknown>(path: string, options: Parameters<typeof call>[2] = {}) =>
  call<T>(context.app, path, options);
const deployments = async () => (await api<{ items: ActionEntry[] }>(`${SERVICE}/deployments`)).body.items;

async function waitIdle(): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const items = await deployments();
    if (items.every((item) => item.status !== "queued" && item.status !== "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Deployments did not settle");
}

describe("the deployment trigger", () => {
  it("is a 48 hex character token that stays the same between reads", async () => {
    const first = await triggerPath();

    expect(first).toMatch(/^\/api\/v1\/deploy\/[0-9a-f]{48}$/);
    expect(await triggerPath()).toBe(first);
  });

  it("requires a session to read", async () => {
    expect((await anonymous(`/api/v1${TRIGGER}`)).status).toBe(401);
  });

  it("starts a deployment on POST and on GET, with no credentials at all", async () => {
    const path = await triggerPath();

    const posted = await anonymous<ActionEntry>(path, { method: "POST" });
    expect(posted.status).toBe(202);
    expect(posted.body.type).toBe("service.deploy");

    const got = await anonymous<ActionEntry>(path);
    expect(got.status).toBe(202);

    await waitIdle();
    expect(await deployments()).toHaveLength(2);
  });

  it("answers 404 for a token that does not exist", async () => {
    const result = await anonymous("/api/v1/deploy/not-a-real-token", { method: "POST" });

    expect(result.status).toBe(404);
    expect(apiErrorOf(result).code).toBe("not_found");
  });

  it("stops working the moment the token is rotated", async () => {
    const before = await triggerPath();

    const rotated = await api<DeploymentTrigger>(`${TRIGGER}/rotate`, "POST");

    expect(rotated.status).toBe(200);
    expect(rotated.body.path).not.toBe(before);
    expect((await anonymous(before, { method: "POST" })).status).toBe(404);
    expect((await anonymous(rotated.body.path, { method: "POST" })).status).toBe(202);
  });

  it("keeps the token out of the service's own responses and stores it sealed", async () => {
    const path = await triggerPath();
    const token = path.split("/").at(-1) as string;

    expect(JSON.stringify((await api(SERVICE)).body)).not.toContain(token);
    expect(JSON.stringify((await api(`${SERVICE}/source`)).body)).not.toContain(token);
  });

  it("refuses without a source", async () => {
    await api("/projects/shop/services", "POST", { name: "empty" });
    const path = (await api<DeploymentTrigger>("/projects/shop/services/empty/deployments/trigger")).body
      .path;

    const result = await anonymous(path, { method: "POST" });

    expect(result.status).toBe(409);
  });

  it("rebuilds without the cache when asked", async () => {
    const tools = context.deps.tools as FakeTools;
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });
    const path = await triggerPath();

    await anonymous(`${path}?forceRebuild`, { method: "POST" });
    await waitIdle();
    expect(tools.callsTo("docker").at(-1)?.args).toContain("--no-cache");

    await anonymous(path, { method: "POST" });
    await waitIdle();
    expect(tools.callsTo("docker").at(-1)?.args).not.toContain("--no-cache");
  });
});

describe("a GitHub delivery", () => {
  const sign = (body: string, secret: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  const deliver = (path: string, event: string, body: string, signature?: string) =>
    anonymous<{ deployed?: boolean; reason?: string }>(path, {
      method: "POST",
      headers: {
        "x-github-event": event,
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
      },
      rawBody: body,
    });

  beforeEach(async () => {
    await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
  });

  it("deploys a push to the configured branch", async () => {
    const result = await deliver(await triggerPath(), "push", JSON.stringify({ ref: "refs/heads/main" }));

    expect(result.status).toBe(202);
  });

  it("ignores a push to another branch", async () => {
    const result = await deliver(await triggerPath(), "push", JSON.stringify({ ref: "refs/heads/feature" }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ deployed: false, reason: "other_branch" });
    expect(await deployments()).toHaveLength(0);
  });

  it("deploys a push to a configured tag", async () => {
    await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "v1.2",
      path: "/",
    });

    expect(
      (await deliver(await triggerPath(), "push", JSON.stringify({ ref: "refs/tags/v1.2" }))).status,
    ).toBe(202);
  });

  it("ignores a ping and a deleted branch", async () => {
    const path = await triggerPath();

    expect((await deliver(path, "ping", "{}")).body).toEqual({ deployed: false, reason: "not_a_push" });
    expect(
      (await deliver(path, "push", JSON.stringify({ ref: "refs/heads/main", deleted: true }))).body,
    ).toEqual({
      deployed: false,
      reason: "branch_deleted",
    });
    expect(await deployments()).toHaveLength(0);
  });

  it("checks the signature when there is one", async () => {
    const path = await triggerPath();
    const token = path.split("/").at(-1) as string;
    const body = JSON.stringify({ ref: "refs/heads/main" });

    expect((await deliver(path, "push", body, sign(body, "wrong-secret"))).status).toBe(401);
    expect((await deliver(path, "push", body, sign(body, token))).status).toBe(202);
  });
});

describe("the reach of a public path", () => {
  it("does not make any other route public", async () => {
    expect((await anonymous("/api/v1/projects")).status).toBe(401);
  });

  it("keeps the source settings private", async () => {
    expect((await anonymous<SourceSettings>(`/api/v1${SERVICE}/source`)).status).toBe(401);
  });
});
