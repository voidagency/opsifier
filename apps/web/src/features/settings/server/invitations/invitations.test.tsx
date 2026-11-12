// @vitest-environment jsdom
import "../../../../testing/browser-stubs";
import { defaultNotificationEvents } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../../../testing/appHarness";

afterEach(resetApp);

const OWNER = {
  id: "u1",
  email: "admin@example.com",
  role: "admin",
  owner: true,
  twoFactorEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  projects: [],
  apiKeyCount: 0,
  name: "",
  active: true,
};

const MAIL_CHANNEL = {
  id: "c1",
  name: "Team mail",
  type: "smtp",
  target: "smtp.example.test:587",
  hasSecret: true,
  config: { type: "smtp", host: "smtp.example.test", port: 587, from: "panel@example.test" },
  events: defaultNotificationEvents,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastDeliveryAt: null,
  lastDeliveryOk: null,
};

const channels = (list: unknown[]) => ({
  channels: list,
  settings: { allowPrivateDestinations: false },
  canChangeSettings: true,
});

function invitation(email: string, extra: Record<string, unknown> = {}) {
  return {
    id: `i-${email}`,
    email,
    role: "member",
    projects: [],
    invitedBy: "admin@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    expired: false,
    delivery: "link",
    channelName: null,
    sentAt: null,
    error: null,
    ...extra,
  };
}

const page = (routes: Record<string, unknown>) =>
  installFakeServer({
    "GET /users": { users: [OWNER] },
    "GET /projects": { projects: [] },
    "GET /users/invitations": { invitations: [] },
    "GET /notifications/channels": channels([]),
    ...routes,
  });

const addresses = () => screen.findByLabelText("Email addresses");

describe("inviting people", () => {
  it("invites a pasted list, and shows each link once when nothing e-mails them", async () => {
    const server = page({
      "POST /users/invitations": {
        results: [
          {
            email: "ann@example.com",
            outcome: "invited",
            invitation: invitation("ann@example.com"),
            link: "https://panel.example.com/invitation#ann-token",
          },
          {
            email: "bob@example.com",
            outcome: "account_exists",
            invitation: null,
            link: null,
          },
          { email: "ann@example.com", outcome: "duplicate", invitation: null, link: null },
        ],
        action: null,
      },
    });
    renderApp("/settings/server/users");

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    fireEvent.change(await addresses(), {
      target: { value: "Ann <ann@example.com>, bob@example.com\nANN@example.com" },
    });
    expect(screen.getByText("2 people · 1 repeated")).toBeTruthy();
    expect(screen.getByText(/No email channel is set up/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invite 2 people" }));

    expect(await screen.findByDisplayValue("https://panel.example.com/invitation#ann-token")).toBeTruthy();
    expect(screen.getByText(/won't be shown again/)).toBeTruthy();
    expect(screen.getByText("Has an account")).toBeTruthy();
    expect(screen.getByText("Repeated")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      emails: ["ann@example.com", "bob@example.com", "ann@example.com"],
      role: "member",
      projects: [],
      channel: null,
      language: "en",
    });
  });

  it("says what is not an address before sending anything", async () => {
    const server = page({});
    renderApp("/settings/server/users");

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    fireEvent.change(await addresses(), { target: { value: "ann@example.com bob@" } });
    expect(screen.getByText(/1 is not an address/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    expect(await screen.findByText("Not an email address: bob@")).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("e-mails the links through the first SMTP channel unless told otherwise", async () => {
    const server = page({
      "GET /notifications/channels": channels([MAIL_CHANNEL]),
      "POST /users/invitations": {
        results: [
          {
            email: "ann@example.com",
            outcome: "invited",
            invitation: invitation("ann@example.com", { delivery: "sending", channelName: "Team mail" }),
            link: null,
          },
        ],
        action: null,
      },
    });
    renderApp("/settings/server/users");

    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    fireEvent.change(await addresses(), { target: { value: "ann@example.com" } });
    const delivery = await screen.findByRole("combobox", { name: "Delivery" });
    await waitFor(() => expect(delivery.textContent).toBe("By email through Team mail (panel@example.test)"));
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 person" }));

    await screen.findByText("Invited");
    expect(screen.queryByDisplayValue(/invitation#/)).toBeNull();
    expect(server.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      emails: ["ann@example.com"],
      role: "admin",
      channel: "c1",
    });
  });
});

describe("pending invitations", () => {
  it("shows where each one stands, sends one again as a link, and revokes another", async () => {
    const failed = invitation("ann@example.com", {
      delivery: "failed",
      channelName: "Team mail",
      error: "The mail server answered: 550 No such mailbox",
    });
    const handed = invitation("bob@example.com");
    const server = page({
      "GET /users/invitations": { invitations: [failed, handed] },
      "POST /users/invitations/i-ann@example.com/resend": {
        invitation: { ...failed, delivery: "link", error: null },
        link: "https://panel.example.com/invitation#fresh",
        action: null,
      },
      "DELETE /users/invitations/i-bob@example.com": { ok: true },
    });
    renderApp("/settings/server/users");

    const list = within(
      (await screen.findByRole("heading", { name: "Invitations" })).closest("section") as HTMLElement,
    );
    expect(await list.findByText("Email not sent")).toBeTruthy();
    expect(list.getByText("The mail server answered: 550 No such mailbox")).toBeTruthy();
    expect(list.getByText("Link handed over")).toBeTruthy();

    fireEvent.click(list.getByRole("button", { name: "Send the invitation for ann@example.com again" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Send again" }));
    expect(await screen.findByDisplayValue("https://panel.example.com/invitation#fresh")).toBeTruthy();
    expect(server.calls.find((call) => call.path.endsWith("/resend"))?.body).toEqual({
      channel: null,
      language: "en",
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    fireEvent.click(list.getByRole("button", { name: "Revoke the invitation for bob@example.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(
        server.calls.some((call) => call.method === "DELETE" && call.path.endsWith("bob@example.com")),
      ).toBe(true),
    );
  });

  it("shows nothing while nobody is waiting", async () => {
    page({});
    renderApp("/settings/server/users");

    expect(await screen.findByText("admin@example.com")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invitations" })).toBeNull();
  });
});
