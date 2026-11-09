// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { TemplateDocument, TemplateInstall } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const template = (overrides: Partial<TemplateDocument> = {}): TemplateDocument => ({
  id: "gotify",
  version: "1.0.0",
  name: "Gotify",
  summary: { en: "Push notifications", fr: "Notifications" },
  description: { en: "A small notification server.", fr: "Un petit serveur." },
  category: "communication",
  tags: ["notifications", "push"],
  links: [{ kind: "website", url: "https://gotify.net" }],
  verified: false,
  params: [
    {
      key: "adminUser",
      label: { en: "Admin user", fr: "Admin" },
      type: "text",
      required: true,
      default: "admin",
    },
  ],
  secrets: [],
  services: [
    {
      key: "app",
      name: "gotify",
      kind: "app",
      source: { type: "image", image: "gotify/server:3.1.1" },
      env: {},
      command: null,
      mounts: [],
      domain: { port: 80, https: true, path: "/" },
      ports: [],
      startup: { path: "/health", expect: [200] },
      dependsOn: [],
    },
  ],
  ...overrides,
});

const miniflux = template({
  id: "miniflux",
  name: "Miniflux",
  summary: { en: "A reader", fr: "Un lecteur" },
  category: "productivity",
  tags: ["rss"],
  services: [
    { key: "db", name: "miniflux-db", kind: "database", engine: "postgres", image: "postgres:17-alpine" },
    {
      key: "app",
      name: "miniflux",
      kind: "app",
      source: { type: "image", image: "miniflux/miniflux:2.3.5" },
      env: {},
      command: null,
      mounts: [],
      domain: { port: 8080, https: true, path: "/" },
      ports: [],
      startup: { path: "/healthcheck", expect: [200] },
      dependsOn: ["db"],
    },
  ],
});

const install: TemplateInstall = {
  id: "abc",
  projectName: "shop",
  templateId: "gotify",
  templateVersion: "1.0.0",
  templateName: "Gotify",
  category: "communication",
  custom: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  instructions: { en: "Sign in as admin.", fr: "Connectez-vous." },
  components: [
    {
      role: "app",
      kind: "app",
      service: {
        projectName: "shop",
        name: "gotify",
        type: "app",
        status: "undeployed",
        replicas: { running: 0, desired: 0 },
        activeAction: null,
        runtimeUncertain: null,
        wake: [],
        lastDeployedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      url: "https://shop-gotify.example.test/",
    },
  ],
  secrets: [
    { service: "gotify", name: "adminPassword", label: { en: "Admin password", fr: "Mot de passe" } },
  ],
};

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop": { name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] },
  "GET /templates": { templates: [template(), miniflux] },
  ...extra,
});

describe("the templates tab", () => {
  it("lists the catalogue and filters as you type, with an empty state", async () => {
    installFakeServer(base());
    renderApp("/projects/shop/create?tab=templates");

    expect(await screen.findByText("Gotify")).toBeTruthy();
    expect(screen.getByText("Miniflux")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search templates" }), {
      target: { value: "mini" },
    });
    await waitFor(() => expect(screen.queryByText("Gotify")).toBeNull());
    expect(screen.getByText("Miniflux")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search templates" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText("No template matches")).toBeTruthy();
  });

  it("explains a failure to load, and offers a retry", async () => {
    installFakeServer(
      base({ "GET /templates": withStatus(500, { error: { code: "internal_error", message: "x" } }) }),
    );
    renderApp("/projects/shop/create?tab=templates");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("opens a form pre-filled from the template", async () => {
    installFakeServer(base());
    renderApp("/projects/shop/create?tab=templates");
    fireEvent.click(await screen.findByText("Miniflux"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create Miniflux")).toBeTruthy();
    const inputs = within(dialog).getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs.map((input) => input.value)).toEqual(
      expect.arrayContaining(["miniflux", "miniflux-db", "postgres:17-alpine", "miniflux/miniflux:2.3.5"]),
    );
  });

  it("shows the server's field errors in the form", async () => {
    installFakeServer(
      base({
        "POST /projects/shop/templates": withStatus(400, {
          error: {
            code: "validation_failed",
            message: "Some fields need attention.",
            fields: { "services.app.name": "This name is taken in this project" },
          },
        }),
      }),
    );
    renderApp("/projects/shop/create?tab=templates");
    fireEvent.click(await screen.findByText("Gotify"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("This name is taken in this project")).toBeTruthy();
  });
});

describe("the custom tab", () => {
  it("rejects text that isn't JSON without asking the server", async () => {
    const server = installFakeServer(base());
    renderApp("/projects/shop/create?tab=custom");
    fireEvent.click(await screen.findByRole("button", { name: "Paste a schema" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "{ not json" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(within(dialog).getByText(/JSON|Expected|position/)).toBeTruthy());
    expect(server.calls.filter((request) => request.path.includes("templates/preview"))).toEqual([]);
  });
});

describe("the install page", () => {
  it("shows the parts, how each is doing, and offers to deploy and reveal", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/templates/abc": install,
        "POST /projects/shop/templates/abc/secrets/reveal": { value: "s3cret-value" },
      }),
    );
    renderApp("/projects/shop/installs/abc");

    expect(await screen.findByText("gotify")).toBeTruthy();
    expect(screen.getByText("Sign in as admin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("s3cret-value")).toBeTruthy();
  });

  it("explains a failure to load", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/templates/abc": withStatus(500, {
          error: { code: "internal_error", message: "x" },
        }),
      }),
    );
    renderApp("/projects/shop/installs/abc");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
