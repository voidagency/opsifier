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
  lastHeartbeatAt: null,
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

  it("offers to register when there is no address, in the empty state", async () => {
    const server = open({
      "GET /server/opsifier-address": off,
      "POST /server/opsifier-address/register": () => {
        server.set({ "GET /server/opsifier-address": active });
        return active;
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Register" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.path === "/server/opsifier-address/register")).toBe(true),
    );
    expect(await screen.findByText(DOMAIN)).toBeTruthy();
  });

  it("offers nothing to do when this server was told never to call the service", async () => {
    open({ "GET /server/opsifier-address": { ...off, available: false } });

    expect(await screen.findByText(/never call/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register" })).toBeNull();
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

  it("asks before registering again, and shows where the panel moved to", async () => {
    const next = {
      ...active,
      domain: "mnpqrstv.opsifier.dev",
      panelUrl: "https://panel.mnpqrstv.opsifier.dev",
    };
    const server = open({
      "GET /server/opsifier-address": active,
      "POST /server/opsifier-address/register": next,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Register again" }));

    const dialog = await screen.findByRole("dialog");
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Register again" }));

    await waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
    expect(await screen.findByText("https://panel.mnpqrstv.opsifier.dev", { selector: "span" })).toBeTruthy();
  });

  it("says it failed, and keeps what was there", async () => {
    open({
      "GET /server/opsifier-address": off,
      "POST /server/opsifier-address/register": withStatus(502, {
        error: { code: "address_service_failed", message: "No." },
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText(/could not be used/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register" })).toBeTruthy();
  });
});
