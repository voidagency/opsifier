// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const MEMBER = {
  status: "signed-in",
  user: { ...SIGNED_IN.user, role: "member" },
};

describe("the settings menu", () => {
  it("shows server settings to administrators only", async () => {
    installFakeServer({});
    renderApp("/settings/user/api");
    expect(await screen.findByRole("link", { name: "General" })).toBeTruthy();
    resetApp();

    installFakeServer({ "GET /auth/session": MEMBER });
    renderApp("/settings/user/api");
    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("link", { name: "General" })).toBeNull();
  });
});

describe("API keys", () => {
  const KEY = {
    id: "k1",
    name: "ci",
    prefix: "opsifier_abc",
    level: "read",
    projects: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  it("shows a new key once, and lists it afterwards without the secret", async () => {
    installFakeServer({
      "GET /me/api-keys": { keys: [] },
      "GET /projects": { projects: [] },
      "POST /me/api-keys": () => ({ ...KEY, token: "opsifier_supersecret" }),
    });
    renderApp("/settings/user/api-keys");
    fireEvent.click(await screen.findByRole("button", { name: "New key" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "ci" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByDisplayValue("opsifier_supersecret")).toBeTruthy();
    expect(screen.getByText(/won't be shown again/)).toBeTruthy();
  });

  it("revokes a key after a confirmation", async () => {
    const server = installFakeServer({
      "GET /me/api-keys": { keys: [KEY] },
      "DELETE /me/api-keys/k1": { ok: true },
    });
    renderApp("/settings/user/api-keys");
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});

describe("users", () => {
  const OWNER = {
    id: "u1",
    email: "admin@example.com",
    role: "admin",
    owner: true,
    twoFactorEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    projects: [],
    apiKeyCount: 0,
    name: "",
    active: true,
  };
  const MEMBER_USER = {
    ...OWNER,
    id: "u2",
    email: "sam@example.com",
    role: "member",
    owner: false,
    projects: [{ project: "shop", role: "viewer" }],
  };

  it("shows each account's role and access, and guards the owner", async () => {
    installFakeServer({ "GET /users": { users: [OWNER, MEMBER_USER] }, "GET /projects": { projects: [] } });
    renderApp("/settings/server/users");
    expect(await screen.findByText("admin@example.com")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText(/1 project/)).toBeTruthy();
    // Only the second account can be deleted.
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  });

  it("requires the email to be typed before deleting", async () => {
    const server = installFakeServer({
      "GET /users": { users: [OWNER, MEMBER_USER] },
      "GET /projects": { projects: [] },
      "DELETE /users/u2": { ok: true },
    });
    renderApp("/settings/server/users");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("button", { name: "Delete" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sam@example.com" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({
        confirm: "sam@example.com",
      }),
    );
  });
});

describe("general settings", () => {
  const OVERVIEW = {
    hostname: "host-1",
    uptimeSeconds: 90_061,
    dailyCleanup: true,
    releasesKept: 5,
    panel: { version: "1.0.0", managed: true },
    proxy: { state: "running" },
    docker: {
      available: true,
      version: "29.1.0",
      apiVersion: "1.52",
      minimumVersion: "26.0.0",
      minimumApiVersion: "1.45",
      swarm: "active",
      missing: [],
      warnings: [],
    },
  };
  const routes = {
    "GET /server/overview": OVERVIEW,
    "GET /server/panel-domain": {
      defaultDomain: "panel.203.0.113.10.sslip.io",
      customDomain: null,
      serveOnIp: true,
      url: "https://panel.203.0.113.10.sslip.io",
    },
    "GET /server/service-domain": { defaultDomain: "*.203.0.113.10.sslip.io", customDomain: null },
    "GET /server/letsencrypt-email": { email: "admin@example.com" },
  };

  it("shows the state strip and the read-only domains", async () => {
    installFakeServer(routes);
    renderApp("/settings/server/general");
    expect(await screen.findByText(/Uptime: 1 days, 1 hours, 1 minutes/)).toBeTruthy();
    expect(await screen.findByDisplayValue("panel.203.0.113.10.sslip.io")).toBeTruthy();
    expect((screen.getByDisplayValue("panel.203.0.113.10.sslip.io") as HTMLInputElement).readOnly).toBe(true);
    expect(await screen.findByDisplayValue("admin@example.com")).toBeTruthy();
  });

  it("says what the daily cleanup does beside its switch", async () => {
    installFakeServer(routes);
    renderApp("/settings/server/general");
    expect(await screen.findByText(/Off until you turn it on/)).toBeTruthy();
  });

  it("shows server errors next to the field that caused them", async () => {
    installFakeServer({
      ...routes,
      "PUT /server/letsencrypt-email": () =>
        withStatus(400, {
          error: {
            code: "validation_failed",
            message: "Some fields need attention.",
            fields: { email: "Enter a valid email address" },
          },
        }),
    });
    renderApp("/settings/server/general");
    const email = await screen.findByDisplayValue("admin@example.com");
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.submit(email.closest("form") as HTMLFormElement);
    expect(await screen.findByText("Enter a valid email address")).toBeTruthy();
  });
});

describe("notifications", () => {
  const CHANNEL = {
    id: "c1",
    name: "ops",
    type: "webhook",
    target: "hooks.example.com",
    hasSecret: true,
    config: { type: "webhook" },
    events: {
      deploy: true,
      backup: true,
      dockerCleanup: true,
      updateAvailable: true,
      diskUsage: { enabled: true, minPercent: 80, cron: "0 2 * * *" },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    lastDeliveryAt: "2026-01-02T00:00:00.000Z",
    lastDeliveryOk: false,
  };

  it("shows the state of each channel without its secrets", async () => {
    installFakeServer({
      "GET /notifications/channels": {
        channels: [CHANNEL],
        settings: { allowPrivateDestinations: false },
        canChangeSettings: true,
      },
      "GET /notifications/deliveries": { deliveries: [] },
    });
    renderApp("/settings/server/notifications");
    expect(await screen.findByText("ops")).toBeTruthy();
    expect(screen.getByLabelText("Last delivery failed")).toBeTruthy();
    expect(document.body.textContent).toContain("hooks.example.com");
  });

  it("sends a test from what's in the form, without saving", async () => {
    const server = installFakeServer({
      "GET /notifications/channels": {
        channels: [],
        settings: { allowPrivateDestinations: false },
        canChangeSettings: true,
      },
      "GET /notifications/deliveries": { deliveries: [] },
      "POST /notifications/test": { ok: true, detail: "HTTP 200" },
    });
    renderApp("/settings/server/notifications");
    fireEvent.click((await screen.findAllByRole("button", { name: "Add channel" }))[0] as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "ops" } });
    fireEvent.change(screen.getByLabelText("Webhook URL"), {
      target: { value: "https://discord.com/api/webhooks/1/abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    expect(await screen.findByText("The test was delivered.")).toBeTruthy();
    expect(
      server.calls.filter((call) => call.method === "POST" && call.path === "/notifications/channels"),
    ).toHaveLength(0);
    const sent = server.calls.find((call) => call.path === "/notifications/test")?.body as {
      config: { webhookUrl: string };
    };
    expect(sent.config.webhookUrl).toBe("https://discord.com/api/webhooks/1/abc");
  });

  it("only lets the owner allow private destinations", async () => {
    installFakeServer({
      "GET /notifications/channels": {
        channels: [CHANNEL],
        settings: { allowPrivateDestinations: false },
        canChangeSettings: false,
      },
      "GET /notifications/deliveries": { deliveries: [] },
    });
    renderApp("/settings/server/notifications");
    expect(await screen.findByText("Only the owner can change this.")).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: /Allow private destinations/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("certificates", () => {
  it("shows the empty state", async () => {
    installFakeServer({ "GET /certificates": { certificates: [] } });
    renderApp("/settings/server/certificates");
    expect(await screen.findByText("No certificates yet")).toBeTruthy();
  });

  it("lists certificates problems first, and needs the domain typed to remove one", async () => {
    const server = installFakeServer({
      "GET /certificates": {
        certificates: [
          {
            id: "0123456789abcdef",
            domain: "app.example.com",
            sans: [],
            resolver: "letsencrypt",
            issuer: "Stub CA",
            notBefore: "2026-01-01T00:00:00.000Z",
            notAfter: "2026-02-01T00:00:00.000Z",
            state: "expired",
          },
        ],
      },
      "DELETE /certificates/0123456789abcdef": () => ({
        id: "a",
        type: "proxy.restart",
        title: "t",
        status: "queued",
        projectName: null,
        serviceName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
        hasLog: false,
        actorEmail: null,
      }),
    });
    renderApp("/settings/server/certificates");
    expect(await screen.findByLabelText("Expired")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByRole("button", { name: "Remove" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "app.example.com" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({
        confirm: "app.example.com",
      }),
    );
  });
});

describe("monitoring", () => {
  const OVERVIEW = {
    metrics: { enabled: true, retention: 7, retentionUnit: "days", scrapeSeconds: 15 },
    logs: { enabled: false, retention: 7, retentionUnit: "days", maxSizeMb: 1024 },
    store: {
      rows: 10,
      approximateBytes: 2048,
      oldestAt: "2026-01-01T00:00:00.000Z",
      newestAt: "2026-01-02T00:00:00.000Z",
    },
    logStore: { rows: 0, approximateBytes: 0, oldestAt: null, newestAt: null },
  };

  it("loads the defaults and saves what changed", async () => {
    const server = installFakeServer({
      "GET /settings/monitoring": OVERVIEW,
      "PUT /settings/monitoring": OVERVIEW,
    });
    renderApp("/settings/server/monitoring");
    expect(await screen.findByDisplayValue("1024")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "PUT")).toBe(true));
    expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({
      metrics: { enabled: true, retention: 7, retentionUnit: "days", scrapeSeconds: 15 },
    });
  });
});

describe("the API reference", () => {
  it("renders the published document, searchable", async () => {
    installFakeServer({
      "GET /openapi.json": {
        info: { title: "Opsifier API", version: "1.0.0" },
        paths: {
          "/api/v1/projects": {
            get: { summary: "List projects", tags: ["Projects"], responses: { 200: { description: "OK" } } },
          },
          "/api/v1/users": {
            get: { summary: "List users", tags: ["Accounts"], responses: { 200: { description: "OK" } } },
          },
        },
      },
    });
    renderApp("/settings/user/api");
    expect(await screen.findByText("/api/v1/projects")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search operations"), { target: { value: "users" } });
    await waitFor(() => expect(screen.queryByText("/api/v1/projects")).toBeNull());
    expect(screen.getByText("/api/v1/users")).toBeTruthy();
  });
});
