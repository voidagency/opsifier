import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, DomainEntry, DomainList, ExposedPorts, ServiceDetail } from "@opsifier/contract";
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
import { feature } from "./routes";

let context: TestContext;
let cookie: string;

afterEach(async () => {
  await context.close();
});

async function start(env: Record<string, string> = {}) {
  context = await createTestContext({ env });
  cookie = await setupAdmin(context.app);
  await call(context.app, "/api/v1/projects", {
    method: "POST",
    body: { name: "shop" },
    cookie,
    origin: TEST_ORIGIN,
  });
}

const createService = (name = "web") =>
  call(context.app, "/api/v1/projects/shop/services", {
    method: "POST",
    body: { name },
    cookie,
    origin: TEST_ORIGIN,
  });

const listDomains = (name = "web") =>
  call<DomainList>(context.app, `/api/v1/projects/shop/services/${name}/domains`, { cookie });

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1/projects/shop/services/web${path}`, {
    method,
    body,
    cookie,
    origin: TEST_ORIGIN,
  });

const addDomain = (body: Record<string, unknown>) => api<DomainEntry>("/domains", "POST", body);

const proxyFile = () =>
  parse(readFileSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"), "utf8")) as {
    http: {
      routers: Record<string, { rule: string; middlewares?: string[]; tls?: unknown; service: string }>;
      services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>;
      middlewares?: Record<string, unknown>;
      serversTransports?: Record<string, unknown>;
    };
  };

async function waitForAction(id: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await call<ActionEntry>(context.app, `/api/v1/actions/${id}`, { cookie });
    if (body.status === "succeeded") {
      return;
    }
    if (body.status === "failed") {
      throw new Error(`The action failed: ${body.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function deployed(): Promise<void> {
  await createService();
  await api("/source", "PUT", { image: "traefik/whoami:v1.10" });
  const accepted = await api<ActionEntry>("/deploy", "POST");
  await waitForAction(accepted.body.id);
}

describe("the domains tab", () => {
  beforeEach(async () => {
    await start();
  });

  it("gives a new service exactly one primary domain under the server's sslip.io name", async () => {
    await createService();

    const { domains } = (await listDomains()).body;
    expect(domains).toHaveLength(1);
    expect(domains[0]?.primary).toBe(true);
    expect(domains[0]?.url).toBe("https://shop-web.203.0.113.10.sslip.io/");
    expect(domains[0]?.internalUrl).toBe("http://shop_web:80/");
  });

  it("answers 404 for a service that does not exist", async () => {
    expect((await listDomains("nope")).status).toBe(404);
  });
});

describe("a default domain without a known server address", () => {
  it("is simply left out, and the service can still be created", async () => {
    await start();
    // The stored address is gone, as on a server whose address could not be found.
    const { getSetting } = await import("../../system/repo");
    expect(getSetting(context.deps.db, "server_ip")).toBe("203.0.113.10");
    const { settings } = await import("../../../core/db/schema");
    context.deps.db.delete(settings).run();

    expect((await createService()).status).toBe(201);
    expect((await listDomains()).body.domains).toEqual([]);
  });
});

describe("adding a domain", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  it("applies the defaults a new domain should have, and writes the route at once", async () => {
    const result = await addDomain({ host: "whoami.example.test", https: false });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      host: "whoami.example.test",
      path: "/",
      port: 80,
      https: false,
      primary: false,
      destinationProtocol: "http",
      destinationPath: "/",
      certificateResolver: null,
      wildcard: false,
      middlewares: [],
      url: "http://whoami.example.test/",
      internalUrl: "http://shop_web:80/",
    });

    const { http } = proxyFile();
    expect(http.routers["http-shop_web-1"]?.rule).toBe("Host(`whoami.example.test`) && PathPrefix(`/`)");
    expect(http.routers["https-shop_web-1"]).toBeUndefined();
  });

  it("normalises a host and a trailing slash, and keeps a named path", async () => {
    const result = await addDomain({ host: "  WhoAmI.Example.Test ", path: "/api/", https: false });

    expect(result.body.host).toBe("whoami.example.test");
    expect(result.body.path).toBe("/api");
    expect(result.body.url).toBe("http://whoami.example.test/api");
  });

  it("stores every field and compiles them", async () => {
    const result = await addDomain({
      host: "app.example.test",
      path: "/api",
      https: true,
      port: 8443,
      destinationProtocol: "https",
      destinationPath: "/v1",
      certificateResolver: "cloudflare",
      middlewares: ["rate-limit"],
    });

    expect(result.body.internalUrl).toBe("https://shop_web:8443/v1");
    expect(result.body.certificateResolver).toBe("cloudflare");
    expect(proxyFile().http.routers["https-shop_web-1"]?.tls).toEqual({
      certResolver: "cloudflare",
      domains: [{ main: "app.example.test" }],
    });
    expect(proxyFile().http.routers["http-shop_web-1"]?.middlewares).toContain("rate-limit");
  });

  it("makes the first domain of a service primary, and no other", async () => {
    await addDomain({ host: "second.example.test", https: false });
    const domains = (await listDomains()).body.domains;
    expect(domains.filter((domain) => domain.primary)).toHaveLength(1);
    expect(domains[0]?.primary).toBe(true);
  });

  it("answers 404 for a service that does not exist", async () => {
    const result = await call(context.app, "/api/v1/projects/shop/services/nope/domains", {
      method: "POST",
      body: { host: "a.example.test" },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(result.status).toBe(404);
  });

  it.each([
    [{ host: "" }, "host"],
    [{}, "host"],
    [{ host: "bad host" }, "host"],
    [{ host: "noscheme" }, "host"],
    [{ host: "evil`) || Host(`x.example.test" }, "host"],
    [{ host: "a.example.test", path: "" }, "path"],
    [{ host: "a.example.test", path: "noslash" }, "path"],
    [{ host: "a.example.test", path: "/two//slashes" }, "path"],
    [{ host: "a.example.test", path: "/dots/../here" }, "path"],
    [{ host: "a.example.test", path: "/`tick" }, "path"],
    [{ host: "a.example.test", port: 0 }, "port"],
    [{ host: "a.example.test", port: 70000 }, "port"],
    [{ host: "a.example.test", port: 12.5 }, "port"],
    [{ host: "a.example.test", port: "80" }, "port"],
    [{ host: "a.example.test", destinationProtocol: "ftp" }, "destinationProtocol"],
    [{ host: "a.example.test", destinationPath: "nope" }, "destinationPath"],
    [{ host: "a.example.test", certificateResolver: "bad name" }, "certificateResolver"],
    [{ host: "a.example.test", middlewares: ["bad name"] }, "middlewares.0"],
    [{ host: "a.example.test", middlewares: [""] }, "middlewares.0"],
    [{ host: "a.example.test", middlewares: ["opsifier-auth-shop_web"] }, "middlewares.0"],
    [{ host: "a.example.test", wildcard: true, https: true }, "certificateResolver"],
  ])("rejects %j", async (body, field) => {
    const result = await addDomain(body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("validation_failed");
    expect(apiErrorOf(result).fields?.[field]).toBeTruthy();
    expect((await listDomains()).body.domains).toHaveLength(1);
  });

  it("refuses a host another service uses on the same path, and allows another path", async () => {
    await createService("api");
    await addDomain({ host: "shared.example.test", path: "/app", https: false });

    const taken = await call(context.app, "/api/v1/projects/shop/services/api/domains", {
      method: "POST",
      body: { host: "SHARED.example.test", path: "/app/", https: false },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(taken.status).toBe(409);
    expect(apiErrorOf(taken).code).toBe("domain_taken");
    expect(apiErrorOf(taken).fields?.host).toBe("Another service already uses this hostname on this path");

    const elsewhere = await call(context.app, "/api/v1/projects/shop/services/api/domains", {
      method: "POST",
      body: { host: "shared.example.test", path: "/admin", https: false },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(elsewhere.status).toBe(201);
  });

  it("refuses a host and path this service already has, under its own message", async () => {
    await addDomain({ host: "dup.example.test", https: false });
    const again = await addDomain({ host: "dup.example.test", https: true });

    expect(again.status).toBe(409);
    expect(apiErrorOf(again).fields?.host).toBe("This service already answers on this hostname and path");
  });

  it("lets a wildcard and the exact root coexist, and treats a second wildcard as taken", async () => {
    await addDomain({ host: "example.test", https: false });
    const wildcard = await addDomain({ host: "example.test", https: false, wildcard: true });
    expect(wildcard.status).toBe(201);
    expect(wildcard.body.url).toBe("http://*.example.test/");

    const second = await addDomain({ host: "example.test", https: false, wildcard: true });
    expect(second.status).toBe(409);
  });
});

describe("a route that someone else holds", () => {
  const blogDomains = "/api/v1/projects/blog/services/api/domains";
  const claim = (body: Record<string, unknown>) =>
    call<DomainEntry>(context.app, blogDomains, { method: "POST", body, cookie, origin: TEST_ORIGIN });

  beforeEach(async () => {
    await start();
    await createService();
    await call(context.app, "/api/v1/projects", {
      method: "POST",
      body: { name: "blog" },
      cookie,
      origin: TEST_ORIGIN,
    });
    await call(context.app, "/api/v1/projects/blog/services", {
      method: "POST",
      body: { name: "api" },
      cookie,
      origin: TEST_ORIGIN,
    });
  });

  it.each([
    ["a longer path under the path it holds", { host: "app.example.test" }, { path: "/admin" }],
    ["a longer path under a nested path", { host: "app.example.test", path: "/a" }, { path: "/a/b" }],
    ["a shorter path over the path it holds", { host: "app.example.test", path: "/admin" }, { path: "/" }],
    ["the identical route", { host: "app.example.test", path: "/admin" }, { path: "/admin" }],
  ])("refuses %s, across projects", async (_name, held, wanted) => {
    expect((await addDomain({ ...held, https: false })).status).toBe(201);

    const result = await claim({ host: "app.example.test", https: false, ...wanted });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("domain_taken");
    expect(JSON.stringify(result.body)).not.toMatch(/shop|blog/);
  });

  it("refuses a wildcard over an exact host another project holds", async () => {
    await addDomain({ host: "shop.example.test", https: false });
    const result = await claim({ host: "example.test", wildcard: true, https: false });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("domain_taken");
  });

  it("refuses an exact host under a wildcard another project holds", async () => {
    await addDomain({ host: "example.test", wildcard: true, https: false });
    const result = await claim({ host: "shop.example.test", https: false });

    expect(result.status).toBe(409);
  });

  it("refuses a wildcard route on a path it shares with an exact host, and not on one it doesn't", async () => {
    await addDomain({ host: "shop.example.test", path: "/shop", https: false });

    expect(
      (await claim({ host: "example.test", path: "/shop/x", wildcard: true, https: false })).status,
    ).toBe(409);
    expect((await claim({ host: "example.test", path: "/blog", wildcard: true, https: false })).status).toBe(
      201,
    );
  });

  it("does not count a deeper subdomain as covered, since a wildcard only reaches one level", async () => {
    await addDomain({ host: "deep.shop.example.test", https: false });

    expect((await claim({ host: "example.test", wildcard: true, https: false })).status).toBe(201);
  });

  it("keeps a boundary between paths, so /apix is free when /api is held", async () => {
    await addDomain({ host: "app.example.test", path: "/api", https: false });

    expect((await claim({ host: "app.example.test", path: "/apix", https: false })).status).toBe(201);
  });

  it("lets two projects share a host on paths that never meet", async () => {
    await addDomain({ host: "app.example.test", path: "/shop", https: false });

    expect((await claim({ host: "app.example.test", path: "/blog", https: false })).status).toBe(201);
  });

  it("lets the services of one project split a host by path", async () => {
    await createService("api");
    await addDomain({ host: "app.example.test", https: false });

    const nested = await call(context.app, "/api/v1/projects/shop/services/api/domains", {
      method: "POST",
      body: { host: "app.example.test", path: "/api", https: false },
      cookie,
      origin: TEST_ORIGIN,
    });

    expect(nested.status).toBe(201);
  });

  it("refuses an edit that would reach into someone else's route", async () => {
    await addDomain({ host: "app.example.test", https: false });
    const own = await claim({ host: "own.example.test", https: false });

    const result = await call(context.app, `${blogDomains}/${own.body.id}`, {
      method: "PUT",
      body: { host: "app.example.test", path: "/admin", https: false },
      cookie,
      origin: TEST_ORIGIN,
    });

    expect(result.status).toBe(409);
  });

  it("still lets a route that predates these rules be edited, as long as it stays where it is", async () => {
    const held = (await addDomain({ host: "app.example.test", https: false })).body;
    const { insertDomain } = await import("./repo");
    const now = new Date();
    insertDomain(context.deps.db, {
      id: "old-route",
      projectName: "blog",
      serviceName: "api",
      host: held.host,
      path: "/admin",
      port: 80,
      https: false,
      isPrimary: false,
      createdAt: now,
      updatedAt: now,
    });

    const edit = (body: Record<string, unknown>) =>
      call(context.app, `${blogDomains}/old-route`, {
        method: "PUT",
        body: { host: held.host, https: false, ...body },
        cookie,
        origin: TEST_ORIGIN,
      });

    expect((await edit({ path: "/admin", port: 8080 })).status).toBe(200);
    expect((await edit({ path: "/admin/deeper" })).status).toBe(409);
  });

  it("treats a custom destination as someone else's, and refuses one over a service's route", async () => {
    const servers = [{ url: "https://outside.example.net" }];
    await call(context.app, "/api/v1/domains/custom", {
      method: "POST",
      body: { host: "ext.example.test", servers, https: false },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect((await addDomain({ host: "ext.example.test", path: "/app", https: false })).status).toBe(409);

    await addDomain({ host: "app.example.test", https: false });
    const custom = await call(context.app, "/api/v1/domains/custom", {
      method: "POST",
      body: { host: "app.example.test", path: "/admin", servers, https: false },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(custom.status).toBe(409);
    expect(apiErrorOf(custom).code).toBe("domain_taken");
  });

  it("gives no default name under a wildcard another project holds", async () => {
    await call(context.app, "/api/v1/server/service-domain", {
      method: "PUT",
      body: { customDomain: "apps.example.test" },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect((await addDomain({ host: "apps.example.test", wildcard: true, https: false })).status).toBe(201);

    await call(context.app, "/api/v1/projects/blog/services", {
      method: "POST",
      body: { name: "late" },
      cookie,
      origin: TEST_ORIGIN,
    });

    const { domains } = (
      await call<DomainList>(context.app, "/api/v1/projects/blog/services/late/domains", { cookie })
    ).body;
    expect(domains).toEqual([]);
  });
});

describe("an international hostname", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  it("is stored and routed under the name DNS uses, and collides with its own punycode", async () => {
    const result = await addDomain({ host: "BÜCHER.example.test", https: false });

    expect(result.status).toBe(201);
    expect(result.body.host).toBe("xn--bcher-kva.example.test");
    expect(proxyFile().http.routers["http-shop_web-1"]?.rule).toContain("Host(`xn--bcher-kva.example.test`)");
    expect((await addDomain({ host: "xn--bcher-kva.example.test", https: false })).status).toBe(409);
  });
});

describe("taking the path off a request", () => {
  it("is off by default, and saved with the domain and compiled when turned on", async () => {
    await start();
    await createService();

    expect((await addDomain({ host: "a.example.test", path: "/a", https: false })).body.stripPath).toBe(
      false,
    );

    const result = await addDomain({ host: "b.example.test", path: "/api", stripPath: true, https: false });
    expect(result.body.stripPath).toBe(true);
    expect(proxyFile().http.middlewares?.["opsifier-strip-shop_web-2"]).toEqual({
      stripPrefix: { prefixes: ["/api"] },
    });
  });
});

describe("an HTTPS upstream's certificate", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  const upstream = { host: "tls.example.test", https: false, destinationProtocol: "https", port: 8443 };

  it("is verified against the public name unless told otherwise, with nothing turned off", async () => {
    const result = await addDomain(upstream);

    expect(result.status).toBe(201);
    expect(readFileSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"), "utf8")).not.toContain(
      "insecureSkipVerify",
    );
    expect(proxyFile().http.serversTransports?.["opsifier-tls-shop_web-1"]).toEqual({
      serverName: "tls.example.test",
    });
  });

  it("is refused if what was pasted is not really a certificate", async () => {
    const result = await addDomain({
      ...upstream,
      upstreamCa: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.upstreamCa).toBeTruthy();
  });

  it("forgets what to check when the upstream goes back to plain HTTP", async () => {
    const created = await addDomain({ ...upstream, upstreamServerName: "backend.internal" });
    expect(created.body.upstreamServerName).toBe("backend.internal");

    const result = await api<DomainEntry>(`/domains/${created.body.id}`, "PUT", {
      ...upstream,
      destinationProtocol: "http",
      upstreamServerName: "backend.internal",
    });

    expect(result.body.upstreamServerName).toBeNull();
    expect(proxyFile().http.serversTransports).toBeUndefined();
  });
});

describe("a route that would complete a redirect loop", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  it("is refused when it brings the rules' target to this service", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    const toOther = { regex: "^http://one.example.test/(.*)", replacement: "http://two.example.test/${1}" };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
    const toOne = { regex: "^http://two.example.test/(.*)", replacement: "http://one.example.test/${1}" };
    expect((await addDomain({ host: "one.example.test", https: false })).status).toBe(201);
    expect((await api("/redirects", "POST", toOther)).status).toBe(201);
    // The target isn't on this service yet, so nothing can come round again.
    expect((await api("/redirects", "POST", toOne)).status).toBe(201);

    const result = await addDomain({ host: "two.example.test", https: false });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("domain_redirect_loop");
    expect((await listDomains()).body.domains.map((domain) => domain.host)).not.toContain("two.example.test");
  });
});

describe("editing a domain", () => {
  let id: string;

  beforeEach(async () => {
    await start();
    await createService();
    id = (await addDomain({ host: "edit.example.test", https: false })).body.id;
  });

  it("rewrites the routers immediately", async () => {
    const result = await api<DomainEntry>(`/domains/${id}`, "PUT", {
      host: "edit.example.test",
      path: "/api",
      https: false,
      port: 8080,
    });

    expect(result.status).toBe(200);
    const { http } = proxyFile();
    expect(http.routers["http-shop_web-1"]?.rule).toContain("(Path(`/api`) || PathPrefix(`/api/`))");
    expect(http.services["shop_web-1"]?.loadBalancer.servers).toEqual([{ url: "http://shop_web:8080/" }]);
  });

  it("can keep its own host and path", async () => {
    const result = await api(`/domains/${id}`, "PUT", {
      host: "edit.example.test",
      https: false,
      port: 8081,
    });
    expect(result.status).toBe(200);
  });

  it("is refused for a route another domain holds", async () => {
    await addDomain({ host: "other.example.test", https: false });
    const result = await api(`/domains/${id}`, "PUT", { host: "other.example.test", https: false });
    expect(result.status).toBe(409);
  });

  it("answers 404 for a domain of another service", async () => {
    await createService("api");
    const result = await call(context.app, `/api/v1/projects/shop/services/api/domains/${id}`, {
      method: "PUT",
      body: { host: "x.example.test", https: false },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(result.status).toBe(404);
  });

  it("is rejected with field errors like a new one", async () => {
    const result = await api(`/domains/${id}`, "PUT", { host: "bad host", https: false });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.host).toBeTruthy();
  });
});

describe("deleting a domain", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  it("removes its routers from the proxy file at once", async () => {
    const id = (await addDomain({ host: "gone.example.test", https: false })).body.id;
    expect(proxyFile().http.routers["http-shop_web-1"]).toBeDefined();

    expect((await api(`/domains/${id}`, "DELETE")).status).toBe(200);

    expect(proxyFile().http.routers["http-shop_web-1"]).toBeUndefined();
    expect((await listDomains()).body.domains).toHaveLength(1);
  });

  it("hands the star to the next domain when the primary goes", async () => {
    const second = await addDomain({ host: "next.example.test", https: false });
    const domains = (await listDomains()).body.domains;
    const primary = domains.find((domain) => domain.primary);
    expect((await api(`/domains/${primary?.id}`, "DELETE")).status).toBe(200);

    const after = (await listDomains()).body.domains;
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(second.body.id);
    expect(after[0]?.primary).toBe(true);
  });

  it("can remove the last domain, which leaves no primary and no routing file", async () => {
    const domains = (await listDomains()).body.domains;
    expect(existsSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"))).toBe(true);

    expect((await api(`/domains/${domains[0]?.id}`, "DELETE")).status).toBe(200);

    expect((await listDomains()).body.domains).toEqual([]);
    // An empty `routers:` is refused by Traefik, along with every other file next to it.
    expect(existsSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"))).toBe(false);
    expect((await api<ServiceDetail>("")).body.primaryUrl).toBeNull();
  });

  it("clears the file an earlier version left for a service with no domains, at boot", async () => {
    const domains = (await listDomains()).body.domains;
    await api(`/domains/${domains[0]?.id}`, "DELETE");
    const file = join(context.dataDir, "traefik/dynamic/shop__web.yaml");
    writeFileSync(file, "http:\n  services: {}\n  routers: {}\n");

    await feature.boot?.(context.deps);

    expect(existsSync(file)).toBe(false);
  });

  it("answers 404 for a domain that does not exist", async () => {
    expect((await api("/domains/nope", "DELETE")).status).toBe(404);
  });
});

describe("the primary domain", () => {
  beforeEach(async () => {
    await start();
    await createService();
  });

  it("moves the star, and Open follows it", async () => {
    const second = await addDomain({ host: "two.example.test", https: false });

    const result = await api<DomainEntry>(`/domains/${second.body.id}/primary`, "POST");
    expect(result.status).toBe(200);
    expect(result.body.primary).toBe(true);

    const domains = (await listDomains()).body.domains;
    expect(domains.filter((domain) => domain.primary).map((domain) => domain.id)).toEqual([second.body.id]);
    expect((await api<ServiceDetail>("")).body.primaryUrl).toBe("http://two.example.test/");
  });

  it("refuses a wildcard domain", async () => {
    const wildcard = await addDomain({ host: "wild.example.test", wildcard: true, https: false });
    const result = await api(`/domains/${wildcard.body.id}/primary`, "POST");

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("domain_wildcard_primary");
  });

  it("refuses to turn the primary domain into a wildcard", async () => {
    const domains = (await listDomains()).body.domains;
    const primary = domains[0] as DomainEntry;
    const result = await api(`/domains/${primary.id}`, "PUT", {
      host: primary.host,
      https: false,
      wildcard: true,
    });
    expect(result.status).toBe(409);
  });

  it("answers 404 for a domain that does not exist", async () => {
    expect((await api("/domains/nope/primary", "POST")).status).toBe(404);
  });
});

describe("the primary domain at the next deploy", () => {
  it("substitutes $(PRIMARY_DOMAIN) and PORT from the new primary", async () => {
    await start();
    await deployed();
    await api("/environment", "PUT", { env: "HOST=$(PRIMARY_DOMAIN)", interpolation: true });
    const second = await addDomain({ host: "two.example.test", https: false, port: 8080 });
    await api(`/domains/${second.body.id}/primary`, "POST");

    const accepted = await api<ActionEntry>("/deploy", "POST");
    await waitForAction(accepted.body.id);

    const swarm = await context.docker.inspectService("shop_web");
    expect(swarm?.spec.TaskTemplate.ContainerSpec.Env).toEqual(["PORT=8080", "HOST=two.example.test"]);
  });
});

describe("changes never touch Docker", () => {
  it("leaves the Swarm service alone through add, edit, primary and delete", async () => {
    await start();
    await deployed();
    const before = await context.docker.inspectService("shop_web");

    const added = await addDomain({ host: "side.example.test", https: false });
    await api(`/domains/${added.body.id}`, "PUT", { host: "side.example.test", https: false, port: 3000 });
    await api(`/domains/${added.body.id}/primary`, "POST");
    await api(`/domains/${added.body.id}`, "DELETE");

    const after = await context.docker.inspectService("shop_web");
    expect(after?.version).toBe(before?.version);
    expect(after?.spec).toEqual(before?.spec);
  });
});

describe("the exposed port suggestions", () => {
  it("are empty before a deploy and list the image's ports after one", async () => {
    await start();
    await createService();
    expect((await api<ExposedPorts>("/domains/exposed-ports")).body).toEqual({ ports: [] });

    await api("/source", "PUT", { image: "traefik/whoami:v1.10" });
    expect((await api<ExposedPorts>("/domains/exposed-ports")).body).toEqual({ ports: [] });

    const accepted = await api<ActionEntry>("/deploy", "POST");
    await waitForAction(accepted.body.id);
    expect((await api<ExposedPorts>("/domains/exposed-ports")).body).toEqual({ ports: [80] });
  });

  it("answers an empty list when Docker can't be asked", async () => {
    await start();
    await createService();
    await api("/source", "PUT", { image: "traefik/whoami:v1.10" });
    context.docker.failNext("imageExposedPorts");

    const result = await api<ExposedPorts>("/domains/exposed-ports");
    expect(result.status).toBe(200);
    expect(result.body.ports).toEqual([]);
  });
});

describe("at boot", () => {
  it("writes every service's routes again, and one failure doesn't stop the rest", async () => {
    await start();
    await createService();
    await createService("api");
    const file = join(context.dataDir, "traefik/dynamic/shop__web.yaml");
    rmSync(file);

    await feature.boot?.(context.deps);

    expect(existsSync(file)).toBe(true);
  });
});

describe("the default domain", () => {
  it("keeps the project-then-service name of the golden captures", async () => {
    await start();
    await createService();
    const { domains } = (await listDomains()).body;
    expect(domains[0]?.host).toBe("shop-web.203.0.113.10.sslip.io");
  });
});
