// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ServerPurposeState } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  SIGNED_IN,
  withStatus,
} from "../../testing/appHarness";

afterEach(resetApp);

const domain = (host: string, status: "protected" | "exposed" | "public") => ({
  host,
  path: "/",
  wildcard: false,
  project: "shop",
  service: "web",
  status,
});

const state = (overrides: Partial<ServerPurposeState> = {}): ServerPurposeState => ({
  purpose: "staging",
  protection: true,
  domains: [domain("a.example.test", "protected"), domain("b.example.test", "protected")],
  protectedCount: 2,
  totalCount: 2,
  problems: [],
  confirmation: "PUBLIC 2",
  ...overrides,
});

const open = async (routes: FakeRoute, path = "/settings/server/purpose") => {
  const server = installFakeServer({
    "GET /projects": [],
    "GET /server-purpose/users": {
      users: [{ id: "u1", username: "opsifier", createdAt: "2026-01-01T00:00:00.000Z" }],
    },
    "GET /server-purpose/allowlist": { entries: [], services: [{ project: "shop", service: "web" }] },
    ...routes,
  });
  const view = renderApp(path);
  return { server, view };
};

const topBar = async () => {
  await waitFor(() => {
    if (document.querySelector("header.brand-bar") === null) {
      throw new Error("Still rendering");
    }
  });
  return document.querySelector("header.brand-bar") as HTMLElement;
};

describe("the top bar indicator", () => {
  it("shows the purpose's label and how many domains are protected", async () => {
    await open({ "GET /server-purpose": state() }, "/");

    expect(await within(await topBar()).findByText("Staging")).toBeTruthy();
    expect(within(await topBar()).getByText("2/2")).toBeTruthy();
    expect(within(await topBar()).getByRole("link", { name: /2 of 2 domains protected/ })).toBeTruthy();
  });

  it("puts a gap first, as a failure", async () => {
    await open(
      {
        "GET /server-purpose": state({
          protectedCount: 1,
          domains: [domain("a.example.test", "exposed"), domain("b.example.test", "protected")],
        }),
      },
      "/",
    );

    const link = await within(await topBar()).findByRole("link", { name: /only 1 of 2 domains protected/ });
    const children = [...link.children];
    expect(children[0]?.getAttribute("data-state")).toBe("failed");
    expect(children[1]?.textContent).toBe("1/2");
  });

  it("reads as a failure when there are no credentials, even with every domain counted", async () => {
    await open({ "GET /server-purpose": state({ problems: [{ code: "no_credentials" }] }) }, "/");

    const link = await within(await topBar()).findByRole("link", { name: /every site is locked/ });
    expect(link.querySelector('[data-state="failed"]')).toBeTruthy();
  });

  it("says a production server is public, not protected", async () => {
    await open(
      {
        "GET /server-purpose": state({
          purpose: "production",
          protection: false,
          protectedCount: 0,
          domains: [domain("a.example.test", "public")],
          totalCount: 1,
        }),
      },
      "/",
    );

    expect(await within(await topBar()).findByText("Production")).toBeTruthy();
    expect(within(await topBar()).getByText("1 public")).toBeTruthy();
    const link = within(await topBar()).getByRole("link", { name: /public by design/ });
    expect(link.querySelector('[data-state="failed"]')).toBeNull();
  });

  it("tells an unknown purpose apart from a chosen one, and never crashes the bar", async () => {
    await open({}, "/");

    const lamp = await within(await topBar()).findByLabelText("Server purpose unknown");
    expect(lamp).toBeTruthy();
  });
});

describe("the first-use prompt", () => {
  const unset = state({
    purpose: null,
    confirmation: "PUBLIC 0",
    domains: [],
    totalCount: 0,
    protectedCount: 0,
  });

  it("asks an administrator after sign-in, and reports the generated credentials once", async () => {
    const { server } = await open(
      {
        "GET /server-purpose": unset,
        "PUT /server-purpose": {
          state: state(),
          credentials: { username: "opsifier", password: "generated-password-1234567890ab" },
        },
      },
      "/",
    );

    expect(await screen.findByRole("dialog", { name: "What is this server for?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Staging/ }));

    expect(await screen.findByText("generated-password-1234567890ab")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ purpose: "staging" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("generated-password-1234567890ab")).toBeNull());
  });

  it("needs the typed confirmation to choose production first", async () => {
    const { server } = await open(
      {
        "GET /server-purpose": unset,
        "PUT /server-purpose": {
          state: state({ purpose: "production", protection: false }),
          credentials: null,
        },
      },
      "/",
    );
    await screen.findByRole("dialog", { name: "What is this server for?" });

    fireEvent.click(screen.getByRole("button", { name: /^Production/ }));
    const confirm = await screen.findByRole("button", { name: "Move to production" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "PUBLIC 0" } });
    fireEvent.click(screen.getByRole("button", { name: "Move to production" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        purpose: "production",
        confirm: "PUBLIC 0",
      }),
    );
  });

  it("can be put off, for this visit", async () => {
    await open({ "GET /server-purpose": unset }, "/");
    await screen.findByRole("dialog", { name: "What is this server for?" });

    fireEvent.click(screen.getByRole("button", { name: "Decide later" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(await topBar()).getByText("Not set")).toBeTruthy();
  });

  it("does not appear when a purpose is set, or for someone who could not answer it", async () => {
    await open({ "GET /server-purpose": state() }, "/");
    await within(await topBar()).findByText("Staging");
    expect(screen.queryByRole("dialog")).toBeNull();
    resetApp();

    await open(
      {
        "GET /auth/session": { ...SIGNED_IN, user: { ...SIGNED_IN.user, role: "member" } },
        "GET /server-purpose": unset,
      },
      "/",
    );
    await within(await topBar()).findByText("Not set");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the settings page", () => {
  it("lists a domain that is exposed before the others, with a lamp saying so", async () => {
    await open({
      "GET /server-purpose": state({
        protectedCount: 1,
        domains: [domain("open.example.test", "exposed"), domain("safe.example.test", "protected")],
      }),
    });

    const open_ = await screen.findByText("open.example.test");
    const safe = screen.getByText("safe.example.test");
    expect(open_.compareDocumentPosition(safe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByLabelText("Exposed: not protected").length).toBeGreaterThan(0);
  });

  it("shows why protection is failing", async () => {
    await open({ "GET /server-purpose": state({ problems: [{ code: "no_credentials" }] }) });

    expect(await screen.findByText(/every site is locked. Add a user/)).toBeTruthy();
  });

  it("moves to production only with the confirmation that states the domain count", async () => {
    const { server } = await open({
      "GET /server-purpose": state(),
      "PUT /server-purpose": {
        state: state({ purpose: "production", protection: false }),
        credentials: null,
      },
    });
    await screen.findByText("a.example.test");

    fireEvent.click(screen.getByRole("button", { name: /^Production/ }));

    expect(await screen.findByText(/2 domains will become public/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Move to production" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Move to production?" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "PUBLIC 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Move to production" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        purpose: "production",
        confirm: "PUBLIC 2",
      }),
    );
  });

  it("offers leaving production with a plain confirmation", async () => {
    const { server } = await open({
      "GET /server-purpose": state({
        purpose: "production",
        protection: false,
        protectedCount: 0,
        domains: [domain("a.example.test", "public")],
        totalCount: 1,
      }),
      "PUT /server-purpose": {
        state: state(),
        credentials: { username: "opsifier", password: "shown-once-secret" },
      },
    });
    await screen.findByText("a.example.test");

    fireEvent.click(screen.getByRole("button", { name: /^Staging/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Protect this server" }));

    expect(await screen.findByText("shown-once-secret")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ purpose: "staging" });
  });

  it("generates a password for a new user and shows it once", async () => {
    const { server } = await open({
      "GET /server-purpose": state(),
      "POST /server-purpose/users": {
        user: { id: "u2", username: "alice", createdAt: "2026-01-01T00:00:00.000Z" },
        credentials: { username: "alice", password: "generated-for-alice" },
      },
    });
    await screen.findByText("opsifier");

    fireEvent.click(screen.getByRole("button", { name: "Add a user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a user" });
    fireEvent.change(within(dialog).getByLabelText(/Username/), { target: { value: "alice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a user" }));

    expect(await screen.findByText("generated-for-alice")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ username: "alice" });
  });

  it("refuses a bad username before calling the server", async () => {
    const { server } = await open({ "GET /server-purpose": state() });
    await screen.findByText("opsifier");

    fireEvent.click(screen.getByRole("button", { name: "Add a user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a user" });
    fireEvent.change(within(dialog).getByLabelText(/Username/), { target: { value: "a:b" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a user" }));

    expect(await within(dialog).findByText(/letters, digits, dots/)).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("shows each exemption with its warning and removes one", async () => {
    const { server } = await open({
      "GET /server-purpose": state(),
      "GET /server-purpose/allowlist": {
        entries: [
          {
            id: "e1",
            project: "shop",
            service: "web",
            kind: "path",
            value: "/healthz",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        services: [{ project: "shop", service: "web" }],
      },
      "DELETE /server-purpose/allowlist/e1": { id: "e1" },
    });

    expect(await screen.findByText("/healthz")).toBeTruthy();
    expect(screen.getAllByText(/way around the password/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove this exemption" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(server.calls.find((call) => call.method === "DELETE")).toBeDefined());
  });

  it("checks an exemption before calling the server, and sends a valid one", async () => {
    const { server } = await open({
      "GET /server-purpose": state(),
      "POST /server-purpose/allowlist": {
        id: "e2",
        project: "shop",
        service: "web",
        kind: "path",
        value: "/hooks/*",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await screen.findByLabelText("Path");
    const value = screen.getByLabelText("Path") as HTMLInputElement;

    fireEvent.change(value, { target: { value: "/a/../b" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an exemption" }));
    expect(await screen.findByText("Choose a service.")).toBeTruthy();
    expect(await screen.findByText(/for everything under it/)).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("explains certificate logs without recommending a wildcard nobody has verified", async () => {
    await open({ "GET /server-purpose": state() });

    expect(await screen.findByText(/Certificate Transparency/)).toBeTruthy();
    expect(screen.getByText(/HTTPS on a wildcard has not been verified/)).toBeTruthy();
    expect(screen.queryByText(/use a wildcard certificate/)).toBeNull();
  });

  it("hides the credentials and exemptions from someone who is not an administrator", async () => {
    await open({
      "GET /auth/session": { ...SIGNED_IN, user: { ...SIGNED_IN.user, role: "member" } },
      "GET /server-purpose": state(),
    });

    await screen.findByText("a.example.test");
    expect(screen.queryByText("Credentials")).toBeNull();
    expect(screen.queryByText("Exemptions")).toBeNull();
    expect((screen.getByRole("button", { name: /^Production/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error with a way to retry when the report can't be read", async () => {
    const { server } = await open({
      "GET /server-purpose": withStatus(500, { error: { code: "internal_error", message: "Boom" } }),
    });

    expect(await screen.findByText("Try again")).toBeTruthy();
    server.set({ "GET /server-purpose": state() });
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("a.example.test")).toBeTruthy();
  });
});
