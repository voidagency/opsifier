// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const SERVICE_DOMAIN = {
  destination: "service",
  id: "d1",
  projectName: "shop",
  serviceName: "web",
  host: "app.example.com",
  path: "/",
  stripPath: false,
  port: 80,
  https: true,
  primary: true,
  destinationProtocol: "http",
  destinationPath: "/",
  upstreamServerName: null,
  upstreamCa: null,
  certificateResolver: null,
  wildcard: false,
  middlewares: [],
  url: "https://app.example.com/",
  internalUrl: "http://shop_web:80/",
  composeService: null,
  tls: "issued",
};

const PROJECTS = {
  projects: [
    {
      name: "shop",
      createdAt: "2026-01-01T00:00:00.000Z",
      services: [
        {
          projectName: "shop",
          name: "web",
          type: "app",
          status: "running",
          replicas: { running: 1, desired: 1 },
          activeAction: null,
          runtimeUncertain: null,
          wake: [],
          lastDeployedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
};

describe("the domains page", () => {
  it("shows a viewer's domains without offering to change them", async () => {
    installFakeServer({
      "GET /domains": { domains: [SERVICE_DOMAIN], serverIp: "203.0.113.10", managedProjects: [] },
      "GET /projects": PROJECTS,
    });
    renderApp("/domains");
    expect(await screen.findByLabelText("Certificate issued")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("lists domains with what they point at and the state of their certificate", async () => {
    installFakeServer({
      "GET /domains": { domains: [SERVICE_DOMAIN], serverIp: "203.0.113.10" },
      "GET /projects": PROJECTS,
    });
    renderApp("/domains");
    expect(await screen.findByLabelText("Certificate issued")).toBeTruthy();
    expect(document.body.textContent).toContain("https://app.example.com/");
    expect(screen.getByText(/shop\/web → http:\/\/shop_web:80\//)).toBeTruthy();
  });

  it("states the prerequisites of the domain being added", async () => {
    installFakeServer({
      "GET /domains": { domains: [], serverIp: "2001:db8::1" },
      "GET /projects": PROJECTS,
    });
    renderApp("/domains");

    // The empty state offers it too.
    fireEvent.click((await screen.findAllByRole("button", { name: "Add domain" }))[0] as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "app.example.com" } });

    expect(await screen.findByText("AAAA record: app.example.com → 2001:db8::1")).toBeTruthy();
    expect(screen.getByText("80 and 443 open to the internet")).toBeTruthy();
  });

  it.each([
    ["unreadable", "Certificate unreadable", "failed"],
    ["unverified", "Wildcard HTTPS not verified", "unknown"],
  ])("names and draws the %s state", async (tls, label, state) => {
    installFakeServer({
      "GET /domains": { domains: [{ ...SERVICE_DOMAIN, tls }], serverIp: null },
      "GET /projects": PROJECTS,
    });
    renderApp("/domains");

    const lamp = await screen.findByRole("img", { name: label });
    expect(lamp.closest("[data-state]")?.getAttribute("data-state")).toBe(state);
  });

  it("explains what's needed when there are no domains yet", async () => {
    installFakeServer({
      "GET /domains": { domains: [], serverIp: "203.0.113.10" },
      "GET /projects": PROJECTS,
    });
    renderApp("/domains");
    expect(await screen.findByText(/Point a domain's DNS at 203.0.113.10/)).toBeTruthy();
  });

  it("creates a domain and shows the server's field errors", async () => {
    const server = installFakeServer({
      "GET /domains": { domains: [], serverIp: "203.0.113.10" },
      "GET /projects": PROJECTS,
      "POST /projects/shop/services/web/domains": () =>
        withStatus(400, {
          error: {
            code: "validation_failed",
            message: "Some fields need attention.",
            fields: { host: "Enter a full hostname such as app.example.com" },
          },
        }),
    });
    renderApp("/domains");
    fireEvent.click((await screen.findAllByRole("button", { name: "Add domain" }))[0] as HTMLElement);

    expect((await screen.findAllByDisplayValue("/")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Enter a hostname.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("offers custom destinations with several servers to administrators", async () => {
    installFakeServer({ "GET /domains": { domains: [], serverIp: null }, "GET /projects": PROJECTS });
    renderApp("/domains");
    fireEvent.click((await screen.findAllByRole("button", { name: "Add domain" }))[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    expect(await screen.findByPlaceholderText("https://example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(screen.getAllByPlaceholderText("https://example.com")).toHaveLength(2));
  });
});
