// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN, withStatus } from "../../testing/appHarness";

const status = (overrides: Record<string, unknown> = {}) => ({
  activeVersion: "1.0.0",
  managed: true,
  deployedImage: "ghcr.io/example/opsifier:1.0.0",
  latest: null,
  updateAvailable: false,
  checkedAt: "2026-11-08T00:00:00.000Z",
  checkError: null,
  checksEnabled: true,
  inProgress: null,
  last: null,
  rollback: null,
  ...overrides,
});

const release = {
  version: "1.1.0",
  image: "ghcr.io/example/opsifier:1.1.0",
  notes: "## Changes\n\n- Faster deployments",
  migrations: ["Adds a table for notes"],
  publishedAt: "2026-11-01T00:00:00.000Z",
};

const base = {
  "GET /system/info": { version: "1.0.0", serverIp: null, simulated: false },
  "GET /projects": { projects: [] },
};

afterEach(resetApp);

describe("the panel's version", () => {
  it("shows the version on every page, and nothing more to a member", async () => {
    installFakeServer({
      ...base,
      "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } },
    });
    renderApp("/");

    expect(await screen.findByText("v1.0.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("reports that there is no update, without changing anything", async () => {
    const server = installFakeServer({
      ...base,
      "GET /system/update": status(),
      "POST /system/update/check": status({ checkedAt: "2026-11-08T01:00:00.000Z" }),
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("No update available")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/system/update/check",
    ]);
  });

  it("explains a check that could not be made", async () => {
    installFakeServer({
      ...base,
      "GET /system/update": status(),
      "POST /system/update/check": status({ checkError: "The release feed could not be read: offline" }),
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("The release feed could not be read: offline")).toBeTruthy();
  });

  it("shows the notes and data changes before updating, and confirms by typing a word", async () => {
    const server = installFakeServer({
      ...base,
      "GET /system/update": status({ latest: release, updateAvailable: true }),
      "POST /system/update": withStatus(202, {
        id: "a1",
        type: "panel.update",
        title: "Update",
        status: "queued",
        projectName: null,
        serviceName: null,
        actorEmail: null,
        hasLog: false,
        createdAt: "2026-11-08T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
      }),
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "Update to 1.1.0" }));

    expect(await screen.findByText("Faster deployments")).toBeTruthy();
    expect(screen.getByText("Adds a table for notes")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Update the panel" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "update" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path === "/system/update")?.body,
      ).toEqual({
        version: "1.1.0",
        confirm: "update",
      }),
    );
  });

  describe("while an update runs", () => {
    const started = {
      id: "a1",
      type: "panel.update",
      title: "Update",
      status: "running",
      projectName: null,
      serviceName: null,
      actorEmail: null,
      hasLog: true,
      createdAt: "2026-11-08T00:00:00.000Z",
      startedAt: "2026-11-08T00:00:00.000Z",
      finishedAt: null,
      error: null,
    };
    const lastFailure = {
      kind: "update",
      result: "rolled-back",
      fromVersion: "0.9.0",
      toVersion: "1.0.0",
      digest: null,
      sizeBytes: null,
      finishedAt: "2026-11-01T00:00:00.000Z",
      message: "An older failure",
    };

    async function startUpdate(server: ReturnType<typeof installFakeServer>) {
      fireEvent.click(await screen.findByRole("button", { name: "Update to 1.1.0" }));
      fireEvent.change(await screen.findByRole("textbox"), { target: { value: "update" } });
      const confirm = (await screen.findByRole("button", { name: "Update the panel" })) as HTMLButtonElement;
      await waitFor(() => expect(confirm.disabled).toBe(false));
      fireEvent.click(confirm);
      await waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
    }

    it("does not report the previous outcome just because the update has only begun", async () => {
      const server = installFakeServer({
        ...base,
        "GET /system/update": status({ latest: release, updateAvailable: true, last: lastFailure }),
        "POST /system/update": withStatus(202, started),
        "GET /actions/a1": started,
      });
      renderApp("/");

      await startUpdate(server);

      expect(await screen.findByText(/Saving the panel's data and starting 1.1.0/)).toBeTruthy();
      expect(screen.queryByText(/did not start/)).toBeNull();
    });

    it("says so when the update failed before the panel restarted", async () => {
      const server = installFakeServer({
        ...base,
        "GET /system/update": status({ latest: release, updateAvailable: true }),
        "POST /system/update": withStatus(202, started),
        "GET /actions/a1": { ...started, status: "failed", error: "manifest unknown" },
      });
      renderApp("/");

      await startUpdate(server);

      expect(
        await screen.findByText("The update could not start", undefined, { timeout: 6000 }),
      ).toBeTruthy();
      expect(screen.getByText("manifest unknown")).toBeTruthy();
    });
  });

  it("does not offer an update that the panel cannot apply to itself", async () => {
    installFakeServer({
      ...base,
      "GET /system/update": status({ latest: release, updateAvailable: true, managed: false }),
    });
    renderApp("/");

    await screen.findByText("v1.0.0");

    expect(screen.queryByRole("button", { name: "Update to 1.1.0" })).toBeNull();
  });

  it("offers the way back after an update", async () => {
    installFakeServer({
      ...base,
      "GET /system/update": status({
        last: {
          kind: "update",
          result: "succeeded",
          fromVersion: "0.9.0",
          toVersion: "1.0.0",
          digest: "sha256:abc",
          sizeBytes: 1024,
          finishedAt: "2026-11-08T00:00:00.000Z",
          message: null,
        },
        rollback: { version: "0.9.0", restoresData: true, savedAt: "2026-11-07T00:00:00.000Z" },
      }),
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "v1.0.0" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go back to 0.9.0" }));

    expect(await screen.findByText(/changes made in the panel since then are lost/)).toBeTruthy();
  });
});
