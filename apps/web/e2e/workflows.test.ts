/**
 * Real workflows in a real browser: by keyboard, at phone width and at 200% zoom, plus an axe
 * accessibility pass over the main screens in both themes. Everything else in the suite runs in
 * jsdom, which has no layout, no colours and no real focus handling, so none of this can be seen
 * from there.
 *
 * Run it against a panel on the fake driver, with Chrome installed:
 *
 *   OPSIFIER_E2E_WEB_URL=http://127.0.0.1:5173 OPSIFIER_E2E_SETUP_TOKEN=<token> bunx vitest run apps/web/e2e
 *
 * The setup token claims a fresh panel, by keyboard. Use OPSIFIER_E2E_EMAIL and OPSIFIER_E2E_PASSWORD
 * for a panel that is already claimed. It is skipped when no URL is set, as the Docker suite is.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const BASE = process.env.OPSIFIER_E2E_WEB_URL;
const SETUP_TOKEN = process.env.OPSIFIER_E2E_SETUP_TOKEN;
const EMAIL = process.env.OPSIFIER_E2E_EMAIL;
const PASSWORD = process.env.OPSIFIER_E2E_PASSWORD;

const PHONE = { width: 390, height: 844 };
/** A 1280 by 800 window at 200% zoom shows half as many CSS pixels. */
const ZOOM_200 = { width: 640, height: 400 };
const DESKTOP = { width: 1280, height: 900 };

const runId = randomBytes(3).toString("hex");
const project = `kbd-${runId}`;
const service = `web-${runId}`;
/** Longer than the breadcrumb has room for at 200% zoom. */
const LONG_SERVICE = `a-service-with-quite-a-long-name-${runId}`;
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** Whatever axe is sure of, in the WCAG 2.0, 2.1 and 2.2 A and AA tags. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface Screen {
  name: string;
  path: string;
  setUp?: () => Promise<void>;
}

let browser: Browser;
let context: BrowserContext;
let page: Page;

async function open(path: string): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await settle();
}

/** The live feeds never go fully quiet, so this waits for a moment of calm and moves on. */
async function settle(): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
}

async function tabTo(target: Locator): Promise<void> {
  await target.waitFor({ state: "attached" });
  for (let press = 0; press < 120; press += 1) {
    const focused = await target.evaluate(
      (element) => element === document.activeElement || element.contains(document.activeElement),
    );
    if (focused) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${String(target)}`);
}

/** Menus move with the arrow keys, as any desktop menu does. */
async function arrowTo(item: Locator): Promise<void> {
  await item.waitFor({ state: "attached" });
  for (let press = 0; press < 40; press += 1) {
    if (await item.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`The arrow keys never reached ${String(item)}`);
}

async function press(target: Locator, key = "Enter"): Promise<void> {
  await tabTo(target);
  await page.keyboard.press(key);
}

async function typeInto(field: Locator, text: string): Promise<void> {
  await tabTo(field);
  await page.keyboard.type(text);
}

/** Nothing may need scrolling sideways, at any width. */
async function expectNoSidewaysScroll(): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `the page is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(
    innerWidth,
  );
}

/** A service refuses a new destructive action while something is running on it. */
async function waitUntilIdle(serviceName: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ([projectName, name]) => {
            const response = await fetch(`/api/v1/projects/${projectName}/services/${name}`);
            return ((await response.json()) as { activeAction: unknown }).activeAction ?? null;
          },
          [project, serviceName] as const,
        ),
      { timeout: 60_000 },
    )
    .toBeNull();
}

async function expectInsideWindow(target: Locator): Promise<void> {
  await expect
    .poll(() => target.boundingBox())
    .toMatchObject({
      x: expect.any(Number),
    });
  const box = await target.boundingBox();
  const { width, height } = page.viewportSize() as { width: number; height: number };
  expect(box, "the element must be on the page").not.toBeNull();
  const { x, y, width: boxWidth, height: boxHeight } = box as NonNullable<typeof box>;
  expect(x, "starts past the left edge").toBeGreaterThanOrEqual(0);
  expect(y, "starts above the top edge").toBeGreaterThanOrEqual(0);
  expect(x + boxWidth, "runs past the right edge").toBeLessThanOrEqual(width);
  expect(y + boxHeight, "runs past the bottom edge").toBeLessThanOrEqual(height);
}

/** The breadcrumb's names are cut short when there is no room, and must never run into each other. */
async function expectCrumbsApart(): Promise<void> {
  const boxes = await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .locator("li:visible")
    .evaluateAll((items) =>
      items.map((item) => {
        const { left, right } = item.getBoundingClientRect();
        return { left, right };
      }),
    );
  for (const [index, box] of boxes.entries()) {
    const previous = boxes[index - 1];
    if (previous !== undefined) {
      expect(box.left, "breadcrumb names overlap").toBeGreaterThanOrEqual(previous.right);
    }
  }
}

async function axeViolations(): Promise<unknown[]> {
  // Nothing should be measured with a focus ring or a focused skip link in the way.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(axeSource);
  return page.evaluate(async (values: string[]) => {
    const axe = (
      window as unknown as { axe: { run: (context: Document, options: object) => Promise<unknown> } }
    ).axe;
    const results = (await axe.run(document, { runOnly: { type: "tag", values } })) as {
      violations: Array<{ id: string; nodes: Array<{ html: string; failureSummary?: string }> }>;
    };
    return results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({ html: node.html.slice(0, 200), why: node.failureSummary })),
    }));
  }, WCAG_TAGS);
}

function setTheme(theme: "light" | "dark"): Promise<void> {
  return page.evaluate((value) => {
    localStorage.setItem("opsifier.theme", value);
    document.documentElement.dataset.theme = value;
  }, theme);
}

const suite = BASE === undefined ? describe.skip : describe;

suite("real workflows in a browser", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    // Reduced motion: what axe measures has to be the settled screen, not a dialog still fading in.
    context = await browser.newContext({
      viewport: PHONE,
      locale: "en-US",
      timezoneId: "Europe/Paris",
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("opsifier.theme", "light");
      } catch {
        // Only the theme of the first paint depends on this.
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("claims a fresh panel, or signs in, without touching the mouse", async () => {
    if (SETUP_TOKEN !== undefined) {
      await open(`/setup?token=${SETUP_TOKEN}`);
      expect(await axeViolations()).toEqual([]);
      await typeInto(page.getByLabel("Name", { exact: true }), "Keyboard Owner");
      await typeInto(page.getByLabel("Email", { exact: true }), `owner-${runId}@example.com`);
      await typeInto(page.getByLabel("Password", { exact: true }), `a-long-enough-password-${runId}`);
      await press(page.getByRole("button", { name: "Create account" }));
    } else {
      await open("/login");
      expect(await axeViolations()).toEqual([]);
      await typeInto(page.getByLabel("Email", { exact: true }), EMAIL as string);
      await typeInto(page.getByLabel("Password", { exact: true }), PASSWORD as string);
      await page.keyboard.press("Enter");
    }
    await page.waitForURL(`${BASE}/`);
    await expectNoSidewaysScroll();
    if (SETUP_TOKEN !== undefined) {
      // A new panel asks what the server is for on every visit until that is answered.
      await page.evaluate(() =>
        fetch("/api/v1/server-purpose", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "development" }),
        }),
      );
    }
  });

  it("creates a project and an app, deploys it and follows the deployment, on a phone, by keyboard", async () => {
    await page.setViewportSize(PHONE);
    await open("/");
    await press(page.getByRole("button", { name: "New project" }));
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.waitFor();
    await expect.poll(() => dialog.locator(":focus").count()).toBe(1);
    await typeInto(dialog.getByLabel("Project name"), project);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${BASE}/projects/${project}`);
    await expectNoSidewaysScroll();

    await press(page.getByRole("link", { name: "Add service" }));
    await page.waitForURL(`${BASE}/projects/${project}/create`);
    await press(page.getByRole("button", { name: /^App/ }));
    const create = page.getByRole("dialog", { name: "Add an app" });
    await create.waitFor();
    await expectNoSidewaysScroll();
    await typeInto(create.getByLabel("Name"), service);
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/projects/${project}/app/${service}/init/source`));

    const image = page.getByRole("textbox", { name: "Image", exact: true });
    await typeInto(image, "traefik/whoami:v1.10");
    await press(page.getByRole("button", { name: "Save" }));
    await page.getByText("Source saved").first().waitFor();

    await open(`/projects/${project}/app/${service}`);
    await expectNoSidewaysScroll();
    await press(page.getByRole("button", { name: "Deploy", exact: true }));
    await expect
      .poll(async () => page.getByRole("img", { name: /Running/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expectNoSidewaysScroll();

    await page.getByText("Simulated", { exact: true }).first().waitFor();

    await press(page.getByRole("button", { name: "Show live log" }));
    await page.getByRole("region", { name: "Live activity log" }).waitFor();
    await expectNoSidewaysScroll();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("region", { name: "Live activity log" }).count()).toBe(0);
    await expect
      .poll(() =>
        page.getByRole("button", { name: "Show live log" }).evaluate((el) => el === document.activeElement),
      )
      .toBe(true);
  });

  it("confirms a destructive action by typing, by keyboard, with focus back on what opened it", async () => {
    await page.setViewportSize(PHONE);
    await open(`/projects/${project}/app/${service}`);
    await press(page.getByRole("button", { name: "More actions" }));
    await page.getByRole("menuitem", { name: "Notes" }).waitFor();
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.getByRole("button", { name: "More actions" }).evaluate((el) => el === document.activeElement),
      )
      .toBe(true);

    await press(page.getByRole("button", { name: "More actions" }));
    await arrowTo(page.getByRole("menuitem", { name: "Destroy service" }));
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await typeInto(dialog.getByRole("textbox"), service);
    await expectNoSidewaysScroll();
    await expectInsideWindow(dialog);
    await waitUntilIdle(service);
    await press(dialog.getByRole("button", { name: "Destroy" }));
    await page.waitForURL(`${BASE}/projects/${project}`, { timeout: 60_000 });
  });

  it("creates another service with a very long name, for the screens that follow", async () => {
    await open(`/projects/${project}/create`);
    await press(page.getByRole("button", { name: /^App/ }));
    const create = page.getByRole("dialog", { name: "Add an app" });
    await create.waitFor();
    await typeInto(create.getByLabel("Name"), LONG_SERVICE);
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/projects/${project}/app/${LONG_SERVICE}/init/source`));
    await typeInto(page.getByRole("textbox", { name: "Image", exact: true }), "traefik/whoami:v1.10");
    await press(page.getByRole("button", { name: "Save" }));
    await page.getByText("Source saved").first().waitFor();
    await open(`/projects/${project}/app/${LONG_SERVICE}`);
    await press(page.getByRole("button", { name: "Deploy", exact: true }));
    await expect
      .poll(async () => page.getByRole("button", { name: "Console" }).getAttribute("aria-disabled"), {
        timeout: 30_000,
      })
      .toBeNull();
  });

  it("keeps labels, errors, logs and buttons readable at 200% zoom, with no sideways scroll, in both themes", async () => {
    await page.setViewportSize(ZOOM_200);
    for (const theme of ["light", "dark"] as const) {
      await open("/");
      await setTheme(theme);
      await open(`/projects/${project}`);
      await expectNoSidewaysScroll();
      await expectCrumbsApart();

      // An error next to its field is the thing most likely to be pushed off the screen.
      await open(`/projects/${project}/create`);
      await press(page.getByRole("button", { name: /^App/ }));
      const dialog = page.getByRole("dialog", { name: "Add an app" });
      await dialog.waitFor();
      await typeInto(dialog.getByLabel("Name"), "NOT VALID");
      await page.keyboard.press("Enter");
      const error = dialog.getByText("Use lowercase letters", { exact: false });
      await error.waitFor();
      await expectInsideWindow(dialog);
      await expectInsideWindow(error);
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);

      await open(`/projects/${project}/app/${LONG_SERVICE}`);
      await expectNoSidewaysScroll();
      await expectCrumbsApart();
      const deploy = page.getByRole("button", { name: "Deploy", exact: true });
      await deploy.scrollIntoViewIfNeeded();
      await expectInsideWindow(deploy);
      // A log is taller than a zoomed window on purpose. It must start on screen and fit its width.
      const logs = page.getByRole("log").first();
      await logs.scrollIntoViewIfNeeded();
      const box = await logs.boundingBox();
      expect(box?.y ?? -1).toBeLessThan(ZOOM_200.height);
      expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(ZOOM_200.width);
    }
  });

  it("switches the theme from the menu, and nothing goes missing", async () => {
    await page.setViewportSize(ZOOM_200);
    await open("/");
    await setTheme("light");
    await press(page.getByRole("button", { name: "Account menu" }));
    const menu = page.getByRole("menu");
    await menu.waitFor();
    await arrowTo(menu.getByRole("menuitemradio", { name: "Dark" }));
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expectNoSidewaysScroll();
    expect(await axeViolations()).toEqual([]);
  });

  describe.each([
    ["light", DESKTOP],
    ["dark", DESKTOP],
    ["dark", PHONE],
  ] as const)("axe finds nothing on the main screens in the %s theme", (theme, viewport) => {
    const screens: readonly Screen[] = [
      { name: "overview", path: "/" },
      { name: "project", path: `/projects/${project}` },
      { name: "project settings", path: `/projects/${project}/settings` },
      { name: "create a service", path: `/projects/${project}/create` },
      { name: "a service", path: `/projects/${project}/app/${LONG_SERVICE}` },
      { name: "activity", path: "/activity" },
      { name: "monitor", path: "/monitor" },
      { name: "domains", path: "/domains" },
      { name: "sign-in settings", path: "/settings/user/authentication" },
      { name: "server settings", path: "/settings/server/general" },
      { name: "users", path: "/settings/server/users" },
      { name: "notifications", path: "/settings/server/notifications" },
      { name: "server purpose", path: "/settings/server/purpose" },
      {
        name: "the command palette",
        path: "/",
        setUp: async () => {
          await page.keyboard.press("ControlOrMeta+k");
          await page.getByRole("dialog", { name: "Command palette" }).waitFor();
        },
      },
      {
        name: "the new project dialog",
        path: "/",
        setUp: async () => {
          await page.getByRole("button", { name: "New project" }).click();
          await page.getByRole("dialog", { name: "New project" }).waitFor();
        },
      },
      {
        name: "the console",
        path: `/projects/${project}/app/${LONG_SERVICE}`,
        setUp: async () => {
          await page.getByRole("button", { name: "Console" }).click();
          await page.getByRole("dialog").waitFor();
        },
      },
      {
        name: "the live log drawer",
        path: "/",
        setUp: async () => {
          await page.getByRole("button", { name: "Show live log" }).click();
          await page.getByRole("region", { name: "Live activity log" }).waitFor();
        },
      },
    ];

    // Live pages under a loaded machine can stall a browser for a moment, so one retry is allowed.
    it.each(screens)(`$name (${viewport.width}px)`, { retry: 1 }, async ({ path, setUp }) => {
      await page.setViewportSize(viewport);
      await open(path);
      await setTheme(theme);
      await page.reload();
      await settle();
      await page.waitForTimeout(300);
      await setUp?.();
      await expectNoSidewaysScroll();
      expect(await axeViolations()).toEqual([]);
    });
  });
});
