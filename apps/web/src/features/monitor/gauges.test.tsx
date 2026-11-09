// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../testing/appHarness";

afterEach(resetApp);

const SYSTEM = {
  readAt: "2026-01-01T12:00:00.000Z",
  origin: "host",
  cpu: { percent: 12.5, cores: 4, load: [0.5, 0.25, 0.75] },
  memory: { usedBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 25 },
  disk: { usedBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, percent: 50, path: "/var/lib/opsifier" },
  network: { scope: "containers", origin: "docker", rxBytesPerSecond: 1024, txBytesPerSecond: 2048 },
  docker: { available: true, lastSeenAt: "2026-01-01T12:00:00.000Z" },
};

const HISTORY = { range: "24h", step: "5m", stepSeconds: 300, points: [] };

const routes = (system: unknown = SYSTEM) => ({
  "GET /monitor/system": system,
  "GET /monitor/system/history": HISTORY,
  "GET /projects": { projects: [] },
});

describe("the server gauges", () => {
  it("show every reading with its detail", async () => {
    installFakeServer(routes());
    renderApp("/");
    expect(await screen.findByRole("meter", { name: "CPU" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Memory" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Disk" })).toBeTruthy();
    expect(screen.getByText("4 cores")).toBeTruthy();
    expect(screen.getByText(/0\.50\s+0\.25\s+0\.75/)).toBeTruthy();
    expect(screen.getByText("2.0 GB / 8.0 GB")).toBeTruthy();
    expect(screen.getByText("3.0 KB/s")).toBeTruthy();
  });

  it("draw a missing reading as no data, never as zero", async () => {
    installFakeServer(
      routes({
        ...SYSTEM,
        cpu: { percent: null, cores: null, load: null },
        network: { scope: "containers", origin: "docker", rxBytesPerSecond: null, txBytesPerSecond: null },
        docker: { available: false, lastSeenAt: "2026-01-01T12:00:00.000Z" },
      }),
    );
    renderApp("/");
    expect(await screen.findByLabelText("CPU: No data")).toBeTruthy();
    expect(screen.getByText(/Docker down since .*(2026|26)/)).toBeTruthy();
    expect(screen.queryByText("0 B/s")).toBeNull();
    expect(screen.queryByText("0 cores")).toBeNull();
    expect(screen.getAllByText("No data").length).toBeGreaterThan(0);
  });

  it("date the reading and say where it came from", async () => {
    installFakeServer(routes());
    renderApp("/");
    await screen.findByRole("meter", { name: "CPU" });

    const stamp = screen.getByTitle("This server");

    expect(stamp.textContent).toMatch(/2026|26/);
  });

  it("are not shown to members, and the Monitor page says why", async () => {
    installFakeServer({
      ...routes(),
      "GET /auth/session": {
        status: "signed-in",
        user: { ...SIGNED_IN.user, role: "member" },
      },
    });
    renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.queryByRole("meter", { name: "CPU" })).toBeNull();

    const monitor = renderApp("/monitor");
    await waitFor(() => expect(monitor.location()).toBe("/monitor"));
    expect(await screen.findByText("Administrators only")).toBeTruthy();
  });
});
