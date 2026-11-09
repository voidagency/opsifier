// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const BASE = "/settings/known-hosts";

const ENTRY = {
  id: "h1",
  host: "git.example.com",
  port: 22,
  keyType: "ssh-ed25519",
  publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIJ9h",
  fingerprint: "SHA256:abcdef",
  addedBy: "admin@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const open = (routes: FakeRoute) => {
  const server = installFakeServer(routes);
  renderApp("/settings/server/known-hosts");
  return server;
};

describe("the known hosts page", () => {
  it("says what it is for when it is empty", async () => {
    open({ [`GET ${BASE}`]: { items: [] } });

    expect(await screen.findByText("No hosts yet")).toBeTruthy();
    expect(screen.getByText(/HTTPS needs nothing here/)).toBeTruthy();
  });

  it("offers to retry when the list can't be read", async () => {
    open({ [`GET ${BASE}`]: withStatus(500, { error: { code: "boom", message: "It broke." } }) });

    expect(await screen.findByText("It broke.")).toBeTruthy();
  });

  it("lists each key with its fingerprint", async () => {
    open({ [`GET ${BASE}`]: { items: [ENTRY, { ...ENTRY, id: "h2", port: 2222, addedBy: null }] } });

    expect(await screen.findByText("git.example.com")).toBeTruthy();
    expect(screen.getByText("git.example.com:2222")).toBeTruthy();
    expect(screen.getAllByText("SHA256:abcdef")).toHaveLength(2);
    expect(screen.getByText("Learned before the registry existed")).toBeTruthy();
  });

  it("reads a server's keys for comparison and trusts only the one chosen", async () => {
    const server = open({
      [`GET ${BASE}`]: { items: [] },
      [`POST ${BASE}/scan`]: {
        items: [{ keyType: "ssh-ed25519", publicKey: "AAAAC3Nza", fingerprint: "SHA256:scanned" }],
      },
      [`POST ${BASE}`]: withStatus(201, ENTRY),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Add a host" }));
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "git.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Read the server's keys" }));

    expect(await screen.findByText("SHA256:scanned")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST" && call.path === BASE)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));

    await waitFor(() => {
      const posts = server.calls.filter((call) => call.method === "POST" && call.path === BASE);
      expect(posts[0]?.body).toEqual({
        host: "git.example.com",
        port: 22,
        publicKey: "ssh-ed25519 AAAAC3Nza",
      });
    });
    expect(await screen.findByText("Key trusted")).toBeTruthy();
  });

  it("explains why a host could not be read", async () => {
    open({
      [`GET ${BASE}`]: { items: [] },
      [`POST ${BASE}/scan`]: withStatus(502, {
        error: { code: "ssh_host_unreachable", message: "Could not read the identity of git.example.com." },
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Add a host" }));
    fireEvent.change(await screen.findByLabelText("Host"), { target: { value: "git.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Read the server's keys" }));

    expect(await screen.findByText("That server's identity could not be read.")).toBeTruthy();
  });

  it("wants a host before anything happens", async () => {
    const server = open({ [`GET ${BASE}`]: { items: [] } });

    fireEvent.click(await screen.findByRole("button", { name: "Add a host" }));
    fireEvent.click(await screen.findByRole("button", { name: "Read the server's keys" }));

    expect(await screen.findByText("Enter a host name.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("asks before it stops trusting a key", async () => {
    const server = open({
      [`GET ${BASE}`]: { items: [ENTRY] },
      [`DELETE ${BASE}/h1`]: { items: [] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "DELETE" && call.path === `${BASE}/h1`)).toBe(true),
    );
  });
});
