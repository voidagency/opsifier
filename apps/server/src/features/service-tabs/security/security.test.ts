import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BasicAuthEntry, BasicAuthList } from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { findService } from "../../services/repo";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1/projects/shop/services/web${path}`, {
    method,
    body,
    cookie,
    origin: TEST_ORIGIN,
  });

const proxyFile = () =>
  parse(readFileSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"), "utf8")) as {
    http: {
      routers: Record<string, { middlewares?: string[] }>;
      middlewares?: Record<string, { basicAuth?: { users: string[]; removeHeader: boolean } }>;
    };
  };

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await call(context.app, "/api/v1/projects", {
    method: "POST",
    body: { name: "shop" },
    cookie,
    origin: TEST_ORIGIN,
  });
  await call(context.app, "/api/v1/projects/shop/services", {
    method: "POST",
    body: { name: "web" },
    cookie,
    origin: TEST_ORIGIN,
  });
});

afterEach(async () => {
  await context.close();
});

const credentials = { username: "probeuser", password: "a long and fake secret" };

describe("the basic auth tab", () => {
  it("hashes the password for Traefik and attaches the middleware to every router", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);

    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), username: "probeuser" });

    const { http } = proxyFile();
    const auth = http.middlewares?.["opsifier-auth-shop_web"]?.basicAuth;
    expect(auth?.removeHeader).toBe(true);
    const [user, hash] = (auth?.users[0] ?? "").split(":") as [string, string];
    expect(user).toBe("probeuser");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hash).not.toContain(credentials.password);
    expect(await bcrypt.compare(credentials.password, hash)).toBe(true);
    for (const router of Object.values(http.routers)) {
      expect(router.middlewares).toContain("opsifier-auth-shop_web");
    }
  });

  it("never sends back a password or a hash", async () => {
    await api("/basic-auth", "POST", credentials);

    const list = await api<BasicAuthList>("/basic-auth");
    expect(JSON.stringify(list.body)).not.toMatch(/password|\$2[aby]\$/);
    expect(list.body.entries[0]).toEqual({ id: expect.any(String), username: "probeuser" });

    const detail = await api("");
    expect(JSON.stringify(detail.body)).not.toMatch(/\$2[aby]\$/);
  });

  it("keeps the stored hash when an edit leaves the password blank", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    const hashBefore = findService(context.deps.db, "shop", "web")?.spec.basicAuth[0]?.passwordHash;

    const updated = await api<BasicAuthEntry>(`/basic-auth/${created.body.id}`, "PUT", {
      username: "renamed",
    });

    expect(updated.status).toBe(200);
    expect(updated.body.username).toBe("renamed");
    const entry = findService(context.deps.db, "shop", "web")?.spec.basicAuth[0];
    expect(entry?.username).toBe("renamed");
    expect(entry?.passwordHash).toBe(hashBefore);
    expect(await bcrypt.compare(credentials.password, entry?.passwordHash ?? "")).toBe(true);
  });

  it("re-hashes when an edit sets a new password", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    await api(`/basic-auth/${created.body.id}`, "PUT", { username: "probeuser", password: "another one" });

    const entry = findService(context.deps.db, "shop", "web")?.spec.basicAuth[0];
    expect(await bcrypt.compare("another one", entry?.passwordHash ?? "")).toBe(true);
    expect(await bcrypt.compare(credentials.password, entry?.passwordHash ?? "")).toBe(false);
  });

  it("removes the middleware with the last entry", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    expect((await api(`/basic-auth/${created.body.id}`, "DELETE")).status).toBe(200);

    expect(proxyFile().http.middlewares ?? {}).toEqual({});
    for (const router of Object.values(proxyFile().http.routers)) {
      expect(router.middlewares).not.toContain("opsifier-auth-shop_web");
    }
    expect((await api<BasicAuthList>("/basic-auth")).body.entries).toEqual([]);
  });

  it("refuses a username that is already listed", async () => {
    await api("/basic-auth", "POST", credentials);
    const result = await api("/basic-auth", "POST", { ...credentials, password: "something else" });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("basic_auth_taken");
    expect(apiErrorOf(result).fields?.username).toBeTruthy();
  });

  it("answers 404 for an entry that does not exist", async () => {
    expect((await api("/basic-auth/nope", "PUT", { username: "x" })).status).toBe(404);
    expect((await api("/basic-auth/nope", "DELETE")).status).toBe(404);
  });

  it.each([
    [{}, "username"],
    [{ username: "", password: "x" }, "username"],
    [{ username: "   ", password: "x" }, "username"],
    [{ username: "with space", password: "x" }, "username"],
    [{ username: "co:lon", password: "x" }, "username"],
    [{ username: "new\nline", password: "x" }, "username"],
    [{ username: "u" }, "password"],
    [{ username: "u", password: "" }, "password"],
    [{ username: "u", password: "   " }, "password"],
    [{ username: "u", password: "x".repeat(73) }, "password"],
    [{ username: "u", password: "é".repeat(37) }, "password"],
  ])("rejects %j", async (body, field) => {
    const result = await api("/basic-auth", "POST", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeTruthy();
    expect((await api<BasicAuthList>("/basic-auth")).body.entries).toEqual([]);
  });

  it("rejects a blank password on an edit, while an absent one keeps the old", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    const result = await api(`/basic-auth/${created.body.id}`, "PUT", { username: "u", password: "" });
    expect(result.status).toBe(400);
  });
});
