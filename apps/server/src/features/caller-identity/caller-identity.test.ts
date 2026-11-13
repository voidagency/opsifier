import type { CallerIdentity, CreatedApiKey, PanelUser } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let context: TestContext;
let admin: string;

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  for (const project of ["shop", "secret"]) {
    expect((await session("POST", "/api/v1/projects", admin, { name: project })).status).toBe(201);
    expect(
      (await session("POST", `/api/v1/projects/${project}/services`, admin, { name: "web" })).status,
    ).toBe(201);
  }
});

afterEach(async () => {
  await context.close();
});

function session<T = unknown>(method: string, path: string, cookie: string, body?: unknown) {
  return call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });
}

async function member(
  email: string,
  grants: Array<{ project: string; role: "viewer" | "operator" }>,
  allProjects: "viewer" | "operator" | null = null,
) {
  const created = await session<PanelUser>("POST", "/api/v1/users", admin, {
    email,
    password: TEST_PASSWORD,
    role: "member",
    projects: grants,
    allProjects,
  });
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  return login.cookie as string;
}

async function keyOf(cookie: string, body: Record<string, unknown>) {
  const created = await session<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, {
    name: "key",
    ...body,
  });
  expect(created.status).toBe(201);
  return created.body.token;
}

const identityOf = (token: string) =>
  call<CallerIdentity>(context.app, "/api/v1/auth/identity", {
    headers: { authorization: `Bearer ${token}` },
  });

const has = (identity: CallerIdentity, method: string, path: string) =>
  identity.operations.some((operation) => operation.method === method && operation.path === path);

const SERVICE = "/api/v1/projects/{project}/services/{service}";

describe("GET /api/v1/auth/identity", () => {
  it("needs a credential", async () => {
    const result = await call(context.app, "/api/v1/auth/identity");
    expect(result.status).toBe(401);
    expect(apiErrorOf(result).code).toBe("unauthenticated");
  });

  it("names a key and the operations a full administrator key may call", async () => {
    const key = await keyOf(admin, { name: "ci", level: "write" });
    const { body, status } = await identityOf(key);

    expect(status).toBe(200);
    expect(body.user.email).toBe("admin@example.com");
    expect(body.credential).toMatchObject({ kind: "api_key", name: "ci", level: "write", projects: null });
    expect(body.projects).toBeNull();
    expect(has(body, "POST", `${SERVICE}/deploy`)).toBe(true);
    expect(has(body, "GET", `${SERVICE}/logs/search`)).toBe(true);
    // Reachable by no key, whoever owns it.
    expect(has(body, "POST", "/api/v1/me/api-keys")).toBe(false);
    expect(has(body, "GET", "/api/v1/users")).toBe(false);
  });

  it("drops everything that changes something from a read key", async () => {
    const { body } = await identityOf(await keyOf(admin, { level: "read" }));

    expect(has(body, "GET", SERVICE)).toBe(true);
    expect(has(body, "POST", `${SERVICE}/deploy`)).toBe(false);
    expect(has(body, "POST", "/api/v1/projects")).toBe(false);
    expect(body.operations.filter((operation) => operation.method !== "GET")).toEqual([]);
  });

  it("limits an administrator's key to the projects it was narrowed to", async () => {
    const { body } = await identityOf(await keyOf(admin, { level: "write", projects: ["shop"] }));

    expect(body.projects).toEqual([{ name: "shop", role: "admin" }]);
    const deploy = body.operations.find(
      (operation) => operation.method === "POST" && operation.path === `${SERVICE}/deploy`,
    );
    expect(deploy?.projects).toEqual(["shop"]);
    // A narrowed key is not an administrator's reach of the whole server any more.
    expect(has(body, "POST", "/api/v1/projects")).toBe(false);
  });

  it("follows a member's role in each project", async () => {
    const cookie = await member("m@example.com", [
      { project: "shop", role: "operator" },
      { project: "secret", role: "viewer" },
    ]);
    const { body } = await identityOf(await keyOf(cookie, { level: "write" }));

    expect(body.projects).toEqual(
      expect.arrayContaining([
        { name: "shop", role: "operator" },
        { name: "secret", role: "viewer" },
      ]),
    );
    const inProjects = (method: string, path: string) =>
      body.operations.find((operation) => operation.method === method && operation.path === path)?.projects;
    expect(inProjects("GET", SERVICE)?.sort()).toEqual(["secret", "shop"]);
    expect(inProjects("POST", `${SERVICE}/deploy`)).toEqual(["shop"]);
    expect(inProjects("GET", `${SERVICE}/logs/search`)).toEqual(["shop"]);
    expect(inProjects("DELETE", "/api/v1/projects/{project}")).toBeUndefined();
    expect(body.allProjects).toBeNull();
  });

  it("counts a member's role in every project, and says it reaches the projects to come", async () => {
    const cookie = await member("e@example.com", [{ project: "shop", role: "operator" }], "viewer");
    expect(
      (await session("POST", "/api/v1/projects", admin, { name: "later" })).status,
      "a project created after the account",
    ).toBe(201);
    const { body } = await identityOf(await keyOf(cookie, { level: "write" }));

    expect(body.allProjects).toBe("viewer");
    expect(body.projects).toEqual([
      { name: "later", role: "viewer" },
      { name: "secret", role: "viewer" },
      { name: "shop", role: "operator" },
    ]);
    const inProjects = (method: string, path: string) =>
      body.operations.find((operation) => operation.method === method && operation.path === path)?.projects;
    expect(inProjects("GET", SERVICE)).toEqual(["later", "secret", "shop"]);
    expect(inProjects("POST", `${SERVICE}/deploy`)).toEqual(["shop"]);

    // A key narrowed to a list reaches no project to come.
    const narrowed = await identityOf(await keyOf(cookie, { level: "write", projects: ["secret"] }));
    expect(narrowed.body.allProjects).toBeNull();
    expect(narrowed.body.projects).toEqual([{ name: "secret", role: "viewer" }]);

    // An administrator reaches everything as one, which no project role adds to.
    expect((await identityOf(await keyOf(admin, { level: "write" }))).body.allProjects).toBeNull();
  });

  it("agrees with what the routes then do", async () => {
    const cookie = await member("v@example.com", [{ project: "shop", role: "viewer" }]);
    const key = await keyOf(cookie, { level: "write" });
    const { body } = await identityOf(key);
    const send = (method: string, path: string) =>
      call(context.app, path, { method, headers: { authorization: `Bearer ${key}` } });

    expect(has(body, "GET", SERVICE)).toBe(true);
    expect((await send("GET", "/api/v1/projects/shop/services/web")).status).toBe(200);
    expect(has(body, "POST", `${SERVICE}/deploy`)).toBe(false);
    expect((await send("POST", "/api/v1/projects/shop/services/web/deploy")).status).toBe(403);
  });
});
