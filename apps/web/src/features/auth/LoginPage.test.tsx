// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { i18n } from "../../i18n";
import { LoginPage } from "./LoginPage";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  useRouter: () => ({ navigate: router.navigate }),
}));

vi.mock("./AuthLayout", () => ({
  AuthLayout: ({ title, children }: { title: string; children: unknown }) => (
    <main aria-label={title}>{children as never}</main>
  ),
}));

const fetchMock = vi.fn();
const signedIn = {
  status: "signed-in",
  user: { id: "1", email: "a@example.com", role: "admin", twoFactorEnabled: true },
};

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

const lastBody = () => JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body as string) as Record<string, unknown>;

async function reachCodeStep() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LoginPage />
    </QueryClientProvider>,
  );
  respond(401, { error: { code: "two_factor_required", message: "Enter the code." } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Authentication code");
}

const switchToRecovery = () =>
  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
const recoveryField = () => screen.getByLabelText("Recovery code") as HTMLInputElement;
const verify = () => fireEvent.click(screen.getByRole("button", { name: "Verify" }));

beforeEach(async () => {
  await i18n.changeLanguage("en");
  router.navigate.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the login 2FA step", () => {
  it("signs in with a recovery code", async () => {
    await reachCodeStep();
    switchToRecovery();

    respond(200, signedIn);
    fireEvent.change(recoveryField(), { target: { value: "abcd-efgh-jkmn-pqrs" } });
    verify();

    await waitFor(() => expect(router.navigate).toHaveBeenCalled());
    expect(lastBody()).toMatchObject({ recoveryCode: "abcd-efgh-jkmn-pqrs" });
    expect(lastBody().code).toBeUndefined();
  });

  it("checks the format before sending anything", async () => {
    await reachCodeStep();
    switchToRecovery();
    const calls = fetchMock.mock.calls.length;

    fireEvent.change(recoveryField(), { target: { value: "not a code" } });
    verify();

    expect(screen.getByText(/Enter a recovery code/)).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("shows a refused code on the field and lets you try again", async () => {
    await reachCodeStep();
    switchToRecovery();

    respond(401, {
      error: {
        code: "invalid_recovery_code",
        message: "No.",
        fields: { recoveryCode: "That code is not valid." },
      },
    });
    fireEvent.change(recoveryField(), { target: { value: "abcd-efgh-jkmn-pqrs" } });
    verify();

    await screen.findByText(/recovery code didn't work/);
    expect(recoveryField().value).toBe("");
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("goes back to the authenticator code", async () => {
    await reachCodeStep();
    switchToRecovery();

    fireEvent.click(screen.getByRole("button", { name: "Use a code from your app instead" }));

    expect(screen.getByLabelText("Authentication code")).toBeTruthy();
    expect(screen.queryByLabelText("Recovery code")).toBeNull();
  });

  it("has the French wording too", async () => {
    await reachCodeStep();
    await i18n.changeLanguage("fr");

    await screen.findByRole("button", { name: "Utiliser plutôt un code de récupération" });
  });
});
