// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const EMPTY = { configured: false, login: null, updatedAt: null };
const CONNECTED = { configured: true, login: "octocat", updatedAt: "2026-01-01T00:00:00.000Z" };

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
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    expect(screen.getByText(/repo scope/)).toBeTruthy();
    expect(screen.getByText(/admin:repo_hook/)).toBeTruthy();
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
