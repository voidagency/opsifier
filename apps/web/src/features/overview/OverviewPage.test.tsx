// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ProjectSummary, ServiceSummary } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectLocation, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const service = (overrides: Partial<ServiceSummary> = {}): ServiceSummary => ({
  projectName: "alpha",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded", "failed"],
  lastDeployedAt: new Date().toISOString(),
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const project = (name: string, createdAt: string, services: ServiceSummary[] = []): ProjectSummary => ({
  name,
  createdAt,
  services,
});

/** The projects in the order drawn. A project's heading is the one that links to it. */
const names = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .flatMap((heading) => heading.querySelector("a")?.textContent ?? []);

describe("the Overview project list", () => {
  it("shows the controls and a way to create the first project when there are none", async () => {
    installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/");

    expect(await screen.findByRole("button", { name: "Create a project" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Sort projects" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Detail shown for each project" })).toBeTruthy();
  });

  it("sorts by name, or oldest first, and remembers it", async () => {
    installFakeServer({
      "GET /projects": {
        projects: [
          project("zulu", "2026-01-01T00:00:00.000Z"),
          project("alpha", "2026-03-01T00:00:00.000Z"),
          project("mike", "2026-02-01T00:00:00.000Z"),
        ],
      },
    });
    const app = renderApp("/");

    await screen.findByRole("link", { name: "alpha" });
    expect(names()).toEqual(["alpha", "mike", "zulu"]);

    fireEvent.click(screen.getByRole("button", { name: "Oldest first" }));
    await waitFor(() => expect(names()).toEqual(["zulu", "mike", "alpha"]));

    app.unmount();
    renderApp("/");
    await screen.findByRole("link", { name: "alpha" });
    expect(names()).toEqual(["zulu", "mike", "alpha"]);
  });

  it("hides and shows the services of each project, and remembers it", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z", [service()])] },
    });
    const app = renderApp("/");

    expect(await screen.findByRole("link", { name: "web" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "web" })).toBeNull());

    app.unmount();
    renderApp("/");
    await screen.findByRole("link", { name: "alpha" });
    expect(screen.queryByRole("link", { name: "web" })).toBeNull();
  });

  it("draws services as rows with a lamp and a wake strip, and links them", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z", [service()])] },
    });
    renderApp("/");

    const link = await screen.findByRole("link", { name: "web" });
    expect(link.getAttribute("href")).toBe("/projects/alpha/app/web");
    const row = within(link.closest("li") as HTMLElement);
    expect(row.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(row.getByRole("img", { name: "2 recent deployments" })).toBeTruthy();
    expect(row.getByText("1/1")).toBeTruthy();
  });

  it("offers the four links of each project", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z")] },
    });
    renderApp("/");
    await screen.findByRole("link", { name: "alpha" });

    expect(screen.getByRole("link", { name: "Open this project" }).getAttribute("href")).toBe(
      "/projects/alpha",
    );
    expect(screen.getByRole("link", { name: "Project settings" }).getAttribute("href")).toBe(
      "/projects/alpha/settings",
    );
    expect(screen.getByRole("link", { name: "Add a service" }).getAttribute("href")).toBe(
      "/projects/alpha/create",
    );
    expect(screen.getByRole("link", { name: "Browse templates" }).getAttribute("href")).toBe(
      "/projects/alpha/create?tab=templates",
    );
  });

  it("shows the server's message when the list cannot load, and can retry", async () => {
    installFakeServer({
      "GET /projects": withStatus(500, { error: { code: "internal_error", message: "boom" } }),
    });
    renderApp("/");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("the Overview health summary", () => {
  const failing = service({ name: "broken", status: "failing", replicas: { running: 0, desired: 1 } });
  const degraded = service({ name: "wobbly", status: "failing", replicas: { running: 1, desired: 2 } });
  const busy = service({ name: "busy", activeAction: { id: "a1", type: "service.deploy" } });
  const stopped = service({ name: "off", status: "stopped", replicas: { running: 0, desired: 0 } });
  const healthy = service({ name: "fine" });
  const crowded = [healthy, stopped, busy, degraded, failing];

  const serviceLinks = () =>
    screen.getAllByRole("link", { name: /^(broken|wobbly|busy|fine|off)$/ }).map((link) => link.textContent);

  it("opens with every service counted by state, problems first", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z", crowded)] },
    });
    renderApp("/");

    const strip = within(await screen.findByRole("group", { name: "Services by state" }));
    expect(strip.getByText("2 problems")).toBeTruthy();
    expect(strip.getByRole("button", { name: "1 Failed" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "1 Degraded" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "1 In progress" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "1 Running" })).toBeTruthy();
    expect(strip.getByRole("button", { name: "1 Stopped" })).toBeTruthy();
    expect(serviceLinks()).toEqual(["broken", "wobbly", "busy", "fine", "off"]);
  });

  it("puts the projects with problems first, whatever the sort says", async () => {
    installFakeServer({
      "GET /projects": {
        projects: [
          project("alpha", "2026-01-01T00:00:00.000Z", [healthy]),
          project("zulu", "2026-01-01T00:00:00.000Z", [failing]),
        ],
      },
    });
    renderApp("/");

    await screen.findByRole("link", { name: "alpha" });
    expect(names()).toEqual(["zulu", "alpha"]);
  });

  it("filters the list with its counts, and lets go again", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z", crowded)] },
    });
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "1 Failed" }));
    await waitFor(() => expect(serviceLinks()).toEqual(["broken"]));

    fireEvent.click(screen.getByRole("button", { name: "1 Failed" }));
    await waitFor(() => expect(serviceLinks()).toHaveLength(5));
  });

  it("rolls each project up into its services' pictograms and lamps", async () => {
    installFakeServer({
      "GET /projects": { projects: [project("alpha", "2026-01-01T00:00:00.000Z", [healthy, failing])] },
    });
    renderApp("/");

    expect(await screen.findByRole("img", { name: "alpha: Failed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "broken: Failed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "fine: Running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));

    expect((await screen.findByRole("link", { name: "broken: Failed" })).getAttribute("href")).toBe(
      "/projects/alpha/app/broken",
    );
  });

  it("draws the empty state, without a summary of nothing", async () => {
    installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/");

    await screen.findByRole("button", { name: "Create a project" });
    expect(document.querySelector('[data-illustration="no-projects"]')).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Services by state" })).toBeNull();
  });
});

describe("creating a project", () => {
  async function openDialog() {
    fireEvent.click(await screen.findByRole("button", { name: "Create a project" }));
    return screen.findByRole("dialog");
  }

  const nameField = () => screen.getByLabelText("Project name") as HTMLInputElement;
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));

  it("explains what is wrong with an empty or invalid name, without asking the server", async () => {
    const server = installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/");
    await openDialog();

    submit();
    expect(await screen.findByText("Give the project a name.")).toBeTruthy();

    fireEvent.change(nameField(), { target: { value: "Bad Name!" } });
    submit();
    expect(await screen.findByText(/Use lowercase letters, digits and dashes/)).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("creates the project, adds it to the list and goes to it", async () => {
    const server = installFakeServer({
      "GET /projects": { projects: [] },
      "POST /projects": { name: "probe-app", createdAt: "2026-01-01T00:00:00.000Z", services: [] },
      "GET /projects/probe-app": { name: "probe-app", createdAt: "2026-01-01T00:00:00.000Z", services: [] },
    });
    const app = renderApp("/");
    await openDialog();

    fireEvent.change(nameField(), { target: { value: "probe-app" } });
    server.set({
      "GET /projects": {
        projects: [{ name: "probe-app", createdAt: "2026-01-01T00:00:00.000Z", services: [] }],
      },
    });
    submit();

    await expectLocation(app, "/projects/probe-app");
    expect(await screen.findByText("No services in this project yet")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ name: "probe-app" });
  });

  it("shows the server's rejection on the field", async () => {
    installFakeServer({
      "GET /projects": { projects: [] },
      "POST /projects": withStatus(409, {
        error: { code: "project_exists", message: "Taken", fields: { name: "This name is taken" } },
      }),
    });
    renderApp("/");
    await openDialog();

    fireEvent.change(nameField(), { target: { value: "taken" } });
    submit();

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
