// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { defaultNotificationEvents } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(async () => {
  resetApp();
  await i18n.changeLanguage("en");
});

const MAIL = {
  id: "c1",
  name: "Mail",
  type: "smtp",
  target: "smtp.example.com:587",
  hasSecret: true,
  config: {
    type: "smtp",
    host: "smtp.example.com",
    port: 587,
    username: "panel",
    from: "panel@example.com",
    recipients: ["ops@example.com"],
  },
  events: defaultNotificationEvents,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastDeliveryAt: null,
  lastDeliveryOk: null,
};

const HOOK = {
  ...MAIL,
  id: "c2",
  name: "Hook",
  type: "webhook",
  target: "hooks.example.com",
  config: { type: "webhook" },
};

const REFUSED = withStatus(400, {
  error: {
    code: "secret_destination_changed",
    message: "The stored password belongs to another host, port or username, so it is not sent to this one.",
    fields: { password: "Enter the password for this server again" },
  },
});

const PASSWORD_AGAIN =
  "The host, port or username changed, so the stored password won't be sent there. Type it again.";
const REFUSAL =
  "The stored password or secret belongs to another destination, so it isn't sent to this one. Type it again.";

/** Opens the page with one channel and the dialog that edits it. */
async function editChannel(channel: object, routes: FakeRoute = {}, editLabel = "Edit") {
  const server = installFakeServer({
    "GET /notifications/channels": {
      channels: [channel],
      settings: { allowPrivateDestinations: false },
      canChangeSettings: true,
    },
    "GET /notifications/deliveries": { deliveries: [] },
    ...routes,
  });
  renderApp("/settings/server/notifications");
  fireEvent.click(await screen.findByRole("button", { name: editLabel }));
  return { server, dialog: within(await screen.findByRole("dialog")) };
}

describe("editing a notification channel", () => {
  it("asks for the password again once the host, port or username changes", async () => {
    const { dialog } = await editChannel(MAIL);
    const password = dialog.getByLabelText("Password");
    expect(password.getAttribute("placeholder")).toBe("Stored");
    expect(dialog.getByText("Kept sealed, and never shown again.")).toBeTruthy();

    fireEvent.change(dialog.getByLabelText("Host"), { target: { value: "mail.elsewhere.example" } });
    expect(dialog.getByText(PASSWORD_AGAIN)).toBeTruthy();
    expect(password.getAttribute("placeholder")).toBeNull();

    // The same server written another way still keeps it.
    fireEvent.change(dialog.getByLabelText("Host"), { target: { value: " SMTP.example.com" } });
    expect(dialog.queryByText(PASSWORD_AGAIN)).toBeNull();
    expect(password.getAttribute("placeholder")).toBe("Stored");

    fireEvent.change(dialog.getByLabelText("Port"), { target: { value: "465" } });
    expect(dialog.getByText(PASSWORD_AGAIN)).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("Port"), { target: { value: "587" } });
    fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "someone-else" } });
    expect(dialog.getByText(PASSWORD_AGAIN)).toBeTruthy();
  });

  it("puts the server's refusal on the password field when saving", async () => {
    const { server, dialog } = await editChannel(MAIL, { "PUT /notifications/channels/c1": REFUSED });

    fireEvent.change(dialog.getByLabelText("Host"), { target: { value: "mail.elsewhere.example" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    expect(await dialog.findByText(REFUSAL)).toBeTruthy();
    expect(dialog.getByText("Some fields need your attention.")).toBeTruthy();
    const sent = server.calls.find((call) => call.method === "PUT")?.body as {
      config: Record<string, unknown>;
    };
    expect(sent.config).toMatchObject({ host: "mail.elsewhere.example" });
    expect(sent.config.password).toBeUndefined();
  });

  it("says why a test send to another server was refused", async () => {
    const { server, dialog } = await editChannel(MAIL, { "POST /notifications/test": REFUSED });

    fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "someone-else" } });
    fireEvent.click(dialog.getByRole("button", { name: "Send test" }));

    expect(await dialog.findByText(REFUSAL)).toBeTruthy();
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "POST")?.body).toMatchObject({ id: "c1" }),
    );
  });

  it("says a new webhook URL needs its signing secret again", async () => {
    const { dialog } = await editChannel(HOOK);
    const secret = dialog.getByLabelText("Signing secret");
    expect(secret.getAttribute("placeholder")).toBe("Stored");

    fireEvent.change(dialog.getByLabelText("URL"), { target: { value: "https://hooks.example.com/new" } });

    expect(
      dialog.getByText(
        "A stored signing secret only goes with the URL it was saved for. With a new URL, type it again.",
      ),
    ).toBeTruthy();
    expect(secret.getAttribute("placeholder")).toBeNull();
  });

  it("says all of it in French too", async () => {
    await i18n.changeLanguage("fr");
    const { dialog } = await editChannel(MAIL, { "PUT /notifications/channels/c1": REFUSED }, "Modifier");

    fireEvent.change(dialog.getByLabelText("Hôte"), { target: { value: "mail.elsewhere.example" } });
    expect(
      dialog.getByText(
        "L'hôte, le port ou l'identifiant a changé : le mot de passe enregistré n'y sera pas envoyé. Saisissez-le à nouveau.",
      ),
    ).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "Enregistrer" }));
    expect(
      await dialog.findByText(
        "Le mot de passe ou le secret enregistré correspond à une autre destination : il n'est pas envoyé à celle-ci. Saisissez-le à nouveau.",
      ),
    ).toBeTruthy();
  });
});
