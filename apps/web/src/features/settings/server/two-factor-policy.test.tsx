// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../../testing/appHarness";

afterEach(resetApp);

const OWNER = {
  id: "u1",
  email: "admin@example.com",
  role: "admin",
  owner: true,
  twoFactorEnabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  projects: [],
  apiKeyCount: 0,
  name: "",
  active: true,
};

const WITH_TWO_FACTOR = { ...SIGNED_IN, user: { ...SIGNED_IN.user, twoFactorEnabled: true } };
const policy = (overrides: object = {}) => ({
  required: false,
  accountsWithout: 3,
  canChange: true,
  ...overrides,
});

const page = (routes: Record<string, unknown>) =>
  installFakeServer({
    "GET /users": { users: [OWNER] },
    "GET /projects": { projects: [] },
    "GET /users/invitations": { invitations: [] },
    ...routes,
  });

const requireSwitch = () =>
  screen.findByRole("switch", { name: "Require two-factor sign-in for every account" });

describe("requiring two-factor sign-in", () => {
  it("lets the owner require it, after saying who it will hold up", async () => {
    const server = page({
      "GET /auth/session": WITH_TWO_FACTOR,
      "GET /settings/two-factor": policy(),
      "PUT /settings/two-factor": policy({ required: true }),
    });
    renderApp("/settings/server/users");

    expect(await screen.findByText(/3 accounts don't use it yet/)).toBeTruthy();
    fireEvent.click(await requireSwitch());
    expect(await screen.findByText(/3 accounts don't use it yet: until they turn it on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Require it" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ required: true }),
    );
  });

  it("says so when every account already uses it", async () => {
    page({
      "GET /auth/session": WITH_TWO_FACTOR,
      "GET /settings/two-factor": policy({ accountsWithout: 0 }),
    });
    renderApp("/settings/server/users");

    expect(await screen.findByText(/Every active account already uses it\./)).toBeTruthy();
    fireEvent.click(await requireSwitch());
    expect(await screen.findByText(/A new account will have to turn it on/)).toBeTruthy();
  });

  it("asks the owner to turn it on for their own account first", async () => {
    page({ "GET /settings/two-factor": policy() });
    renderApp("/settings/server/users");

    expect((await requireSwitch()).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Turn on two-factor sign-in on your own account first/)).toBeTruthy();
  });

  it("is the owner's alone to change", async () => {
    page({
      "GET /auth/session": WITH_TWO_FACTOR,
      "GET /settings/two-factor": policy({ required: true, accountsWithout: 1, canChange: false }),
    });
    renderApp("/settings/server/users");

    const toggle = await requireSwitch();
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Only the owner can change this.")).toBeTruthy();
  });
});
