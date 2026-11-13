// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, within } from "@testing-library/react";
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

const KEPT = { ...SIGNED_IN, twoFactorSetupRequired: true };
const secret = "JBSWY3DPEHPK3PXP";
const codes = Array.from({ length: 10 }, (_, index) => `aaaa-bbbb-cccc-000${index}`);
const dialog = () => within(screen.getByRole("dialog"));

describe("an account the panel requires two-factor sign-in of", () => {
  it("is sent to turning it on, and comes into the panel once it has", async () => {
    const server = installFakeServer({
      "GET /auth/session": KEPT,
      "POST /auth/two-factor/begin": { secret, otpauthUri: `otpauth://totp/Opsifier:a?secret=${secret}` },
      "POST /auth/two-factor/enable": {
        status: "signed-in",
        user: { ...SIGNED_IN.user, twoFactorEnabled: true },
        recoveryCodes: codes,
      },
    });
    const app = renderApp("/settings/server/users");

    await expectLocation(app, "/two-factor");
    expect(await screen.findByText("Turn on two-factor sign-in")).toBeTruthy();
    expect(screen.getByText("Signed in as admin@example.com.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    fireEvent.change(dialog().getByLabelText("Current password"), { target: { value: "my password" } });
    fireEvent.click(dialog().getByRole("button", { name: "Continue" }));
    await screen.findByText(secret);
    fireEvent.change(dialog().getByLabelText("6-digit code"), { target: { value: "123456" } });
    await screen.findByRole("list", { name: "Recovery codes" });
    fireEvent.click(dialog().getByRole("checkbox"));
    fireEvent.click(dialog().getByRole("button", { name: "Done" }));

    await expectLocation(app, "/");
    expect(
      server.calls.filter((call) => call.path.startsWith("/auth/two-factor")).map((call) => call.path),
    ).toEqual(["/auth/two-factor/begin", "/auth/two-factor/enable"]);
  });

  it("is sent there as soon as the panel refuses it something for that reason", async () => {
    const server = installFakeServer({
      "GET /users": () => {
        // The owner required it while the page was open.
        server.set({ "GET /auth/session": KEPT });
        return withStatus(403, {
          error: { code: "two_factor_setup_required", message: "Turn it on first." },
        });
      },
      "GET /projects": { projects: [] },
    });
    const app = renderApp("/settings/server/users");

    await expectLocation(app, "/two-factor");
  });

  it("can sign out instead", async () => {
    installFakeServer({
      "GET /auth/session": KEPT,
      "POST /auth/logout": { status: "signed-out" },
    });
    const app = renderApp("/two-factor");

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await expectLocation(app, "/login");
  });

  it("is let through when nothing is required of it", async () => {
    installFakeServer({});
    const app = renderApp("/two-factor");

    await expectLocation(app, "/");
  });
});
