// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen } from "@testing-library/react";
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

const REQUEST = {
  userCode: "BCDF-GHJK",
  client: "ada-laptop",
  address: "203.0.113.7",
  sameAddress: false,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe("approving the command line", () => {
  it("shows what asks and from where, then approves with the password", async () => {
    const server = installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /auth/cli/requests/BCDF-GHJK": REQUEST,
      "POST /auth/cli/requests/BCDF-GHJK/approve": { status: "approved" },
    });
    renderApp("/cli-login?code=BCDF-GHJK");

    expect(await screen.findByText("BCDF-GHJK")).toBeTruthy();
    expect(screen.getByText(/ada-laptop/)).toBeTruthy();
    expect(screen.getByText(/203\.0\.113\.7/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "my password" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow the command line" }));

    expect(await screen.findByText("The command line is signed in")).toBeTruthy();
    const approval = server.calls.find((call) => call.path === "/auth/cli/requests/BCDF-GHJK/approve");
    expect(approval?.body).toEqual({ currentPassword: "my password" });
  });

  it("asks for the two-factor code instead, when the account has it", async () => {
    installFakeServer({
      "GET /auth/session": { ...SIGNED_IN, user: { ...SIGNED_IN.user, twoFactorEnabled: true } },
      "GET /auth/cli/requests/BCDF-GHJK": { ...REQUEST, sameAddress: true },
    });
    renderApp("/cli-login?code=BCDF-GHJK");

    await screen.findByText("BCDF-GHJK");
    expect(screen.getByText("Enter the code from your authenticator app to allow it.")).toBeTruthy();
    expect(screen.queryByText(/203\.0\.113\.7/)).toBeNull();
  });

  it("refuses the request", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /auth/cli/requests/BCDF-GHJK": REQUEST,
      "POST /auth/cli/requests/BCDF-GHJK/deny": { status: "denied" },
    });
    renderApp("/cli-login?code=BCDF-GHJK");

    await screen.findByText("BCDF-GHJK");
    fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
    expect(await screen.findByText("Refused")).toBeTruthy();
  });

  it("says when the request is no longer waiting", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /auth/cli/requests/BCDF-GHJK": withStatus(404, { error: { code: "not_found", message: "Gone." } }),
    });
    renderApp("/cli-login?code=BCDF-GHJK");

    expect(await screen.findByText("This request is no longer waiting")).toBeTruthy();
  });

  it("sends a signed-out person to sign in first, and back here after", async () => {
    installFakeServer({ "GET /auth/session": { status: "signed-out" } });
    const app = renderApp("/cli-login?code=BCDF-GHJK");

    await expectLocation(app, "/login");
  });
});
