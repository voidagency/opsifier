import type { ActionEntry } from "@opsifier/contract";
import { Hono } from "hono";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerUnsupportedError } from "../../core/docker";
import { createErrorHandler } from "../../core/errors";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
  await api(`${WEB}/source`, "PUT", { image: "nginx:alpine" });
});

afterEach(async () => {
  await context.close();
});

const WEB = "/projects/shop/services/web";
const STACK = "/projects/shop/services/stack";
const COMPOSE_FILE = "services:\n  web:\n    image: nginx\n    restart: always\n";

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

const tools = () => context.deps.tools as FakeTools;

async function finishedAction(id: string): Promise<ActionEntry> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { body } = await api<ActionEntry>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function deploy(path = WEB): Promise<ActionEntry> {
  const accepted = await api<ActionEntry>(`${path}/deploy`, "POST", {});
  expect(accepted.status).toBe(202);
  return finishedAction(accepted.body.id);
}

describe("an engine the panel can't run on", () => {
  it.each([
    ["old", { version: "20.10.24", apiVersion: "1.41" }],
    ["a current number on an old API", { version: "29.1.0", apiVersion: "1.40" }],
    ["missing a driver it needs", { networkDrivers: ["bridge", "host"] }],
    ["without Swarm", { swarmAvailable: false }],
    ["with Swarm stopped", { swarm: "inactive" as const, swarmManager: false }],
  ])("refuses to deploy when %s, and runs nothing on it", async (_case, engine) => {
    context.docker.engine = { ...context.docker.engine, ...engine };
    tools().calls.length = 0;

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toMatch(/Upgrade or repair Docker/);
    expect(await context.docker.inspectService("shop_web")).toBeNull();
    expect(tools().calls).toEqual([]);
  });

  it("deploys as usual on a compatible one", async () => {
    expect((await deploy()).status).toBe("succeeded");
    expect(await context.docker.inspectService("shop_web")).not.toBeNull();
  });

  it("refuses the other work that changes Docker too, and says the same thing", async () => {
    expect((await deploy()).status).toBe("succeeded");
    const before = await context.docker.inspectService("shop_web");
    context.docker.engine = { ...context.docker.engine, apiVersion: "1.20" };

    const restarted = await api<ActionEntry>(`${WEB}/restart`, "POST", {});
    expect(restarted.status).toBe(202);
    const failed = await finishedAction(restarted.body.id);

    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Engine API 1\.20/);
    expect((await context.docker.inspectService("shop_web"))?.version).toBe(before?.version);
  });

  it("keeps the panel able to say what is wrong", async () => {
    context.docker.engine = { ...context.docker.engine, version: "20.10.24", apiVersion: "1.41" };

    const engine = await api<{ warnings: string[]; missing: string[] }>("/server/docker");

    expect(engine.status).toBe(200);
    expect(engine.body.missing).toEqual(expect.arrayContaining(["version", "api"]));
    expect(engine.body.warnings).toContain("too-old");
  });
});

describe("a Compose stack on a server whose Compose plugin doesn't answer", () => {
  beforeEach(async () => {
    await api("/projects/shop/compose", "POST", { name: "stack" });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: COMPOSE_FILE });
  });

  it("fails before anything is run", async () => {
    tools().missingPlugins.add("compose");
    tools().calls.length = 0;

    const deployed = await deploy(STACK);

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toMatch(/Compose plugin/);
    const composeCalls = tools()
      .callsTo("docker")
      .filter((request) => request.args[0] === "compose");
    expect(composeCalls).toEqual([]);
  });

  it("deploys once the plugin answers", async () => {
    expect((await deploy(STACK)).status).toBe("succeeded");
  });
});

describe("the answer to a refused request", () => {
  it("is the panel's own error shape with a 503", async () => {
    const app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.get("/x", () => {
      throw new DockerUnsupportedError("Docker can't do that here.");
    });

    const response = await app.request("/x");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "docker_unsupported", message: "Docker can't do that here." },
    });
  });

  it("says it instead of starting a helper on a daemon that can't run one", async () => {
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "opsifier:test" } });
    cookie = await setupAdmin(context.app);
    context.docker.engine = { ...context.docker.engine, apiVersion: "1.20" };

    const listing = await api("/server/disk");

    expect(listing.status).toBe(503);
    expect(apiErrorOf(listing).code).toBe("docker_unsupported");
    expect(context.docker.helpers).toEqual([]);
  });
});
