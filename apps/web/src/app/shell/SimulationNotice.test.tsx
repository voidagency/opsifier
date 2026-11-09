// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

afterEach(resetApp);

const projects = { projects: [], viewer: { admin: true, canCreate: true } };

describe("the simulated driver", () => {
  it("is announced on every screen", async () => {
    installFakeServer({
      "GET /projects": projects,
      "GET /system/info": { version: "1.0.0", serverIp: null, simulated: true },
    });
    const app = renderApp("/");

    expect(await screen.findByText("Simulated")).toBeTruthy();
    expect(screen.getByText(/nothing is deployed/)).toBeTruthy();

    await app.router.navigate({ to: "/activity" });
    await waitFor(() => expect(app.location()).toBe("/activity"));
    expect(screen.getByText("Simulated")).toBeTruthy();
  });

  it("is never mentioned on a real server", async () => {
    installFakeServer({
      "GET /projects": projects,
      "GET /system/info": { version: "1.0.0", serverIp: null, simulated: false },
    });
    renderApp("/");

    await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(screen.queryByText("Simulated")).toBeNull());
  });
});
