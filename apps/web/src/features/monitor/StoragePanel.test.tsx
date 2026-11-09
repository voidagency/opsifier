// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const report = (dockerDisk: unknown) => ({
  "GET /monitor/storage": {
    scannedAt: "2026-01-01T00:00:00.000Z",
    scanning: false,
    disk: { usedBytes: 1000, totalBytes: 4000, path: "/var/lib/opsifier" },
    dockerDisk,
    docker: { imagesBytes: 100, containersBytes: 10, volumesBytes: 5, buildCacheBytes: 1 },
    services: [],
  },
});

const noVolumes = { "GET /retained-volumes": { volumes: [] } };

const kept = {
  name: "shop_web_uploads",
  projectName: "shop",
  serviceName: "web",
  kind: "app",
  retainedAt: "2026-01-01T00:00:00.000Z",
};

async function openStorage() {
  renderApp("/monitor");
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Storage" }));
}

describe("the storage tab", () => {
  it("shows Docker's own disk beside the panel's", async () => {
    installFakeServer({
      ...noVolumes,
      ...report({
        usedBytes: 2 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        freeBytes: 6 * 1024 ** 3,
        path: "/mnt/docker",
      }),
    });
    await openStorage();

    expect(await screen.findByRole("meter", { name: "Docker disk" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Panel disk" })).toBeTruthy();
    expect(screen.getByText("/mnt/docker")).toBeTruthy();
    expect(screen.getByText("2.0 GB / 8.0 GB")).toBeTruthy();
  });

  it("says so when Docker's disk can't be read, instead of drawing another disk", async () => {
    installFakeServer({ ...noVolumes, ...report(null) });
    await openStorage();

    expect(await screen.findByText("Docker's disk can't be measured from here.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Docker disk: No data" })).toBeTruthy();
  });

  it("says when nothing is being kept", async () => {
    installFakeServer({ ...noVolumes, ...report(null) });
    await openStorage();

    expect(await screen.findByText("No volume is being kept.")).toBeTruthy();
  });

  it("shows an error when the list can't be read", async () => {
    installFakeServer({
      ...report(null),
      "GET /retained-volumes": withStatus(502, {
        error: { code: "docker_error", message: "Docker is away." },
      }),
    });
    await openStorage();

    expect(await screen.findByText("Docker refused this. Check the server's Docker daemon.")).toBeTruthy();
  });

  it("lists what is kept and deletes one only with its exact name, saying what goes and stays", async () => {
    const server = installFakeServer({
      ...report(null),
      "GET /retained-volumes": { volumes: [kept] },
      "DELETE /retained-volumes/shop_web_uploads": {
        id: "a1",
        type: "volume.delete",
        title: "Delete the kept volume shop_web_uploads",
        status: "queued",
        projectName: "shop",
        serviceName: "web",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
        hasLog: false,
        actorEmail: null,
      },
    });
    await openStorage();

    expect(await screen.findByText("shop_web_uploads")).toBeTruthy();
    expect(screen.getByText("shop / web")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this volume?" });
    expect(dialog.textContent).toContain("This volume and everything it holds");
    expect(dialog.textContent).toContain("Backups of the service it came from");
    const confirm = within(dialog).getByRole("button", { name: "Delete volume" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "shop_web_uploads" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({
        confirm: "shop_web_uploads",
      }),
    );
  });
});
