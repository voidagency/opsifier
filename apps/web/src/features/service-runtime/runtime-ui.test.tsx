// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realtime } from "../../lib/realtime";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

vi.mock("./TerminalPane", () => ({
  default: ({
    task,
    target,
    onStatus,
  }: {
    task: string;
    target: unknown;
    onStatus: (status: "connected" | "ended") => void;
  }) => (
    <div>
      <p>{`terminal in ${task} running ${JSON.stringify(target)}`}</p>
      <button type="button" onClick={() => onStatus("connected")}>
        fake-connect
      </button>
      <button type="button" onClick={() => onStatus("ended")}>
        fake-end
      </button>
    </div>
  ),
}));

afterEach(resetApp);

const service = {
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  wake: [],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "nginx:alpine", username: null, hasPassword: false },
  notes: "",
  stopped: false,
  primaryUrl: null,
};

const metrics = {
  cpuPercent: 0,
  memoryUsedBytes: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
  readAt: null,
};

const consoleInfo = {
  tasks: [
    { id: "task-1", slot: 1, name: "shop_web.1.task-1" },
    { id: "task-2", slot: 2, name: "shop_web.2.task-2" },
  ],
  programs: ["sh", "bash"],
  scripts: ["Clear cache"],
};

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop/services/web": service,
  "GET /projects/shop/services/web/metrics": metrics,
  "GET /projects/shop/services/web/console": consoleInfo,
  ...extra,
});

const LOGS = "service-logs:shop/web";

const logSubscriptions = () =>
  vi.mocked(realtime.subscribe).mock.calls.filter(([topic]) => topic === LOGS).length;

const snapshot = (lines: unknown[] = [], state = "streaming") => ({
  kind: "snapshot",
  feed: "f1",
  state,
  lines,
});
const line = (seq: number, text: string) => ({
  seq,
  stream: "stdout",
  line: text,
  at: "2026-01-01T10:00:00Z",
});

async function openOverview() {
  installFakeServer(base());
  const app = renderApp("/projects/shop/app/web");
  await screen.findByRole("button", { name: "Deploy" });
  await screen.findByRole("log");
  return app;
}

describe("live logs", () => {
  it("tells a service that hasn't started apart from one with nothing to say", async () => {
    const app = await openOverview();

    app.emit(LOGS, snapshot([], "waiting"));
    expect(screen.getByText("Waiting for shop_web to start…")).toBeTruthy();

    app.emit(LOGS, snapshot([], "streaming"));
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect(screen.getByText("Nothing printed yet.")).toBeTruthy();
  });

  it("shows new lines without a reload, newest last", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "first line")]));

    app.emit(LOGS, { kind: "lines", feed: "f1", lines: [line(1, "second line")] });

    const log = within(screen.getByRole("log"));
    expect(log.getByText("first line")).toBeTruthy();
    const text = screen.getByRole("log").textContent ?? "";
    expect(text.indexOf("first line")).toBeLessThan(text.indexOf("second line"));
  });

  it("inserts a separator, then keeps going", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "before")]));

    fireEvent.click(screen.getByRole("button", { name: "Add a separator" }));
    app.emit(LOGS, { kind: "lines", feed: "f1", lines: [line(1, "after")] });

    const log = screen.getByRole("log");
    expect(log.querySelectorAll("hr")).toHaveLength(2);
    expect(log.textContent).toContain("after");
    expect(logSubscriptions()).toBe(1);
  });

  it("opens the same stream in the whole window without interrupting it", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "already here")]));

    fireEvent.click(screen.getByRole("button", { name: "Open in the whole window" }));
    await screen.findByRole("dialog");
    app.emit(LOGS, { kind: "lines", feed: "f1", lines: [line(1, "arrived while fullscreen")] });

    expect(within(screen.getByRole("dialog")).getByText("arrived while fullscreen")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("already here")).toBeTruthy();
    expect(logSubscriptions()).toBe(1);
  });

  it("reloads the stream on request", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "old")]));

    fireEvent.click(screen.getByRole("button", { name: "Reload the logs" }));

    expect(screen.queryByText("old")).toBeNull();
    expect(logSubscriptions()).toBe(2);
  });

  it("opens the fullscreen view from the toolbar on any tab", async () => {
    installFakeServer(base({ "GET /projects/shop/services/web/environment": { env: "" } }));
    const app = renderApp("/projects/shop/app/web/environment");

    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));

    const dialog = await screen.findByRole("dialog");
    app.emit(LOGS, snapshot([], "waiting"));
    expect(within(dialog).getByText("Waiting for shop_web to start…")).toBeTruthy();
  });

  it("stops listening when the page goes away", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([], "waiting"));

    app.unmount();

    expect(() => app.emit(LOGS, snapshot([line(0, "too late")]))).not.toThrow();
    expect(document.body.textContent).not.toContain("too late");
  });
});

describe("log search", () => {
  it("searches with the chosen filters and shows the matches", async () => {
    const calls: Array<URLSearchParams> = [];
    installFakeServer(
      base({
        "GET /projects/shop/services/web/logs/search": (_body: unknown, url: URL) => {
          calls.push(url.searchParams);
          return {
            lines: [{ seq: 0, stream: "stderr", line: "boom happened", at: "2026-01-01T10:00:00Z" }],
            scanned: 40,
            truncated: false,
          };
        },
      }),
    );
    renderApp("/projects/shop/app/web");
    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));
    const dialog = within(await screen.findByRole("dialog"));

    fireEvent.click(dialog.getByRole("button", { name: "Search" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Text" }), { target: { value: "boom" } });
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);

    expect(await dialog.findByText("boom happened")).toBeTruthy();
    expect(dialog.getByText("1 matching lines, out of 40 read.")).toBeTruthy();
    expect(calls[0]?.get("q")).toBe("boom");
    expect(calls[0]?.get("since")).toBe("3600");
  });

  it("explains an empty result, and shows a failure", async () => {
    const server = installFakeServer(
      base({ "GET /projects/shop/services/web/logs/search": { lines: [], scanned: 0, truncated: false } }),
    );
    renderApp("/projects/shop/app/web");
    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Search" }));
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);

    expect(await dialog.findByText("No matching lines")).toBeTruthy();

    server.set({
      "GET /projects/shop/services/web/logs/search": withStatus(500, {
        error: { code: "internal_error", message: "no" },
      }),
    });
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);
    expect(await dialog.findByText("The server hit a problem and couldn't finish.")).toBeTruthy();
  });
});

describe("the console", () => {
  async function openConsole(extra: FakeRoute = {}) {
    installFakeServer(base(extra));
    renderApp("/projects/shop/app/web");
    const button = (await screen.findByRole("button", { name: "Console" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    return within(await screen.findByRole("dialog"));
  }

  it("lists the tasks, the programs and the saved scripts", async () => {
    const dialog = await openConsole();

    expect(await dialog.findByRole("button", { name: "Sh" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Bash" })).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    expect(dialog.getByRole("combobox", { name: "Task" }).textContent).toContain("shop_web.1.task-1");
    expect(dialog.getByText("Choose a program to open a session in the selected task.")).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("starts a session and offers to disconnect", async () => {
    const dialog = await openConsole();

    fireEvent.click(await dialog.findByRole("button", { name: "Sh" }));
    expect(await dialog.findByText('terminal in task-1 running {"program":"sh"}')).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "fake-connect" }));
    await dialog.findByRole("button", { name: "Disconnect" });
    expect((dialog.getByRole("button", { name: "Bash" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(dialog.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(dialog.queryByText(/terminal in/)).toBeNull());
    expect(dialog.getByText("Choose a program to open a session in the selected task.")).toBeTruthy();
  });

  it("runs a saved script the same way", async () => {
    const dialog = await openConsole();

    fireEvent.click(await dialog.findByRole("button", { name: "Clear cache" }));

    expect(await dialog.findByText('terminal in task-1 running {"script":"Clear cache"}')).toBeTruthy();
  });

  it("offers another program once the last session has ended", async () => {
    const dialog = await openConsole();
    fireEvent.click(await dialog.findByRole("button", { name: "Sh" }));
    fireEvent.click(await dialog.findByRole("button", { name: "fake-connect" }));
    await dialog.findByRole("button", { name: "Disconnect" });

    fireEvent.click(dialog.getByRole("button", { name: "fake-end" }));

    await waitFor(() => expect(dialog.queryByRole("button", { name: "Disconnect" })).toBeNull());
    expect((dialog.getByRole("button", { name: "Bash" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when nothing is running", async () => {
    const dialog = await openConsole({
      "GET /projects/shop/services/web/console": { tasks: [], programs: ["sh", "bash"], scripts: [] },
    });

    expect(
      await dialog.findByText("Nothing is running yet. Start the service to open a console."),
    ).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Sh" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error if the information can't be loaded, and can try again", async () => {
    const server = installFakeServer(
      base({
        "GET /projects/shop/services/web/console": withStatus(500, {
          error: { code: "internal_error", message: "no" },
        }),
      }),
    );
    renderApp("/projects/shop/app/web");
    const button = (await screen.findByRole("button", { name: "Console" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    const dialog = within(await screen.findByRole("dialog"));

    expect(await dialog.findByText("The server hit a problem and couldn't finish.")).toBeTruthy();

    server.set({ "GET /projects/shop/services/web/console": consoleInfo });
    fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    expect(await dialog.findByRole("button", { name: "Sh" })).toBeTruthy();
  });

  it("can't be opened while nothing is running", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/web": {
          ...service,
          status: "stopped",
          stopped: true,
          replicas: { running: 0, desired: 0 },
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    const button = (await screen.findByRole("button", { name: "Console" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("can't be opened by someone who isn't an administrator", async () => {
    installFakeServer(
      base({
        "GET /auth/session": {
          status: "signed-in",
          user: { id: "u2", email: "member@example.com", role: "member", twoFactorEnabled: false },
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    const button = (await screen.findByRole("button", { name: "Console" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("live readings", () => {
  const METRICS = "service-metrics:shop/web";

  it("show what the server publishes without a reload, and never NaN", async () => {
    installFakeServer(base());
    const app = renderApp("/projects/shop/app/web");
    await screen.findByRole("button", { name: "Deploy" });
    await screen.findByText("0.0%");

    app.emit(METRICS, {
      ...metrics,
      cpuPercent: 12.5,
      memoryUsedBytes: 134217728,
      networkRxBytes: 1024,
      networkTxBytes: 2048,
      readAt: "2026-01-01T00:00:01.000Z",
    });

    expect(await screen.findByText("12.5%")).toBeTruthy();
    expect(screen.getByText("128 MB")).toBeTruthy();
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("ignores a reading that isn't one", async () => {
    installFakeServer(base());
    const app = renderApp("/projects/shop/app/web");
    await screen.findByRole("button", { name: "Deploy" });
    await screen.findByText("0.0%");

    app.emit(METRICS, { cpuPercent: Number.NaN, memoryUsedBytes: "lots" });

    expect(document.body.textContent).not.toContain("NaN");
  });

  it("subscribe only while the page is on screen", async () => {
    installFakeServer(base());
    renderApp("/projects/shop/app/web");
    await screen.findByRole("button", { name: "Deploy" });
    const subscribed = () =>
      vi.mocked(realtime.subscribe).mock.calls.filter(([topic]) => topic === METRICS).length;
    await waitFor(() => expect(subscribed()).toBe(1));
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(subscribed()).toBe(2));
  });
});
