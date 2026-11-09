// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ServiceSummary } from "@opsifier/contract";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLocation, installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

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

const service: ServiceSummary = {
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded"],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const project = (services: ServiceSummary[]) => ({
  name: "shop",
  createdAt: "2026-01-01T00:00:00.000Z",
  services,
});

const list = (services: ServiceSummary[] = []) => ({
  "GET /projects": { projects: [project(services)] },
  "GET /projects/shop": project(services),
});

describe("the project page", () => {
  it("shows an empty state with its links when there are no services", async () => {
    installFakeServer(list());
    renderApp("/projects/shop");

    expect(await screen.findByText("No services in this project yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add service" }).getAttribute("href")).toBe(
      "/projects/shop/create",
    );
    expect(screen.getByRole("link", { name: "Templates" }).getAttribute("href")).toBe(
      "/projects/shop/create?tab=templates",
    );
  });

  it("lists services as rows and stays on the page", async () => {
    installFakeServer(list([service]));
    const app = renderApp("/projects/shop");

    expect(await screen.findByRole("link", { name: "web" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(app.location()).toBe("/projects/shop");
  });

  it("leads each row with its lamp and pictogram, problems first, and filters by state", async () => {
    const broken: ServiceSummary = {
      ...service,
      name: "api",
      status: "failing",
      replicas: { running: 0, desired: 1 },
      type: "postgres",
    };
    installFakeServer(list([service, broken]));
    renderApp("/projects/shop");

    const links = () => screen.getAllByRole("link", { name: /^(api|web)$/ }).map((link) => link.textContent);
    await screen.findByRole("link", { name: "api" });
    expect(links()).toEqual(["api", "web"]);
    expect(screen.getByRole("img", { name: "Postgres" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "shop: Failed" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 Running" }));
    await waitFor(() => expect(links()).toEqual(["web"]));
  });

  it("draws what each service uses against its limit, and that it can't know yet", async () => {
    installFakeServer(list([service]));
    const app = renderApp("/projects/shop");

    expect(await screen.findByRole("img", { name: "web: CPU: No data" })).toBeTruthy();

    app.emit("metrics:services", {
      available: true,
      readAt: "2026-01-01T00:00:00.000Z",
      services: [
        {
          projectName: "shop",
          serviceName: "web",
          tasks: [
            {
              taskId: "t1",
              slot: 1,
              cpuPercent: 50,
              cpuCapacityPercent: 200,
              memoryUsedBytes: 134217728,
              memoryLimitBytes: 536870912,
              memoryPercent: 25,
              networkRxBytes: 0,
              networkTxBytes: 0,
            },
          ],
        },
      ],
    });

    const cpu = await screen.findByRole("meter", { name: "web: CPU" });
    expect(cpu.getAttribute("aria-valuetext")).toBe("0.5 of 2 cores");
    expect(screen.getByRole("meter", { name: "web: Memory" }).getAttribute("aria-valuetext")).toBe(
      "128 MB of 512 MB",
    );
  });

  it("switches project from the breadcrumb", async () => {
    installFakeServer(list([service]));
    renderApp("/projects/shop");

    const trigger = await screen.findByRole("button", { name: "Project shop. Switch project" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    expect(await screen.findByRole("menuitem", { name: "New project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "shop" })).toBeTruthy();
  });
});

describe("the create-service page", () => {
  it("shows the three tabs in the URL and lists the nine types", async () => {
    installFakeServer(list());
    const app = renderApp("/projects/shop/create");

    for (const name of [
      "App",
      "MySQL",
      "MariaDB",
      "Postgres",
      "Mongo",
      "Redis",
      "Box",
      "Compose",
      "WordPress",
    ]) {
      expect(await screen.findByText(name)).toBeTruthy();
    }

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Templates" }));
    await waitFor(() => expect(app.router.state.location.search).toEqual({ tab: "templates" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Custom" }));
    await waitFor(() => expect(app.router.state.location.search).toEqual({ tab: "custom" }));
    expect(await screen.findByRole("heading", { name: "Create from a schema" })).toBeTruthy();
  });

  it("opens straight on a tab named in the URL", async () => {
    installFakeServer({ ...list(), "GET /templates": { templates: [] } });
    renderApp("/projects/shop/create?tab=templates");

    expect(await screen.findByPlaceholderText("Search templates")).toBeTruthy();
  });

  it("creates an app and goes to its setup page", async () => {
    const server = installFakeServer({
      ...list(),
      "POST /projects/shop/services": {
        ...service,
        source: null,
        notes: "",
        notesHidden: false,
        stopped: false,
        primaryUrl: null,
        pendingChanges: false,
        answering: null,
      },
      "GET /projects/shop/services/web": {
        ...service,
        source: null,
        notes: "",
        notesHidden: false,
        stopped: false,
        primaryUrl: null,
        pendingChanges: false,
        answering: null,
        status: "undeployed",
      },
    });
    const app = renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByRole("button", { name: /Run any container image/ }));
    fireEvent.change(await screen.findByLabelText("Service name"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await expectLocation(app, "/projects/shop/app/web/init/source");
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ name: "web", type: "app" });
  });

  it("rejects an invalid service name in the dialog", async () => {
    installFakeServer(list());
    renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByRole("button", { name: /Run any container image/ }));
    fireEvent.change(await screen.findByLabelText("Service name"), { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
  });
});

describe("project settings", () => {
  const settings = (services: ServiceSummary[] = []) => ({
    ...list(services),
    "GET /projects/shop/env": { names: ["SHARED"] },
    "POST /projects/shop/env/reveal": { env: "SHARED=1" },
    "GET /projects/shop/schema": { services: [] },
  });

  it("edits the shared variables and reminds that a redeploy is needed", async () => {
    const server = installFakeServer(settings());
    renderApp("/projects/shop/settings");

    // Named on load: the value only comes when somebody asks.
    await screen.findByText("SHARED");
    expect(screen.queryByText("SHARED=1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show and edit" }));
    const field = (await screen.findByLabelText("Shared variables")) as HTMLTextAreaElement;
    expect(field.value).toBe("SHARED=1");

    server.set({ "PUT /projects/shop/env": { names: ["SHARED"] } });
    fireEvent.change(field, { target: { value: "SHARED=2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save variables" }));

    expect(await screen.findByText("Shared variables saved")).toBeTruthy();
    expect(screen.getByText("They reach a service at its next deploy.")).toBeTruthy();
  });

  it("shows the schema document", async () => {
    installFakeServer(settings());
    renderApp("/projects/shop/settings");

    await waitFor(() =>
      expect(screen.getByTestId("project-schema").textContent).toBe('{\n  "services": []\n}'),
    );
  });

  it("won't let a project that still holds a service be destroyed", async () => {
    installFakeServer(settings([service]));
    renderApp("/projects/shop/settings");

    expect(await screen.findByText("Delete the service in this project first.")).toBeTruthy();
    const destroy = screen.getByRole("button", { name: "Destroy project" }) as HTMLButtonElement;
    await waitFor(() => expect(destroy.disabled).toBe(true));
  });

  it("says what goes and what stays, and needs the exact name to destroy an empty project", async () => {
    const server = installFakeServer(settings());
    const app = renderApp("/projects/shop/settings");

    const destroy = (await screen.findByRole("button", { name: "Destroy project" })) as HTMLButtonElement;
    await waitFor(() => expect(destroy.disabled).toBe(false));
    fireEvent.click(destroy);
    const confirm = (await screen.findByRole("button", { name: "Destroy" })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText("Its network and its shared variables.")).toBeTruthy();
    expect(screen.getByText(/Volumes kept from services it used to hold/)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: /To confirm/ }), { target: { value: "shop" } });
    expect(confirm.disabled).toBe(false);

    server.set({
      "DELETE /projects/shop": {
        id: "x",
        type: "project.destroy",
        title: "Destroy project shop",
        status: "queued",
        projectName: "shop",
        serviceName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
        hasLog: false,
        actorEmail: null,
      },
    });
    fireEvent.click(confirm);

    await expectLocation(app, "/");
    expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({ confirm: "shop" });
  });
});
