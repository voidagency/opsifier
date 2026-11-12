// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectLocation,
  installFakeServer,
  renderApp,
  resetApp,
  SIGNED_IN,
  withStatus,
} from "../../testing/appHarness";

afterEach(resetApp);

const SIGNED_OUT = { status: "signed-out" };
const PREVIEW = {
  email: "ann@example.com",
  role: "member",
  invitedBy: "Ada Admin",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("accepting an invitation", () => {
  it("creates the account with the name and password chosen, then opens the panel", async () => {
    const server = installFakeServer({
      "GET /auth/session": SIGNED_OUT,
      "POST /auth/invitation/check": PREVIEW,
      "POST /auth/invitation/accept": () => {
        server.set({ "GET /auth/session": SIGNED_IN });
        return withStatus(201, {
          status: "signed-in",
          user: { ...SIGNED_IN.user, email: "ann@example.com" },
        });
      },
    });
    const app = renderApp("/invitation#link-token");

    expect(await screen.findByText(/Ada Admin invited you to this server/)).toBeTruthy();
    expect(screen.getByDisplayValue("ann@example.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Example" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));
    expect(await screen.findByText("Use at least 12 characters.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a fine long password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));

    await expectLocation(app, "/");
    expect(server.calls.find((call) => call.path === "/auth/invitation/check")?.body).toEqual({
      token: "link-token",
    });
    expect(server.calls.find((call) => call.path === "/auth/invitation/accept")?.body).toEqual({
      token: "link-token",
      name: "Ann Example",
      password: "a fine long password",
    });
  });

  it("says plainly when a link no longer works", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_OUT,
      "POST /auth/invitation/check": withStatus(404, {
        error: { code: "invitation_invalid", message: "This invitation link no longer works." },
      }),
    });
    renderApp("/invitation#used-token");

    expect(await screen.findByText("This invitation no longer works")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });

  it("asks nothing of the server for a link without its token", async () => {
    const server = installFakeServer({ "GET /auth/session": SIGNED_OUT });
    renderApp("/invitation");

    expect(await screen.findByText("This invitation no longer works")).toBeTruthy();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.startsWith("/auth/invitation"))).toBe(false),
    );
  });
});
