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

const names = () =>
  screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.split(/\d/)[0]);

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
    fireEvent.click(screen.getByRole("button", { name: "Names only" }));
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
