import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionPage,
  BasicAuthEntry,
  BasicAuthList,
  RevealedSecret,
  StoredBasicAuthEntry,
} from "@opsifier/contract";
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
import { serviceRedactor } from "../../services/masking";
import { findService, saveServiceSpec } from "../../services/repo";
import { BASIC_AUTH_PASSWORD_CONTEXT } from "../../services/spec";

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

const reveal = (id: string) => api<RevealedSecret>(`/basic-auth/${id}/reveal`, "POST");
const storedEntry = () => findService(context.deps.db, "shop", "web")?.spec.basicAuth[0];
const traefikText = () => readFileSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"), "utf8");

describe("the basic auth tab", () => {
  it("hashes the password for Traefik and attaches the middleware to every router", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);

    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), username: "probeuser", revealable: true });

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

  it("never sends back a password, a hash or the sealed password, except through a reveal", async () => {
    await api("/basic-auth", "POST", credentials);
    const sealed = storedEntry()?.sealedPassword ?? "";

    const list = await api<BasicAuthList>("/basic-auth");
    expect(JSON.stringify(list.body)).not.toMatch(/password|\$2[aby]\$/);
    expect(JSON.stringify(list.body)).not.toContain(sealed);
    expect(list.body.entries[0]).toEqual({ id: expect.any(String), username: "probeuser", revealable: true });

    const detail = JSON.stringify((await api("")).body);
    expect(detail).not.toMatch(/\$2[aby]\$/);
    expect(detail).not.toContain(sealed);
    expect(detail).not.toContain(credentials.password);
  });

  it("keeps the password sealed with the panel's key, and out of Traefik's file", async () => {
    await api("/basic-auth", "POST", credentials);
    const sealed = storedEntry()?.sealedPassword ?? "";

    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(credentials.password);
    expect(context.deps.secrets.unseal(sealed, BASIC_AUTH_PASSWORD_CONTEXT)).toBe(credentials.password);
    expect(traefikText()).not.toContain(sealed);
    expect(traefikText()).not.toContain(credentials.password);
  });

  it("shows a kept password, uncached, and the activity log names who asked", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);

    const shown = await reveal(created.body.id);

    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({ value: credentials.password });
    expect(shown.headers.get("cache-control")).toBe("no-store");
    const actions = await call<ActionPage>(context.app, "/api/v1/actions?limit=100", {
      cookie,
      origin: TEST_ORIGIN,
    });
    const reveals = actions.body.items.filter((action) => action.type === "service.security-reveal");
    expect(reveals.map(({ title, actorEmail, status }) => ({ title, actorEmail, status }))).toEqual([
      {
        title: "Reveal the basic auth password of probeuser on shop/web",
        actorEmail: "admin@example.com",
        status: "succeeded",
      },
    ]);
  });

  it("hides a kept password from the service's output, like its other secrets", async () => {
    await api("/basic-auth", "POST", credentials);

    const redact = serviceRedactor(context.deps, { projectName: "shop", serviceName: "web" });

    expect(redact.apply(`login with ${credentials.password} now`)).not.toContain(credentials.password);
  });

  it("keeps the stored hash and password when an edit leaves the password blank", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    const before = storedEntry();

    const updated = await api<BasicAuthEntry>(`/basic-auth/${created.body.id}`, "PUT", {
      username: "renamed",
    });

    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ id: created.body.id, username: "renamed", revealable: true });
    const entry = storedEntry();
    expect(entry?.username).toBe("renamed");
    expect(entry?.passwordHash).toBe(before?.passwordHash);
    expect(entry?.sealedPassword).toBe(before?.sealedPassword);
    expect(await bcrypt.compare(credentials.password, entry?.passwordHash ?? "")).toBe(true);
    expect((await reveal(created.body.id)).body.value).toBe(credentials.password);
  });

  it("re-hashes and keeps the new password when an edit sets one", async () => {
    const created = await api<BasicAuthEntry>("/basic-auth", "POST", credentials);
    await api(`/basic-auth/${created.body.id}`, "PUT", { username: "probeuser", password: "another one" });

    const entry = storedEntry();
    expect(await bcrypt.compare("another one", entry?.passwordHash ?? "")).toBe(true);
    expect(await bcrypt.compare(credentials.password, entry?.passwordHash ?? "")).toBe(false);
    expect((await reveal(created.body.id)).body.value).toBe("another one");
  });

  it("cannot show a password saved as a hash only, until the user gets a new one", async () => {
    const record = findService(context.deps.db, "shop", "web");
    if (record === undefined) {
      throw new Error("The service should exist.");
    }
    // As saved before the panel kept passwords: the stored entry has no sealed password at all.
    const legacy = {
      id: "legacy",
      username: "olduser",
      passwordHash: await bcrypt.hash("forgotten", 4),
    } as unknown as StoredBasicAuthEntry;
    saveServiceSpec(context.deps.db, "shop", "web", { ...record.spec, basicAuth: [legacy] }, new Date());

    expect((await api<BasicAuthList>("/basic-auth")).body.entries).toEqual([
      { id: "legacy", username: "olduser", revealable: false },
    ]);
    const refused = await reveal("legacy");
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("password_not_kept");

    await api("/basic-auth/legacy", "PUT", { username: "olduser" });
    expect((await reveal("legacy")).status).toBe(409);

    const renewed = await api<BasicAuthEntry>("/basic-auth/legacy", "PUT", {
      username: "olduser",
      password: "a fresh one",
    });
    expect(renewed.body.revealable).toBe(true);
    expect((await reveal("legacy")).body.value).toBe("a fresh one");
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
    expect((await reveal("nope")).status).toBe(404);
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
