// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { type ActionEntry, actionsTopic, actionTopic } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

afterEach(resetApp);

const action = (overrides: Partial<ActionEntry> = {}): ActionEntry => ({
  id: "a1",
  type: "service.deploy",
  title: "Deploy shop/web",
  status: "succeeded",
  phase: null,
  projectName: "shop",
  serviceName: "web",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:12.000Z",
  error: null,
  hasLog: true,
  actorEmail: "admin@example.com",
  origin: "session",
  originDetail: null,
  ...overrides,
});

const page = (items: ActionEntry[], nextCursor: string | null = null) => ({ items, nextCursor });

describe("following a task", () => {
  it("shows the phase while it runs", async () => {
    installFakeServer({
      "GET /actions": page([action({ status: "running", finishedAt: null, phase: "rollout" })]),
    });
    renderApp("/activity");

    expect(await screen.findByText("Rolling out")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Running" }).length).toBeGreaterThan(0);
  });

  it("shows the result and the step it stopped at, in the row and in its dialog", async () => {
    const failed = action({ status: "failed", phase: "verify", error: "The new tasks did not stay up." });
    installFakeServer({
      "GET /actions": page([failed]),
      "GET /actions/a1": { ...failed, log: "line", logTruncated: false, logSeq: 0 },
    });
    renderApp("/activity");

    expect(await screen.findByText("Checking it stays up")).toBeTruthy();
    expect(screen.getByText("The new tasks did not stay up.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "See the output" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Failed")).toBeTruthy();
    expect(dialog.getByText("Checking it stays up")).toBeTruthy();
    expect(dialog.getByText("The new tasks did not stay up.")).toBeTruthy();
  });

  it("offers to deploy again only when pressed, never by coming back to the page", async () => {
    const failed = action({ status: "failed", error: "no" });
    const server = installFakeServer({
      "GET /actions": page([failed]),
      "POST /projects/shop/services/web/deploy": action({ id: "a2", status: "queued" }),
    });
    const app = renderApp("/activity");

    await screen.findByRole("button", { name: "Deploy again" });
    await app.router.navigate({ to: "/" });
    await app.router.navigate({ to: "/activity" });
    await screen.findByRole("button", { name: "Deploy again" });
    const deploys = () => server.calls.filter((call) => call.method === "POST");
    expect(deploys()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Deploy again" }));

    await waitFor(() =>
      expect(deploys().map((call) => call.path)).toEqual(["/projects/shop/services/web/deploy"]),
    );
    expect(await screen.findByText("Deployment started")).toBeTruthy();
  });

  it("has nothing to resume for a deployment that worked, or an action that can't be repeated", async () => {
    installFakeServer({
      "GET /actions": page([
        action({ id: "ok" }),
        action({ id: "backup", type: "backup.database", status: "failed", error: "no" }),
      ]),
    });
    renderApp("/activity");

    await screen.findByText("Database backup");
    expect(screen.queryByRole("button", { name: "Deploy again" })).toBeNull();
  });
});

describe("the Activity page", () => {
  it("says when there is nothing yet", async () => {
    installFakeServer({ "GET /actions": page([]) });
    renderApp("/activity");

    expect(await screen.findByText("The log is empty")).toBeTruthy();
    expect(document.querySelector('[data-illustration="no-activity"]')).toBeTruthy();
  });

  it("shows an entry's outcome, duration, target, actor and shortcut", async () => {
    installFakeServer({ "GET /actions": page([action()]) });
    renderApp("/activity");

    expect(await screen.findByText("Deployment")).toBeTruthy();
    expect(screen.getByText("shop/web")).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Succeeded" })).toBeTruthy();
    expect(screen.getByText("Started by admin@example.com")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the service" }).getAttribute("href")).toBe(
      "/projects/shop/app/web",
    );
  });

  it("makes a failure visibly different, and shows why", async () => {
    installFakeServer({ "GET /actions": page([action({ status: "failed", error: "The tasks crashed." })]) });
    renderApp("/activity");

    expect(await screen.findByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.getByText("The tasks crashed.").className).toContain("text-bad");
  });

  it("leads each row with its lamp and a drawing of what it was about", async () => {
    installFakeServer({ "GET /actions": page([action({ type: "service.domains" })]) });
    renderApp("/activity");

    await screen.findByRole("img", { name: "Succeeded" });
    expect(document.querySelector('main li svg[data-pictogram="domain"]')).toBeTruthy();
  });

  it("counts outcomes in its own words, and filters by them", async () => {
    installFakeServer({
      "GET /actions": page([
        action({ id: "ok" }),
        action({ id: "bad", status: "failed", error: "The tasks crashed." }),
      ]),
    });
    renderApp("/activity");

    await screen.findByText("The tasks crashed.");
    expect(screen.getByRole("group", { name: "Recent actions by outcome" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 Succeeded" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 Succeeded" }));
    await waitFor(() => expect(screen.queryByText("The tasks crashed.")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "1 Succeeded" }));
    expect(await screen.findByText("The tasks crashed.")).toBeTruthy();
  });

  it("offers no output control for an entry with no log", async () => {
    installFakeServer({
      "GET /actions": page([action({ hasLog: false, type: "auth.login", title: "Signed in" })]),
    });
    renderApp("/activity");

    await screen.findByText("Signed in");
    expect(screen.queryByRole("button", { name: "See the output" })).toBeNull();
  });

  it("pages older entries in, and stops offering more at the end", async () => {
    const first = Array.from({ length: 15 }, (_, index) =>
      action({ id: `n${index}`, title: `Task ${index}`, type: "x" }),
    );
    const server = installFakeServer({
      "GET /actions": (_: unknown, url: URL) =>
        url.searchParams.get("cursor") === "next"
          ? page([action({ id: "old", title: "Older task", type: "x" })])
          : page(first, "next"),
    });
    renderApp("/activity");

    expect(await screen.findByText("Task 0")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Succeeded" })).toHaveLength(15);

    fireEvent.click(screen.getByRole("button", { name: "Show older entries" }));

    expect(await screen.findByText("Older task")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show older entries" })).toBeNull());
    expect(server.calls.filter((call) => call.path === "/actions").length).toBeGreaterThan(1);
  });

  it("adds a new entry on top without a reload, and updates it in place", async () => {
    installFakeServer({ "GET /actions": page([action()]) });
    const app = renderApp("/activity");
    await screen.findByText("Deployment");

    app.emit(actionsTopic, action({ id: "new", type: "service.stop", status: "running", finishedAt: null }));
    expect(await screen.findByText("Service stop")).toBeTruthy();

    app.emit(actionsTopic, action({ id: "new", type: "service.stop", status: "succeeded" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Running" })).toBeNull());
    const text = document.querySelector("main")?.textContent ?? "";
    expect(text.indexOf("Service stop")).toBeLessThan(text.indexOf("Deployment"));
  });

  it("opens the log in a dialog, follows it live and returns to the same list", async () => {
    const running = action({ id: "live", status: "running", finishedAt: null });
    installFakeServer({
      "GET /actions": page([running]),
      "GET /actions/live": { ...running, log: "first line\n", logTruncated: false, logSeq: 1 },
    });
    const app = renderApp("/activity");

    fireEvent.click(await screen.findByRole("button", { name: "See the output" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/first line/)).toBeTruthy();

    app.emit(actionTopic("live"), { kind: "log", seq: 2, line: "second line" });
    expect(await within(dialog).findByText(/second line/)).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Deployment")).toBeTruthy();
  });

  it("can stop a running action", async () => {
    const running = action({ id: "live", status: "running", finishedAt: null });
    const server = installFakeServer({
      "GET /actions": page([running]),
      "POST /actions/live/cancel": running,
    });
    renderApp("/activity");

    fireEvent.click(await screen.findByRole("button", { name: "Stop this action" }));

    await waitFor(() =>
      expect(
        server.calls.some((call) => call.method === "POST" && call.path === "/actions/live/cancel"),
      ).toBe(true),
    );
  });
});
