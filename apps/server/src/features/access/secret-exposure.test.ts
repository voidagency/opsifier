import { type PanelUser, serviceLogsTopic } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeTools } from "../../core/tools";
import {
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { logStoreFor, searchStoredLogs } from "../monitor/logstore";
import { saveMonitoringSettings } from "../monitor/settings";
import { saveServiceSpec } from "../services/repo";
import { requireService } from "../services/service";
import { createTopicGuard } from "./guard";

/**
 * One fixture of every kind of secret a service can hold, one person in each role, and every place a
 * secret could reach them: answers, logs and errors. Nothing should say anything to anyone unless they
 * asked for it, and then only an operator or above.
 */
const RUNTIME = "runtime-secret-value-1";
const SHARED = "shared-secret-value-22";
const BUILD_VARIABLE = "build-variable-value-3";
const BUILD_SECRET = "build-secret-value-44";
const TEMPLATE = "template-secret-value-5";
const OLD_RUNTIME = "PreviouslyUsedValueQz9";
const SPLIT_SECRET = "correct-horse-battery-staple";
const ALL = [RUNTIME, SHARED, BUILD_VARIABLE, BUILD_SECRET, TEMPLATE, OLD_RUNTIME, SPLIT_SECRET];

let context: TestContext;
let admin: string;
let viewer: { user: PanelUser; cookie: string };
let operator: { user: PanelUser; cookie: string };
let failedActionId = "";
let succeededActionId = "";

const WEB = "/api/v1/projects/shop/services/web";

function api<T = unknown>(cookie: string, path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, path, { method, body, cookie, origin: TEST_ORIGIN });
}

async function createMember(email: string, role: "viewer" | "operator") {
  const created = await api<PanelUser>(admin, "/api/v1/users", "POST", {
    email,
    password: TEST_PASSWORD,
    role: "member",
    projects: [{ project: "shop", role }],
  });
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  return { user: created.body, cookie: login.cookie as string };
}

async function waitFor(id: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<{ status: string }>(admin, `/api/v1/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function deployPrinting(lines: string[], failure?: string): Promise<string> {
  const tools = context.deps.tools as FakeTools;
  tools.handler = (request) => {
    if (request.command !== "docker") {
      return undefined;
    }
    for (const line of lines) {
      request.onLine?.(line);
    }
    if (failure !== undefined) {
      throw new Error(failure);
    }
    return { exitCode: 0, tail: [] };
  };
  const accepted = await api<{ id: string }>(admin, `${WEB}/deploy`, "POST", {});
  await waitFor(accepted.body.id);
  return accepted.body.id;
}

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  await api(admin, "/api/v1/projects", "POST", { name: "shop" });
  await api(admin, "/api/v1/projects/shop/services", "POST", { name: "web" });
  viewer = await createMember("viewer@example.com", "viewer");
  operator = await createMember("operator@example.com", "operator");

  await api(admin, `${WEB}/source`, "PUT", {
    type: "git",
    url: "https://git.example.com/acme/shop.git",
    ref: "main",
    path: "/",
  });
  await api(admin, `${WEB}/environment`, "PUT", { env: `API_TOKEN=${OLD_RUNTIME}\n` });
  await api(admin, `${WEB}/environment`, "PUT", {
    env: `API_TOKEN=${RUNTIME}\nSPLIT_TOKEN=${SPLIT_SECRET}\nREF=$(secret.apiKey)\n`,
  });
  await api(admin, "/api/v1/projects/shop/env", "PUT", { env: `SHARED_TOKEN=${SHARED}\n` });
  await api(admin, `${WEB}/environment/build`, "PUT", { env: `BUILD_TOKEN=${BUILD_VARIABLE}\n` });
  await api(admin, `${WEB}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: BUILD_SECRET });

  const target = { projectName: "shop", serviceName: "web" };
  const record = requireService(context.deps, target);
  saveServiceSpec(
    context.deps.db,
    "shop",
    "web",
    {
      ...record.spec,
      references: {
        databases: {},
        secrets: {
          apiKey: { sealed: context.deps.secrets.seal(TEMPLATE, "template-secret"), label: null },
        },
      },
    },
    new Date(),
  );

  succeededActionId = await deployPrinting([
    `one ${RUNTIME}`,
    `two ${SHARED}`,
    `three ${BUILD_VARIABLE}`,
    `four ${BUILD_SECRET}`,
    `five ${TEMPLATE}`,
    `six ${OLD_RUNTIME}`,
    "seven correct-horse-",
    "battery-staple end",
  ]);
  failedActionId = await deployPrinting([], `the build died printing ${RUNTIME} and ${BUILD_SECRET}`);

  context.docker.writeLog("shop_web", `service said ${RUNTIME}`);
  context.docker.writeLog("shop_web", "half of correct-horse-");
  context.docker.writeLog("shop_web", "battery-staple the rest");
  context.docker.writeLog("shop_web", `and also ${OLD_RUNTIME}`);
});

afterEach(async () => {
  await context.close();
});

const expectNoSecret = (text: string): void => {
  for (const secret of ALL) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain("correct-horse-");
  expect(text).not.toContain("battery-staple");
};

/** Everything a person can read about the project, whatever they are allowed to. */
const readable = [
  "/api/v1/projects",
  "/api/v1/projects/shop",
  "/api/v1/projects/shop/env",
  "/api/v1/projects/shop/schema",
  WEB,
  `${WEB}/environment`,
  `${WEB}/environment/build`,
  `${WEB}/source`,
  `${WEB}/source/env-file`,
  `${WEB}/deployments`,
  `${WEB}/logs/search?q=`,
  "/api/v1/actions?limit=100",
];

describe.each(["admin", "operator", "viewer"] as const)("as %s", (role) => {
  const cookie = () => (role === "admin" ? admin : role === "operator" ? operator.cookie : viewer.cookie);

  it("no answer gives a secret away", async () => {
    for (const path of readable) {
      const response = await api(cookie(), path);
      expectNoSecret(JSON.stringify(response.body));
    }
  });

  it("no log, or error attached to it, gives a secret away", async () => {
    for (const id of [succeededActionId, failedActionId]) {
      const detail = await api<{ log?: string; error?: string | null }>(cookie(), `/api/v1/actions/${id}`);
      expectNoSecret(JSON.stringify(detail.body));
      expect(detail.status).toBe(role === "viewer" ? 403 : 200);
    }
    const listed = await api<{ items: Array<{ id: string; error: string | null }> }>(
      cookie(),
      "/api/v1/actions?limit=100",
    );
    const failed = listed.body.items.find((item) => item.id === failedActionId);
    expect(failed?.error).toContain("[redacted]");
    expectNoSecret(JSON.stringify(failed));
  });

  it("a failing request gives none away either", async () => {
    const failures = [
      await api(cookie(), `${WEB}/environment`, "PUT", { env: `no equals sign ${RUNTIME}` }),
      await api(cookie(), `${WEB}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: "" }),
      await api(cookie(), "/api/v1/projects/shop/services/missing/environment"),
    ];
    for (const failure of failures) {
      expect(failure.status).toBeGreaterThanOrEqual(400);
      expectNoSecret(JSON.stringify(failure.body));
    }
  });

  it("the values come only from asking, as far as the role allows, and asking is on record", async () => {
    const reveal = await api<{ env: string }>(cookie(), `${WEB}/environment/reveal`, "POST");
    const project = await api<{ env: string }>(cookie(), "/api/v1/projects/shop/env/reveal", "POST");
    const build = await api<{ env: string }>(cookie(), `${WEB}/environment/build/reveal`, "POST");

    if (role === "viewer") {
      expect([reveal.status, project.status, build.status]).toEqual([403, 403, 403]);
      expectNoSecret(JSON.stringify([reveal.body, project.body, build.body]));
      const logs = await api(cookie(), `${WEB}/logs/search?q=`);
      expect(logs.status).toBe(403);
      return;
    }
    expect(reveal.body.env).toContain(RUNTIME);
    expect(project.body.env).toContain(SHARED);
    expect(build.body.env).toContain(BUILD_VARIABLE);
    const audit = await api<{ items: Array<{ type: string; title: string }> }>(
      admin,
      "/api/v1/actions?type=service.env-reveal",
    );
    expect(audit.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it("a build secret can't be read back by anyone", async () => {
    const surfaces = await Promise.all([
      api(cookie(), `${WEB}/environment/build`),
      api(cookie(), `${WEB}/environment/build/secrets/NPM_TOKEN`),
    ]);
    expectNoSecret(JSON.stringify(surfaces.map((surface) => surface.body)));
    expect(surfaces[1]?.status).not.toBe(200);
  });

  it("the live log stream is open to the same people as the log itself", () => {
    if (role !== "admin") {
      const person = role === "operator" ? operator : viewer;
      expect(createTopicGuard(context.deps).allow(person.user.id, serviceLogsTopic("shop", "web"))).toBe(
        role === "operator",
      );
    }
  });
});

describe("what the panel keeps of a service's output", () => {
  it("has its secrets removed before it is stored, and when read back", async () => {
    saveMonitoringSettings(context.deps, {
      metrics: { enabled: true, retention: 1, retentionUnit: "days", scrapeSeconds: 15 },
      logs: { enabled: true, retention: 1, retentionUnit: "days", maxSizeMb: 10 },
    });

    await logStoreFor(context.deps).collect();

    const stored = searchStoredLogs(
      context.deps,
      { projectName: "shop", serviceName: "web" },
      { q: "", stream: "all", level: "any", limit: 50 },
    );
    expect(stored.lines.length).toBeGreaterThan(0);
    expectNoSecret(JSON.stringify(stored));
  });
});
