// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ActionEntry, ServiceDetail } from "@opsifier/contract";
import { actionsTopic, deployActionType } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectLocation,
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  withStatus,
} from "../../testing/appHarness";
import { serviceTabs } from "./tabs";

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
  source: { type: "image", image: "traefik/whoami:v1.10", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: "https://shop-web.example.test/",
  pendingChanges: false,
  answering: null,
  ...overrides,
});

const action = (overrides: Partial<ActionEntry> = {}): ActionEntry => ({
  id: "a1",
  type: deployActionType,
  title: "Deploy shop/web",
  status: "queued",
  phase: null,
  projectName: "shop",
  serviceName: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  error: null,
  hasLog: false,
  actorEmail: "admin@example.com",
  origin: "session",
  originDetail: null,
  ...overrides,
});

const metrics = {
  cpuPercent: 1.5,
  memoryUsedBytes: 67108864,
  networkRxBytes: 2048,
  networkTxBytes: 4096,
  readAt: "2026-01-01T00:00:00.000Z",
};

const base = (service: ServiceDetail, extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop/services/web": service,
  "GET /projects/shop/services/web/metrics": metrics,
  ...extra,
});

const deployButton = () => screen.findByRole("button", { name: "Deploy" }) as Promise<HTMLButtonElement>;

describe("what the header says about what is running", () => {
  it("says when saved settings have not reached the running version", async () => {
    installFakeServer(base(detail({ pendingChanges: true })));
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("Changes waiting")).toBeTruthy();
  });

  it("opens the list of what the next deployment would change", async () => {
    installFakeServer(
      base(detail({ pendingChanges: true }), {
        "GET /projects/shop/services/web/deployments/pending": {
          known: true,
          changes: [{ area: "image", name: "", kind: "changed", before: "nginx:1.26", after: "nginx:1.27" }],
          refetches: "image",
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    fireEvent.click(await screen.findByRole("button", { name: "Changes waiting" }));

    expect(await screen.findByText("nginx:1.27")).toBeTruthy();
    expect(screen.getByText("Running now")).toBeTruthy();
  });

  it("says nothing when what runs is what was saved", async () => {
    installFakeServer(base(detail()));
    renderApp("/projects/shop/app/web");

    expect(await deployButton()).toBeTruthy();
    expect(screen.queryByText("Changes waiting")).toBeNull();
    expect(screen.queryByText("Not answering")).toBeNull();
  });

  it("says when a running service answered nothing at its last deployment", async () => {
    installFakeServer(base(detail({ answering: false })));
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("Not answering")).toBeTruthy();
  });

  it("does not hold a silent port against a service that is not running", async () => {
    installFakeServer(base(detail({ answering: false, status: "stopped", stopped: true })));
    renderApp("/projects/shop/app/web");

    expect(await deployButton()).toBeTruthy();
    expect(screen.queryByText("Not answering")).toBeNull();
  });

  it.each([
    ["interrupted", "A deployment did not finish"],
    ["restore_failed", "The previous version could not be put back"],
  ] as const)("explains a %s runtime on every tab", async (runtimeUncertain, title) => {
    installFakeServer(base(detail({ runtimeUncertain })));
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText(title)).toBeTruthy();
    expect(await screen.findByText("State uncertain")).toBeTruthy();
  });

  it("leaves the notice out while a deployment is settling it", async () => {
    installFakeServer(
      base(
        detail({
          runtimeUncertain: "interrupted",
          activeAction: { id: "a1", type: deployActionType },
        }),
        { "GET /actions/a1": action({ status: "running" }) },
      ),
    );
    renderApp("/projects/shop/app/web");

    expect(await screen.findByRole("navigation", { name: "Service sections" })).toBeTruthy();
    expect(screen.queryByText("A deployment did not finish")).toBeNull();
  });
});

describe("the service page", () => {
  it("reaches all twelve tabs by URL, each with its own segment", async () => {
    expect(serviceTabs.map((tab) => tab.key)).toEqual([
      "overview",
      "source",
      "deployments",
      "environment",
      "domains",
      "redirects",
      "scripts",
      "security",
      "resources",
      "maintenance",
      "storage",
      "advanced",
    ]);

    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/deployments": { items: [], nextCursor: null },
        "GET /projects/shop/services/web/environment": { names: [], interpolation: false },
        "GET /projects/shop/services/web/domains": { domains: [] },
      }),
    );
    const app = renderApp("/projects/shop/app/web");

    await screen.findByRole("navigation", { name: "Service sections" });
    for (const tab of serviceTabs) {
      const nav = within(screen.getByRole("navigation", { name: "Service sections" }));
      fireEvent.click(nav.getByRole("link", { name: tabLabels[tab.key] as string }));
      await expectLocation(
        app,
        tab.key === "overview" ? "/projects/shop/app/web" : `/projects/shop/app/web/${tab.key}`,
      );
      // The toolbar stays on every tab.
      expect(await deployButton()).toBeTruthy();
    }
  });

  it("shows the toolbar and the live readings", async () => {
    installFakeServer(base(detail()));
    renderApp("/projects/shop/app/web");

    expect(await deployButton()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open this site" }).getAttribute("href")).toBe(
      "https://shop-web.example.test/",
    );
    expect(await screen.findByText("1.5%")).toBeTruthy();
    expect(screen.getByText("64 MB")).toBeTruthy();
  });

  it("shows what it is and how it is doing in the header", async () => {
    installFakeServer(
      base(detail({ status: "failing", replicas: { running: 1, desired: 2 }, wake: ["failed"] })),
    );
    renderApp("/projects/shop/app/web");

    await deployButton();
    expect(screen.getByRole("img", { name: "App" })).toBeTruthy();
    expect(document.querySelector('[data-state="degraded"] svg')?.getAttribute("width")).toBe("50");
    expect(screen.getByText("Degraded")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 recent deployment" })).toBeTruthy();
  });

  it("draws CPU, memory and traffic against what they can reach", async () => {
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/metrics": {
          ...metrics,
          cpuPercent: 360,
          cpuCapacityPercent: 400,
          memoryLimitBytes: 536870912,
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    const cpu = await screen.findByRole("meter", { name: "CPU" });
    expect(cpu.getAttribute("aria-valuetext")).toBe("3.6 of 4 cores");
    expect(screen.getByText("90.0%")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Memory" }).getAttribute("aria-valuetext")).toBe(
      "64 MB of 512 MB",
    );
    // Traffic is a rate, so it has nothing to say before a second reading.
    expect(screen.getByRole("img", { name: "In: No data" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Out: No data" })).toBeTruthy();
  });

  it("measures traffic from one reading to the next", async () => {
    const metricsTopic = "service-metrics:shop/web";
    const first = {
      ...metrics,
      networkRxBytes: 1024,
      networkTxBytes: 2048,
      readAt: "2026-01-01T00:00:00.000Z",
    };
    installFakeServer(base(detail(), { "GET /projects/shop/services/web/metrics": first }));
    const app = renderApp("/projects/shop/app/web");
    await screen.findByText("1.0 KB");

    app.emit(metricsTopic, {
      ...first,
      networkRxBytes: 1024 + 3 * 2048,
      networkTxBytes: 2048,
      readAt: "2026-01-01T00:00:03.000Z",
    });

    const incoming = await screen.findByRole("meter", { name: "In" });
    expect(incoming.getAttribute("aria-valuetext")).toBe("2.0 KB/s");
    expect(screen.getByRole("meter", { name: "Out" }).getAttribute("aria-valuetext")).toBe("0 B/s");
  });

  it("says so in pictures when nothing runs", async () => {
    installFakeServer(
      base(detail({ status: "stopped", stopped: true, replicas: { running: 0, desired: 0 } })),
    );
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("This service is stopped")).toBeTruthy();
    expect(document.querySelector('[data-illustration="service-stopped"]')).toBeTruthy();
  });

  it("never prints NaN while readings are missing", async () => {
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/metrics": {
          cpuPercent: 0,
          memoryUsedBytes: 0,
          networkRxBytes: 0,
          networkTxBytes: 0,
          readAt: null,
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    await deployButton();
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("swaps Stop for Start when the service is stopped", async () => {
    installFakeServer(
      base(detail({ status: "stopped", stopped: true, replicas: { running: 0, desired: 0 } })),
    );
    renderApp("/projects/shop/app/web");

    expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Restart" }).getAttribute("disabled")).toBeNull();
  });

  it("shows progress on Deploy only while the Action is alive, and never after it", async () => {
    const running = detail({ activeAction: { id: "a1", type: deployActionType } });
    const server = installFakeServer(base(detail()));
    const app = renderApp("/projects/shop/app/web");

    const deploy = await deployButton();
    expect(deploy.getAttribute("aria-busy")).toBeNull();

    server.set({
      "POST /projects/shop/services/web/deploy": action({ status: "queued" }),
      "GET /projects/shop/services/web": running,
    });
    fireEvent.click(deploy);
    await waitFor(async () => expect((await deployButton()).getAttribute("aria-busy")).toBe("true"));
    expect(server.calls.some((call) => call.method === "POST" && call.path.endsWith("/deploy"))).toBe(true);
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("aria-disabled")).toBe("true");

    server.set({ "GET /projects/shop/services/web": detail() });
    app.emit(actionsTopic, action({ status: "succeeded", finishedAt: "2026-01-01T00:00:10.000Z" }));

    await waitFor(async () => expect((await deployButton()).getAttribute("aria-busy")).toBeNull());
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("aria-disabled")).toBeNull();
    expect(await screen.findByText("Deployment finished")).toBeTruthy();
  });

  it("says so when a deployment fails", async () => {
    const running = detail({ activeAction: { id: "a1", type: deployActionType } });
    const server = installFakeServer(base(detail()));
    const app = renderApp("/projects/shop/app/web");

    const deploy = await deployButton();
    server.set({
      "POST /projects/shop/services/web/deploy": action({ status: "queued" }),
      "GET /projects/shop/services/web": running,
    });
    fireEvent.click(deploy);
    await waitFor(async () => expect((await deployButton()).getAttribute("aria-busy")).toBe("true"));

    server.set({ "GET /projects/shop/services/web": detail() });
    app.emit(actionsTopic, action({ status: "failed", error: "The new tasks did not stay up." }));

    expect(await screen.findByText("The deployment didn't finish")).toBeTruthy();
    expect(screen.getByText("The new tasks did not stay up.")).toBeTruthy();
  });

  it("renders notes on the overview and reopens them for editing", async () => {
    installFakeServer(base(detail({ notes: "# Runbook\n\nRestart **first**." })));
    renderApp("/projects/shop/app/web");

    expect(await screen.findByRole("heading", { name: "Runbook" })).toBeTruthy();
    expect(screen.getByText("first").tagName).toBe("STRONG");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const field = (await screen.findByLabelText("Your notes")) as HTMLTextAreaElement;
    expect(field.value).toBe("# Runbook\n\nRestart **first**.");
  });

  it("says when there are no notes yet and offers to add some", async () => {
    installFakeServer(base(detail()));
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("None yet")).toBeTruthy();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByLabelText("Your notes")).toBeTruthy();
  });

  it("tells hidden notes apart from empty ones, and can show them again", async () => {
    const server = installFakeServer({
      ...base(detail({ notes: "A secret runbook", notesHidden: true })),
      "PUT /projects/shop/services/web/notes/visibility": { hidden: false },
    });
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("Hidden")).toBeTruthy();
    expect(screen.queryByText("None yet")).toBeNull();
    expect(screen.queryByText("A secret runbook")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.path === "/projects/shop/services/web/notes/visibility")?.body,
      ).toEqual({
        hidden: false,
      }),
    );
  });

  it("can hide notes that are shown", async () => {
    const server = installFakeServer({
      ...base(detail({ notes: "Restart first" })),
      "PUT /projects/shop/services/web/notes/visibility": { hidden: true },
    });
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("Restart first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.path === "/projects/shop/services/web/notes/visibility")?.body,
      ).toEqual({
        hidden: true,
      }),
    );
  });
});

const tabLabels: Record<string, string> = {
  overview: "Overview",
  source: "Source",
  deployments: "Deployments",
  environment: "Environment",
  domains: "Domains",
  redirects: "Redirects",
  scripts: "Scripts",
  security: "Security",
  resources: "Resources",
  maintenance: "Maintenance",
  storage: "Storage",
  advanced: "Advanced",
};

describe("a service with no source", () => {
  it("lands on the setup page, with no tabs and no toolbar", async () => {
    installFakeServer(base(detail({ source: null, status: "undeployed" })));
    const app = renderApp("/projects/shop/app/web");

    await expectLocation(app, "/projects/shop/app/web/init/source");
    expect(await screen.findByLabelText("Image")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Service sections" })).toBeNull();
    expect(screen.getByRole("button", { name: "Destroy service" })).toBeTruthy();
  });

  it("goes to the full page once a source is saved", async () => {
    const server = installFakeServer(base(detail({ source: null, status: "undeployed" })));
    const app = renderApp("/projects/shop/app/web/init/source");

    fireEvent.change(await screen.findByLabelText("Image"), { target: { value: "traefik/whoami:v1.10" } });
    server.set({
      "PUT /projects/shop/services/web/source": {
        type: "image",
        image: "traefik/whoami:v1.10",
        username: null,
        hasPassword: false,
      },
      "GET /projects/shop/services/web": detail(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await expectLocation(app, "/projects/shop/app/web");
    expect(await deployButton()).toBeTruthy();
  });

  it("does not let a finished setup stay on the setup page", async () => {
    installFakeServer(base(detail()));
    const app = renderApp("/projects/shop/app/web/init/source");

    await expectLocation(app, "/projects/shop/app/web");
  });
});

describe("the source form", () => {
  const open = async (source: Partial<ServiceDetail> = {}) => {
    const server = installFakeServer(base(detail(source)));
    renderApp("/projects/shop/app/web/source");
    await screen.findByLabelText("Image");
    return server;
  };

  it("needs an image", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Image"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter an image to run.")).toBeTruthy();
  });

  it("never shows a stored password and says one exists", async () => {
    await open({ source: { type: "image", image: "x/y:1", username: "deployer", hasPassword: true } });

    expect((screen.getByLabelText(/Registry password/) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/A password is stored/)).toBeTruthy();
  });

  it("needs a username with a password, and a password with a new username", async () => {
    await open();
    fireEvent.change(screen.getByLabelText(/Registry password/), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A password needs a username.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Registry password/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Registry username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A username needs a password.")).toBeTruthy();
  });

  it("saves without a password when one is already stored, and reminds about deploying", async () => {
    const server = await open({
      source: { type: "image", image: "x/y:1", username: "deployer", hasPassword: true },
    });
    server.set({
      "PUT /projects/shop/services/web/source": {
        type: "image",
        image: "x/y:2",
        username: "deployer",
        hasPassword: true,
      },
    });

    fireEvent.change(screen.getByLabelText("Image"), { target: { value: "x/y:2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findAllByText("Source saved")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("It takes effect at the next deploy.").length).toBeGreaterThan(0);
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
      image: "x/y:2",
      username: "deployer",
    });
  });
});

describe("the environment tab", () => {
  const ENVIRONMENT = "/projects/shop/services/web/environment";

  it("names the variables and shows no value until someone asks", async () => {
    const server = installFakeServer(
      base(detail(), { [`GET ${ENVIRONMENT}`]: { names: ["API_TOKEN", "A"], interpolation: false } }),
    );
    renderApp("/projects/shop/app/web/environment");

    await screen.findByText("API_TOKEN");
    expect(screen.getAllByText("••••••••")).toHaveLength(2);
    expect(screen.queryByLabelText("Variables")).toBeNull();
    expect(server.calls.some((call) => call.path.endsWith("/environment/reveal"))).toBe(false);
  });

  it("names a line that is not a variable, and saves valid text once revealed", async () => {
    const server = installFakeServer(
      base(detail(), {
        [`GET ${ENVIRONMENT}`]: { names: ["A"], interpolation: false },
        [`POST ${ENVIRONMENT}/reveal`]: { env: "A=1" },
      }),
    );
    renderApp("/projects/shop/app/web/environment");

    fireEvent.click(await screen.findByRole("button", { name: "Show and edit" }));
    const field = (await screen.findByLabelText("Variables")) as HTMLTextAreaElement;
    expect(field.value).toBe("A=1");
    expect(server.calls.filter((call) => call.path.endsWith("/environment/reveal"))).toHaveLength(1);

    fireEvent.change(field, { target: { value: "A=1\nnope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variables" }));
    expect(await screen.findByText("Line 2 needs to look like NAME=value.")).toBeTruthy();

    server.set({ [`PUT ${ENVIRONMENT}`]: { names: ["A"], interpolation: false } });
    fireEvent.change(field, { target: { value: "A=2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variables" }));

    expect(await screen.findByText("Variables saved")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ env: "A=2" });
  });

  it("leaves placeholders off until someone turns them on, without showing any value (REQ-477)", async () => {
    const server = installFakeServer(
      base(detail(), {
        [`GET ${ENVIRONMENT}`]: { names: ["A"], interpolation: false },
        [`PUT ${ENVIRONMENT}`]: { names: ["A"], interpolation: true },
      }),
    );
    renderApp("/projects/shop/app/web/environment");

    const toggle = (await screen.findByRole("switch", {
      name: /Fill in \$\(PROJECT_NAME\)/,
    })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await screen.findByText("Setting saved");
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ interpolation: true });
    expect(server.calls.some((call) => call.path.endsWith("/environment/reveal"))).toBe(false);
  });

  it("says so when the placeholder setting could not be changed", async () => {
    installFakeServer(
      base(detail(), {
        [`GET ${ENVIRONMENT}`]: { names: ["A"], interpolation: false },
        [`PUT ${ENVIRONMENT}`]: withStatus(500, { error: { code: "internal", message: "Nope" } }),
      }),
    );
    renderApp("/projects/shop/app/web/environment");

    fireEvent.click(await screen.findByRole("switch", { name: /Fill in \$\(PROJECT_NAME\)/ }));

    expect(await screen.findByText("Could not change this setting")).toBeTruthy();
  });

  it("opens the editor directly when there is nothing to reveal", async () => {
    installFakeServer(base(detail(), { [`GET ${ENVIRONMENT}`]: { names: [], interpolation: false } }));
    renderApp("/projects/shop/app/web/environment");

    expect(await screen.findByLabelText("Variables")).toBeTruthy();
  });

  it("says what went wrong when the values can't be shown", async () => {
    installFakeServer(
      base(detail(), {
        [`GET ${ENVIRONMENT}`]: { names: ["A"], interpolation: false },
        [`POST ${ENVIRONMENT}/reveal`]: withStatus(500, { error: { code: "internal", message: "Nope" } }),
      }),
    );
    renderApp("/projects/shop/app/web/environment");

    fireEvent.click(await screen.findByRole("button", { name: "Show and edit" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText("Variables")).toBeNull();
  });

  describe("on a service built from source", () => {
    const BUILD = `${ENVIRONMENT}/build`;
    const git = detail({
      source: { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" },
    });
    const empty = { variables: [], secrets: [], inheritsRuntime: false };
    const open = (build: unknown = empty, extra: Parameters<typeof base>[1] = {}) =>
      installFakeServer(
        base(git, {
          [`GET ${ENVIRONMENT}`]: { names: [], interpolation: false },
          [`GET ${BUILD}`]: build,
          "GET /projects/shop/services/web/source/env-file": { path: null, inImage: false },
          ...extra,
        }),
      );

    it("offers build variables and secrets apart from the variables above", async () => {
      open({
        variables: ["API_URL"],
        secrets: [{ name: "NPM_TOKEN", updatedAt: "2026-01-02T03:04:05.000Z" }],
        inheritsRuntime: false,
      });
      renderApp("/projects/shop/app/web/environment");

      expect(await screen.findByText("Build variables")).toBeTruthy();
      expect(await screen.findByText("API_URL")).toBeTruthy();
      expect(await screen.findByText("NPM_TOKEN")).toBeTruthy();
      expect(screen.queryByText("Still sharing its variables with the build")).toBeNull();
    });

    it("sets a build secret without ever being given one back", async () => {
      const server = open(empty, {
        [`PUT ${BUILD}/secrets/NPM_TOKEN`]: {
          variables: [],
          secrets: [{ name: "NPM_TOKEN", updatedAt: "2026-01-02T03:04:05.000Z" }],
          inheritsRuntime: false,
        },
      });
      renderApp("/projects/shop/app/web/environment");

      fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "NPM_TOKEN" } });
      fireEvent.change(screen.getByLabelText("Value"), { target: { value: "hunter2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

      await waitFor(() =>
        expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ value: "hunter2" }),
      );
      expect(await screen.findByText("Build secret saved")).toBeTruthy();
    });

    it("explains an inherited environment and stops it only after a confirmation", async () => {
      const server = open({ ...empty, inheritsRuntime: true }, { [`DELETE ${BUILD}/inherited`]: empty });
      renderApp("/projects/shop/app/web/environment");

      expect(await screen.findByText("Still sharing its variables with the build")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Stop sharing them" }));
      expect(server.calls.some((call) => call.method === "DELETE")).toBe(false);
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing them" }));

      await waitFor(() =>
        expect(
          server.calls.some((call) => call.method === "DELETE" && call.path === `${BUILD}/inherited`),
        ).toBe(true),
      );
    });

    it("does not appear on a service that is not built", async () => {
      installFakeServer(base(detail(), { [`GET ${ENVIRONMENT}`]: { names: [], interpolation: false } }));
      renderApp("/projects/shop/app/web/environment");

      await screen.findByLabelText("Variables");
      expect(screen.queryByText("Build variables")).toBeNull();
    });
  });
});

const noVersions = {
  "GET /projects/shop/services/web/releases": { available: true, items: [], keep: 5 },
};

describe("the deployments tab", () => {
  it("says when nothing has been deployed", async () => {
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/deployments": { items: [], nextCursor: null },
        ...noVersions,
      }),
    );
    renderApp("/projects/shop/app/web/deployments");

    expect(await screen.findByText("Nothing deployed yet")).toBeTruthy();
    expect(document.querySelector('[data-illustration="no-deployments"]')).toBeTruthy();
  });

  it("lists outcomes, and opens the log of a row", async () => {
    const finished = {
      ...action({
        id: "d1",
        status: "failed",
        hasLog: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:12.000Z",
        error: "boom",
      }),
      deployment: null,
    };
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/deployments": { items: [finished], nextCursor: null },
        ...noVersions,
        "GET /actions/d1": {
          ...finished,
          log: "Pulling image traefik/whoami:v1.10\nFailed",
          logTruncated: false,
          logSeq: 0,
        },
      }),
    );
    renderApp("/projects/shop/app/web/deployments");

    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(document.querySelector('td [data-state="failed"]')).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "See output" }));
    expect(await screen.findByText(/Pulling image traefik\/whoami:v1.10/)).toBeTruthy();
  });
});

describe("the domains tab", () => {
  it("lists the default domain with its internal address and a filled star", async () => {
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/domains": {
          domains: [
            {
              id: "d1",
              host: "shop-web.example.test",
              path: "/",
              stripPath: false,
              port: 80,
              https: true,
              primary: true,
              destinationProtocol: "http",
              destinationPath: "/",
              upstreamServerName: null,
              upstreamCa: null,
              certificateResolver: null,
              wildcard: false,
              middlewares: [],
              url: "https://shop-web.example.test/",
              internalUrl: "http://shop_web:80/",
            },
          ],
        },
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    expect(await screen.findByText("https://shop-web.example.test/")).toBeTruthy();
    expect(screen.getByText("http://shop_web:80/")).toBeTruthy();
    expect(screen.getByRole("img", { name: "The service's main domain" })).toBeTruthy();
  });
});

describe("destroying a service", () => {
  it("needs the exact name, and Cancel leaves everything alone", async () => {
    installFakeServer(base(detail({ source: null, status: "undeployed" })));
    renderApp("/projects/shop/app/web/init/source");

    fireEvent.click(await screen.findByRole("button", { name: "Destroy service" }));
    const confirm = (await screen.findByRole("button", { name: "Destroy" })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/Its containers, domains, routes, settings and source files/)).toBeTruthy();
    expect(screen.getByText(/Its named volumes and its backups/)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: /To confirm/ }), { target: { value: "we" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /To confirm/ }), { target: { value: "web" } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Destroy" })).toBeNull());
  });
});
