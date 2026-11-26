import type { ActionEntry, DomainList, SystemInfo } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { actions } from "../../core/db/schema";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  setupTokenOf,
  TEST_EMAIL,
  TEST_NAME,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { getSetting, putSetting } from "../system/repo";
import { SERVER_IP_KEY } from "../system/service";
import { ipOfHostHeader } from "./host";

let context: TestContext | undefined;

/** The context the test started. */
function current(): TestContext {
  if (context === undefined) {
    throw new Error("start() first");
  }
  return context;
}

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function start(env: Record<string, string> = {}, stored: string | null = "172.31.5.9") {
  context = await createTestContext({ env });
  if (stored !== null) {
    putSetting(context.deps.db, SERVER_IP_KEY, stored, new Date());
  }
  return context;
}

/** Claims the panel the way the owner's browser does, at the address typed in its address bar. */
async function claimAt(origin: string) {
  if (context === undefined) {
    throw new Error("start() first");
  }
  const result = await call(context.app, `${origin}/api/v1/auth/setup`, {
    method: "POST",
    origin,
    body: { token: setupTokenOf(context.app), name: TEST_NAME, email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(result.status).toBe(201);
  return result.cookie ?? "";
}

const storedIp = () => (context === undefined ? null : getSetting(context.deps.db, SERVER_IP_KEY));

describe("the IP a Host header names", () => {
  it.each([
    ["34.240.101.95", "34.240.101.95"],
    ["34.240.101.95:3000", "34.240.101.95"],
    ["[2a01:4f8:c17:1::1]:3000", "2a01:4f8:c17:1::1"],
    ["[2a01:4f8:c17:1::1]", "2a01:4f8:c17:1::1"],
    ["panel.34.240.101.95.sslip.io", null],
    ["localhost:3000", null],
    ["", null],
    [undefined, null],
    ["34.240.101.95:3000:1", null],
    ["999.1.1.1", null],
  ])("%s → %s", (header, ip) => {
    expect(ipOfHostHeader(header)).toBe(ip);
  });
});

describe("the address the panel is claimed at", () => {
  it("becomes the server's address when the server only knew a private one, and generated names follow it", async () => {
    await start();
    const cookie = await claimAt("http://34.240.101.95:3000");

    expect(storedIp()).toBe("34.240.101.95");
    const info = await call<SystemInfo>(current().app, "/api/v1/system/info", { cookie });
    expect(info.body.serverIp).toBe("34.240.101.95");
    const entry = current().deps.db.select().from(actions).where(eq(actions.type, "server.set-ip")).get();
    expect(entry?.actorEmail).toBe(TEST_EMAIL);
    expect(entry?.title).toBe("Server address is now 34.240.101.95, the address the panel was opened at");

    const api = (method: string, path: string, body?: unknown) =>
      call(current().app, path, { method, cookie, body, origin: TEST_ORIGIN });
    await api("POST", "/api/v1/projects", { name: "shop" });
    await api("POST", "/api/v1/projects/shop/services", { name: "web" });
    const domains = await call<DomainList>(current().app, "/api/v1/projects/shop/services/web/domains", {
      cookie,
    });
    expect(domains.body.domains.map((domain) => domain.host)).toContain("shop-web.34.240.101.95.sslip.io");
  });

  it("takes a public IPv6 address too, and a server that knew none", async () => {
    await start({}, null);
    current().deps.db.delete(actions).run();
    await claimAt("http://[2a01:4f8:c17:1::1]:3000");
    expect(storedIp()).toBe("2a01:4f8:c17:1::1");
  });

  it("keeps an address the server already knew to be public", async () => {
    await start({}, "52.17.1.2");
    await claimAt("http://34.240.101.95:3000");
    expect(storedIp()).toBe("52.17.1.2");
  });

  it("ignores a private, loopback or named address, and one the configuration sets", async () => {
    for (const origin of ["http://10.0.0.5:3000", "http://127.0.0.1:3000", "http://panel.example.com"]) {
      await start();
      await claimAt(origin);
      expect(storedIp(), origin).toBe("172.31.5.9");
      await current().close();
      context = undefined;
    }

    await start({ OPSIFIER_SERVER_IP: "192.168.1.20" }, null);
    await claimAt("http://34.240.101.95:3000");
    expect(storedIp()).toBe("192.168.1.20");
  });
});

describe("setting the server's address by hand", () => {
  it("moves generated names, and leaves custom ones alone", async () => {
    await start();
    const cookie = await setupAdmin(current().app);
    const api = <T = unknown>(method: string, path: string, body?: unknown) =>
      call<T>(current().app, path, { method, cookie, body, origin: TEST_ORIGIN });
    await api("POST", "/api/v1/projects", { name: "shop" });
    await api("POST", "/api/v1/projects/shop/services", { name: "web" });
    await api("POST", "/api/v1/projects/shop/services/web/domains", { host: "shop.example.com" });

    const set = await api<ActionEntry>("PUT", "/api/v1/server/panel/ip", { ip: "34.240.101.95" });
    expect(set.status).toBe(200);
    expect(set.body.title).toBe("Server address is now 34.240.101.95");
    const listed = await api<DomainList>("GET", "/api/v1/projects/shop/services/web/domains");
    expect(listed.body.domains.map((domain) => domain.host).sort()).toEqual([
      "shop-web.34.240.101.95.sslip.io",
      "shop.example.com",
    ]);

    const again = await api<ActionEntry>("PUT", "/api/v1/server/panel/ip", { ip: "34.240.101.95" });
    expect(again.body.title).toBe("Server address is still 34.240.101.95");
  });

  it("writes an address one way, and makes valid names from an IPv6 /64 written without its length", async () => {
    await start();
    const cookie = await setupAdmin(current().app);
    const api = <T = unknown>(method: string, path: string, body?: unknown) =>
      call<T>(current().app, path, { method, cookie, body, origin: TEST_ORIGIN });
    await api("POST", "/api/v1/projects", { name: "shop" });
    await api("POST", "/api/v1/projects/shop/services", { name: "web" });

    expect((await api("PUT", "/api/v1/server/panel/ip", { ip: "2A01:04F8:0000::1" })).status).toBe(200);
    expect(storedIp()).toBe("2a01:4f8::1");

    const set = await api<ActionEntry>("PUT", "/api/v1/server/panel/ip", { ip: "2a01:4f8:c17:1::" });
    expect(set.status).toBe(200);
    const listed = await api<DomainList>("GET", "/api/v1/projects/shop/services/web/domains");
    expect(listed.body.domains.map((domain) => domain.host)).toEqual(["shop-web.2a01-4f8-c17-1--0.sslip.io"]);
    // The panel's own name is valid too: it starts again.
    await current().restart();
  });

  it("refuses an address nobody reaches a server on", async () => {
    await start();
    const cookie = await setupAdmin(current().app);
    for (const ip of [
      "0.0.0.0",
      "::",
      "127.0.0.1",
      "::1",
      "224.0.0.1",
      "255.255.255.255",
      "169.254.1.1",
      "::ffff:1.2.3.4",
    ]) {
      const refused = await call(current().app, "/api/v1/server/panel/ip", {
        method: "PUT",
        cookie,
        origin: TEST_ORIGIN,
        body: { ip },
      });
      expect(refused.status, ip).toBe(400);
      expect(apiErrorOf(refused).fields?.ip, ip).toMatch(/Nobody can reach a server on this address/);
    }
    expect(storedIp()).toBe("172.31.5.9");
  });

  it("keeps a public address when the server only finds a private one again", async () => {
    await start();
    const cookie = await setupAdmin(current().app);
    const api = <T = unknown>(method: string, path: string, body?: unknown) =>
      call<T>(current().app, path, { method, cookie, body, origin: TEST_ORIGIN });
    await api("PUT", "/api/v1/server/panel/ip", { ip: "34.240.101.95" });

    // The fake Swarm says 203.0.113.10, a range no one outside reaches, as a cloud server's own interface.
    const refreshed = await api<ActionEntry>("POST", "/api/v1/server/panel/refresh-ip");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.title).toBe(
      "Server address is still 34.240.101.95: the server only sees 203.0.113.10, a private address",
    );
    expect(storedIp()).toBe("34.240.101.95");
  });

  it("refuses what is not an IP, and an address the configuration sets", async () => {
    await start();
    let cookie = await setupAdmin(current().app);
    const invalid = await call(current().app, "/api/v1/server/panel/ip", {
      method: "PUT",
      cookie,
      origin: TEST_ORIGIN,
      body: { ip: "my-server.example.com" },
    });
    expect(invalid.status).toBe(400);
    expect(apiErrorOf(invalid).fields?.ip).toBe("Enter an IPv4 or IPv6 address");

    await current().close();
    await start({ OPSIFIER_SERVER_IP: "192.168.1.20" }, null);
    cookie = await setupAdmin(current().app);
    const configured = await call(current().app, "/api/v1/server/panel/ip", {
      method: "PUT",
      cookie,
      origin: TEST_ORIGIN,
      body: { ip: "34.240.101.95" },
    });
    expect(configured.status).toBe(409);
    expect(apiErrorOf(configured).code).toBe("server_address_configured");
    expect(storedIp()).toBe("192.168.1.20");
  });
});
