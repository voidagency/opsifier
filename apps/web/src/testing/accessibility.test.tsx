// @vitest-environment jsdom
import "./browser-stubs";
import { screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp } from "./appHarness";

afterEach(resetApp);

// axe looks for canvas support, which jsdom only announces it does not have.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

/**
 * The structural half of an accessibility pass, on every test run: names, roles, labels, landmarks
 * and ARIA. Colour contrast needs a real browser, and has its own pass in `apps/web/e2e`.
 */
async function violations(): Promise<string[]> {
  const { violations } = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    // Canvas and pseudo-element colours are not computed in jsdom.
    rules: { "color-contrast": { enabled: false } },
  });
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.html.slice(0, 160)}`),
  );
}

const service = {
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "nginx:alpine", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: "https://shop-web.example.test/",
};

const metrics = {
  cpuPercent: 1,
  cpuCapacityPercent: 100,
  memoryUsedBytes: 100,
  memoryLimitBytes: 1000,
  networkRxBytes: 0,
  networkTxBytes: 0,
  readAt: "2026-01-01T00:00:00.000Z",
};

const routes: FakeRoute = {
  "GET /projects": {
    projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [service] }],
    viewer: { admin: true, canCreate: true },
  },
  "GET /projects/shop/services/web": service,
  "GET /projects/shop/services/web/metrics": metrics,
  "GET /server-purpose": {
    purpose: "production",
    protection: false,
    domains: [],
    protectedCount: 0,
    totalCount: 0,
    problems: [],
    confirmation: "PUBLIC 0",
  },
};

describe("no structural accessibility problem on the main screens", () => {
  it.each([
    ["the overview", "/", "Overview"],
    ["the activity page", "/activity", "Activity"],
    ["a service page", "/projects/shop/app/web", "web"],
  ])("%s", async (_name, path, heading) => {
    installFakeServer(routes);
    renderApp(path);

    await screen.findAllByText(heading);
    await waitFor(async () => expect(await violations()).toEqual([]), { timeout: 4000 });
  });

  it("the sign-in page", async () => {
    installFakeServer({ "GET /auth/session": { status: "signed-out" } });
    renderApp("/login");

    await screen.findByRole("heading", { level: 1 });
    expect(await violations()).toEqual([]);
  });

  it("a dialog, once it is open", async () => {
    installFakeServer(routes);
    renderApp("/");
    await screen.findAllByText("Overview");

    (await screen.findByRole("button", { name: "New project" })).click();
    await screen.findByRole("dialog");

    expect(await violations()).toEqual([]);
  });
});
