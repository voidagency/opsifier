// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const EMPTY = { configured: false, login: null, updatedAt: null, method: null, oauthApp: null };
const CONNECTED = {
  configured: true,
  login: "octocat",
  updatedAt: "2026-01-01T00:00:00.000Z",
  method: "token",
  oauthApp: null,
};

const renderAppAt = (path: string) => {
  installFakeServer({ "GET /settings/github": EMPTY });
  renderApp(path);
};

const open = async (routes: FakeRoute) => {
  const server = installFakeServer(routes);
  renderApp("/settings/server/github");
  await screen.findByText("Access token");
  return server;
};

describe("the GitHub settings page", () => {
  it("masks the token, with a way to reveal it, and names the scopes it needs", async () => {
    await open({ "GET /settings/github": EMPTY });

    const input = screen.getByLabelText("Access token") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getAllByRole("button", { name: "Show password" })[0] as HTMLElement);
    expect(input.type).toBe("text");
    expect(screen.getByText(/repo scope/)).toBeTruthy();
    expect(screen.getByText(/admin:repo_hook/)).toBeTruthy();
  });

  describe("connecting through an OAuth app", () => {
    const WITH_APP = { ...EMPTY, oauthApp: { clientId: "Iv1.abc" } };

    it("shows the callback to register, and saves the app without showing its secret again", async () => {
      const server = await open({
        "GET /settings/github": EMPTY,
        "PUT /settings/github/oauth": WITH_APP,
      });
      expect(
        ((await screen.findByLabelText(/Callback URL/)) as HTMLInputElement).value.endsWith(
          "/api/v1/settings/github/oauth/callback",
        ),
      ).toBe(true);
      fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "Iv1.abc" } });
      fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "shh" } });
      server.set({ "GET /settings/github": WITH_APP, "PUT /settings/github/oauth": WITH_APP });

      fireEvent.click(screen.getByRole("button", { name: "Save the app" }));

      await waitFor(() =>
        expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
          clientId: "Iv1.abc",
          clientSecret: "shh",
        }),
      );
      expect(await screen.findByText("Iv1.abc")).toBeTruthy();
      expect(screen.queryByLabelText("Client secret")).toBeNull();
    });

    it("says what each field needs", async () => {
      const server = await open({ "GET /settings/github": EMPTY });

      fireEvent.click(screen.getByRole("button", { name: "Save the app" }));

      expect(await screen.findByText("Paste the client ID of the OAuth app.")).toBeTruthy();
      expect(server.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    });

    it("shows what connected the panel, and offers the way to connect", async () => {
      await open({
        "GET /settings/github": { ...WITH_APP, configured: true, login: "octocat", method: "oauth" },
      });

      expect(await screen.findByText("Connected as octocat, through the OAuth app")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connect with GitHub" })).toBeTruthy();
    });

    it("reports a sign-in that came back with an error", async () => {
      renderAppAt("/settings/server/github?oauthError=denied");

      expect(await screen.findByText("GitHub wasn't given access.")).toBeTruthy();
    });
  });

  it("requires a value before calling the server", async () => {
    const server = await open({ "GET /settings/github": EMPTY });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Paste a GitHub token.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("shows when GitHub refuses a token", async () => {
    await open({
      "GET /settings/github": EMPTY,
      "PUT /settings/github": withStatus(400, {
        error: {
          code: "github_token_invalid",
          message: "GitHub did not accept this token.",
          fields: { token: "GitHub did not accept this token" },
        },
      }),
    });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "nope" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("GitHub didn't accept this token.")).toBeTruthy();
  });

  it("saves a token and says who it belongs to, then lets it be removed", async () => {
    const server = await open({ "GET /settings/github": EMPTY, "PUT /settings/github": CONNECTED });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "ghp_x" } });
    server.set({ "GET /settings/github": CONNECTED, "DELETE /settings/github": EMPTY });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Connected as octocat")).toBeTruthy();
    expect(((await screen.findByLabelText("Access token")) as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});
