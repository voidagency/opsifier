// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../../testing/appHarness";

afterEach(resetApp);

const NODE = {
  id: "m1",
  hostname: "cfc",
  role: "manager",
  leader: true,
  state: "ready",
  availability: "active",
  address: "10.0.0.1",
  engineVersion: "29.1.0",
  os: "linux",
  architecture: "x86_64",
  cpus: 8,
  memoryBytes: 16 * 1024 ** 3,
  self: true,
  runningTasks: 42,
};

describe("the nodes page", () => {
  it("shows every node with its role, state, resources and what runs on it", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /server/nodes": {
        nodes: [
          NODE,
          {
            ...NODE,
            id: "w1",
            hostname: "agadir",
            role: "worker",
            leader: false,
            self: false,
            state: "down",
            availability: "drain",
            address: "10.0.0.2",
            cpus: 1,
            runningTasks: 0,
          },
        ],
      },
    });
    renderApp("/settings/server/nodes");

    expect(await screen.findByText("Cluster nodes", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText("2 nodes · 1 manager · 1 worker")).toBeTruthy();

    const [, first, second] = screen.getAllByRole("row");
    expect(within(first as HTMLElement).getByText("cfc")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("this server")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("leader")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("Ready")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("8 cores · 16 GB")).toBeTruthy();
    expect(within(first as HTMLElement).getByText("42")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("Down")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("· Drained")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("1 core · 16 GB")).toBeTruthy();
    expect(screen.getByText(/only shows the nodes/)).toBeTruthy();
  });

  it("is in the server's settings", async () => {
    installFakeServer({ "GET /auth/session": SIGNED_IN, "GET /server/nodes": { nodes: [NODE] } });
    renderApp("/settings/server/nodes");

    expect(await screen.findByText("1 node · 1 manager · 0 workers")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Nodes" })).toBeTruthy();
  });
});
