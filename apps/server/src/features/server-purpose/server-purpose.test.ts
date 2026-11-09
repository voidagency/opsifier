import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AllowlistEntry,
  type AllowlistState,
  type ProtectionUserList,
  type ProtectionUserResult,
  type ServerPurposeState,
  type SetServerPurposeResult,
  serviceType,
} from "@opsifier/contract";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { apiErrorOf, call, type TestContext } from "../../testing/harness";
import { requirementFor } from "../access/policy";
import { type DatabaseTestContext, setupDatabaseTests } from "../databases/testing";
import { PANEL_DOMAIN_KEY } from "../server/panel-host";
import { GATE_MIDDLEWARE, NOINDEX_MIDDLEWARE, ROBOTS_ROUTER_PREFIX } from "../services/compile/protection";
import { findService } from "../services/repo";
import { writeProxyConfig } from "../services/service";
import { putSetting } from "../system/repo";
import { readProtection, saveProtection, seedProtection } from "./repo";

let suite: DatabaseTestContext;
let context: TestContext;

const SERVER_IP = "203.0.113.10";

beforeEach(async () => {
  vi.stubEnv("OPSIFIER_SERVER_IP", SERVER_IP);
  suite = await setupDatabaseTests();
  context = suite.context;
  await suite.api("/projects", "POST", { name: "shop" });
});

afterEach(async () => {
  await suite.close();
  vi.unstubAllEnvs();
});

interface Router {
  rule: string;
  middlewares?: string[];
  service: string;
  entryPoints?: string[];
}

const dynamicDir = () => context.deps.config.traefikDynamicDir;

function routingFiles(): Array<{
  file: string;
  http: { routers?: Record<string, Router>; middlewares?: Record<string, unknown> };
}> {
  return readdirSync(dynamicDir())
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => ({
      file,
      http: (parse(readFileSync(join(dynamicDir(), file), "utf8")) as { http?: unknown }).http as never,
    }));
}

const allRouters = () =>
  routingFiles().flatMap(({ file, http }) =>
    Object.entries(http.routers ?? {}).map(([name, router]) => ({ file, name, router })),
  );

const gated = (router: Router) =>
  (router.middlewares ?? []).some(
    (name) => name === GATE_MIDDLEWARE || name.startsWith(`${GATE_MIDDLEWARE}-`),
  );

/** Every route of every kind, however it was produced, has the protection on it. */
function expectEveryRouterProtected(): void {
  const routers = allRouters();
  expect(routers.length).toBeGreaterThan(0);

  for (const { file, name, router } of routers) {
    const where = `${file}: ${name}`;
    expect(router.middlewares?.[0], where).toBe(NOINDEX_MIDDLEWARE);
    if (name.startsWith(ROBOTS_ROUTER_PREFIX)) {
      expect(router.rule, where).toContain("Path(`/robots.txt`)");
      expect(gated(router), where).toBe(false);
      continue;
    }
    if (file === "_base.yaml") {
      expect(gated(router), `${where} keeps the panel's own login only`).toBe(false);
      continue;
    }
    expect(gated(router), `${where} has no gate`).toBe(true);
    expect(
      routers.some(
        (other) =>
          other.file === file &&
          other.name.startsWith(ROBOTS_ROUTER_PREFIX) &&
          other.router.entryPoints?.join() === router.entryPoints?.join() &&
          other.router.rule.includes(
            /(?:HostRegexp|Host)\(`[^`]*`\)/.exec(router.rule)?.[0] ?? "Path(`/robots.txt`)",
          ),
      ),
      `${where} has no robots.txt route`,
    ).toBe(true);
  }
  // Every gate and tag those routers name is really defined.
  const base = routingFiles().find(({ file }) => file === "_base.yaml")?.http.middlewares ?? {};
  expect(base[NOINDEX_MIDDLEWARE]).toBeDefined();
  expect(base[GATE_MIDDLEWARE]).toBeDefined();
}

/** One of every kind of thing that produces a route today. */
async function produceEveryKindOfRoute(): Promise<void> {
  // Each service type the contract offers, through the same API the panel uses.
  for (const type of serviceType.options) {
    expect((await suite.api(`/projects/shop/services`, "POST", { name: `made-${type}`, type })).status).toBe(
      201,
    );
  }

  // A service with a default domain, a path, an HTTP-only host and a wildcard.
  await suite.api("/projects/shop/services", "POST", { name: "web" });
  const web = "/projects/shop/services/web";
  await suite.api(`${web}/domains`, "POST", { host: "app.example.test" });
  await suite.api(`${web}/domains`, "POST", { host: "app.example.test", path: "/api", port: 8080 });
  await suite.api(`${web}/domains`, "POST", { host: "plain.example.test", https: false });
  await suite.api(`${web}/domains`, "POST", {
    host: "wild.example.test",
    wildcard: true,
    certificateResolver: "dns",
  });

  // A service with its own basic auth, redirects and a named middleware on a domain.
  await suite.api("/projects/shop/services", "POST", { name: "locked" });
  const locked = "/projects/shop/services/locked";
  await suite.api(`${locked}/basic-auth`, "POST", { username: "owner", password: "a long enough secret" });
  await suite.api(`${locked}/domains`, "POST", {
    host: "locked.example.test",
    middlewares: ["forward@file"],
  });

  // A service in maintenance, and one that is stopped.
  await suite.api("/projects/shop/services", "POST", { name: "paused" });
  const paused = "/projects/shop/services/paused";
  await suite.api(`${paused}/maintenance`, "PUT", { enabled: true, title: "Back soon", body: "" });
  await suite.api("/projects/shop/services", "POST", { name: "halted" });
  const target = { projectName: "shop", serviceName: "halted" };
  const record = readRecord("halted");
  await writeProxyConfig(context.deps, target, { ...record, stopped: true });

  // A database's web tool, and the panel's own files.
  await suite.deployed({ engine: "postgres" });
  expect((await suite.run(`${suite.service()}/companions/pgweb`)).status).toBe("succeeded");
  await context.deps.proxy.writeOwnFile("_extra.yaml", {
    http: {
      routers: {
        extra: { rule: "Host(`extra.example.test`)", service: "api@internal", entryPoints: ["web"] },
      },
    },
  });

  // Something nobody has written yet.
  await context.deps.proxy.writeService("shop", "future", {
    http: {
      routers: {
        "new-kind-of-route": {
          rule: "Host(`new.example.test`) && Path(`/thing`)",
          service: "someone",
          entryPoints: ["websecure"],
          tls: { certResolver: "letsencrypt" },
        },
      },
      services: { someone: { loadBalancer: { servers: [{ url: "http://x:1/" }] } } },
    },
  });
}

const readRecord = (name: string) => {
  const record = findService(context.deps.db, "shop", name);
  if (record === undefined) {
    throw new Error("No such service");
  }
  return record.spec;
};

const setPurpose = (purpose: string, confirm?: string) =>
  suite.api<SetServerPurposeResult>("/server-purpose", "PUT", { purpose, confirm });

const stateNow = async () => (await suite.api<ServerPurposeState>("/server-purpose")).body;

describe("SRV-02: every route on a non-production server", () => {
  it("is protected, for each kind of route, created while the server is already protected", async () => {
    expect((await setPurpose("staging")).status).toBe(200);

    await produceEveryKindOfRoute();

    expectEveryRouterProtected();
  });

  it("is protected, for each kind of route, created before the server stopped being production", async () => {
    await produceEveryKindOfRoute();

    await setPurpose("development");

    expectEveryRouterProtected();
  });

  it("is protected when the purpose has never been set, with no redeploy and no user action", async () => {
    await produceEveryKindOfRoute();

    seedProtection(context.deps.db, null, new Date());
    await context.runtime.boot();

    expectEveryRouterProtected();
    expect((await stateNow()).purpose).toBeNull();
    expect((await stateNow()).protection).toBe(true);
  });

  it("carries nothing on production", async () => {
    await produceEveryKindOfRoute();

    for (const { name, router } of allRouters()) {
      expect(name.startsWith("opsifier-protect-")).toBe(false);
      expect(router.middlewares ?? []).not.toContain(NOINDEX_MIDDLEWARE);
    }
    const base = routingFiles().find(({ file }) => file === "_base.yaml")?.http.middlewares ?? {};
    expect(base[GATE_MIDDLEWARE]).toBeUndefined();
  });

  it("publishes a newly created service protected, at the moment it is created", async () => {
    await setPurpose("staging");

    await suite.api("/projects/shop/services", "POST", { name: "fresh" });

    const fresh = parse(readFileSync(join(dynamicDir(), "shop__fresh.yaml"), "utf8")) as {
      http: { routers: Record<string, Router> };
    };
    expect(fresh.http.routers["https-shop_fresh-0"]?.middlewares).toContain(GATE_MIDDLEWARE);
    expect(await stateNow()).toMatchObject({ totalCount: 1, protectedCount: 1, problems: [] });
  });

  it("never lets a route through when the credentials are gone: the gate locks instead", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });

    saveProtection(context.deps.db, { ...readProtection(context.deps.db), users: [] }, new Date());
    await context.runtime.boot();

    const base = routingFiles().find(({ file }) => file === "_base.yaml")?.http.middlewares as Record<
      string,
      { basicAuth: { users: string[] } }
    >;
    expect(base[GATE_MIDDLEWARE]?.basicAuth.users).toEqual([expect.stringMatching(/^locked:/)]);
    expect((await stateNow()).problems).toEqual([{ code: "no_credentials" }]);
    expect((await stateNow()).domains.every((domain) => domain.status === "protected")).toBe(true);
  });

  it("answers robots.txt from the panel, with the header on the panel's own responses", async () => {
    await setPurpose("staging");

    const page = await suite.api<string>("/../proxy-pages/robots.txt");
    const robots = await context.app.request("/robots.txt");

    expect(page.status).toBe(200);
    expect(page.body).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
  });

  it("removes the panel's robots.txt and header on production", async () => {
    const page = await context.app.request("/api/v1/system/info");
    const robots = await context.app.request("/robots.txt");

    expect(page.headers.get("x-robots-tag")).toBeNull();
    expect(robots.status).toBe(404);
  });
});

describe("the pages the proxy asks the panel for", () => {
  it("are served whatever host the visitor named, even when the panel answers only on its own names", async () => {
    await setPurpose("staging");
    putSetting(
      context.deps.db,
      PANEL_DOMAIN_KEY,
      { customDomain: "panel.example.test", serveOnIp: false },
      new Date(),
    );

    const robots = await call(context.app, "/api/proxy-pages/robots.txt", {
      headers: { host: "shop-web.example.test" },
    });
    const elsewhere = await call(context.app, "/api/v1/system/info", {
      headers: { host: "shop-web.example.test" },
    });

    expect(robots.status).toBe(200);
    expect(robots.body).toBe("User-agent: *\nDisallow: /\n");
    expect(elsewhere.status).toBe(404);
  });
});

describe("SRV-04: changing the purpose", () => {
  it("makes moving to production type a confirmation stating how many domains open up", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    await suite.api("/projects/shop/services/web/domains", "POST", { host: "a.example.test" });

    expect((await stateNow()).confirmation).toBe("PUBLIC 2");
    const refused = await setPurpose("production", "PUBLIC 1");

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("confirmation_mismatch");
    expect((await stateNow()).purpose).toBe("staging");

    const accepted = await setPurpose("production", "PUBLIC 2");

    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toMatchObject({ purpose: "production", protection: false });
    expect(accepted.body.state.domains.every((domain) => domain.status === "public")).toBe(true);
    expect(allRouters().some(({ router }) => (router.middlewares ?? []).includes(NOINDEX_MIDDLEWARE))).toBe(
      false,
    );
  });

  it("asks for no confirmation to leave production, and applies protection straight away", async () => {
    await suite.api("/projects/shop/services", "POST", { name: "web" });

    const result = await setPurpose("development");

    expect(result.status).toBe(200);
    expect(result.body.state).toMatchObject({ purpose: "development", protection: true, protectedCount: 1 });
    expectEveryRouterProtected();
  });

  it("generates the first credentials on the first protected purpose and shows them once", async () => {
    const first = await setPurpose("staging");

    expect(first.body.credentials).toMatchObject({ username: "opsifier" });
    const password = first.body.credentials?.password ?? "";
    expect(password).toMatch(/^[a-z2-9]{32}$/);

    const again = await setPurpose("development");
    expect(again.body.credentials).toBeNull();

    const users = (await suite.api<ProtectionUserList>("/server-purpose/users")).body;
    expect(JSON.stringify(users)).not.toContain("passwordHash");
    expect(JSON.stringify(users)).not.toContain(password);

    const stored = readProtection(context.deps.db).users[0];
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare(password, stored?.passwordHash ?? "")).toBe(true);
    const base = readFileSync(join(dynamicDir(), "_base.yaml"), "utf8");
    expect(base).toContain(stored?.passwordHash);
    expect(base).not.toContain(password);
  });

  it("records each change, and a failed one, in the Activity log", async () => {
    await setPurpose("staging");

    const { items } = (
      await suite.api<{ items: Array<{ type: string; title: string; status: string; actorEmail?: string }> }>(
        "/actions?limit=50",
      )
    ).body;
    expect(items.find((item) => item.type === "server.purpose")).toMatchObject({
      title: "Set the server's purpose to staging",
      status: "succeeded",
    });
  });

  it("does nothing, and asks for nothing, when the purpose is already the one requested", async () => {
    await setPurpose("staging");

    const { status, body } = await setPurpose("staging");

    expect(status).toBe(200);
    expect(body.credentials).toBeNull();
    const { items } = (await suite.api<{ items: Array<{ type: string }> }>("/actions?limit=50")).body;
    expect(items.filter((item) => item.type === "server.purpose")).toHaveLength(1);
  });

  it("is readable by anyone signed in, but only an administrator at a browser can change it", async () => {
    expect((await suite.api("/server-purpose")).status).toBe(200);
    expect((await context.app.request("/api/v1/server-purpose")).status).toBe(401);
    expect(requirementFor("GET", "/api/v1/server-purpose")).toEqual({ kind: "open" });
    expect(requirementFor("PUT", "/api/v1/server-purpose")).toEqual({ kind: "admin", session: true });
    expect(requirementFor("GET", "/api/v1/server-purpose/users")).toEqual({ kind: "admin", session: true });
    expect(requirementFor("POST", "/api/v1/server-purpose/allowlist")).toEqual({
      kind: "admin",
      session: true,
    });
  });

  it("keeps the previous files and the previous state when a file on disk can't be processed", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    const before = readFileSync(join(dynamicDir(), "shop__web.yaml"), "utf8");
    writeFileSync(join(dynamicDir(), "shop__broken.yaml"), "http: [not: valid");

    const result = await setPurpose("production", "PUBLIC 1");

    // The confirmation counts the readable domains: the failure is the file, not the text.
    expect(result.status).toBe(500);
    expect(apiErrorOf(result).code).toBe("protection_not_applied");
    expect((await stateNow()).purpose).toBe("staging");
    expect(readFileSync(join(dynamicDir(), "shop__web.yaml"), "utf8")).toBe(before);
    const { items } = (
      await suite.api<{ items: Array<{ type: string; status: string }> }>("/actions?limit=50")
    ).body;
    expect(items.find((item) => item.type === "server.purpose" && item.status === "failed")).toBeDefined();
  });

  it("keeps the previous state when the directory can't be written, and stays protected", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    const before = readFileSync(join(dynamicDir(), "shop__web.yaml"), "utf8");
    chmodSync(dynamicDir(), 0o555);

    try {
      const result = await setPurpose("production", "PUBLIC 1");

      expect(result.status).toBe(500);
      expect(apiErrorOf(result).code).toBe("protection_not_applied");
      expect((await stateNow()).purpose).toBe("staging");
      expect(readFileSync(join(dynamicDir(), "shop__web.yaml"), "utf8")).toBe(before);
    } finally {
      chmodSync(dynamicDir(), 0o755);
    }
  });
});

describe("the credentials", () => {
  it("adds a user with a generated password, shown once, and rotates it", async () => {
    await setPurpose("staging");

    const added = await suite.api<ProtectionUserResult>("/server-purpose/users", "POST", {
      username: "alice",
    });
    expect(added.status).toBe(201);
    const first = added.body.credentials?.password ?? "";
    expect(first).toMatch(/^[a-z2-9]{32}$/);

    const rotated = await suite.api<ProtectionUserResult>(
      `/server-purpose/users/${added.body.user.id}`,
      "PUT",
      {},
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.credentials?.password).toMatch(/^[a-z2-9]{32}$/);
    expect(rotated.body.credentials?.password).not.toBe(first);

    const stored = readProtection(context.deps.db).users.find((user) => user.username === "alice");
    expect(await bcrypt.compare(first, stored?.passwordHash ?? "")).toBe(false);
    expect(await bcrypt.compare(rotated.body.credentials?.password ?? "", stored?.passwordHash ?? "")).toBe(
      true,
    );
    expect(readFileSync(join(dynamicDir(), "_base.yaml"), "utf8")).toContain(stored?.passwordHash);
  });

  it("takes a password the owner typed and never returns it", async () => {
    await setPurpose("staging");

    const added = await suite.api<ProtectionUserResult>("/server-purpose/users", "POST", {
      username: "bob",
      password: "twelve chars here",
    });

    expect(added.body.credentials).toBeNull();
  });

  it("refuses a short password and a username the proxy could not hold", async () => {
    await setPurpose("staging");

    const short = await suite.api("/server-purpose/users", "POST", { username: "bob", password: "short" });
    const badName = await suite.api("/server-purpose/users", "POST", { username: "a:b" });

    expect(short.status).toBe(400);
    expect(apiErrorOf(short).fields?.password).toBeDefined();
    expect(badName.status).toBe(400);
    expect(apiErrorOf(badName).fields?.username).toBeDefined();
  });

  it("refuses a duplicate username and removing the last user of a protected server", async () => {
    await setPurpose("staging");
    const { users } = (await suite.api<ProtectionUserList>("/server-purpose/users")).body;

    const duplicate = await suite.api("/server-purpose/users", "POST", { username: "opsifier" });
    expect(duplicate.status).toBe(409);

    const last = await suite.api(`/server-purpose/users/${users[0]?.id}`, "DELETE");
    expect(last.status).toBe(409);
    expect(apiErrorOf(last).code).toBe("protection_last_user");
  });

  it("removes a user and applies it", async () => {
    await setPurpose("staging");
    const added = await suite.api<ProtectionUserResult>("/server-purpose/users", "POST", {
      username: "alice",
    });
    const hash =
      readProtection(context.deps.db).users.find((user) => user.username === "alice")?.passwordHash ?? "";

    const removed = await suite.api(`/server-purpose/users/${added.body.user.id}`, "DELETE");

    expect(removed.status).toBe(200);
    expect(readFileSync(join(dynamicDir(), "_base.yaml"), "utf8")).not.toContain(hash);
  });

  it("is refused on a missing user", async () => {
    expect((await suite.api("/server-purpose/users/nope", "PUT", {})).status).toBe(404);
    expect((await suite.api("/server-purpose/users/nope", "DELETE")).status).toBe(404);
  });

  it("lets a service keep its own users behind the gate", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    await suite.api("/projects/shop/services/web/basic-auth", "POST", {
      username: "owner",
      password: "a long enough secret",
    });

    const web = routingFiles().find(({ file }) => file === "shop__web.yaml");
    const gate = `${GATE_MIDDLEWARE}-https-shop_web-0`;
    expect(web?.http.routers?.["https-shop_web-0"]?.middlewares).toContain(gate);
    const users =
      (web?.http.middlewares?.[gate] as { basicAuth: { users: string[] } } | undefined)?.basicAuth.users ??
      [];
    expect(users.some((user) => user.startsWith("opsifier:"))).toBe(true);
    expect(users.some((user) => user.startsWith("owner:"))).toBe(true);
    expect(web?.http.routers?.["https-shop_web-0"]?.middlewares).toContain("opsifier-auth-shop_web");
  });

  it("re-renders every file when the credentials change", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    await suite.api("/projects/shop/services/web/basic-auth", "POST", {
      username: "owner",
      password: "a long enough secret",
    });
    const { users } = (await suite.api<ProtectionUserList>("/server-purpose/users")).body;

    await suite.api(`/server-purpose/users/${users[0]?.id}`, "PUT", { password: "another long secret" });

    const hash = readProtection(context.deps.db).users[0]?.passwordHash ?? "";
    expect(readFileSync(join(dynamicDir(), "shop__web.yaml"), "utf8")).toContain(hash);
    expect(readFileSync(join(dynamicDir(), "_base.yaml"), "utf8")).toContain(hash);
  });
});

describe("the allowlist", () => {
  beforeEach(async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
  });

  const add = (body: Record<string, unknown>) =>
    suite.api<AllowlistEntry>("/server-purpose/allowlist", "POST", {
      project: "shop",
      service: "web",
      ...body,
    });

  it("adds a route that skips the gate but keeps the header, and records it", async () => {
    const created = await add({ kind: "path", value: "/healthz" });

    expect(created.status).toBe(201);
    const web = routingFiles().find(({ file }) => file === "shop__web.yaml");
    const exempt = Object.entries(web?.http.routers ?? {}).find(([name]) =>
      name.startsWith("opsifier-protect-exempt-https"),
    )?.[1];
    expect(exempt?.rule).toContain("Path(`/healthz`)");
    expect(exempt?.middlewares?.[0]).toBe(NOINDEX_MIDDLEWARE);
    expect(gated(exempt as Router)).toBe(false);

    const { items } = (
      await suite.api<{ items: Array<{ type: string; title: string }> }>("/actions?limit=50")
    ).body;
    expect(items.find((item) => item.type === "server.allowlist")?.title).toBe(
      "Exempt /healthz on shop/web from the server's protection",
    );
  });

  it("lists entries and what they can be added to", async () => {
    await add({ kind: "ip", value: "203.0.113.0/24" });

    const { body } = await suite.api<AllowlistState>("/server-purpose/allowlist");
    expect(body.entries).toMatchObject([
      { kind: "ip", value: "203.0.113.0/24", project: "shop", service: "web" },
    ]);
    expect(body.services).toContainEqual({ project: "shop", service: "web" });
  });

  it("removes an entry and the route with it", async () => {
    const created = await add({ kind: "path", value: "/healthz" });

    const removed = await suite.api(`/server-purpose/allowlist/${created.body.id}`, "DELETE");

    expect(removed.status).toBe(200);
    expect(allRouters().some(({ name }) => name.startsWith("opsifier-protect-exempt-"))).toBe(false);
  });

  it.each([
    ["path", "/"],
    ["path", "/*"],
    ["path", "healthz"],
    ["path", "/a/../b"],
    ["path", "/a//b"],
    ["path", "/a`)||Host(`b"],
    ["path", "/a b"],
    ["path", "/a%2fb"],
    ["path", "/robots.txt"],
    ["ip", "0.0.0.0/0"],
    ["ip", "::/0"],
    ["ip", "10.1.2.3/8"],
    ["ip", "203.0.113.0/33"],
    ["ip", "1.2.3.4/7"],
    ["ip", "999.1.1.1"],
    ["ip", "01.2.3.4"],
    ["ip", "1.2.3.4/08"],
    ["ip", "::ffff:1.2.3.4"],
    ["ip", "2001:db8::/20"],
    ["ip", "2001:db8::1/64"],
    ["ip", "not-an-ip"],
    ["ip", ""],
  ])("refuses the %s entry %s", async (kind, value) => {
    const result = await add({ kind, value });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.value).toBeDefined();
    expect(allRouters().some(({ name }) => name.startsWith("opsifier-protect-exempt-"))).toBe(false);
  });

  it.each([
    ["path", "/healthz"],
    ["path", "/hooks/*"],
    ["path", "/.well-known/thing"],
    ["ip", "203.0.113.7"],
    ["ip", "203.0.113.0/24"],
    ["ip", "10.0.0.0/8"],
    ["ip", "2001:db8::/32"],
    ["ip", "2001:db8::1"],
  ])("accepts the %s entry %s", async (kind, value) => {
    expect((await add({ kind, value })).status).toBe(201);
  });

  it("refuses an entry for a service that does not exist", async () => {
    const result = await suite.api("/server-purpose/allowlist", "POST", {
      project: "shop",
      service: "ghost",
      kind: "path",
      value: "/x",
    });

    expect(result.status).toBe(404);
  });

  it("refuses the same entry twice", async () => {
    await add({ kind: "path", value: "/x" });

    expect((await add({ kind: "path", value: "/x" })).status).toBe(409);
  });

  it("drops a service's exemptions when the service goes away", async () => {
    await add({ kind: "path", value: "/x" });

    await context.deps.proxy.removeService("shop", "web");

    expect(readProtection(context.deps.db).allowlist).toEqual([]);
  });
});

describe("the protection report", () => {
  it("reports a route whose file was changed by hand as exposed, ahead of the others", async () => {
    await setPurpose("staging");
    await suite.api("/projects/shop/services", "POST", { name: "web" });
    await suite.api("/projects/shop/services", "POST", { name: "api" });
    const file = join(dynamicDir(), "shop__web.yaml");
    const edited = parse(readFileSync(file, "utf8")) as { http: { routers: Record<string, Router> } };
    for (const router of Object.values(edited.http.routers)) {
      router.middlewares = [];
    }
    writeFileSync(file, JSON.stringify(edited));

    const state = await stateNow();

    expect(state.protectedCount).toBe(1);
    expect(state.totalCount).toBe(2);
    expect(state.domains[0]?.status).toBe("exposed");
    expect(state.domains[0]?.service).toBe("web");
    expect(state.domains[1]?.status).toBe("protected");
  });

  it("treats every domain as public on production", async () => {
    await suite.api("/projects/shop/services", "POST", { name: "web" });

    expect(await stateNow()).toMatchObject({
      protection: false,
      protectedCount: 0,
      totalCount: 1,
      problems: [],
    });
  });
});

describe("the guard", () => {
  it("is the only thing in the code that writes into the proxy's directory", async () => {
    const root = join(__dirname, "..", "..");
    const nodeFs = await import("node:fs");
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of nodeFs.readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          const text = nodeFs.readFileSync(path, "utf8");
          if (
            /traefikDynamicDir|traefik\/dynamic/.test(text) &&
            !path.endsWith(join("core", "config", "index.ts")) &&
            !path.endsWith("runtime.ts") &&
            !path.endsWith(join("testing", "harness.ts"))
          ) {
            offenders.push(path.replace(root, ""));
          }
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });

  it("passes every write through the guard even for a route the compilers never saw", async () => {
    await setPurpose("staging");

    await context.deps.proxy.writeOwnFile("_added.yaml", {
      http: {
        routers: { added: { rule: "Host(`added.example.test`)", service: "s", entryPoints: ["web"] } },
      },
    });

    expect(existsSync(join(dynamicDir(), "_added.yaml"))).toBe(true);
    const added = parse(readFileSync(join(dynamicDir(), "_added.yaml"), "utf8")) as {
      http: { routers: Record<string, Router> };
    };
    expect(gated(added.http.routers.added as Router)).toBe(true);
  });
});
