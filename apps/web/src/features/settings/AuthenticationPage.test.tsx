// @vitest-environment jsdom
import type { SessionState } from "@opsifier/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { i18n } from "../../i18n";
import { sessionQuery } from "../auth/session";
import { AuthenticationPage } from "./AuthenticationPage";

const fetchMock = vi.fn();
const user = { id: "1", email: "admin@example.com", role: "admin" as const, twoFactorEnabled: false };
const codes = Array.from({ length: 10 }, (_, index) => `aaaa-bbbb-cccc-000${index}`);
const secret = "JBSWY3DPEHPK3PXP";

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call]?.[1].body as string) as Record<string, unknown>;
}

function renderPage(session: SessionState = { status: "signed-in", user }) {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, session);
  render(
    <QueryClientProvider client={client}>
      <AuthenticationPage />
    </QueryClientProvider>,
  );
}

const dialog = () => within(screen.getByRole("dialog"));
const passwordField = () => dialog().getByLabelText("Current password");

async function startSetup() {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Set up two-factor" }));
  await screen.findByRole("dialog");
}

async function reachScanStep() {
  await startSetup();
  respond(200, { secret, otpauthUri: `otpauth://totp/Opsifier:a?secret=${secret}` });
  fireEvent.change(passwordField(), { target: { value: "my current password" } });
  fireEvent.click(dialog().getByRole("button", { name: "Continue" }));
  await screen.findByText(secret);
}

async function reachCodesStep() {
  await reachScanStep();
  respond(200, { status: "signed-in", user: { ...user, twoFactorEnabled: true }, recoveryCodes: codes });
  fireEvent.change(dialog().getByLabelText("6-digit code"), { target: { value: "123456" } });
  await screen.findByRole("list", { name: "Recovery codes" });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("setting up two-factor sign-in", () => {
  it("asks for the password before anything is sent", async () => {
    await startSetup();

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(dialog().getByRole("button", { name: "Continue" }));

    expect(dialog().getByText("Enter your current password.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the password to begin, then shows the QR step", async () => {
    await reachScanStep();

    expect(bodyOf(0)).toEqual({ currentPassword: "my current password" });
    expect(dialog().getByText(secret)).toBeTruthy();
  });

  it("shows a wrong password on its field and stays on the step", async () => {
    await startSetup();
    respond(400, {
      error: {
        code: "invalid_current_password",
        message: "No.",
        fields: { currentPassword: "Incorrect password" },
      },
    });

    fireEvent.change(passwordField(), { target: { value: "wrong" } });
    fireEvent.click(dialog().getByRole("button", { name: "Continue" }));

    await screen.findByText("That password isn't correct.");
    expect(passwordField()).toBeTruthy();
  });

  it("shows the ten recovery codes after enabling", async () => {
    await reachCodesStep();

    for (const code of codes) {
      expect(dialog().getByText(code)).toBeTruthy();
    }
  });

  it("does not let the codes be dismissed by accident", async () => {
    await reachCodesStep();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(dialog().getByRole("button", { name: "Close" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((dialog().getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes once the codes are confirmed as saved, and does not show them again", async () => {
    await reachCodesStep();

    fireEvent.click(dialog().getByRole("checkbox"));
    fireEvent.click(dialog().getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(codes[0] as string)).toBeNull();
  });

  it("has the French wording too", async () => {
    await reachCodesStep();
    await i18n.changeLanguage("fr");

    await screen.findByText("Enregistrez vos codes de récupération");
    expect(dialog().getByText("J'ai enregistré ces codes en lieu sûr")).toBeTruthy();
  });
});

describe("turning two-factor sign-in off", () => {
  const enabled: SessionState = { status: "signed-in", user: { ...user, twoFactorEnabled: true } };

  async function openDialog() {
    renderPage(enabled);
    fireEvent.click(screen.getByRole("button", { name: "Turn off two-factor" }));
    await screen.findByRole("dialog");
  }

  const confirm = () => fireEvent.click(dialog().getByRole("button", { name: "Turn off" }));

  it("needs the password as well as a code", async () => {
    await openDialog();
    fireEvent.change(dialog().getByLabelText("6-digit code"), { target: { value: "123456" } });

    confirm();

    await screen.findByText("Enter your current password.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the password and the code", async () => {
    await openDialog();
    respond(200, { status: "signed-in", user });

    fireEvent.change(passwordField(), { target: { value: "my current password" } });
    fireEvent.change(dialog().getByLabelText("6-digit code"), { target: { value: "123456" } });
    confirm();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodyOf(0)).toEqual({ currentPassword: "my current password", code: "123456" });
  });

  it("accepts a recovery code in place of the phone", async () => {
    await openDialog();
    respond(200, { status: "signed-in", user });

    fireEvent.click(dialog().getByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.change(passwordField(), { target: { value: "my current password" } });
    fireEvent.change(dialog().getByLabelText("Recovery code"), { target: { value: "abcd-efgh-jkmn-pqrs" } });
    confirm();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodyOf(0)).toEqual({
      currentPassword: "my current password",
      recoveryCode: "abcd-efgh-jkmn-pqrs",
    });
  });

  it("keeps the dialog open on a wrong password", async () => {
    await openDialog();
    respond(400, {
      error: {
        code: "invalid_current_password",
        message: "No.",
        fields: { currentPassword: "Incorrect password" },
      },
    });

    fireEvent.change(passwordField(), { target: { value: "wrong" } });
    fireEvent.change(dialog().getByLabelText("6-digit code"), { target: { value: "123456" } });
    confirm();

    await screen.findByText("That password isn't correct.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
