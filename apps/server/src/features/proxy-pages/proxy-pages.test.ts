import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MaintenanceSettings } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";
import { escapeHtml, renderMaintenancePage, renderProxyPage } from "./render";
import { pickLanguage } from "./strings";

let context: TestContext;
let cookie: string;

const page = (path: string, headers: Record<string, string> = {}) => context.app.request(path, { headers });

const maintenance = (overrides: Partial<MaintenanceSettings> = {}): MaintenanceSettings => ({
  enabled: true,
  title: "Maint title",
  subtitle: "Back soon",
  customLogo: null,
  customCss: "",
  hideLogo: false,
  hideLinks: false,
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

const setMaintenance = (settings: Partial<MaintenanceSettings>) =>
  call(context.app, "/api/v1/projects/shop/services/web/maintenance", {
    method: "PUT",
    body: settings,
    cookie,
    origin: TEST_ORIGIN,
  });

describe("the panel's error pages", () => {
  it.each([
    ["bad-gateway", 502, "This site isn&#39;t answering"],
    ["not-found", 404, "Nothing at this address"],
    ["stopped", 503, "This site is switched off"],
  ])("serves the %s page with its status and no session", async (name, status, text) => {
    const response = await page(`/api/proxy-pages/${name}`);

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(text);
  });

  it("answers any method, because whatever was attempted lands here", async () => {
    const response = await context.app.request("/api/proxy-pages/not-found", { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("speaks French to a browser that prefers it", async () => {
    const response = await page("/api/proxy-pages/stopped", { "accept-language": "fr-FR,fr;q=0.9,en;q=0.5" });
    const html = await response.text();

    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("Ce site est à l'arrêt".replace("'", "&#39;"));
  });
});

describe("the maintenance page", () => {
  it("is 503 and shows the title and subtitle, without a session, only while enabled", async () => {
    expect((await page("/api/proxy-pages/maintenance/shop/web")).status).toBe(404);

    await setMaintenance({ enabled: true, title: "Maint title", subtitle: "Back soon" });
    const response = await page("/api/proxy-pages/maintenance/shop/web");
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("Maint title");
    expect(html).toContain("Back soon");

    await setMaintenance({ enabled: false, title: "Maint title", subtitle: "Back soon" });
    expect((await page("/api/proxy-pages/maintenance/shop/web")).status).toBe(404);
  });

  it("falls back to its own words when the fields are empty, in the visitor's language", async () => {
    await setMaintenance({ enabled: true });
    const french = await page("/api/proxy-pages/maintenance/shop/web", { "accept-language": "fr" });
    expect(await french.text()).toContain("Site en maintenance");
    const english = await page("/api/proxy-pages/maintenance/shop/web");
    expect(await english.text()).toContain("Down for maintenance");
  });

  it("treats unknown names and services as not found", async () => {
    for (const path of [
      "/api/proxy-pages/maintenance/shop/nope",
      "/api/proxy-pages/maintenance/NOT VALID/web",
    ]) {
      expect((await page(path)).status).toBe(404);
    }
  });
});

describe("rendering a maintenance page", () => {
  it("escapes the title and subtitle", () => {
    const html = renderMaintenancePage(
      maintenance({ title: '<img src=x onerror="alert(1)">', subtitle: "<b>bold</b>" }),
      "en",
    );

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("keeps stored CSS inside its style element, even if it tries to leave", () => {
    const html = renderMaintenancePage(maintenance({ customCss: "</STYLE><script>alert(1)</script>" }), "en");
    expect(html).not.toMatch(/<\/style><script/i);
  });

  it("uses a custom logo, and hides the logo and links on request", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const withLogo = renderMaintenancePage(maintenance({ customLogo: logo }), "en");
    expect(withLogo).toContain(`src="${logo}"`);

    const hidden = renderMaintenancePage(
      maintenance({ customLogo: logo, hideLogo: true, hideLinks: true }),
      "en",
    );
    expect(hidden).not.toContain("<img");
    expect(hidden).not.toContain('class="logo"');
    expect(hidden).not.toContain('class="links"');
  });

  it("shows the panel's mark and a retry link by default", () => {
    const html = renderMaintenancePage(maintenance(), "en");
    expect(html).toContain('class="logo"');
    expect(html).toContain("Try again");
  });

  it("draws exactly the panel's mark, as the favicon does, and nothing else", () => {
    const favicon = readFileSync(join(import.meta.dirname, "../../../../web/public/favicon.svg"), "utf8");
    const shapes = (svg: string) =>
      [...svg.matchAll(/<(circle|path)\b[^>]*>/g)].map(([tag]) =>
        tag.match(/ (cx|cy|r|d)="[^"]*"/g)?.join(""),
      );
    const mark = /<svg class="logo"[\s\S]*?<\/svg>/.exec(renderProxyPage("not-found", "en").html)?.[0] ?? "";

    expect(shapes(mark)).toEqual(shapes(favicon));
  });
});

describe("the language of a page", () => {
  it.each([
    [undefined, "en"],
    ["", "en"],
    ["de", "en"],
    ["fr", "fr"],
    ["FR-ca", "fr"],
    ["en;q=0.9,fr;q=0.8", "en"],
    ["fr;q=0.5,en;q=0.9", "en"],
    ["en;q=0,fr", "fr"],
  ])("for %j is %s", (header, language) => {
    expect(pickLanguage(header)).toBe(language);
  });
});

describe("escapeHtml", () => {
  it("escapes everything that matters in an attribute or in text", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("the pure page renderer", () => {
  it("has no trace of an outside asset", () => {
    for (const name of ["bad-gateway", "not-found", "stopped"] as const) {
      expect(renderProxyPage(name, "en").html).not.toMatch(/https?:\/\//);
    }
    expect(renderMaintenancePage(maintenance(), "fr")).not.toMatch(/https?:\/\//);
  });
});
