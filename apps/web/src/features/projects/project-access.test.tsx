// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../testing/appHarness";

afterEach(resetApp);

const CREATED = "2026-01-01T00:00:00.000Z";

const member = (email: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${email}`,
  email,
  name: "",
  owner: false,
  administrator: false,
  active: true,
  role: "viewer",
  grant: null,
  allProjects: null,
  ...extra,
});

const OWNER = member("admin@example.com", { id: "u1", owner: true, administrator: true, role: "admin" });
const OWN = member("own@example.com", { role: "operator", grant: "operator" });
const EVERYWHERE = member("ops@example.com", { role: "operator", allProjects: "operator" });
const VIEWER = member("view@example.com", { allProjects: "viewer" });

const account = (email: string, role = "member") => ({
  id: `id-${email}`,
  email,
  name: "",
  role,
  owner: false,
  twoFactorEnabled: false,
  active: true,
  createdAt: CREATED,
  projects: [],
  allProjects: null,
  apiKeyCount: 0,
});

const page = (members: unknown[], routes: Record<string, unknown> = {}) =>
  installFakeServer({
    "GET /projects": { projects: [{ name: "shop", createdAt: CREATED, services: [] }] },
    "GET /projects/shop": { name: "shop", createdAt: CREATED, services: [] },
    "GET /projects/shop/env": { names: [] },
    "GET /projects/shop/schema": { services: [] },
    "GET /projects/shop/members": { members },
    ...routes,
  });

async function accessSection(): Promise<ReturnType<typeof within>> {
  const heading = await screen.findByRole("heading", { name: "Access" });
  return within(heading.closest("section") as HTMLElement);
}

async function choose(combobox: HTMLElement, option: string): Promise<void> {
  fireEvent.click(combobox);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("a project's access", () => {
  it("lists who reaches the project and where each role comes from", async () => {
    page([OWNER, EVERYWHERE, OWN, VIEWER]);
    renderApp("/projects/shop/settings");

    const section = await accessSection();
    expect(await section.findByText("admin@example.com")).toBeTruthy();
    expect(section.getByText("Owner")).toBeTruthy();
    expect(section.getByText("Every project, as an administrator")).toBeTruthy();
    // A role in every project is changed on the account, not here.
    expect(section.getByText("Operator in every project, set on the Users page")).toBeTruthy();
    expect(section.queryByRole("combobox", { name: "Role of ops@example.com in shop" })).toBeNull();
    expect(section.getByRole("combobox", { name: "Role of own@example.com in shop" }).textContent).toBe(
      "Operator",
    );
    expect(section.getByRole("button", { name: "Remove the access of own@example.com" })).toBeTruthy();
    expect(section.getByRole("combobox", { name: "Role of view@example.com in shop" }).textContent).toBe(
      "Viewer",
    );
    expect(section.queryByRole("button", { name: "Remove the access of view@example.com" })).toBeNull();
  });

  it("gives access to a member who doesn't reach the project yet", async () => {
    const server = page([OWNER, OWN], {
      "GET /users": {
        users: [
          account("admin@example.com", "admin"),
          account("own@example.com"),
          account("new@example.com"),
        ],
      },
      "PUT /projects/shop/members/id-new@example.com": {
        members: [OWNER, OWN, member("new@example.com", { grant: "viewer" })],
      },
    });
    renderApp("/projects/shop/settings");

    const section = await accessSection();
    fireEvent.click(await section.findByRole("button", { name: "Give access" }));
    const dialog = within(await screen.findByRole("dialog"));
    // Only members who don't reach the project are offered.
    await choose(await dialog.findByRole("combobox", { name: "Account" }), "new@example.com");
    expect(screen.queryByRole("option", { name: "own@example.com" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Give access" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")).toMatchObject({
        path: "/projects/shop/members/id-new@example.com",
        body: { role: "viewer" },
      }),
    );
    expect(await section.findByText("new@example.com")).toBeTruthy();
  });

  it("raises a role at once, and asks before lowering or removing one", async () => {
    const server = page([OWNER, OWN, VIEWER], {
      "PUT /projects/shop/members/id-view@example.com": { members: [OWNER, OWN, VIEWER] },
      "PUT /projects/shop/members/id-own@example.com": { members: [OWNER, OWN, VIEWER] },
    });
    renderApp("/projects/shop/settings");
    const section = await accessSection();
    const puts = () => server.calls.filter((call) => call.method === "PUT");

    await choose(
      await section.findByRole("combobox", { name: "Role of view@example.com in shop" }),
      "Operator",
    );
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toEqual({ role: "operator" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await choose(section.getByRole("combobox", { name: "Role of own@example.com in shop" }), "Viewer");
    const lower = await screen.findByRole("dialog", { name: "Lower the access of own@example.com?" });
    expect(puts()).toHaveLength(1);
    fireEvent.click(within(lower).getByRole("button", { name: "Lower" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]?.body).toEqual({ role: "viewer" });

    fireEvent.click(section.getByRole("button", { name: "Remove the access of own@example.com" }));
    const remove = await screen.findByRole("dialog", {
      name: "Remove the access of own@example.com to shop?",
    });
    fireEvent.click(within(remove).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(puts()[2]?.body).toEqual({ role: null });
  });

  it("is not shown to a member, who never asks for it", async () => {
    const server = page([OWNER], {
      "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } },
    });
    renderApp("/projects/shop/settings");

    expect(await screen.findByRole("heading", { name: "Portable description" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Access" })).toBeNull();
    expect(server.calls.some((call) => call.path.endsWith("/members"))).toBe(false);
  });
});
