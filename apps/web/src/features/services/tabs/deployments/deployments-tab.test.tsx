// @vitest-environment jsdom
import "../../../../testing/browser-stubs";
import type { DeploymentEntry, ReleaseEntry, ServiceDetail } from "@opsifier/contract";
import { rollbackActionType } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp } from "../../../../testing/appHarness";

afterEach(resetApp);

const SERVICE = "/projects/shop/services/web";

const detail = (overrides: Partial<ServiceDetail> = {}): ServiceDetail => ({
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "nginx:1.27", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: null,
  pendingChanges: false,
  answering: null,
  ...overrides,
});

const release = (number: number, overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  number,
  active: false,
  image: `nginx:1.${25 + number}`,
  imageId: `sha256:${String(number).repeat(64)}`,
  digest: `nginx@sha256:${String(number).repeat(64)}`,
  sizeBytes: 50 * 1024 * 1024,
  requestedRef: null,
  builtCommit: null,
  ociRevision: null,
  rollbackOf: null,
  actorEmail: "ada@example.com",
  actionId: `a${number}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  refusal: null,
  ...overrides,
});

const deployment = (overrides: Partial<DeploymentEntry> = {}): DeploymentEntry => ({
  id: "d1",
  type: "service.deploy",
  title: "Deploy shop/web",
  status: "succeeded",
  projectName: "shop",
  serviceName: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:08.000Z",
  error: null,
  hasLog: true,
  actorEmail: "ada@example.com",
  origin: "session",
  originDetail: null,
  phase: null,
  deployment: null,
  ...overrides,
});

const routes = (extra: FakeRoute = {}, service = detail()): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  [`GET ${SERVICE}`]: service,
  [`GET ${SERVICE}/metrics`]: {
    cpuPercent: 1.5,
    memoryUsedBytes: 1024,
    networkRxBytes: 2048,
    networkTxBytes: 4096,
    readAt: "2026-01-01T00:00:00.000Z",
  },
  [`GET ${SERVICE}/deployments`]: { items: [deployment()], nextCursor: null },
  [`GET ${SERVICE}/deployments/trigger`]: {
    path: "/api/v1/deploy",
    hasToken: false,
    legacyUrl: false,
    createdAt: null,
    webhook: null,
    webhookAvailable: false,
  },
  ...extra,
});

function versions(items: ReleaseEntry[], keep = 5): FakeRoute {
  return { [`GET ${SERVICE}/releases`]: { available: true, items, keep } };
}

const tab = "/projects/shop/app/web/deployments";

describe("the versions a service keeps", () => {
  it("marks the one running, and says why another can't be gone back to", async () => {
    installFakeServer(
      routes(
        versions([
          release(3, { active: true, refusal: "active" }),
          release(2),
          release(1, { refusal: "image_missing" }),
        ]),
      ),
    );
    renderApp(tab);

    expect(await screen.findByText("Active")).toBeTruthy();
    expect(screen.getByText("Kept")).toBeTruthy();
    expect(screen.getByText("Image gone")).toBeTruthy();
    expect(document.querySelector('[data-state="running"]')).toBeTruthy();
    expect(document.querySelector('[data-state="degraded"]')).toBeTruthy();

    const goBack = screen.getAllByRole("button", { name: "Go back" });
    expect(goBack).toHaveLength(2);
    expect((goBack[0] as HTMLButtonElement).disabled).toBe(false);
    expect((goBack[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("says how many it keeps, against the limit", async () => {
    installFakeServer(routes(versions([release(1, { active: true, refusal: "active" })], 3)));
    renderApp(tab);

    expect(await screen.findByRole("meter", { name: "1 of 3 versions kept" })).toBeTruthy();
  });

  it("shows nothing for a service that has no versions", async () => {
    installFakeServer(routes({ [`GET ${SERVICE}/releases`]: { available: false, items: [], keep: 5 } }));
    renderApp(tab);

    expect(await screen.findByText("Settled")).toBeTruthy();
    expect(screen.queryByText("Versions")).toBeNull();
  });

  it("shows the commit and where a rollback went", async () => {
    installFakeServer(
      routes(
        versions([
          release(2, { active: true, refusal: "active", rollbackOf: 1, builtCommit: "a".repeat(40) }),
          release(1, { builtCommit: "a".repeat(40) }),
        ]),
      ),
    );
    renderApp(tab);

    expect(await screen.findByText("Back to #1")).toBeTruthy();
    expect(screen.getAllByText("a".repeat(12))).toHaveLength(2);
  });

  it("lists a rollback in the history as a new attempt", async () => {
    installFakeServer(
      routes({
        ...versions([]),
        [`GET ${SERVICE}/deployments`]: {
          items: [
            deployment({
              type: rollbackActionType,
              deployment: {
                requestedRef: null,
                builtCommit: null,
                ociRevision: null,
                image: "nginx:1.26",
                imageId: "sha256:aaa",
                digest: "nginx@sha256:aaa",
                release: 3,
                rollbackOf: 1,
                answering: true,
                runningTasks: 1,
                desiredTasks: 1,
              },
            }),
          ],
          nextCursor: null,
        },
      }),
    );
    renderApp(tab);

    expect(await screen.findByText("Back to #1")).toBeTruthy();
    expect(screen.getByText("nginx:1.26")).toBeTruthy();
  });
});

describe("going back to a version", () => {
  const detailOf = (number: number) => ({
    ...release(number),
    changes: [
      { area: "image", name: "", kind: "changed", before: "nginx:1.27", after: "nginx:1.26" },
      { area: "environment", name: "API_KEY", kind: "changed", before: null, after: null },
    ],
  });

  async function openDialog() {
    installFakeServer({
      ...routes({
        ...versions([release(3, { active: true, refusal: "active" }), release(1)]),
        [`GET ${SERVICE}/releases/1`]: detailOf(1),
      }),
      [`POST ${SERVICE}/releases/1/rollback`]: () => ({
        __status: 202,
        body: deployment({ id: "rb1", type: rollbackActionType, status: "queued" }),
      }),
    });
    renderApp(tab);
    fireEvent.click(await screen.findByRole("button", { name: "Go back" }));
    return screen.findByRole("dialog");
  }

  it("says what the image, the settings and the data will be", async () => {
    const dialog = await openDialog();

    expect((await within(dialog).findAllByText("nginx:1.26")).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(`nginx@sha256:${"1".repeat(64)}`)).toBeTruthy();
    expect(within(dialog).getByText("Variable")).toBeTruthy();
    expect(within(dialog).getByText("API_KEY")).toBeTruthy();
    expect(within(dialog).getByText(/whatever was written since then is kept/)).toBeTruthy();
    expect(within(dialog).getByText(/migrations are not undone/)).toBeTruthy();
  });

  it("stays locked until the exact name is typed, and then starts the Action", async () => {
    const dialog = await openDialog();
    await within(dialog).findAllByText("nginx:1.26");
    const confirm = within(dialog).getByRole("button", { name: "Go back" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "WEB" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "web" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("offers nothing while other work is in progress", async () => {
    installFakeServer(
      routes(
        versions([release(2, { active: true, refusal: "active" }), release(1)]),
        detail({ activeAction: { id: "a9", type: "service.deploy" } }),
      ),
    );
    renderApp(tab);

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Go back" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe("saved changes waiting for a deployment", () => {
  const changes = {
    known: true,
    refetches: "image",
    changes: [
      { area: "image", name: "", kind: "changed", before: "nginx:1.26", after: "nginx:1.27" },
      { area: "environment", name: "API_KEY", kind: "changed", before: null, after: null },
      { area: "resources", name: "memory-limit", kind: "added", before: null, after: "512 MiB" },
    ],
  };

  it("lists what the next deployment would change, running and saved side by side", async () => {
    installFakeServer(
      routes(
        { ...versions([]), [`GET ${SERVICE}/deployments/pending`]: changes },
        detail({ pendingChanges: true }),
      ),
    );
    renderApp(tab);

    expect(await screen.findByText("Running now")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("nginx:1.26")).toBeTruthy();
    expect(screen.getByText("nginx:1.27")).toBeTruthy();
    expect(screen.getByText("API_KEY")).toBeTruthy();
    expect(screen.getAllByText("Value hidden")).toHaveLength(2);
    expect(screen.getByText("Memory limit")).toBeTruthy();
    expect(screen.getByText("512 MiB")).toBeTruthy();
    expect(screen.getByText(/pulls the image again/)).toBeTruthy();
  });

  it("is not shown when nothing is waiting", async () => {
    installFakeServer(routes(versions([])));
    renderApp(tab);

    expect(await screen.findByText("Settled")).toBeTruthy();
    expect(screen.queryByText("Running now")).toBeNull();
  });
});
