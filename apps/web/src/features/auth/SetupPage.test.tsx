// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { i18n } from "../../i18n";
import { SetupPage } from "./SetupPage";

const router = vi.hoisted(() => ({ search: {} as { token?: string }, navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}));

vi.mock("./AuthLayout", () => ({
  AuthLayout: ({ title, children }: { title: string; children: unknown }) => (
    <main aria-label={title}>{children as never}</main>
  ),
}));

const fetchMock = vi.fn();

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SetupPage />
    </QueryClientProvider>,
  );
}

const codeField = () => screen.queryByLabelText("Setup code") as HTMLInputElement | null;
const emailField = () => screen.getByLabelText("Email") as HTMLInputElement;
const passwordField = () => screen.getByLabelText("Password") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: "Create account" });

function fillAccount() {
  fireEvent.change(emailField(), { target: { value: "admin@example.com" } });
  fireEvent.change(passwordField(), { target: { value: "a long enough password" } });
}

const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body as string) as Record<string, unknown>;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  router.search = {};
  router.navigate.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupPage", () => {
  it("sends the code from the link, without asking for one", async () => {
    router.search = { token: "code-from-link" };
    renderPage();
    expect(codeField()).toBeNull();

    respond(201, {
      status: "signed-in",
      user: { id: "1", email: "admin@example.com", role: "admin", twoFactorEnabled: false },
    });
    fillAccount();
    fireEvent.click(submitButton());

    await waitFor(() => expect(router.navigate).toHaveBeenCalled());
    expect(lastBody().token).toBe("code-from-link");
  });

  it("asks for the code, and says where it is, when the link has none", () => {
    renderPage();

    expect(codeField()).not.toBeNull();
    expect(screen.getByText(/server log/)).toBeTruthy();
  });

  it("will not submit without a code", () => {
    renderPage();
    fillAccount();

    fireEvent.click(submitButton());

    expect(screen.getByText("Enter the setup code.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a typed code", async () => {
    renderPage();
    respond(201, {
      status: "signed-in",
      user: { id: "1", email: "admin@example.com", role: "admin", twoFactorEnabled: false },
    });

    fireEvent.change(codeField() as HTMLInputElement, { target: { value: "typed-code" } });
    fillAccount();
    fireEvent.click(submitButton());

    await waitFor(() => expect(router.navigate).toHaveBeenCalled());
    expect(lastBody().token).toBe("typed-code");
  });

  it("shows the field when the code in the link is refused", async () => {
    router.search = { token: "stale-link" };
    renderPage();
    respond(403, {
      error: {
        code: "invalid_setup_token",
        message: "That setup code is not valid.",
        fields: { token: "x" },
      },
    });

    fillAccount();
    fireEvent.click(submitButton());

    await waitFor(() => expect(codeField()).not.toBeNull());
    expect(screen.getByText(/isn't right/)).toBeTruthy();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("has the French wording too", async () => {
    await i18n.changeLanguage("fr");
    renderPage();

    expect(screen.getByLabelText("Code de configuration")).toBeTruthy();
    expect(screen.getByText(/journal du serveur/)).toBeTruthy();
  });
});
