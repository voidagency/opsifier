import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionEntry,
  CertificateList,
  CleanupPreview,
  DiskUsageListing,
  DockerUpdateCheck,
  DomainsOverview,
  OverviewDomain,
  PanelDomainSettings,
  ProxyEnvironmentSummary,
  ServerOverview,
  ServiceDomainSettings,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { actions } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { finishInterruptedReboots, REBOOT_SCRIPT } from "./host";
import { createDailyCleanupRunner } from "./runtime";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

const api = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, unknown> = {},
) => call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN, ...extra });

async function createService(project = "shop", service = "web") {
  await api("POST", "/api/v1/projects", { name: project });
  await api("POST", `/api/v1/projects/${project}/services`, { name: service });
}

async function waitForAction(id: string): Promise<ActionEntry> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await api<ActionEntry>("GET", `/api/v1/actions/${id}`);
    if (result.body.status !== "queued" && result.body.status !== "running") {
      return result.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

function installProxy() {
  return context.docker.createService({
    Name: "opsifier-traefik",
    TaskTemplate: {
      ContainerSpec: {
        Image: "traefik:3",
        Args: ["--old"],
        Mounts: [{ Type: "bind", Source: join(context.dataDir, "traefik"), Target: "/etc/traefik" }],
      },
    },
    Mode: { Replicated: { Replicas: 1 } },
  });
}

describe("the server overview", () => {
  it("reports uptime, engine and proxy state", async () => {
    const result = await api<ServerOverview>("GET", "/api/v1/server/overview");
    expect(result.status).toBe(200);
    expect(result.body.uptimeSeconds).toBeGreaterThan(0);
    expect(result.body.docker).toMatchObject({ available: true, version: "29.1.0", warnings: [] });
    expect(result.body.proxy.state).toBe("missing");
    expect(result.body.panel.managed).toBe(false);
  });

  it("names what this engine can't do, from what it reports and not from its version", async () => {
    context.docker.engine = {
      ...context.docker.engine,
      version: "29.1.0",
      apiVersion: "1.41",
      networkDrivers: ["bridge"],
    };

    const { body } = await api<ServerOverview>("GET", "/api/v1/server/overview");

    expect(body.docker.warnings).toEqual(["unsupported"]);
    expect(body.docker.missing).toEqual(["api", "overlay"]);
    expect(body.docker).toMatchObject({ version: "29.1.0", minimumApiVersion: "1.45" });
  });

  it("names a plugin of the CLI that doesn't answer", async () => {
    (context.deps.tools as FakeTools).missingPlugins.add("compose");

    const { body } = await api<ServerOverview>("GET", "/api/v1/server/overview");

    expect(body.docker.missing).toEqual(["compose"]);
    expect(body.docker.warnings).toEqual(["unsupported"]);
  });

  it("says when Docker is away, or too old", async () => {
    context.docker.failNext("engineInfo");
    const away = await api<ServerOverview>("GET", "/api/v1/server/overview");
    expect(away.body.docker).toMatchObject({ available: false, warnings: ["unavailable"] });

    context.docker.engine = { ...context.docker.engine, version: "20.10.0", swarm: "inactive" };
    const old = await api<ServerOverview>("GET", "/api/v1/server/overview");
    expect(old.body.docker.warnings).toEqual(expect.arrayContaining(["too-old", "swarm-inactive"]));
  });

  it("remembers the daily cleanup switch", async () => {
    await api("PUT", "/api/v1/server/daily-cleanup", { enabled: true });
    const result = await api<ServerOverview>("GET", "/api/v1/server/overview");
    expect(result.body.dailyCleanup).toBe(true);
    await api("PUT", "/api/v1/server/daily-cleanup", { enabled: false });
    expect((await api<ServerOverview>("GET", "/api/v1/server/overview")).body.dailyCleanup).toBe(false);
  });

  it("leaves the daily cleanup off until someone turns it on", async () => {
    const result = await api<ServerOverview>("GET", "/api/v1/server/overview");
    expect(result.body.dailyCleanup).toBe(false);
  });
});

describe("confirmations", () => {
  it.each([
    ["/api/v1/server/panel/restart", { confirm: "nope" }],
    ["/api/v1/server/reboot", { confirm: "nope" }],
    ["/api/v1/server/proxy/restart", { confirm: "nope" }],
    ["/api/v1/server/docker/cleanup/system", { confirm: "nope", items: ["x"] }],
  ])("%s needs the word typed", async (path, body) => {
    const result = await api("POST", path, body);
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("confirmation_mismatch");
  });

  it("says when the panel cannot restart itself", async () => {
    const result = await api("POST", "/api/v1/server/panel/restart", { confirm: "panel" });
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("panel_not_managed");
  });

  it("refuses a reboot with no helper image", async () => {
    const result = await api("POST", "/api/v1/server/reboot", { confirm: "reboot" });
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("host_operations_unavailable");
  });
});

describe("a reboot", () => {
  let helped: TestContext;
  let session: string;
  const logFile = () => join(helped.dataDir, "host-reboots.log");

  const post = (path: string, body: unknown) =>
    call<ActionEntry>(helped.app, path, { method: "POST", cookie: session, body, origin: TEST_ORIGIN });
  const reboot = () => post("/api/v1/server/reboot", { confirm: "reboot" });
  const detail = async (id: string) =>
    (await call<ActionEntry & { log: string }>(helped.app, `/api/v1/actions/${id}`, { cookie: session }))
      .body;

  beforeEach(async () => {
    helped = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
    session = await setupAdmin(helped.app);
  });

  afterEach(async () => {
    await helped.close();
  });

  /** On a real driver the Action waits for the machine to go down, which never happens in a test. */
  async function startRealReboot() {
    Object.defineProperty(helped.docker, "kind", { value: "dockerode" });
    const started = await reboot();
    expect(started.status).toBe(200);
    for (let attempt = 0; attempt < 200 && helped.docker.helpers.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return started.body;
  }

  function runningRow(createdAt: Date) {
    const id = "reboot-row";
    helped.deps.db
      .insert(actions)
      .values({
        id,
        type: "server.reboot",
        title: "Reboot the server",
        status: "running",
        hasLog: true,
        createdAt,
        startedAt: createdAt,
      })
      .run();
    return id;
  }

  it("runs from a helper that writes the outcome to the machine's own log", async () => {
    await reboot();
    const [helper] = helped.docker.helpers;

    expect(helper?.privileged).toBe(true);
    expect(helper?.command.slice(0, 9)).toEqual([
      "nsenter",
      "-t",
      "1",
      "-m",
      "-u",
      "-i",
      "-n",
      "--",
      "/bin/sh",
    ]);
    const args = helper?.command.slice(9) ?? [];
    expect(args[1]).toContain("/sbin/reboot");
    expect(args.slice(2)).toEqual(["opsifier-reboot", logFile(), "admin@example.com"]);
  });

  it("keeps the helper's record in a file that needs no panel", () => {
    const log = join(helped.dataDir, "record.log");

    execFileSync("/bin/sh", [
      "-c",
      REBOOT_SCRIPT.replace("/sbin/reboot", "true"),
      "x",
      log,
      "ada@example.com",
    ]);
    expect(readFileSync(log, "utf8")).toMatch(/Reboot requested by ada@example.com\n/);
    expect(readFileSync(log, "utf8")).toMatch(/Reboot accepted by the system\n/);

    expect(() =>
      execFileSync("/bin/sh", [
        "-c",
        REBOOT_SCRIPT.replace("/sbin/reboot", "false"),
        "x",
        log,
        "ada@example.com",
      ]),
    ).toThrow();
    expect(readFileSync(log, "utf8")).toMatch(/Reboot failed with code 1\n/);
  });

  it("says when it was only simulated, without claiming a real reboot", async () => {
    const started = await reboot();
    const action = await detail(started.body.id);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await detail(started.body.id);
      if (current.status !== "queued" && current.status !== "running") {
        expect(current.status).toBe("succeeded");
        expect(current.log).toContain("Simulated: no server was rebooted");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(action.status).toBe("succeeded");
  });

  it("stays in progress until the outcome is known: never reads as done before it has happened", async () => {
    const started = await startRealReboot();

    await vi.waitFor(async () => expect((await detail(started.id)).log).toContain("accepted the reboot"));
    const current = await detail(started.id);
    expect(current.status).toBe("running");
    expect(current.finishedAt).toBeNull();

    await post(`/api/v1/actions/${started.id}/cancel`, {});
  });

  it("reports the reason when the command fails", async () => {
    Object.defineProperty(helped.docker, "kind", { value: "dockerode" });
    helped.docker.helperResult = () => ({ exitCode: 1, stdout: "", stderr: "Operation not permitted\n" });

    const started = await reboot();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await detail(started.body.id);
      if (current.status !== "queued" && current.status !== "running") {
        expect(current.status).toBe("failed");
        expect(current.error).toBe("Operation not permitted");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The action did not finish");
  });

  it("is left for the next start rather than failed by recovery, and concludes from the boot time", async () => {
    const startedAt = new Date(helped.deps.now() - 60_000);
    const id = runningRow(startedAt);
    writeFileSync(
      logFile(),
      "2026-01-01T00:00:00Z Reboot requested by ada\n2026-01-01T00:00:01Z Reboot accepted\n",
    );

    helped.deps.actions.recover();
    expect((await detail(id)).status).toBe("running");

    await finishInterruptedReboots(helped.deps, helped.deps.now() - 5_000);

    const finished = await detail(id);
    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Server's record: 2026-01-01T00:00:01Z Reboot accepted");
  });

  it("says so when the panel restarted but the machine did not", async () => {
    const id = runningRow(new Date(helped.deps.now() - 5_000));

    await finishInterruptedReboots(helped.deps, helped.deps.now() - 60_000);

    const finished = await detail(id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("The panel restarted, but the server did not reboot.");
  });
});

describe("domains of the panel", () => {
  it("keeps the generated domain read-only and saves a custom one", async () => {
    const before = await api<PanelDomainSettings>("GET", "/api/v1/server/panel-domain");
    expect(before.body.defaultDomain).toBe("panel.203.0.113.10.sslip.io");
    const saved = await api<PanelDomainSettings>("PUT", "/api/v1/server/panel-domain", {
      customDomain: "Panel.Example.com",
      serveOnIp: true,
    });
    expect(saved.body.customDomain).toBe("panel.example.com");
    expect(saved.body.url).toBe("https://panel.example.com");
    const base = readFileSync(join(context.dataDir, "traefik", "dynamic", "_base.yaml"), "utf8");
    expect(base).toContain("panel.example.com");
    expect(base).toContain("panel.203.0.113.10.sslip.io");
  });

  it("rejects an invalid host", async () => {
    const result = await api("PUT", "/api/v1/server/panel-domain", {
      customDomain: "not a host",
      serveOnIp: true,
    });
    expect(result.status).toBe(400);
  });

  it("reserves the panel's domains against services and wildcards", async () => {
    await createService();
    await api("PUT", "/api/v1/server/panel-domain", { customDomain: "panel.example.com", serveOnIp: true });
    const exact = await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "panel.example.com",
    });
    expect(exact.status).toBe(409);
    expect(apiErrorOf(exact).code).toBe("domain_reserved");
    const wildcard = await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "example.com",
      wildcard: true,
      certificateResolver: "dns",
    });
    expect(wildcard.status).toBe(409);
  });

  it("does not take a name a route already answers on, or that a wildcard covers", async () => {
    await createService();
    await api("POST", "/api/v1/projects/shop/services/web/domains", { host: "used.example.com" });
    await api("POST", "/api/v1/projects/shop/services/web/domains", { host: "api.example.net", path: "/v1" });
    await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "wild.example.org",
      wildcard: true,
      certificateResolver: "dns",
    });

    for (const customDomain of ["used.example.com", "api.example.net", "panel.wild.example.org"]) {
      const taken = await api("PUT", "/api/v1/server/panel-domain", { customDomain, serveOnIp: true });
      expect(taken.status).toBe(409);
      expect(apiErrorOf(taken).code).toBe("domain_taken");
      expect(apiErrorOf(taken).fields?.customDomain).toBeTruthy();
    }

    expect(
      (await api<PanelDomainSettings>("GET", "/api/v1/server/panel-domain")).body.customDomain,
    ).toBeNull();
  });

  it("does not count a wildcard as covering a name more than one level below it", async () => {
    await createService();
    await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "example.org",
      wildcard: true,
      certificateResolver: "dns",
    });

    const saved = await api("PUT", "/api/v1/server/panel-domain", {
      customDomain: "panel.deep.example.org",
      serveOnIp: true,
    });

    expect(saved.status).toBe(200);
  });

  it("does not stand in the way of a setting that leaves the panel's own name alone", async () => {
    await createService();
    await api("PUT", "/api/v1/server/panel-domain", { customDomain: "panel.example.com", serveOnIp: true });
    const { insertDomain } = await import("../service-tabs/domains/repo");
    insertDomain(context.deps.db, {
      id: "predates",
      projectName: "shop",
      serviceName: "web",
      host: "panel.example.com",
      port: 80,
      isPrimary: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const saved = await api("PUT", "/api/v1/server/panel-domain", {
      customDomain: "panel.example.com",
      serveOnIp: false,
    });

    expect(saved.status).toBe(200);
  });

  it("answers only on its own names when serve-on-IP is off, but always to the server itself", async () => {
    await api("PUT", "/api/v1/server/panel-domain", { customDomain: "panel.example.com", serveOnIp: false });
    const byIp = await call(context.app, "/api/v1/auth/session", {
      headers: { host: "198.51.100.1:3000" },
      peer: "198.51.100.200",
    });
    expect(byIp.status).toBe(404);
    const byName = await call(context.app, "/api/v1/auth/session", {
      headers: { host: "panel.example.com" },
      peer: "198.51.100.200",
    });
    expect(byName.status).toBe(200);
    const fromServer = await call(context.app, "/api/v1/auth/session", {
      headers: { host: "198.51.100.1:3000" },
      peer: "127.0.0.1",
    });
    expect(fromServer.status).toBe(200);
    // Error pages are requested with the hostname of the site they stand in for.
    const errorPage = await call(context.app, "/api/proxy-pages/bad-gateway", {
      headers: { host: "shop.example.com" },
      peer: "198.51.100.200",
    });
    expect(errorPage.status).toBe(502);
  });

  it("uses the base domain for new services", async () => {
    await api("PUT", "/api/v1/server/service-domain", { customDomain: "apps.example.com" });
    const result = await api<ServiceDomainSettings>("GET", "/api/v1/server/service-domain");
    expect(result.body.customDomain).toBe("apps.example.com");
    await createService();
    const domains = await api<DomainsOverview>("GET", "/api/v1/domains");
    expect(domains.body.domains[0]?.host).toBe("shop-web.apps.example.com");
  });

  it("pre-fills the Let's Encrypt email and validates it", async () => {
    const before = await api<{ email: string }>("GET", "/api/v1/server/letsencrypt-email");
    expect(before.body.email).toBe("admin@example.com");
    expect((await api("PUT", "/api/v1/server/letsencrypt-email", { email: "nope" })).status).toBe(400);
    expect((await api("PUT", "/api/v1/server/letsencrypt-email", { email: "ops@example.com" })).status).toBe(
      200,
    );
  });
});

describe("the proxy", () => {
  it("saves custom configuration only if it is valid, and writes it to the file provider", async () => {
    const bad = await api("PUT", "/api/v1/server/proxy/custom-config", { yaml: "foo: [unterminated" });
    expect(bad.status).toBe(400);
    expect(Object.keys(apiErrorOf(bad).fields ?? {})).toEqual(["yaml"]);

    const reserved = await api("PUT", "/api/v1/server/proxy/custom-config", {
      yaml: "http:\n  routers:\n    opsifier-panel:\n      rule: Host(`x.example.com`)\n",
    });
    expect(reserved.status).toBe(400);

    const yaml = "http:\n  middlewares:\n    limit:\n      rateLimit:\n        average: 10\n";
    expect((await api("PUT", "/api/v1/server/proxy/custom-config", { yaml })).status).toBe(200);
    expect(readFileSync(join(context.dataDir, "traefik", "dynamic", "_custom.yaml"), "utf8")).toBe(yaml);
  });

  it("keeps the environment sealed and lists only names", async () => {
    const saved = await api<ProxyEnvironmentSummary>("PUT", "/api/v1/server/proxy/environment", {
      env: "CF_DNS_API_TOKEN=abc123\nTRAEFIK_CERTIFICATESRESOLVERS_DNS_ACME_EMAIL=a@b.co\n",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.names).toContain("CF_DNS_API_TOKEN");

    const listed = await api<ProxyEnvironmentSummary>("GET", "/api/v1/server/proxy/environment");
    expect(JSON.stringify(listed.body)).not.toContain("abc123");

    const revealed = await api<{ env: string }>("POST", "/api/v1/server/proxy/environment/reveal");
    expect(revealed.body.env).toContain("abc123");

    const reserved = await api("PUT", "/api/v1/server/proxy/environment", {
      env: "TRAEFIK_ENTRYPOINTS_WEB_ADDRESS=:81\n",
    });
    expect(reserved.status).toBe(400);
  });

  it("restarts with its configuration rendered as environment variables", async () => {
    await installProxy();
    await api("PUT", "/api/v1/server/letsencrypt-email", { email: "ops@example.com" });
    await api("PUT", "/api/v1/server/proxy/environment", { env: "CF_DNS_API_TOKEN=abc123\n" });
    const accepted = await api<ActionEntry>("PUT", "/api/v1/server/proxy/trusted-proxies", {
      trustAll: false,
      entries: ["203.0.113.0/24", "::1/128"],
    });
    expect(accepted.status).toBe(202);
    const finished = await waitForAction(accepted.body.id);
    expect(finished.status).toBe("succeeded");

    const service = await context.docker.inspectService("opsifier-traefik");
    const env = service?.spec.TaskTemplate.ContainerSpec.Env ?? [];
    expect(env).toContain("TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_TRUSTEDIPS=203.0.113.0/24,::1/128");
    expect(env).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL=ops@example.com");
    expect(env).toContain("TRAEFIK_PROVIDERS_FILE_DIRECTORY=/etc/traefik/dynamic");
    expect(env).toContain("CF_DNS_API_TOKEN=abc123");
    expect(service?.spec.TaskTemplate.ContainerSpec.Args).toBeUndefined();
    expect(service?.spec.TaskTemplate.ForceUpdate).toBe(1);
  });

  it("rejects an entry that isn't an address or a range", async () => {
    const result = await api("PUT", "/api/v1/server/proxy/trusted-proxies", {
      trustAll: false,
      entries: ["not an ip"],
    });
    expect(result.status).toBe(400);
  });

  it("opens the dashboard behind a password shown once, and rotates it on restart", async () => {
    await installProxy();
    const opened = await api<{ url: string; password: string; username: string }>(
      "POST",
      "/api/v1/server/proxy/dashboard",
    );
    expect(opened.status).toBe(200);
    expect(opened.body.url).toContain("proxy.203.0.113.10.sslip.io");
    const file = readFileSync(join(context.dataDir, "traefik", "dynamic", "_dashboard.yaml"), "utf8");
    expect(file).toContain("api@internal");
    expect(file).not.toContain(opened.body.password);

    const status = await api<{ open: boolean }>("GET", "/api/v1/server/proxy/dashboard");
    expect(status.body.open).toBe(true);

    const restart = await api<ActionEntry>("POST", "/api/v1/server/proxy/restart", { confirm: "proxy" });
    await waitForAction(restart.body.id);
    const after = await api<{ open: boolean }>("GET", "/api/v1/server/proxy/dashboard");
    expect(after.body.open).toBe(false);
  });
});

describe("docker cleanups", () => {
  const image = (id: string, tags: string[], labels: Record<string, string> = {}) => ({
    id,
    tags,
    sizeBytes: 1024 * 1024,
    labels,
    createdAt: null,
  });

  it("previews only what belongs to the panel, and never a volume or something in use", async () => {
    context.docker.images.push(
      image("sha256:own", ["opsifier/shop/web:latest"]),
      image("sha256:used", ["opsifier/shop/api:latest"]),
      image("sha256:foreign", ["redis:7"]),
    );
    context.docker.containers.push({
      id: "c1",
      name: "shop_api.1",
      image: "opsifier/shop/api:latest",
      imageId: "sha256:used",
      state: "running",
      labels: {},
      sizeBytes: 1,
    });
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    expect(preview.body.items.map((item) => item.label)).toEqual(["opsifier/shop/web:latest"]);
    expect(preview.body.retained).toEqual([{ label: "opsifier/shop/api:latest", reason: "in-use" }]);
    expect(preview.body.foreignCount).toBe(1);
    expect(preview.body.reclaimableBytes).toBe(1024 * 1024);
  });

  it("removes only what was selected and is still eligible", async () => {
    context.docker.images.push(
      image("sha256:a", ["opsifier/shop/web:latest"]),
      image("sha256:b", ["opsifier/shop/web2:latest"]),
    );
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    const selected = preview.body.items[0]?.id as string;

    context.docker.containers.push({
      id: "c1",
      name: "x",
      image: "",
      imageId: selected.replace("image:", ""),
      state: "running",
      labels: {},
      sizeBytes: 1,
    });
    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/images", {
      confirm: "images",
      items: [selected, "image:sha256:forged"],
    });
    expect(run.status).toBe(202);
    const finished = await waitForAction(run.body.id);
    expect(finished.status).toBe("succeeded");
    // It gained a container between the preview and the run, so nothing widened and nothing broke.
    expect(context.docker.images.map((entry) => entry.id).sort()).toEqual(["sha256:a", "sha256:b"]);
  });

  it("recognises what a rebuild left behind, once it has seen the image with its tag", async () => {
    context.docker.images.push(image("sha256:old", ["opsifier/shop/web:latest"]));
    await api("GET", "/api/v1/server/docker/cleanup/images");
    context.docker.images[0] = image("sha256:old", []);
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    expect(preview.body.items.map((item) => item.id)).toEqual(["image:sha256:old"]);
  });

  const cacheRecord = (id: string, sizeBytes = 1, inUse = false) => ({
    id,
    sizeBytes,
    inUse,
    shared: false,
    description: "layer",
    lastUsedAt: null,
  });

  /** Runs one build of a Dockerfile service, during which these records appear in the builder. */
  async function buildLeaving(records: ReturnType<typeof cacheRecord>[]) {
    await createService();
    (context.deps.tools as FakeTools).handler = (request) => {
      if (request.command === "docker" && request.args.includes("build")) {
        context.docker.disk = {
          ...context.docker.disk,
          buildCache: [...context.docker.disk.buildCache, ...records],
          buildCacheBytes:
            context.docker.disk.buildCacheBytes + records.reduce((total, r) => total + r.sizeBytes, 0),
        };
      }
      return undefined;
    };
    await api("PUT", "/api/v1/projects/shop/services/web/source", {
      type: "dockerfile",
      dockerfile: "FROM busybox\nRUN echo hi\n",
    });
    const built = await api<ActionEntry>("POST", "/api/v1/projects/shop/services/web/deploy");
    expect((await waitForAction(built.body.id)).status).toBe("succeeded");
    (context.deps.tools as FakeTools).handler = undefined;
  }

  it("offers only the build cache the panel's own builds created, and keeps what is in use", async () => {
    context.docker.disk = {
      imagesBytes: 0,
      containersBytes: 0,
      volumesBytes: 0,
      buildCacheBytes: 9,
      buildCache: [cacheRecord("foreign", 9)],
    };
    await buildLeaving([cacheRecord("free", 1), cacheRecord("busy", 2, true)]);

    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/builder");

    expect(preview.body.items.map((item) => item.id)).toEqual(["build-cache:free"]);
    expect(preview.body.retained).toEqual([{ label: "layer", reason: "in-use" }]);
    expect(preview.body.foreignCount).toBe(1);
    expect(preview.body.reclaimableBytes).toBe(1);

    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/builder", {
      confirm: "builder",
      items: ["build-cache:free"],
    });
    await waitForAction(run.body.id);
    expect(context.docker.disk.buildCache.map((record) => record.id)).toEqual(["foreign", "busy"]);
  });

  it("refuses to remove a build cache record the panel did not create, even if asked by name", async () => {
    context.docker.disk = {
      imagesBytes: 0,
      containersBytes: 0,
      volumesBytes: 0,
      buildCacheBytes: 9,
      buildCache: [cacheRecord("foreign", 9)],
    };

    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/builder", {
      confirm: "builder",
      items: ["build-cache:foreign"],
    });
    await waitForAction(run.body.id);

    expect(context.docker.disk.buildCache.map((record) => record.id)).toEqual(["foreign"]);
  });

  it("offers nothing a build left when it could not see the builder at the start", async () => {
    context.docker.failNext("listBuildCache");
    await buildLeaving([cacheRecord("unknown-origin", 4)]);
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/builder");
    expect(preview.body.items).toEqual([]);
    expect(preview.body.foreignCount).toBe(1);
  });

  it("keeps the only image of a stopped service, which could not start without it", async () => {
    await createService();
    await api("PUT", "/api/v1/projects/shop/services/web/source", {
      type: "dockerfile",
      dockerfile: "FROM busybox\n",
    });
    context.docker.images.push(image("sha256:only", ["opsifier/shop/web:latest"]));

    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/system");

    expect(preview.body.items).toEqual([]);
    expect(preview.body.retained).toEqual([{ label: "opsifier/shop/web:latest", reason: "rollback" }]);
  });

  it("offers the image of a service that no longer exists", async () => {
    context.docker.images.push(image("sha256:orphan", ["opsifier/shop/gone:latest"]));
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    expect(preview.body.items.map((item) => item.label)).toEqual(["opsifier/shop/gone:latest"]);
  });

  it("leaves the networks of an empty project alone", async () => {
    await api("POST", "/api/v1/projects", { name: "empty" });
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/system");
    const offered = preview.body.items.map((item) => item.id);
    expect(offered).not.toContain("network:opsifier-empty");
    expect(offered).not.toContain("network:opsifier-empty_proxy");
  });

  it("offers both networks of a project that no longer exists", async () => {
    await context.docker.createNetwork({ name: "opsifier-gone", attachable: true });
    await context.docker.createNetwork({ name: "opsifier-gone_proxy", attachable: true });
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/system");
    expect(preview.body.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["network:opsifier-gone", "network:opsifier-gone_proxy"]),
    );
  });

  it("reports what Docker gave back, not the listed size", async () => {
    context.docker.images.push(
      image("sha256:a", ["opsifier/shop/one:latest"]),
      image("sha256:b", ["opsifier/shop/two:latest"]),
    );
    context.docker.disk = { ...context.docker.disk, imagesBytes: 3 * 1024 * 1024 };
    // They share most of their layers, so removing both gives back less than the two listed sizes.
    context.docker.imageBytesFreed.set("sha256:a", 256 * 1024);
    context.docker.imageBytesFreed.set("sha256:b", 256 * 1024);

    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/images", {
      confirm: "images",
      items: preview.body.items.map((item) => item.id),
    });
    const finished = await waitForAction(run.body.id);
    const { body } = await api<ActionEntry & { log: string }>("GET", `/api/v1/actions/${finished.id}`);

    expect(body.log).toContain("expected to free 2.1 MB");
    expect(body.log).toContain("Docker reports 524.3 KB given back");
  });

  it("says when Docker can't report what a cleanup gave back", async () => {
    context.docker.images.push(image("sha256:a", ["opsifier/shop/one:latest"]));
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    const originalDiskUsage = context.docker.diskUsage.bind(context.docker);
    context.docker.diskUsage = () => Promise.reject(new Error("no"));

    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/images", {
      confirm: "images",
      items: preview.body.items.map((item) => item.id),
    });
    const finished = await waitForAction(run.body.id);
    context.docker.diskUsage = originalDiskUsage;
    const { body } = await api<ActionEntry & { log: string }>("GET", `/api/v1/actions/${finished.id}`);

    expect(finished.status).toBe("succeeded");
    expect(body.log).toContain("Docker did not report how much space that gave back");
  });

  describe("the daily run", () => {
    const actions = async () =>
      (await api<{ items: ActionEntry[] }>("GET", "/api/v1/actions")).body.items.filter(
        (item) => item.type === "docker.cleanup",
      );

    it("does nothing on a panel where nobody turned it on", async () => {
      context.docker.images.push(image("sha256:own", ["opsifier/shop/gone:latest"]));

      createDailyCleanupRunner(context.deps).check();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await actions()).toEqual([]);
      expect(context.docker.images.map((entry) => entry.id)).toEqual(["sha256:own"]);
    });

    it("once turned on, removes only what a person could have selected", async () => {
      await createService();
      await api("PUT", "/api/v1/projects/shop/services/web/source", {
        type: "dockerfile",
        dockerfile: "FROM busybox\n",
      });
      context.docker.images.push(
        image("sha256:gone", ["opsifier/shop/gone:latest"]),
        image("sha256:stopped", ["opsifier/shop/web:latest"]),
        image("sha256:foreign", ["redis:7"]),
      );
      await api("PUT", "/api/v1/server/daily-cleanup", { enabled: true });

      createDailyCleanupRunner(context.deps).check();
      const [action] = await actions();
      await waitForAction((action as ActionEntry).id);

      expect(context.docker.images.map((entry) => entry.id).sort()).toEqual([
        "sha256:foreign",
        "sha256:stopped",
      ]);
    });
  });

  it("checks the engine against a release feed without touching it", async () => {
    const context2 = await createTestContext({
      env: { OPSIFIER_DOCKER_RELEASES_URL: "http://127.0.0.1:1/none" },
    });
    const session = await setupAdmin(context2.app);
    const result = await call<DockerUpdateCheck>(context2.app, "/api/v1/server/docker/update", {
      cookie: session,
    });
    expect(result.status).toBe(200);
    expect(result.body.upToDate).toBeNull();
    expect(result.body.problem).toBeTruthy();
    await context2.close();
  });
});

describe("disk usage", () => {
  it("browses the data directory when no helper image is available", async () => {
    mkdirSync(join(context.dataDir, "projects", "shop"), { recursive: true });
    writeFileSync(join(context.dataDir, "projects", "shop", "file.txt"), "hello world");
    const result = await api<DiskUsageListing>("GET", "/api/v1/server/disk?path=/projects/shop");
    expect(result.status).toBe(200);
    expect(result.body.scope).toBe("data");
    expect(result.body.entries.map((entry) => entry.name)).toEqual(["file.txt"]);
    expect(result.body.parent).toBe("/projects");
  });

  it("refuses to climb out", async () => {
    expect((await api("GET", "/api/v1/server/disk?path=/../../etc")).status).toBe(400);
  });

  it("uses a helper image for the whole host, as an argument vector", async () => {
    const context2 = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: "alpine:3.21" } });
    const session = await setupAdmin(context2.app);
    context2.docker.helperResult = () => ({
      exitCode: 0,
      stdout: "1024\t/host/var/lib\n2048\t/host/var/log\n4096\t/host/var\n",
      stderr: "",
    });
    const result = await call<DiskUsageListing>(context2.app, "/api/v1/server/disk?path=/var", {
      cookie: session,
    });
    expect(result.status).toBe(200);
    expect(result.body.scope).toBe("host");
    expect(result.body.entries.map((entry) => entry.path)).toEqual(["/var/log", "/var/lib"]);
    expect(context2.docker.helpers[0]?.command).toEqual(["du", "-k", "-x", "-d", "1", "--", "/host/var"]);
    await context2.close();
  });
});

describe("certificates", () => {
  const CERT_B64 =
    "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURSVENDQWkyZ0F3SUJBZ0lVYm1vV2VEcVN4T3d4WlNVQ0s1c1graG56ZnBNd0RRWUpLb1pJaHZjTkFRRUwKQlFBd0xERVlNQllHQTFVRUF3d1BZWEJ3TG1WNFlXMXdiR1V1WTI5dE1SQXdEZ1lEVlFRS0RBZFRkSFZpSUVOQgpNQjRYRFRJMk1URXdPREl3TkRnek0xb1hEVE0yTVRFd05USXdORGd6TTFvd0xERVlNQllHQTFVRUF3d1BZWEJ3CkxtVjRZVzF3YkdVdVkyOXRNUkF3RGdZRFZRUUtEQWRUZEhWaUlFTkJNSUlCSWpBTkJna3Foa2lHOXcwQkFRRUYKQUFPQ0FROEFNSUlCQ2dLQ0FRRUF0K2lGdkZlaHhlaVNoS0piK0o1cGlwVXVMMkhsWUkyQkxzY1IxUlNLWFR5WQoxaXVKT0hKcm9nL3dvc3cwZnJXQWw3WFVCUmxhQjJidlc1ZkJaT29icm12UGlKdW56TGZtZXJGcE5IQSthR1UyClI5MmY4alNvUlBadXFwNCtmSmp6VGZSY1ZEaTI3VGlMWjJzOEFhRkM1bWc3ekV2S3R3cGV6VzFTSzhPbXFiZlcKMUtCT3BEeTlORU9iQ1RYdXhGUEExVGNQcWtOVUZwV1NMa1k4TlRTWFhqeTBmUVhVQy8rWW1JMU1xbm1aT2I3aQpjNWphZDNNT3M2Skp6NDdWZ1I2eW5CR2cwWk9PWENhM1JHaFcxVkdGTlJNTFpwemZFZzJTVWJ3ZWFZMWxORjdkCjc4STkvY2xOd1U4Nnp6NXdoZXNjeE44MXVoWlQ0UkhET0ExZzNVSzBrUUlEQVFBQm8xOHdYVEFkQmdOVkhRNEUKRmdRVWgyNmJ6cDVpZWx1ZWNLcVdORTBZSTI0VTc2Y3dEd1lEVlIwVEFRSC9CQVV3QXdFQi96QXJCZ05WSFJFRQpKREFpZ2c5aGNIQXVaWGhoYlhCc1pTNWpiMjJDRDNkM2R5NWxlR0Z0Y0d4bExtTnZiVEFOQmdrcWhraUc5dzBCCkFRc0ZBQU9DQVFFQUx2Z1E4UTIrUWxrb25DdnFtb0pGdXVjcUs3ZkxHSFFlVEVMRzZxTlM2ZmpYTTc1cFI2L1AKZGFKaVBJa0c0ZnBFdHNteWNIcWV2L1VDOC8vbklnNlRVZkRtanByLytzZHEvY09qWEN5ZURxZ1huaFpEb1NIRwpxWnFDZXdINDZONWxGUjFEQzZmakVYKzVPSTBFME5ZUGx3SVhHd1hQT3N6M2VMNHBpc2RpZHQwSTFIMnVoejFWCnU1eDVYZjZKeXhuQWpTVldSSXh2WFFXWlhWbkZldUpuSFl4dDF0SkdZNDVCZVJTUjdYcWhEUUg2S1BZRWZtNnAKN3NYTXhKeW9BMCtLTk1IeGNtb3VOb2hEWC9yZzZFNnZMejlrSVlzUjl6b1NXR1RPVTRiWmdONXN0YW1WdkdUUwpZdXVrM01CODVnZTBTeENNYWlCU2FVam1ZSGxLUXBXazZRPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";

  function seedAcme() {
    mkdirSync(join(context.dataDir, "traefik"), { recursive: true });
    writeFileSync(
      join(context.dataDir, "traefik", "acme.json"),
      JSON.stringify({
        letsencrypt: {
          Account: { Email: "a@b.co" },
          Certificates: [
            {
              domain: { main: "app.example.com", sans: ["www.example.com"] },
              certificate: CERT_B64,
              key: "aaaa",
              Store: "default",
            },
          ],
        },
      }),
    );
  }

  it("lists what the proxy holds, and nothing when it holds nothing", async () => {
    const empty = await api<CertificateList>("GET", "/api/v1/certificates");
    expect(empty.body.certificates).toEqual([]);

    seedAcme();
    const list = await api<CertificateList>("GET", "/api/v1/certificates");
    expect(list.body.certificates).toHaveLength(1);
    expect(list.body.certificates[0]).toMatchObject({
      domain: "app.example.com",
      sans: ["www.example.com"],
      resolver: "letsencrypt",
      state: "valid",
    });
    expect(list.body.certificates[0]?.notAfter).toBeTruthy();
  });

  it("shows HTTPS as issued only when the proxy holds a certificate", async () => {
    await createService();
    const add = await api("POST", "/api/v1/projects/shop/services/web/domains", { host: "app.example.com" });
    expect(add.status).toBe(201);
    const pending = await api<DomainsOverview>("GET", "/api/v1/domains");
    const entry = (d: OverviewDomain[]) => d.find((row) => row.host === "app.example.com");
    expect(entry(pending.body.domains)?.tls).toBe("pending");

    seedAcme();
    const issued = await api<DomainsOverview>("GET", "/api/v1/domains");
    expect(entry(issued.body.domains)?.tls).toBe("issued");
  });

  describe("what a domain's HTTPS state is really based on", () => {
    function seedCertificates(certificates: Array<{ main: string; sans?: string[]; certificate?: string }>) {
      mkdirSync(join(context.dataDir, "traefik"), { recursive: true });
      writeFileSync(
        join(context.dataDir, "traefik", "acme.json"),
        JSON.stringify({
          letsencrypt: {
            Certificates: certificates.map(({ main, sans, certificate }) => ({
              domain: { main, sans },
              certificate: certificate ?? CERT_B64,
              key: "aaaa",
            })),
          },
        }),
      );
    }

    const tlsOf = async (host: string) => {
      const { body } = await api<DomainsOverview>("GET", "/api/v1/domains");
      return body.domains.find((domain) => domain.host === host)?.tls;
    };

    const addDomain = (body: Record<string, unknown>) =>
      api("POST", "/api/v1/projects/shop/services/web/domains", body);

    beforeEach(async () => {
      await createService();
    });

    it("does not call an unreadable certificate issued", async () => {
      await addDomain({ host: "app.example.com" });
      seedCertificates([{ main: "app.example.com", certificate: "bm90IGEgY2VydGlmaWNhdGU=" }]);

      expect(await tlsOf("app.example.com")).toBe("unreadable");
    });

    it("counts a host covered by a wildcard certificate as issued", async () => {
      await addDomain({ host: "app.example.com" });
      seedCertificates([{ main: "*.example.com" }]);

      expect(await tlsOf("app.example.com")).toBe("issued");
    });

    it("does not let a wildcard certificate cover a name two levels below it", async () => {
      await addDomain({ host: "a.b.example.com" });
      seedCertificates([{ main: "*.example.com" }]);

      expect(await tlsOf("a.b.example.com")).toBe("pending");
    });

    it("prefers the certificate that works when several cover the host", async () => {
      await addDomain({ host: "app.example.com" });
      seedCertificates([
        { main: "app.example.com", certificate: "bm90IGEgY2VydGlmaWNhdGU=" },
        { main: "*.example.com" },
      ]);

      expect(await tlsOf("app.example.com")).toBe("issued");
    });

    it("keeps HTTPS on a wildcard unverified until the proxy holds its certificate", async () => {
      await addDomain({ host: "wild.example.com", wildcard: true, certificateResolver: "dns" });
      expect(await tlsOf("wild.example.com")).toBe("unverified");

      seedCertificates([{ main: "*.wild.example.com" }]);
      expect(await tlsOf("wild.example.com")).toBe("issued");
    });
  });

  it("removes one only with its domain typed, and restarts the proxy to forget it", async () => {
    await installProxy();
    seedAcme();
    const list = await api<CertificateList>("GET", "/api/v1/certificates");
    const id = list.body.certificates[0]?.id as string;

    const wrong = await api("DELETE", `/api/v1/certificates/${id}`, { confirm: "other.example.com" });
    expect(wrong.status).toBe(409);

    const removed = await api<ActionEntry>("DELETE", `/api/v1/certificates/${id}`, {
      confirm: "app.example.com",
    });
    expect(removed.status).toBe(202);
    await waitForAction(removed.body.id);
    const after = await api<CertificateList>("GET", "/api/v1/certificates");
    expect(after.body.certificates).toEqual([]);
  });
});

describe("custom domains", () => {
  it("keeps a path inside its own segment, and strips it when asked", async () => {
    const created = await api<OverviewDomain>("POST", "/api/v1/domains/custom", {
      host: "ext.example.com",
      path: "/docs",
      stripPath: true,
      https: false,
      servers: [{ url: "https://vendor.example.net" }],
    });
    expect(created.status).toBe(201);
    expect(created.body.stripPath).toBe(true);

    const name = `custom-${created.body.id}`;
    const { http } = parse(
      readFileSync(
        join(context.dataDir, "traefik", "dynamic", `_custom-domain-${created.body.id}.yaml`),
        "utf8",
      ),
    ) as {
      http: {
        routers: Record<string, { rule: string; middlewares?: string[] }>;
        middlewares: Record<string, unknown>;
      };
    };

    expect(http.routers[`http-${name}`]?.rule).toBe(
      "Host(`ext.example.com`) && (Path(`/docs`) || PathPrefix(`/docs/`))",
    );
    expect(http.routers[`http-${name}`]?.middlewares).toEqual([`opsifier-strip-${name}`]);
    expect(http.middlewares[`opsifier-strip-${name}`]).toEqual({ stripPrefix: { prefixes: ["/docs"] } });
  });

  it("still lets a custom destination split a host by path with another", async () => {
    const servers = [{ url: "https://vendor.example.net" }];
    await api("POST", "/api/v1/domains/custom", { host: "ext.example.com", https: false, servers });

    const nested = await api("POST", "/api/v1/domains/custom", {
      host: "ext.example.com",
      path: "/api",
      https: false,
      servers,
    });

    expect(nested.status).toBe(201);
  });

  it("routes a host to outside servers and refuses a taken host", async () => {
    await createService();
    const created = await api<OverviewDomain>("POST", "/api/v1/domains/custom", {
      host: "ext.example.com",
      servers: [
        { url: "https://10.0.0.5:8443", weight: 3 },
        { url: "https://10.0.0.6:8443", weight: 1 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.destination).toBe("custom");

    const file = readFileSync(
      join(context.dataDir, "traefik", "dynamic", `_custom-domain-${created.body.id}.yaml`),
      "utf8",
    );
    expect(file).toContain("https://10.0.0.5:8443");
    expect(file).toContain("weight: 3");
    expect(file).not.toContain("serversTransport");

    const duplicate = await api("POST", "/api/v1/domains/custom", {
      host: "ext.example.com",
      servers: [{ url: "http://a.example.com" }],
    });
    expect(duplicate.status).toBe(409);
    const serviceClash = await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "ext.example.com",
    });
    expect(serviceClash.status).toBe(409);

    expect((await api("DELETE", `/api/v1/domains/custom/${created.body.id}`)).status).toBe(200);
    expect(
      (await api<DomainsOverview>("GET", "/api/v1/domains")).body.domains.map((row) => row.host),
    ).toEqual(["shop-web.203.0.113.10.sslip.io"]);
  });

  it("validates its fields", async () => {
    const result = await api("POST", "/api/v1/domains/custom", { host: "ext", servers: [] });
    expect(result.status).toBe(400);
    expect(Object.keys(apiErrorOf(result).fields ?? {})).toEqual(expect.arrayContaining(["host", "servers"]));
  });
});

describe("foreign images", () => {
  it("never claims an image someone else has named, even if the panel once built the same id", async () => {
    const shared = {
      id: "sha256:shared",
      tags: ["opsifier/shop/web:latest", "redis:7"],
      sizeBytes: 1,
      labels: {},
      createdAt: null,
    };
    context.docker.images.push(shared);
    // Seen while it still has the panel's tag.
    await api("GET", "/api/v1/server/docker/cleanup/images");

    context.docker.images[0] = { ...shared, tags: ["redis:7"] };
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    expect(preview.body.items).toEqual([]);
    expect(preview.body.foreignCount).toBe(1);
  });

  it("removes only the panel's own tag from an image that also has another name", async () => {
    context.docker.images.push({
      id: "sha256:twice",
      tags: ["opsifier/shop/web:latest", "redis:7"],
      sizeBytes: 1,
      labels: {},
      createdAt: null,
    });
    const preview = await api<CleanupPreview>("GET", "/api/v1/server/docker/cleanup/images");
    expect(preview.body.items[0]?.label).toBe("opsifier/shop/web:latest");
    expect(JSON.stringify(preview.body)).not.toContain("references");
    const run = await api<ActionEntry>("POST", "/api/v1/server/docker/cleanup/images", {
      confirm: "images",
      items: preview.body.items.map((item) => item.id),
    });
    await waitForAction(run.body.id);
    expect(context.docker.removedImageReferences).toEqual(["opsifier/shop/web:latest"]);
  });
});
