// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  runtimeUncertain: null,
  wake: [],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "nginx:alpine", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: null,
  pendingChanges: false,
  answering: null,
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
    { id: "task-1", slot: 1, name: "shop_web.1.task-1", programs: ["sh", "bash"] },
    { id: "task-2", slot: 2, name: "shop_web.2.task-2", programs: ["sh", "bash"] },
  ],
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
    installFakeServer(
      base({ "GET /projects/shop/services/web/environment": { names: [], interpolation: false } }),
    );
    const app = renderApp("/projects/shop/app/web/environment");

    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));

    const dialog = await screen.findByRole("dialog");
    app.emit(LOGS, snapshot([], "waiting"));
    expect(within(dialog).getByText("Waiting for shop_web to start…")).toBeTruthy();
  });

  it("says whose logs these are, from when, and how many it keeps", async () => {
    const app = await openOverview();
    app.emit(LOGS, { ...snapshot([line(0, "first line")]), tailLines: 200, ringLines: 1000 });

    const scope = screen.getByText("shop/web").closest("p") as HTMLElement;
    expect(scope.textContent).toMatch(/since .*2026|since .*26/);
    expect(scope.textContent).toContain("latest 2,000 lines");
    expect(scope.title).toContain("200");
    expect(scope.title).toContain("1,000");
  });

  it("pauses on request and catches up on resuming", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "before the pause")]));

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    app.emit(LOGS, { kind: "lines", feed: "f1", lines: [line(1, "during the pause")] });

    expect(screen.queryByText("during the pause")).toBeNull();
    expect(screen.getByText("Paused, 1 new line waiting")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(screen.getByText("during the pause")).toBeTruthy();
    expect(logSubscriptions()).toBe(1);
  });

  it("filters the live lines by text, and says so when nothing matches", async () => {
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "GET /health 200"), line(1, "POST /login 500")]));

    fireEvent.change(screen.getByRole("textbox", { name: "Filter the lines" }), {
      target: { value: "login" },
    });
    app.emit(LOGS, { kind: "lines", feed: "f1", lines: [line(2, "GET /login 200")] });

    const log = within(screen.getByRole("log"));
    expect(log.queryByText("GET /health 200")).toBeNull();
    expect(log.getByText("POST /login 500")).toBeTruthy();
    expect(log.getByText("GET /login 200")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter the lines" }), {
      target: { value: "nothing like this" },
    });
    expect(log.getByText("No line matches this filter.")).toBeTruthy();
  });

  it("keeps every control within reach on a phone", async () => {
    // matchMedia answers false to every min-width query here, which is what a narrow screen says.
    const app = await openOverview();
    app.emit(LOGS, snapshot([line(0, "x".repeat(400))]));

    for (const name of ["Pause", "Add a separator", "Reload the logs", "Open in the whole window"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const filter = screen.getByRole("textbox", { name: "Filter the lines" });
    expect(screen.getByRole("combobox", { name: "Stream" })).toBeTruthy();
    // Fields wrap onto their own rows and a long line breaks instead of widening the page.
    expect(filter.className).toContain("basis-full");
    expect(filter.parentElement?.className).toContain("flex-wrap");
    const log = screen.getByRole("log");
    expect(log.className).toContain("overflow-y-auto");
    expect(log.querySelector(".break-words")).toBeTruthy();
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
    expect(dialog.getByText(/1 matching lines, out of 40 read\./)).toBeTruthy();
    expect(calls[0]?.get("q")).toBe("boom");
    expect(calls[0]?.get("since")).toBe("3600");
  });

  it("states what the results cover, as asked for when they were run", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/web/logs/search": {
          lines: [{ seq: 0, stream: "stderr", line: "boom", at: "2026-01-01T10:00:00Z" }],
          scanned: 40,
          truncated: false,
        },
      }),
    );
    renderApp("/projects/shop/app/web");
    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Search" }));
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);

    const summary = (await dialog.findByText(/matching lines/)).closest("p") as HTMLElement;

    expect(summary.textContent).toContain("shop/web");
    expect(summary.textContent).toContain("Last hour");
    expect(summary.textContent).toContain("at most 500 lines");
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

describe("moving between services", () => {
  const api = { ...service, name: "api" };
  const API = "service-logs:shop/api";
  const routes = (extra: FakeRoute = {}) =>
    base({
      "GET /projects/shop/services/api": api,
      "GET /projects/shop/services/api/metrics": metrics,
      ...extra,
    });
  const goToApi = (app: ReturnType<typeof renderApp>) => {
    act(() => {
      app.router.history.push("/projects/shop/app/api");
    });
    return waitFor(() => expect(app.location()).toBe("/projects/shop/app/api"));
  };
  const webSearch = (found: string) => ({
    lines: [{ seq: 0, stream: "stdout", line: found, at: "2026-01-01T10:00:00Z" }],
    scanned: 1,
    truncated: false,
  });

  async function openSearch() {
    fireEvent.click(await screen.findByRole("button", { name: "Open in the whole window" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Search" }));
    return dialog;
  }

  it("never lands a search still under way on the next service", async () => {
    let answer: (value: unknown) => void = () => {};
    installFakeServer(
      routes({
        "GET /projects/shop/services/web/logs/search": () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }),
    );
    const app = renderApp("/projects/shop/app/web");
    const dialog = await openSearch();
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("/web/logs/search"));

    await goToApi(app);
    answer(webSearch("a line from web"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.body.textContent).not.toContain("a line from web");
  });

  it("does not leave a finished search on screen for the next service", async () => {
    installFakeServer(
      routes({ "GET /projects/shop/services/web/logs/search": webSearch("a line from web") }),
    );
    const app = renderApp("/projects/shop/app/web");
    const dialog = await openSearch();
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);
    await dialog.findByText("a line from web");

    await goToApi(app);

    await waitFor(() => expect(document.body.textContent).not.toContain("a line from web"));
  });

  it("asks only about the service on screen, after moving", async () => {
    const asked: string[] = [];
    const answer = (name: string) => (_body: unknown, url: URL) => {
      asked.push(url.pathname);
      return webSearch(`found in ${name}`);
    };
    installFakeServer(
      routes({
        "GET /projects/shop/services/web/logs/search": answer("web"),
        "GET /projects/shop/services/api/logs/search": answer("api"),
      }),
    );
    const app = renderApp("/projects/shop/app/web");
    await openSearch();

    await goToApi(app);
    const dialog = await openSearch();
    fireEvent.click(dialog.getAllByRole("button", { name: "Search" }).at(-1) as HTMLElement);

    expect(await dialog.findByText("found in api")).toBeTruthy();
    expect(asked).toEqual(["/api/v1/projects/shop/services/api/logs/search"]);
  });

  it("leaves a pause behind with the service it was set on", async () => {
    installFakeServer(routes());
    const app = renderApp("/projects/shop/app/web");
    await screen.findByRole("log");
    app.emit(LOGS, snapshot([line(0, "web, before the pause")]));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    await goToApi(app);
    await waitFor(() => expect(realtime.subscribe).toHaveBeenCalledWith(API, expect.anything()));
    app.emit(API, snapshot([line(0, "the first line of api")]));

    expect(await screen.findByText("the first line of api")).toBeTruthy();
    expect(screen.queryByText("web, before the pause")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("reloads only the service on screen", async () => {
    installFakeServer(routes());
    const app = renderApp("/projects/shop/app/web");
    await screen.findByRole("log");
    await goToApi(app);
    await waitFor(() => expect(realtime.subscribe).toHaveBeenCalledWith(API, expect.anything()));
    const countOf = (topic: string) =>
      vi.mocked(realtime.subscribe).mock.calls.filter(([subscribed]) => subscribed === topic).length;
    const webBefore = countOf(LOGS);
    const apiBefore = countOf(API);

    fireEvent.click(screen.getByRole("button", { name: "Reload the logs" }));

    expect(countOf(API)).toBe(apiBefore + 1);
    expect(countOf(LOGS)).toBe(webBefore);
  });
});

describe("the console", () => {
  async function openConsole(extra: FakeRoute = {}) {
    installFakeServer(base(extra));
    renderApp("/projects/shop/app/web");
    const button = (await screen.findByRole("button", { name: "Console" })) as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
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
    expect(dialog.getByRole("button", { name: "Bash" }).getAttribute("aria-disabled")).toBe("true");

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
    expect(dialog.getByRole("button", { name: "Bash" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("closes on Escape when no session is open", async () => {
    const dialog = await openConsole();
    await dialog.findByRole("button", { name: "Sh" });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves Escape to the program while a session is open", async () => {
    const dialog = await openConsole();
    fireEvent.click(await dialog.findByRole("button", { name: "Sh" }));
    fireEvent.click(await dialog.findByRole("button", { name: "fake-connect" }));
    await dialog.findByRole("button", { name: "Disconnect" });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape again once the session has ended", async () => {
    const dialog = await openConsole();
    fireEvent.click(await dialog.findByRole("button", { name: "Sh" }));
    fireEvent.click(await dialog.findByRole("button", { name: "fake-connect" }));
    await dialog.findByRole("button", { name: "Disconnect" });
    fireEvent.click(dialog.getByRole("button", { name: "fake-end" }));
    await waitFor(() => expect(dialog.queryByRole("button", { name: "Disconnect" })).toBeNull());

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when nothing is running", async () => {
    const dialog = await openConsole({
      "GET /projects/shop/services/web/console": { tasks: [], scripts: [] },
    });

    expect(
      await dialog.findByText("Nothing is running yet. Start the service to open a console."),
    ).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Sh" })).toBeNull();
  });

  it("offers only the shells the chosen container has, and says so when it has none", async () => {
    const dialog = await openConsole({
      "GET /projects/shop/services/web/console": {
        tasks: [{ id: "task-1", slot: 1, name: "shop_web.1.task-1", programs: [] }],
        scripts: ["Clear cache"],
      },
    });

    expect(await dialog.findByText("This container has no shell to open.")).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Sh" })).toBeNull();
    expect(dialog.getByRole("button", { name: "Clear cache" }).getAttribute("aria-disabled")).toBe("true");
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
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
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

    const button = await screen.findByRole("button", { name: "Console" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.focus(button);
    expect((await screen.findAllByText("Start the service to open a console")).length).toBeGreaterThan(0);
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

    const button = await screen.findByRole("button", { name: "Console" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.focus(button);
    expect((await screen.findAllByText("Only an administrator can open a console")).length).toBeGreaterThan(
      0,
    );
  });
});

describe("live readings", () => {
  const METRICS = "service-metrics:shop/web";

  const live = {
    ...metrics,
    cpuPercent: 12.5,
    cpuCapacityPercent: 100,
    memoryUsedBytes: 134217728,
    memoryLimitBytes: 536870912,
    networkRxBytes: 1024,
    networkTxBytes: 2048,
    readAt: "2026-01-01T00:00:01.000Z",
    available: true,
    tasks: 2,
    lastReadAt: "2026-01-01T00:00:01.000Z",
    origin: "docker",
    scope: "service",
  };

  it("say what they add up, where from and when", async () => {
    installFakeServer(base({ "GET /projects/shop/services/web/metrics": live }));
    renderApp("/projects/shop/app/web");

    const note = (await screen.findByText(/2 running tasks/)).closest("p") as HTMLElement;

    expect(note.textContent).toContain("Docker statistics");
    expect(note.querySelector("time")?.getAttribute("datetime")).toBe("2026-01-01T00:00:01.000Z");
  });

  it("show a figure Docker left out as missing, not zero", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/web/metrics": {
          ...live,
          memoryUsedBytes: null,
          networkRxBytes: null,
          networkTxBytes: null,
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    await screen.findByText(/2 running tasks/);
    expect(document.body.textContent).not.toContain("0 B");
  });

  it("say Docker is unavailable and date the last reading", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/web/metrics": {
          ...metrics,
          available: false,
          lastReadAt: "2026-03-04T05:06:07.000Z",
        },
      }),
    );
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText("Docker unavailable")).toBeTruthy();
    expect(screen.getByText(/last reading .*2026|last reading .*26/)).toBeTruthy();
    expect(screen.queryByText(/0\.0%|0 B/)).toBeNull();
  });

  it("say nothing is running, and when the last reading was", async () => {
    installFakeServer(
      base({
        "GET /projects/shop/services/web/metrics": { ...metrics, lastReadAt: "2026-03-04T05:06:07.000Z" },
      }),
    );
    renderApp("/projects/shop/app/web");

    expect(await screen.findByText(/Nothing running/)).toBeTruthy();
  });

  it("show what the server publishes without a reload, and never NaN", async () => {
    installFakeServer(base());
    const app = renderApp("/projects/shop/app/web");
    await screen.findByRole("button", { name: "Deploy" });
    await screen.findByRole("img", { name: "CPU: No data" });

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
    await screen.findByRole("img", { name: "CPU: No data" });

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
