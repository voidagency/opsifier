import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionEntry, CreatedApiKey } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActionRow, toActionEntry } from "../../../core/actions";
import {
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_EMAIL,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../../testing/harness";

let dir: string;
let context: TestContext;
let cookie: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "opsifier-origin-"));
  context = await createTestContext({ env: { OPSIFIER_DATA_DIR: dir } });
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
  await api("/projects/shop/services/web/source", "PUT", { image: "nginx:1.28" });
});

afterEach(async () => {
  await context.close();
  rmSync(dir, { recursive: true, force: true });
});

function api<T = unknown>(path: string, method = "GET", body?: unknown, headers?: Record<string, string>) {
  return call<T>(context.app, `/api/v1${path}`, {
    method,
    body,
    cookie: headers === undefined ? cookie : undefined,
    origin: headers === undefined ? TEST_ORIGIN : undefined,
    headers,
  });
}

async function originsById(): Promise<Map<string, string | null>> {
  const { items } = (await api<{ items: ActionEntry[] }>("/actions?limit=100")).body;
  return new Map(items.map((item) => [item.id, item.origin]));
}

describe("where an Action came from", () => {
  it("is the panel itself when nothing asked for it, such as a schedule", () => {
    const scheduled = context.deps.actions.record({ type: "backup.schedule", title: "Scheduled backup" });

    expect(toActionEntry(scheduled)).toMatchObject({ origin: "system", actorEmail: null });
  });

  it("names a person's account when a socket session starts one, as nothing ambient says so there", () => {
    const opened = context.deps.actions.record({
      type: "server.console",
      title: "Open the server console",
      actorEmail: "admin@example.com",
    });

    expect(opened.origin).toBe("session");
    expect(opened.actorEmail).toBe("admin@example.com");
  });

  it("names a schedule apart from an API request, after a restart too", async () => {
    const key = (await api<CreatedApiKey>("/me/api-keys", "POST", { name: "bot", level: "write" })).body
      .token;
    const bearer = { authorization: `Bearer ${key}` };
    const viaKey = await api<ActionEntry>("/projects/shop/services/web/deploy", "POST", undefined, bearer);
    const scheduled = context.deps.actions.record({ type: "backup.schedule", title: "Scheduled backup" });
    expect(viaKey.status).toBe(202);
    for (let attempt = 0; attempt < 500 && !context.deps.actions.isIdle(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await context.close();
    context = await createTestContext({ env: { OPSIFIER_DATA_DIR: dir } });
    cookie = (await login()) as string;

    const origins = await originsById();
    expect(origins.get(viaKey.body.id)).toBe("api_key");
    expect(origins.get(scheduled.id)).toBe("system");
  });

  it("reads rows from before origins were recorded by who is named in them", () => {
    const base = context.deps.actions.record({ type: "a", title: "A" });

    expect(
      toActionEntry({ ...base, origin: null, actorEmail: "admin@example.com" } as ActionRow).origin,
    ).toBe("session");
    expect(toActionEntry({ ...base, origin: null, actorEmail: null } as ActionRow).origin).toBe("system");
  });
});

async function login(): Promise<string | undefined> {
  return (await authPost(context.app, "login", { email: TEST_EMAIL, password: TEST_PASSWORD })).cookie;
}
