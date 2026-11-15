// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

afterEach(resetApp);

const deploy = {
  id: "a1",
  type: "service.deploy",
  title: "Deploy shop/web",
  status: "running",
  phase: null,
  projectName: "shop",
  serviceName: "web",
  createdAt: "2026-11-15T12:00:00.000Z",
  startedAt: "2026-11-15T12:00:01.000Z",
  finishedAt: null,
  error: null,
  hasLog: false,
  actorEmail: "admin@example.com",
  origin: "session",
  originDetail: null,
};

describe("the activity bar", () => {
  it("leads to the activity page when nothing runs, with no empty drawer", async () => {
    installFakeServer({ "GET /projects": { projects: [] } });
    const rendered = renderApp("/");

    const bar = await screen.findByRole("link", { name: /Nothing running/ });
    expect(screen.queryByRole("button", { name: /Show live log/ })).toBeNull();
    fireEvent.click(bar);

    await waitFor(() => expect(rendered.location()).toBe("/activity"));
  });

  it("opens what runs in its drawer", async () => {
    installFakeServer({
      "GET /projects": { projects: [] },
      "GET /actions": (_body: unknown, url: URL) => ({
        items: url.searchParams.get("status") === "running" ? [deploy] : [],
        nextCursor: null,
      }),
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: /Show live log/ }));

    const drawer = await screen.findByRole("region", { name: "Live activity log" });
    expect(drawer.textContent).toContain("Deploy shop/web");
  });
});
