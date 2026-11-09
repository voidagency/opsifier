// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

afterEach(resetApp);

const TOPIC = "metrics:services";

const task = {
  taskId: "abcdefghijkl1234",
  slot: 1,
  cpuPercent: 1.5,
  memoryUsedBytes: 67108864,
  memoryLimitBytes: 536870912,
  memoryPercent: 12.5,
  networkRxBytes: 2048,
  networkTxBytes: 4096,
};

describe("the monitor page", () => {
  it("shows a loading state until the first reading", async () => {
    installFakeServer({});
    renderApp("/monitor");

    await screen.findByRole("heading", { name: "Monitor" });
    expect(screen.queryByText(/Project \/ service/)).toBeNull();
  });

  it("lists each running task under its project and service", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, {
      available: true,
      readAt: "2026-01-01T00:00:00.000Z",
      services: [{ projectName: "shop", serviceName: "web", tasks: [task] }],
    });

    expect(await screen.findByText("shop")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("web.1")).toBeTruthy();
    expect(screen.getAllByText("64 MB")).toHaveLength(3);
    expect(screen.getAllByText("12.5%")).toHaveLength(3);
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("says when nothing is running", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, { available: true, readAt: null, services: [] });

    expect(await screen.findByText("Nothing is running")).toBeTruthy();
  });

  it("says when Docker isn't answering, and dates the last measurement", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, { available: false, readAt: null, lastReadAt: "2026-03-04T05:06:07.000Z", services: [] });

    expect(await screen.findByText(/Docker isn't answering/)).toBeTruthy();
    expect(screen.getByText(/Last measurement: .*(2026|26)/)).toBeTruthy();
  });

  it("says so when there is no measurement to date", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, { available: false, readAt: null, lastReadAt: null, services: [] });

    expect(await screen.findByText("No measurement on record yet.")).toBeTruthy();
  });

  it("states where the table's figures come from and when they were read", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, {
      available: true,
      readAt: "2026-01-01T00:00:00.000Z",
      lastReadAt: "2026-01-01T00:00:00.000Z",
      origin: "docker",
      services: [{ projectName: "shop", serviceName: "web", tasks: [task] }],
    });

    const caption = (await screen.findByText(/Docker statistics/)).closest("p") as HTMLElement;
    expect(caption.textContent).toMatch(/2026|26/);
    expect(caption.title).toContain("running tasks");
  });

  it("draws a figure no task reported as missing, not as zero", async () => {
    installFakeServer({});
    const app = renderApp("/monitor");
    await screen.findByRole("heading", { name: "Monitor" });

    app.emit(TOPIC, {
      available: true,
      readAt: "2026-01-01T00:00:00.000Z",
      services: [
        {
          projectName: "shop",
          serviceName: "web",
          tasks: [
            {
              ...task,
              cpuPercent: null,
              memoryUsedBytes: null,
              memoryPercent: null,
              networkRxBytes: null,
              networkTxBytes: null,
            },
          ],
        },
      ],
    });

    expect(await screen.findByText("shop")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/0 B|0\.0%/);
  });
});
