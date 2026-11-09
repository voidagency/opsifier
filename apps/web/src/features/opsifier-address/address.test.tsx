// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { OpsifierAddressState } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const PAGE = "/settings/server/address";
const DOMAIN = "bcdfghjk.opsifier.dev";

const active: OpsifierAddressState = {
  status: "active",
  available: true,
  domain: DOMAIN,
  wildcard: `*.${DOMAIN}`,
  certificate: "issued",
  panelUrl: `https://panel.${DOMAIN}`,
  ip: "93.184.216.34",
  registeredAt: "2026-11-01T00:00:00.000Z",
  requestedAt: null,
  lastHeartbeatAt: "2026-11-08T00:00:00.000Z",
};

const off: OpsifierAddressState = {
  status: "off",
  available: true,
  domain: null,
  wildcard: null,
  certificate: null,
  panelUrl: null,
  ip: null,
  registeredAt: null,
  requestedAt: null,
  lastHeartbeatAt: null,
};

const waiting: OpsifierAddressState = {
  ...off,
  status: "requested",
  domain: DOMAIN,
  requestedAt: "2026-11-08T00:00:00.000Z",
};

const open = (routes: FakeRoute) => {
  const server = installFakeServer({ "GET /projects": { projects: [] }, ...routes });
  renderApp(PAGE);
  return server;
};

const lampOf = (label: string) => screen.getAllByTitle(label)[0]?.closest("[data-state]");

describe("the address page", () => {
  it("has its own place in the settings menu", async () => {
    open({ "GET /server/opsifier-address": off });

    expect(await screen.findByRole("link", { name: "Address" })).toBeTruthy();
  });

  it("shows a skeleton while loading, then the address", async () => {
    open({ "GET /server/opsifier-address": active });

    expect(await screen.findByText(DOMAIN)).toBeTruthy();
  });

  it("opens with a lamp that says the address is working", async () => {
    open({ "GET /server/opsifier-address": active });
    await screen.findByText(DOMAIN);

    expect(lampOf("Active")?.getAttribute("data-state")).toBe("running");
    expect(screen.getByText(`https://panel.${DOMAIN}`)).toBeTruthy();
    expect(screen.getByText(`*.${DOMAIN}`)).toBeTruthy();
    expect(screen.getByText("93.184.216.34")).toBeTruthy();
  });

  it.each([
    ["unreachable", "degraded", "Service unreachable"],
    ["lost", "failed", "No longer valid"],
    ["disabled", "failed", "Disabled"],
  ] as const)("draws %s as %s, and says what to do", async (status, state, label) => {
    open({ "GET /server/opsifier-address": { ...active, status } });
    await screen.findByText(DOMAIN);

    expect(lampOf(label)?.getAttribute("data-state")).toBe(state);
    expect(document.querySelector("[role=alert], [aria-live=polite]")).not.toBeNull();
  });

  it("shows the certificate's own state beside it", async () => {
    open({ "GET /server/opsifier-address": { ...active, certificate: "pending" } });
    await screen.findByText(DOMAIN);

    expect(lampOf("Waiting for it")?.getAttribute("data-state")).toBe("progress");
  });

  it("offers to ask for one when there is no address, and sends what was typed", async () => {
    const server = open({
      "GET /server/opsifier-address": off,
      "POST /server/opsifier-address/request": () => {
        server.set({ "GET /server/opsifier-address": waiting });
        return waiting;
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Ask for an address" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "me@example.com" } });
    fireEvent.change(within(dialog).getByLabelText(/What will you use it for/), {
      target: { value: "Our shop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the request" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
        email: "me@example.com",
        purpose: "Our shop",
      }),
    );
    expect(await screen.findByText(DOMAIN)).toBeTruthy();
  });

  it("won't send a request that doesn't say what the server is for", async () => {
    const server = open({ "GET /server/opsifier-address": off });

    fireEvent.click(await screen.findByRole("button", { name: "Ask for an address" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "me@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the request" }));

    expect(await within(dialog).findByText(/in 500 characters at most/)).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows a request as waiting, with a turning lamp and the name it will get", async () => {
    open({ "GET /server/opsifier-address": waiting });

    expect(await screen.findByText(DOMAIN)).toBeTruthy();
    expect(lampOf("Waiting for approval")?.getAttribute("data-state")).toBe("progress");
    expect(screen.getByText(new RegExp(`panel\\.${DOMAIN}`))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("asks before withdrawing a request", async () => {
    const server = open({
      "GET /server/opsifier-address": waiting,
      "DELETE /server/opsifier-address/request": () => {
        server.set({ "GET /server/opsifier-address": off });
        return off;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));

    const dialog = await screen.findByRole("dialog");
    expect(server.calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

    await waitFor(() => expect(server.calls.some((call) => call.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("button", { name: "Ask for an address" })).toBeTruthy();
  });

  it("says a request was refused, and that it is possible to ask again", async () => {
    open({ "GET /server/opsifier-address": { ...off, status: "refused" } });

    expect(await screen.findByText(/last request was refused/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask for an address" })).toBeTruthy();
  });

  it("no longer offers to replace an address that works", async () => {
    open({ "GET /server/opsifier-address": active });
    await screen.findByText(DOMAIN);

    expect(screen.queryByRole("button", { name: "Ask for an address" })).toBeNull();
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  });

  it("offers nothing to do when this server was told never to call the service", async () => {
    open({ "GET /server/opsifier-address": { ...off, available: false } });

    expect(await screen.findByText(/never call/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask for an address" })).toBeNull();
  });

  it("shows why it could not load, and a way to try again", async () => {
    open({
      "GET /server/opsifier-address": withStatus(500, { error: { code: "boom", message: "It broke." } }),
    });

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/It broke/)).toBeTruthy();
  });

  it("needs the address typed before releasing it", async () => {
    const server = open({
      "GET /server/opsifier-address": active,
      "DELETE /server/opsifier-address": off,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Release" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Release" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: DOMAIN } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({ confirm: DOMAIN }),
    );
  });

  it("says it failed, and keeps the form open", async () => {
    open({
      "GET /server/opsifier-address": off,
      "POST /server/opsifier-address/request": withStatus(502, {
        error: { code: "address_service_failed", message: "No." },
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Ask for an address" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: "me@example.com" } });
    fireEvent.change(within(dialog).getByLabelText(/What will you use it for/), {
      target: { value: "Our shop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send the request" }));

    expect(await within(dialog).findByText(/could not be used/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send the request" })).toBeTruthy();
  });
});
