// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ComposeDetail, ComposeRuntime, ServiceDetail } from "@opsifier/contract";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

vi.mock("../../ui/CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

afterEach(resetApp);

const detail: ServiceDetail = {
  projectName: "shop",
  name: "stack",
  type: "compose",
  status: "running",
  replicas: { running: 2, desired: 2 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: null,
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: "https://shop-stack.example.test/",
  pendingChanges: false,
  answering: null,
};

const compose = (overrides: Partial<ComposeDetail> = {}): ComposeDetail => ({
  source: { type: "inline", content: "services: {}\n" },
  content: "services: {}\n",
  issues: [],
  parseError: null,
  services: ["web"],
  acknowledgementRequired: false,
  acknowledged: false,
  envFile: false,
  sshPublicKey: null,
  ...overrides,
});

const runtime: ComposeRuntime = {
  children: [
    {
      name: "web",
      state: "running",
      containers: [
        {
          id: "c1",
          name: "shop_stack-web-1",
          image: "traefik/whoami:v1.11",
          state: "running",
          status: "Up 5 minutes",
          exitCode: null,
          ports: [],
        },
      ],
    },
  ],
  addresses: { web: "shop_stack__web" },
};

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop/services/stack": detail,
  "GET /projects/shop/services/stack/metrics": {
    cpuPercent: 0,
    cpuCapacityPercent: 100,
    memoryUsedBytes: 0,
    memoryLimitBytes: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    readAt: null,
  },
  "GET /projects/shop/services/stack/compose": compose(),
  "GET /projects/shop/services/stack/compose/children": runtime,
  ...extra,
});

describe("a Compose stack's pages", () => {
  it("lists its children with their state", async () => {
    installFakeServer(base());
    renderApp("/projects/shop/compose/stack/");

    expect((await screen.findAllByRole("button", { name: "web" })).length).toBe(2);
    expect(screen.getByRole("img", { name: "web: Running" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
  });

  it("warns about host access and asks for a confirmation", async () => {
    const server = installFakeServer(
      base({
        "GET /projects/shop/services/stack/compose": compose({
          issues: [
            { severity: "host", code: "docker_socket", service: "web", detail: "/var/run/docker.sock" },
          ],
          acknowledgementRequired: true,
        }),
        "POST /projects/shop/services/stack/compose/acknowledge": compose({
          acknowledged: true,
          acknowledgementRequired: false,
        }),
      }),
    );
    renderApp("/projects/shop/compose/stack/source");

    expect(await screen.findByText("This stack can reach outside its containers")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/mounts the Docker socket/)).toBeTruthy();

    const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(confirm);
    await vi.waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/compose/acknowledge"))).toBe(true),
    );
  });

  it("says a network the project doesn't own stops the deploy, and what to do instead", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/stack/compose": compose({
          issues: [{ severity: "error", code: "foreign_network", service: null, detail: "opsifier" }],
        }),
      }),
    );
    renderApp("/projects/shop/compose/stack/source");

    expect(await screen.findByText("This file can't be deployed as it is")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/joins a network this project doesn't own/)).toBeTruthy();
    expect(within(dialog).getByText(/publish its port on its Expose tab/)).toBeTruthy();
    expect(within(dialog).getByText("opsifier")).toBeTruthy();
  });

  it("shows the parser's own words for invalid YAML", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/stack/compose": compose({
          parseError: "bad indentation of a mapping entry",
        }),
      }),
    );
    renderApp("/projects/shop/compose/stack/source");
    expect(await screen.findByText("This file can't be deployed as it is")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("bad indentation of a mapping entry")).toBeTruthy();
  });
});
