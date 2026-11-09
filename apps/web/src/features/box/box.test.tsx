// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { BoxDetail, BoxIdeStatus, BoxProcessesStatus, ServiceDetail } from "@opsifier/contract";
import { boxMatrix, boxModulesConfig } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

vi.mock("../../ui/CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

afterEach(resetApp);

const service: ServiceDetail = {
  projectName: "shop",
  name: "dev",
  type: "box",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-11-08T10:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
  source: { type: "dockerfile", dockerfile: "FROM alpine:3.24.4\n" },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: null,
  pendingChanges: false,
  answering: null,
};

const box: BoxDetail = {
  modules: boxModulesConfig.parse({ php: { version: "8.4", extensions: ["opcache"] } }),
  processes: [{ name: "worker", command: "php worker.php", directory: ".", enabled: true }],
  hooks: { build: "", start: "" },
  preset: null,
  matrixRevision: "2026.11",
  built: null,
  pendingChanges: [],
  issues: [],
  history: [],
  runtime: { user: "box", uid: 1000, gid: 1000, workspacePath: "/workspace", workspaceVolume: "workspace" },
  dockerfile: "FROM alpine:3.24.4\n",
};

const processes: BoxProcessesStatus = {
  reachable: true,
  processes: [
    { name: "worker", system: false, state: "restarting", restarts: 3, lastExit: 1, since: null },
    { name: "nginx", system: true, state: "running", restarts: 0, lastExit: null, since: null },
  ],
};

const ide = (access: BoxIdeStatus["access"]): BoxIdeStatus => ({
  enabled: access !== "off",
  access,
  createdAt: access === "open" || access === "expired" ? "2026-11-01T10:00:00.000Z" : null,
  expiresAt: access === "open" || access === "expired" ? "2026-11-08T10:00:00.000Z" : null,
  path: "/ide/shop/dev",
});

const SERVICE = "/projects/shop/services/dev";

function pageServer(routes: FakeRoute = {}) {
  return installFakeServer({
    [`GET ${SERVICE}`]: service,
    [`GET ${SERVICE}/box`]: box,
    [`GET ${SERVICE}/box/processes/status`]: processes,
    [`GET ${SERVICE}/box/ide`]: ide("off"),
    [`GET ${SERVICE}/metrics`]: withStatus(404, { error: { code: "not_found", message: "Not found." } }),
    ...routes,
  });
}

describe("the create page", () => {
  it("offers a box now, with presets, and creates one", async () => {
    const server = pageServer({
      "GET /projects": { items: [] },
      "POST /projects/shop/box": withStatus(201, service),
    });
    renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByRole("button", { name: /Box/ }));
    expect(await screen.findByRole("dialog", { name: "Add a box" })).toBeTruthy();
    expect(screen.getAllByText("Nothing, I'll choose").length).toBeGreaterThan(0);

    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "dev" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add box" }));

    await waitFor(() => expect(server.calls.some((call) => call.path === "/projects/shop/box")).toBe(true));
    expect(server.calls.find((call) => call.path === "/projects/shop/box")?.body).toEqual({
      name: "dev",
      preset: null,
    });
  });
});

describe("the Modules tab", () => {
  it("draws every module of the matrix, says what can't be added, and saves", async () => {
    const server = pageServer({ [`PUT ${SERVICE}/box/modules`]: box });
    renderApp("/projects/shop/box/dev/modules");

    await screen.findByText("Node.js");
    expect(screen.getAllByRole("switch", { name: /^Use / })).toHaveLength(boxMatrix.length);

    fireEvent.click(screen.getByRole("switch", { name: "Use Node.js" }));
    fireEvent.click(screen.getByRole("button", { name: "Save modules" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "PUT" && call.path.endsWith("/box/modules"))).toBe(
        true,
      ),
    );
    const saved = server.calls.find((call) => call.path.endsWith("/box/modules"))?.body as {
      node: { version: string } | null;
    };
    expect(saved.node?.version).toBe("24");
  });

  it("marks an extension the chosen version can't have as unavailable", async () => {
    pageServer({
      [`GET ${SERVICE}/box`]: {
        ...box,
        modules: boxModulesConfig.parse({ php: { version: "8.5", extensions: [] } }),
      },
    });
    renderApp("/projects/shop/box/dev/modules");

    expect(((await screen.findByRole("button", { name: "opcache" })) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "gd" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows why an image needs rebuilding, and the history of past builds", async () => {
    pageServer({
      [`GET ${SERVICE}/box`]: {
        ...box,
        pendingChanges: [{ kind: "security", subject: "php", from: "php84 8.4.20", to: "php84 8.4.27" }],
        history: [
          {
            actionId: "a1",
            at: "2026-11-08T10:00:00.000Z",
            status: "succeeded",
            reason: "upgrade",
            changes: [{ kind: "upgrade", subject: "php", from: "8.3", to: "8.4" }],
            matrixRevision: "2026.11",
            imageId: "sha256:1",
            actorEmail: "admin@example.com",
            error: null,
          },
        ],
      },
    });
    renderApp("/projects/shop/box/dev/modules");

    expect(await screen.findByText("Waiting for a build")).toBeTruthy();
    expect(screen.getAllByText("Security update").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Version change").length).toBeGreaterThan(0);
  });

  it("says what is wrong when the server refuses a selection", async () => {
    pageServer({
      [`PUT ${SERVICE}/box/modules`]: withStatus(400, {
        error: {
          code: "box_modules_invalid",
          message: "Some fields need attention.",
          fields: { "php.extensions": "opcache can't be added to version 8.5." },
        },
      }),
    });
    renderApp("/projects/shop/box/dev/modules");

    fireEvent.click(await screen.findByRole("button", { name: "Save modules" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("the Processes tab", () => {
  it("shows a lamp for each process and restarts one", async () => {
    const server = pageServer({
      [`POST ${SERVICE}/box/processes/worker/restart`]: withStatus(202, {
        id: "action-1",
        type: "box.process-restart",
        title: "Restart",
        status: "queued",
        projectName: "shop",
        serviceName: "dev",
        createdAt: "2026-11-08T10:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
        hasLog: false,
        phase: null,
      }),
    });
    renderApp("/projects/shop/box/dev/processes");

    await screen.findByText("From a module");
    expect(screen.getByRole("cell", { name: /Restarting/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restart worker" }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/worker/restart"))).toBe(true),
    );
  });

  it("says so when the box can't be asked", async () => {
    pageServer({
      [`GET ${SERVICE}/box/processes/status`]: {
        reachable: false,
        processes: [
          { name: "worker", system: false, state: "unknown", restarts: 0, lastExit: null, since: null },
        ],
      },
    });
    renderApp("/projects/shop/box/dev/processes");

    expect(await screen.findByText(/isn't running, so its processes can't be read/)).toBeTruthy();
  });
});

describe("the IDE tab", () => {
  it("issues a token, shown once and only then", async () => {
    pageServer({
      [`GET ${SERVICE}/box/ide`]: ide("no_token"),
      [`POST ${SERVICE}/box/ide/token`]: { ...ide("open"), token: "abc123" },
    });
    renderApp("/projects/shop/box/dev/ide");

    fireEvent.click(await screen.findByRole("button", { name: "Issue a token" }));

    const dialog = await screen.findByRole("dialog", { name: "Copy this token" });
    expect(within(dialog).getByText("abc123")).toBeTruthy();
  });

  it("states what it can reach, and what it can't", async () => {
    pageServer({ [`GET ${SERVICE}/box/ide`]: ide("expired") });
    renderApp("/projects/shop/box/dev/ide");

    expect(await screen.findByText("Token expired")).toBeTruthy();
    expect(screen.getByText(/It has no terminal/)).toBeTruthy();
  });
});

describe("the IDE itself", () => {
  const SESSION = "/ide/shop/dev/session";
  const TREE = "/ide/shop/dev/tree";
  const FILE = "/ide/shop/dev/file";
  const opened = {
    project: "shop",
    service: "dev",
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxFileBytes: 1024,
  };

  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  const refused = withStatus(401, {
    error: { code: "ide_unauthorized", message: "This IDE needs a valid token." },
  });

  it("asks for a token and shows nothing without one, even to someone signed in", async () => {
    const server = installFakeServer({ [`GET ${SESSION}`]: refused });
    renderApp("/ide/shop/dev");

    expect(await screen.findByLabelText("Token")).toBeTruthy();
    expect(server.calls.some((call) => call.path === SESSION)).toBe(false);
  });

  it("says when a token was refused", async () => {
    installFakeServer({ [`GET ${SESSION}`]: refused });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("This token can't open this IDE.")).toBeTruthy();
  });

  it("says when a token has expired", async () => {
    installFakeServer({
      [`GET ${SESSION}`]: withStatus(401, { error: { code: "ide_token_expired", message: "Expired." } }),
    });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "old" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText(/This token has expired/)).toBeTruthy();
  });

  it("opens with a token, sends it only as a bearer, and lists the workspace", async () => {
    const server = installFakeServer({
      [`GET ${SESSION}`]: opened,
      [`GET ${TREE}`]: { path: "", entries: [{ name: "readme.md", kind: "file" }], truncated: false },
    });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByRole("button", { name: "readme.md" })).toBeTruthy();
    expect(server.calls.some((call) => call.path === TREE)).toBe(true);
    expect(vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes(TREE))?.[1]).toMatchObject({
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: "Bearer good" }),
    });
  });

  it("keeps unsaved edits when the token stops working, and asks for a new one", async () => {
    installFakeServer({
      [`GET ${SESSION}`]: opened,
      [`GET ${TREE}`]: { path: "", entries: [{ name: "a.txt", kind: "file" }], truncated: false },
      [`GET ${FILE}`]: { path: "a.txt", content: "hello", unreadable: null, version: "1" },
      [`PUT ${FILE}`]: refused,
    });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
    const editor = (await screen.findByRole("textbox", { name: "a.txt" })) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "hello, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Your token no longer works" });
    expect(within(dialog).getByText("This token can't open this IDE.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "a.txt", hidden: true }) as HTMLTextAreaElement).value).toBe(
      "hello, edited",
    );
  });

  it("says a file changed under it rather than overwriting it", async () => {
    installFakeServer({
      [`GET ${SESSION}`]: opened,
      [`GET ${TREE}`]: { path: "", entries: [{ name: "a.txt", kind: "file" }], truncated: false },
      [`GET ${FILE}`]: { path: "a.txt", content: "hello", unreadable: null, version: "1" },
      [`PUT ${FILE}`]: withStatus(409, { error: { code: "ide_conflict", message: "Changed." } }),
    });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "a.txt" }), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/changed this file since you opened it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load the new version" })).toBeTruthy();
  });

  it("says what it can't show as text", async () => {
    installFakeServer({
      [`GET ${SESSION}`]: opened,
      [`GET ${TREE}`]: { path: "", entries: [{ name: "logo.png", kind: "file" }], truncated: false },
      [`GET ${FILE}`]: { path: "logo.png", content: null, unreadable: "binary", version: "1" },
    });
    renderApp("/ide/shop/dev");

    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "good" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "logo.png" }));

    expect(await screen.findByText("logo.png isn't text")).toBeTruthy();
  });
});
