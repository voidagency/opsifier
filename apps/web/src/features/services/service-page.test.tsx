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
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "traefik/whoami:v1.10", username: null, hasPassword: false },
  notes: "",
  stopped: false,
  primaryUrl: "https://shop-web.example.test/",
  ...overrides,
});

const action = (overrides: Partial<ActionEntry> = {}): ActionEntry => ({
  id: "a1",
  type: deployActionType,
  title: "Deploy shop/web",
  status: "queued",
  projectName: "shop",
  serviceName: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  error: null,
  hasLog: false,
  actorEmail: "admin@example.com",
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
        "GET /projects/shop/services/web/environment": { env: "" },
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
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);

    server.set({ "GET /projects/shop/services/web": detail() });
    app.emit(actionsTopic, action({ status: "succeeded", finishedAt: "2026-01-01T00:00:10.000Z" }));

    await waitFor(async () => expect((await deployButton()).getAttribute("aria-busy")).toBeNull());
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
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
  it("names a line that is not a variable, and saves valid text", async () => {
    const server = installFakeServer(
      base(detail(), { "GET /projects/shop/services/web/environment": { env: "A=1" } }),
    );
    renderApp("/projects/shop/app/web/environment");

    const field = (await screen.findByLabelText("Variables")) as HTMLTextAreaElement;
    expect(field.value).toBe("A=1");

    fireEvent.change(field, { target: { value: "A=1\nnope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variables" }));
    expect(await screen.findByText("Line 2 needs to look like NAME=value.")).toBeTruthy();

    server.set({ "PUT /projects/shop/services/web/environment": { env: "A=2" } });
    fireEvent.change(field, { target: { value: "A=2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variables" }));

    expect(await screen.findByText("Variables saved")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ env: "A=2" });
  });
});

describe("the deployments tab", () => {
  it("says when nothing has been deployed", async () => {
    installFakeServer(
      base(detail(), { "GET /projects/shop/services/web/deployments": { items: [], nextCursor: null } }),
    );
    renderApp("/projects/shop/app/web/deployments");

    expect(await screen.findByText("Nothing deployed yet")).toBeTruthy();
  });

  it("lists outcomes, and opens the log of a row", async () => {
    const finished = action({
      id: "d1",
      status: "failed",
      hasLog: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:12.000Z",
      error: "boom",
    });
    installFakeServer(
      base(detail(), {
        "GET /projects/shop/services/web/deployments": { items: [finished], nextCursor: null },
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
              port: 80,
              https: true,
              primary: true,
              destinationProtocol: "http",
              destinationPath: "/",
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

    fireEvent.change(screen.getByRole("textbox", { name: /To confirm/ }), { target: { value: "we" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /To confirm/ }), { target: { value: "web" } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Destroy" })).toBeNull());
  });
});
