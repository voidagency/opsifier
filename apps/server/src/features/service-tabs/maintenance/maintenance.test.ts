import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, MaintenanceSettings } from "@opsifier/contract";
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
      routers: Record<string, { service: string; middlewares?: string[] }>;
      middlewares?: Record<string, unknown>;
    };
  };

const settings = (overrides: Partial<MaintenanceSettings> = {}) => ({
  enabled: true,
  title: "Maint title",
  subtitle: "Back soon",
  ...overrides,
});

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

describe("the maintenance tab", () => {
  it("starts off with the fields empty", async () => {
    expect((await api<MaintenanceSettings>("/maintenance")).body).toEqual({
      enabled: false,
      title: "",
      subtitle: "",
      customLogo: null,
      customCss: "",
      hideLogo: false,
      hideLinks: false,
    });
  });

  it("switches every router to the page when enabled, and keeps the fields", async () => {
    const saved = await api<MaintenanceSettings>("/maintenance", "PUT", settings());

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject(settings());

    const { http } = proxyFile();
    expect(http.middlewares?.["opsifier-maintenance-shop_web"]).toEqual({
      replacePath: { path: "/api/proxy-pages/maintenance/shop/web" },
    });
    for (const router of Object.values(http.routers)) {
      expect(router.service).toBe("opsifier-panel");
      expect(router.middlewares?.at(-1)).toBe("opsifier-maintenance-shop_web");
    }
  });

  it("restores the routers when disabled, keeping title and subtitle", async () => {
    await api("/maintenance", "PUT", settings());
    const saved = await api<MaintenanceSettings>("/maintenance", "PUT", settings({ enabled: false }));

    expect(saved.body.title).toBe("Maint title");
    const { http } = proxyFile();
    expect(http.middlewares ?? {}).toEqual({});
    for (const router of Object.values(http.routers)) {
      expect(router.service).toBe("shop_web-0");
    }
  });

  it("never touches the Swarm service", async () => {
    await api("/source", "PUT", { image: "traefik/whoami:v1.10" });
    const accepted = await api<ActionEntry>("/deploy", "POST");
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await call<ActionEntry>(context.app, `/api/v1/actions/${accepted.body.id}`, {
        cookie,
      });
      if (body.status === "succeeded") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const before = await context.docker.inspectService("shop_web");

    await api("/maintenance", "PUT", settings());
    await api("/maintenance", "PUT", settings({ enabled: false }));

    expect((await context.docker.inspectService("shop_web"))?.version).toBe(before?.version);
  });

  it("stores the extra page options", async () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const saved = await api<MaintenanceSettings>(
      "/maintenance",
      "PUT",
      settings({ customLogo: logo, customCss: "body { color: red; }", hideLogo: true, hideLinks: true }),
    );

    expect(saved.body).toMatchObject({ customLogo: logo, hideLogo: true, hideLinks: true });
    expect((await api<MaintenanceSettings>("/maintenance")).body.customCss).toBe("body { color: red; }");
  });

  it.each([
    [{ title: "x".repeat(201) }, "title"],
    [{ subtitle: "x".repeat(201) }, "subtitle"],
    [{ customCss: "</style><script>alert(1)</script>" }, "customCss"],
    [{ customCss: "x".repeat(17 * 1024) }, "customCss"],
    [{ customLogo: "https://example.com/logo.png" }, "customLogo"],
    [{ customLogo: "javascript:alert(1)" }, "customLogo"],
    [{ customLogo: "data:text/html;base64,PHNjcmlwdD4=" }, "customLogo"],
  ])("rejects %j", async (body, field) => {
    const result = await api("/maintenance", "PUT", settings(body));

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeTruthy();
  });

  it("answers 404 for a service that does not exist", async () => {
    const result = await call(context.app, "/api/v1/projects/shop/services/nope/maintenance", { cookie });
    expect(result.status).toBe(404);
  });
});
