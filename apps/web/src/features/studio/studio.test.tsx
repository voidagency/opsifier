// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { StudioApp, StudioAppDetail, StudioEventPage, StudioRemark } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  SIGNED_IN,
  withStatus,
} from "../../testing/appHarness";

afterEach(resetApp);

const APP = "/projects/lovable/services/cd-studio-preview/studio";
const CONVERSATION = "c0ffee00-0000-4000-8000-000000000001";

const conversation = {
  id: CONVERSATION,
  title: "Titre de la page d'accueil",
  createdBy: "admin@example.com",
  createdAt: "2026-11-15T12:00:00.000Z",
  updatedAt: "2026-11-15T12:05:00.000Z",
  readOnly: false,
};

const app = (overrides: Partial<StudioApp> = {}): StudioApp => ({
  project: "lovable",
  service: "cd-studio-preview",
  workspaceDir: "/projects/cd-studio",
  previewUrl: "https://lovable-cd-studio-preview.app.example.com",
  previewStatus: "running",
  agentMode: "shared",
  agentStatus: null,
  lastConversation: conversation,
  viewing: null,
  paused: null,
  ...overrides,
});

const detail = (overrides: Partial<StudioAppDetail> = {}): StudioAppDetail => ({
  ...app(),
  conversations: [conversation],
  ...overrides,
});

const ACCOUNT = {
  name: "",
  role: "member",
  owner: false,
  hostAdmin: false,
  twoFactorEnabled: false,
  active: true,
  createdAt: "2026-11-15T12:00:00.000Z",
  projects: [],
  allProjects: null,
  apiKeyCount: 0,
};

const QWEN = { profile: "qwen-rtx", name: "Qwen3.6-27B", host: "100.89.0.1", private: true };
const CLOUD = { profile: "cloud", name: "claude-sonnet-4-5", host: null, private: false };

const page = (overrides: Partial<StudioEventPage> = {}): StudioEventPage => ({
  items: [
    {
      kind: "message",
      id: "e1",
      timestamp: "2026-11-15T12:00:01Z",
      role: "user",
      text: "Change le titre",
      images: [],
      suggestions: [],
    },
    {
      kind: "action",
      id: "e2",
      timestamp: "2026-11-15T12:00:02Z",
      tool: "file_editor",
      verb: "edit",
      summary: "Edited a file",
      described: false,
      detail: "src/routes/index.tsx",
      thought: "Je modifie le **titre** de la page d'accueil.",
      tasks: null,
    },
    {
      kind: "message",
      id: "e3",
      timestamp: "2026-11-15T12:00:03Z",
      role: "agent",
      text: "C'est **fait**.",
      images: [],
      suggestions: ["Ajoute un mode sombre", "Agrandis le logo"],
    },
  ],
  cursor: "e3",
  status: "finished",
  title: "Titre de la page d'accueil",
  model: QWEN,
  more: false,
  asleep: false,
  ...overrides,
});

/** What opening a project found on GitHub: nothing new, unless a test says otherwise. */
const synced = (extra: Record<string, unknown> = {}) => ({
  state: "current",
  branch: "main",
  pulled: 0,
  behind: 0,
  ahead: 0,
  changed: 0,
  blocking: [],
  previewRestarted: false,
  reason: null,
  ...extra,
});

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [] },
  [`POST ${APP}/sync`]: synced(),
  "GET /studio": {
    enabled: true,
    agentConfigured: true,
    canAddProjects: false,
    agentPerProject: false,
    apps: [app()],
  },
  [`GET ${APP}`]: detail(),
  [`GET ${APP}/conversations/${CONVERSATION}/events`]: page(),
  "GET /studio/models": { active: "qwen-rtx", models: [QWEN] },
  ...extra,
});

describe("the Studio's list", () => {
  it("says which projects wait for an agent server of their own", async () => {
    installFakeServer(
      base({
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: false,
          agentPerProject: true,
          apps: [app({ agentMode: "missing" })],
        },
      }),
    );
    renderApp("/studio");

    expect(await screen.findByText("Waiting for its own agent")).toBeTruthy();
  });

  it("puts a project on pause for an administrator, once asked", async () => {
    const server = installFakeServer(
      base({
        [`POST ${APP}/pause`]: detail({
          paused: { at: "2026-11-20T09:00:00.000Z", by: "admin@example.com" },
        }),
      }),
    );
    renderApp("/studio");

    fireEvent.click(await screen.findByRole("button", { name: "Put cd-studio on pause" }));
    const dialog = await screen.findByRole("dialog", { name: "Put cd-studio on pause?" });
    expect(within(dialog).getByText(/nothing starts them again, not even opening the project/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Put on pause" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "POST" && call.path === `${APP}/pause`)).toBe(true),
    );
    expect(await screen.findByText("cd-studio is on pause.")).toBeTruthy();
  });

  it("shows a project on pause, which anyone who works on it can resume", async () => {
    const paused = { at: "2026-11-20T09:00:00.000Z", by: "karim@example.com" };
    const server = installFakeServer(
      base({
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: false,
          agentPerProject: false,
          apps: [app({ paused, previewStatus: "stopped" })],
        },
        [`POST ${APP}/resume`]: { started: true, agentStarted: false },
      }),
    );
    renderApp("/studio");

    expect(await screen.findByText("On pause")).toBeTruthy();
    expect(screen.getByText(/by karim@example.com/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Put cd-studio on pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume cd-studio" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "POST" && call.path === `${APP}/resume`)).toBe(true),
    );
    expect(await screen.findByText("cd-studio resumes: its preview is starting.")).toBeTruthy();
  });

  it("shows the linked projects and opens one", async () => {
    installFakeServer(base());
    const rendered = renderApp("/studio");

    const open = await screen.findByRole("link", { name: "Open cd-studio in the Studio" });
    expect(screen.getByText(/Titre de la page d'accueil/)).toBeTruthy();
    fireEvent.click(open);

    await waitFor(() => expect(rendered.location()).toBe("/studio/lovable/cd-studio-preview"));
  });

  it("says how to turn it on while it is off", async () => {
    installFakeServer(
      base({
        "GET /studio": {
          enabled: false,
          agentConfigured: false,
          canAddProjects: false,
          agentPerProject: false,
          apps: [],
        },
      }),
    );
    renderApp("/studio");

    expect(await screen.findByText("The Studio is turned off")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Studio settings" }).getAttribute("href")).toBe(
      "/settings/server/studio",
    );
  });

  it("adds a GitHub project, then opens it", async () => {
    const added = detail({
      service: "un-mot-par-jour-landing-preview",
      workspaceDir: "/projects/un-mot-par-jour-landing",
      conversations: [],
      lastConversation: null,
    });
    const server = installFakeServer(
      base({
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: true,
          agentPerProject: false,
          apps: [app()],
        },
        "POST /studio/projects": added,
        "GET /projects/lovable/services/un-mot-par-jour-landing-preview/studio": added,
      }),
    );
    const rendered = renderApp("/studio");

    fireEvent.click(await screen.findByRole("button", { name: "Add a project" }));
    fireEvent.change(await screen.findByLabelText("Repository"), {
      target: { value: "https://github.com/mehdinajeddine/un-mot-par-jour-landing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.path === "/studio/projects")?.body).toEqual({
        repository: "https://github.com/mehdinajeddine/un-mot-par-jour-landing",
      }),
    );
    await waitFor(() => expect(rendered.location()).toBe("/studio/lovable/un-mot-par-jour-landing-preview"));
  });

  it("says what the agent server's token needs when it does not reach the repository", async () => {
    installFakeServer(
      base({
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: true,
          agentPerProject: false,
          apps: [],
        },
        "POST /studio/projects": withStatus(422, {
          error: {
            code: "studio_repository_unreachable",
            message: "The agent server's GitHub token does not reach x/y.",
          },
        }),
      }),
    );
    renderApp("/studio");

    // The empty list offers it too, next to the page's own button.
    fireEvent.click((await screen.findAllByRole("button", { name: "Add a project" }))[0] as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "x/y" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/did not let the Studio read this repository/)).toBeTruthy();
  });

  it("asks for the projects folder before projects can be added", async () => {
    installFakeServer(
      base({
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: false,
          agentPerProject: false,
          apps: [],
        },
      }),
    );
    renderApp("/studio");

    expect(await screen.findByText(/Set the projects folder in the Studio's settings/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a project" })).toBeNull();
  });

  it("is not in the bar of an account with no project shared with it", async () => {
    installFakeServer(
      base({
        "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } },
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: false,
          agentPerProject: false,
          apps: [],
        },
      }),
    );
    renderApp("/studio");

    expect(await screen.findByText("No project shared with you yet")).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: "Studio" })).toEqual([]);
    expect(screen.queryByRole("button", { name: "Link a project" })).toBeNull();
  });

  it("shows a designer the projects shared with them, without the administration", async () => {
    installFakeServer(
      base({ "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } } }),
    );
    renderApp("/studio");

    expect(await screen.findByRole("link", { name: "Open cd-studio in the Studio" })).toBeTruthy();
    expect((await screen.findAllByRole("link", { name: "Studio" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Link a project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a project" })).toBeNull();
  });
});

describe("taking a project out of the Studio", () => {
  it("deletes a project once its name is typed, for an administrator", async () => {
    const server = installFakeServer(
      base({
        [`POST ${APP}/remove`]: {
          id: "a1",
          type: "studio.remove",
          title: "Take cd-studio out of the Studio",
          status: "queued",
          projectName: "lovable",
          serviceName: "cd-studio-preview",
          actorEmail: "admin@example.com",
          origin: null,
          originDetail: null,
          hasLog: false,
          logTruncated: false,
          error: null,
          phase: null,
          createdAt: "2026-11-16T19:00:00Z",
          startedAt: null,
          finishedAt: null,
        },
      }),
    );
    renderApp("/studio");

    fireEvent.click(await screen.findByRole("button", { name: "Delete cd-studio" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Its folder stays on the server/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "cd-studio" } });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path === `${APP}/remove`)?.body,
      ).toEqual({
        confirm: "cd-studio",
      }),
    );
  });

  it("leads an administrator to the project in Opsifier", async () => {
    installFakeServer(base());
    renderApp("/studio");

    const link = await screen.findByRole("link", { name: "Open lovable in Opsifier" });
    expect(link.getAttribute("href")).toBe("/projects/lovable");
  });

  it("is not offered to someone a project is shared with", async () => {
    installFakeServer(
      base({ "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } } }),
    );
    renderApp("/studio");

    expect(await screen.findByRole("link", { name: "Open cd-studio in the Studio" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete cd-studio" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open lovable in Opsifier" })).toBeNull();
  });
});

describe("someone who only has the Studio", () => {
  const designer = (projects: Array<{ name: string; role: string }>) =>
    base({
      "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } },
      "GET /auth/identity": {
        user: { id: SIGNED_IN.user.id, email: SIGNED_IN.user.email, role: "member" },
        credential: { kind: "session" },
        projects,
        allProjects: null,
        operations: [],
      },
    });

  it("lands on the Studio, and sees no menu of the panel", async () => {
    installFakeServer(designer([]));
    const rendered = renderApp("/");

    await waitFor(() => expect(rendered.location()).toBe("/studio"));
    expect(await screen.findByRole("link", { name: "Open cd-studio in the Studio" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Activity" })).toBeNull();
  });

  it("is not a member who also reaches projects of the panel", async () => {
    installFakeServer(designer([{ name: "shop", role: "operator" }]));
    const rendered = renderApp("/");

    expect((await screen.findAllByRole("link", { name: "Activity" })).length).toBeGreaterThan(0);
    expect(rendered.location()).toBe("/");
  });
});

const PANEL_KEY = "opsifier.studio.chat-panel";

/** What the inspector in the preview's page says to the Studio. */
function fromPreview(data: Record<string, unknown>) {
  const frame = screen.getByTitle("Live preview of cd-studio-preview") as HTMLIFrameElement;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "opsifier-studio-preview", ...data },
      origin: "https://lovable-cd-studio-preview.app.example.com",
      source: frame.contentWindow,
    }),
  );
}

describe("the versions the agent saved", () => {
  const VERSIONS = `${APP}/versions`;
  const OLDEST = "0".repeat(40);
  const FIRST = "a".repeat(40);
  const SECOND = "b".repeat(40);
  const shownFirst = {
    sha: FIRST,
    at: "2026-11-15T12:00:02.000Z",
    subject: "Change le titre de l'accueil",
    since: "2026-11-15T12:10:00.000Z",
    by: "admin@example.com",
  };
  // Two requests answered, the agent's server writing its times without their zone.
  const twoAnswers = (status: StudioEventPage["status"] = "finished") =>
    page({
      status,
      items: [
        ...page().items.map((item) => ({ ...item, timestamp: item.timestamp.replace("Z", ".123456") })),
        {
          kind: "message",
          id: "e4",
          timestamp: "2026-11-15T12:01:00.000001",
          role: "user",
          text: "Ajoute un formulaire de contact",
          images: [],
          suggestions: [],
        },
        {
          kind: "message",
          id: "e5",
          timestamp: "2026-11-15T12:02:00.5",
          role: "agent",
          text: "Voilà le formulaire.",
          images: [],
          suggestions: [],
        },
      ],
    });
  const saved = {
    versions: [
      { sha: SECOND, at: "2026-11-15T12:01:30.000Z", subject: "Ajoute le formulaire de contact" },
      { sha: FIRST, at: "2026-11-15T12:00:02.000Z", subject: "Change le titre de l'accueil" },
      // Saved before the conversation: under none of its answers.
      { sha: OLDEST, at: "2026-11-14T09:00:00.000Z", subject: "Premier jet" },
    ],
    asleep: false,
    viewing: null,
  };
  const versionsServer = (extra: FakeRoute = {}, initially: typeof shownFirst | null = null) => {
    let viewing = initially;
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: () => detail({ viewing }),
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: twoAnswers(),
        [`GET ${VERSIONS}`]: () => ({ ...saved, viewing }),
        [`POST ${VERSIONS}/${FIRST}/view`]: () => {
          viewing = shownFirst;
          return { viewing };
        },
        [`POST ${VERSIONS}/current`]: () => {
          viewing = null;
          return { viewing };
        },
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation,
        ...extra,
      }),
    );
    return server;
  };
  const card = (subject: string) => screen.findByRole("group", { name: `Version: ${subject}` });

  it("shows under each answer the version it saved", async () => {
    versionsServer();
    renderApp("/studio/lovable/cd-studio-preview");

    const first = await card("Change le titre de l'accueil");
    expect(within(first).getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(within(first).getByRole("button", { name: "Restore" })).toBeTruthy();
    const second = await card("Ajoute le formulaire de contact");
    expect(within(second).getByText("Current version")).toBeTruthy();
    expect(within(second).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("group", { name: "Version: Premier jet" })).toBeNull();
    // Each under its own answer.
    const answers = screen.getAllByRole("listitem");
    const under = (text: string) => answers.find((item) => within(item).queryByText(text) !== null);
    expect(under("Voilà le formulaire.")?.contains(second)).toBe(true);
    expect(under("Voilà le formulaire.")?.contains(first)).toBe(false);
  });

  it("shows an earlier version in the preview, holds messages meanwhile, and brings the current one back", async () => {
    const server = versionsServer();
    renderApp("/studio/lovable/cd-studio-preview");
    const first = await card("Change le titre de l'accueil");

    fireEvent.click(within(first).getByRole("button", { name: "Preview" }));
    const preview = screen.getByRole("region", { name: "Live preview" });
    await within(preview).findByText(/Previewing the version of .*Change le titre de l'accueil/);
    expect(
      server.calls.some((call) => call.method === "POST" && call.path === `${VERSIONS}/${FIRST}/view`),
    ).toBe(true);
    expect(within(await card("Change le titre de l'accueil")).getByText("Shown in the preview")).toBeTruthy();

    // What would be sent waits for the current version.
    expect(screen.getByText(/An earlier version is shown in the preview/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "Encore" },
    });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();

    fireEvent.click(within(preview).getByRole("button", { name: "Back to the current version" }));
    await waitFor(() => expect(within(preview).queryByText(/Previewing the version of/)).toBeNull());
    expect(server.calls.some((call) => call.method === "POST" && call.path === `${VERSIONS}/current`)).toBe(
      true,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByText(/An earlier version is shown in the preview/)).toBeNull();
  });

  it("asks the agent to bring an earlier version back as a new one, with nothing else waiting", async () => {
    const server = versionsServer();
    renderApp("/studio/lovable/cd-studio-preview");
    const first = await card("Change le titre de l'accueil");
    fireEvent.change(screen.getByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "Un mot de plus" },
    });

    fireEvent.click(within(first).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(server.calls.find((call) => call.path.endsWith("/messages"))).toBeTruthy());
    const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as { text: string };
    expect(sent.text).toMatch(/^Restore the version of .+\.\n\n<version_restore>\n/);
    expect(sent.text).toContain(`Commit: ${FIRST}`);
    expect(sent.text).toContain("Subject: Change le titre de l'accueil");
    expect(sent.text).not.toContain("Un mot de plus");
    // What was being typed stays for the next message.
    expect((screen.getByRole("textbox", { name: "Message to the agent" }) as HTMLTextAreaElement).value).toBe(
      "Un mot de plus",
    );
    // The message shows the version asked for, not its block.
    expect(await screen.findByText("Version:")).toBeTruthy();
    expect(screen.queryByText(/<version_restore>/)).toBeNull();
  });

  it("brings the version shown back from the preview, once the current one is in its folder again", async () => {
    const server = versionsServer({}, shownFirst);
    renderApp("/studio/lovable/cd-studio-preview");
    const preview = await screen.findByRole("region", { name: "Live preview" });
    fireEvent.click(await within(preview).findByRole("button", { name: "Restore this version" }));

    await waitFor(() => expect(server.calls.find((call) => call.path.endsWith("/messages"))).toBeTruthy());
    const order = server.calls
      .filter((call) => call.method === "POST" && call.path !== `${APP}/sync`)
      .map((call) => call.path);
    expect(order).toEqual([`${VERSIONS}/current`, `${APP}/conversations/${CONVERSATION}/messages`]);
    const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as { text: string };
    expect(sent.text).toContain(`Commit: ${FIRST}`);
  });

  it("follows a version someone else shows", async () => {
    let reads = 0;
    // The page opened before a colleague showed an earlier version.
    versionsServer({
      [`GET ${APP}`]: () => {
        reads += 1;
        return detail({ viewing: reads === 1 ? null : shownFirst });
      },
      [`GET ${VERSIONS}`]: { ...saved, viewing: shownFirst },
    });
    renderApp("/studio/lovable/cd-studio-preview");
    const preview = await screen.findByRole("region", { name: "Live preview" });
    expect(
      await within(preview).findByText(/admin@example.com is showing|Previewing the version of/),
    ).toBeTruthy();
    expect(screen.getByText(/An earlier version is shown in the preview/)).toBeTruthy();
  });

  it("says why a message waits when it finds an earlier version shown", async () => {
    let shown = false;
    const server = versionsServer({
      [`GET ${APP}`]: () => detail({ viewing: shown ? { ...shownFirst, by: "karim@example.com" } : null }),
      [`GET ${VERSIONS}`]: () => ({ ...saved, viewing: null }),
      [`POST ${APP}/conversations/${CONVERSATION}/messages`]: () => {
        shown = true;
        return withStatus(409, {
          error: { code: "studio_viewing_version", message: "An earlier version is shown." },
        });
      },
    });
    renderApp("/studio/lovable/cd-studio-preview");
    await card("Change le titre de l'accueil");
    fireEvent.change(screen.getByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "Encore" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const preview = screen.getByRole("region", { name: "Live preview" });
    expect(await within(preview).findByText(/karim@example.com is showing the version of/)).toBeTruthy();
    expect(server.calls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(1);
    // What was typed waits for the current version.
    expect((screen.getByRole("textbox", { name: "Message to the agent" }) as HTMLTextAreaElement).value).toBe(
      "Encore",
    );
  });

  it("brings a version back in a new conversation when the one shown is kept for reading", async () => {
    const kept = { ...conversation, readOnly: true };
    const started = { ...conversation, id: "c0ffee00-0000-4000-8000-000000000002", readOnly: false };
    let viewing: typeof shownFirst | null = shownFirst;
    const server = versionsServer({
      [`GET ${APP}`]: () => detail({ viewing, conversations: [kept], lastConversation: kept }),
      [`POST ${VERSIONS}/current`]: () => {
        viewing = null;
        return { viewing };
      },
      [`POST ${APP}/conversations`]: started,
      [`GET ${APP}/conversations/${started.id}/events`]: page({ items: [] }),
    });
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);
    const preview = await screen.findByRole("region", { name: "Live preview" });
    fireEvent.click(await within(preview).findByRole("button", { name: "Restore this version" }));

    await waitFor(() =>
      expect(
        server.calls.some((call) => call.method === "POST" && call.path === `${APP}/conversations`),
      ).toBe(true),
    );
    expect(server.calls.some((call) => call.path.endsWith("/messages"))).toBe(false);
    const sent = server.calls.find((call) => call.method === "POST" && call.path === `${APP}/conversations`)
      ?.body as { text: string };
    expect(sent.text).toContain(`Commit: ${FIRST}`);
  });

  it("waits for the agent's answer before another version can be shown", async () => {
    const server = versionsServer({
      [`GET ${APP}/conversations/${CONVERSATION}/events`]: twoAnswers("running"),
    });
    renderApp("/studio/lovable/cd-studio-preview");
    const first = await card("Change le titre de l'accueil");
    const view = within(first).getByRole("button", { name: "Preview" });
    expect(view.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view);
    fireEvent.click(within(first).getByRole("button", { name: "Restore" }));
    expect(server.calls.some((call) => call.path.startsWith(`${VERSIONS}/`))).toBe(false);
    expect(server.calls.some((call) => call.path.endsWith("/messages"))).toBe(false);
  });
});

describe("the conversation beside the preview", () => {
  it("folds away for the preview to take the whole width, and comes back", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");
    const conversationPane = await screen.findByRole("region", { name: "Conversation" });

    fireEvent.click(screen.getByRole("button", { name: "Hide the conversation" }));
    expect(conversationPane.className).toContain("lg:hidden");
    expect(screen.queryByRole("separator", { name: "Width of the conversation" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}")).toMatchObject({ collapsed: true });

    fireEvent.click(screen.getByRole("button", { name: "Show the conversation" }));
    expect(conversationPane.className).not.toContain("hidden");
    expect(screen.queryByRole("button", { name: "Show the conversation" })).toBeNull();
  });

  it("comes back, folded away as it was left, for an element pointed at in the preview", async () => {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ width: 500, collapsed: true }));
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");
    const conversationPane = await screen.findByRole("region", { name: "Conversation" });
    expect(conversationPane.className).toContain("lg:hidden");

    fromPreview({ type: "ready", path: "/" });
    fromPreview({
      type: "selected",
      element: {
        tag: "h1",
        text: "Bienvenue",
        classes: [],
        attributes: {},
        selector: "h1",
        components: [],
        path: "/",
      },
    });

    await waitFor(() => expect(conversationPane.className).not.toContain("hidden"));
    expect(
      screen.getByRole("separator", { name: "Width of the conversation" }).getAttribute("aria-valuenow"),
    ).toBe("500");
  });

  it("gets wider or narrower from its border with the keyboard, and stays so", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");
    const border = await screen.findByRole("separator", { name: "Width of the conversation" });
    const width = () => border.getAttribute("aria-valuenow");
    expect(width()).toBe("440");

    fireEvent.keyDown(border, { key: "ArrowRight" });
    expect(width()).toBe("456");
    fireEvent.keyDown(border, { key: "ArrowLeft", shiftKey: true });
    expect(width()).toBe("392");
    fireEvent.keyDown(border, { key: "Home" });
    expect(width()).toBe("320");
    fireEvent.keyDown(border, { key: "End" });
    expect(width()).toBe("720");
    expect((border.parentElement as HTMLElement).style.getPropertyValue("--studio-chat-width")).toBe("720px");
    // A double click puts it back where it starts.
    fireEvent.doubleClick(border);
    expect(width()).toBe("440");
    fireEvent.keyDown(border, { key: "ArrowLeft" });
    expect(JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}")).toEqual({ width: 424, collapsed: false });
  });

  it("keeps which conversation a message goes to beside the attachments", async () => {
    installFakeServer(base());
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    const composer = (await screen.findByLabelText("Message to the agent")).closest(
      "form",
    ) as HTMLFormElement;
    expect(within(composer).getByRole("combobox", { name: "Conversation shown" }).textContent).toContain(
      "Titre de la page d'accueil",
    );
    expect(within(composer).getByRole("link", { name: "New conversation" })).toBeTruthy();
    const header = screen
      .getByRole("region", { name: "Conversation" })
      .querySelector("header") as HTMLElement;
    expect(within(header).queryByRole("combobox")).toBeNull();
  });

  it("asks the agent for the texts changed in the preview, the same text once", async () => {
    const server = installFakeServer(
      base({ [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");
    fromPreview({ type: "ready", path: "/" });
    const change = await screen.findByRole("button", { name: "Change a text of the page" });
    await waitFor(() => expect(change.hasAttribute("disabled")).toBe(false));
    fireEvent.click(change);
    expect(change.getAttribute("aria-pressed")).toBe("true");

    const element = {
      tag: "h1",
      text: "Bienvenue",
      classes: [],
      attributes: {},
      selector: "main > h1",
      components: ["Hero"],
      path: "/",
    };
    fromPreview({ type: "text-edited", element, before: "Bienvenue", after: "Bonjour" });
    // Changed again before sending: what it said first, and what it says last.
    fromPreview({ type: "text-edited", element, before: "Bonjour", after: "Bonjour à tous" });
    const edits = await screen.findByRole("list", { name: "Changed texts to send" });
    expect(within(edits).getAllByRole("listitem")).toHaveLength(1);
    expect(within(edits).getByText("Bienvenue")).toBeTruthy();
    expect(within(edits).getByText("Bonjour à tous")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(server.calls.find((call) => call.path.endsWith("/messages"))).toBeTruthy());
    const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as { text: string };
    expect(sent.text).toContain("<text_edit>");
    expect(sent.text).toContain("Selector: main > h1");
    expect(sent.text).toContain("Before: Bienvenue");
    expect(sent.text).toContain("After: Bonjour à tous");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Changed texts to send" })).toBeNull());
  });

  it("still offers the conversations from one kept for reading only", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({
          agentMode: "own",
          agentStatus: "running",
          conversations: [{ ...conversation, readOnly: true }],
        }),
      }),
    );
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    expect(await screen.findByText(/happened with the agent shared by every project/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Conversation shown" })).toBeTruthy();
  });
});

describe("a Studio project", () => {
  it("shows the conversation next to the live preview", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("Change le titre")).toBeTruthy();
    expect(screen.getByText("Qwen3.6-27B")).toBeTruthy();
    expect(screen.getByText("· private network (100.89.0.1)")).toBeTruthy();
    expect(screen.getByText("fait")).toBeTruthy();
    const frame = screen.getByTitle("Live preview of cd-studio-preview");
    expect(frame.getAttribute("src")).toBe("https://lovable-cd-studio-preview.app.example.com");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    // A Studio project takes the whole height: no activity bar under the conversation.
    expect(screen.queryByText("Nothing running")).toBeNull();
  });

  it("folds the steps behind an answer, and opens them on demand", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");

    const steps = await screen.findByRole("button", { name: "1 step · 1 file changed" });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Edited")).toBeNull();
    fireEvent.click(steps);

    expect(steps.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.getByText("src/routes/index.tsx")).toBeTruthy();
    expect(screen.getByText("titre")).toBeTruthy();
  });

  it("shows one pane at a time on a phone, and comes back to the conversation for an element", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");
    const conversationPane = await screen.findByRole("region", { name: "Conversation" });
    const previewPane = screen.getByRole("region", { name: "Live preview" });
    expect(previewPane.className).toContain("hidden lg:flex");

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(conversationPane.className).toContain("hidden lg:flex");
    expect(previewPane.className).not.toContain("hidden");

    const frame = screen.getByTitle("Live preview of cd-studio-preview") as HTMLIFrameElement;
    const fromPreview = (data: Record<string, unknown>) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "opsifier-studio-preview", ...data },
          origin: "https://lovable-cd-studio-preview.app.example.com",
          source: frame.contentWindow,
        }),
      );
    fromPreview({ type: "ready", path: "/" });
    fromPreview({
      type: "selected",
      element: {
        tag: "h1",
        text: "Bienvenue",
        classes: [],
        attributes: {},
        selector: "h1",
        components: [],
        path: "/",
      },
    });
    await waitFor(() => expect(conversationPane.className).not.toContain("hidden"));
  });

  it("shares the project with the member accounts ticked", async () => {
    const server = installFakeServer(
      base({
        "GET /users": {
          users: [
            { ...ACCOUNT, id: "u2", email: "designer@example.com" },
            { ...ACCOUNT, id: "u3", email: "other@example.com" },
            { ...ACCOUNT, id: "u1", email: "admin@example.com", role: "admin" },
          ],
        },
        [`GET ${APP}/members`]: {
          members: [{ userId: "u3", email: "other@example.com", addedAt: "2026-11-15T12:00:00.000Z" }],
        },
        [`PUT ${APP}/members`]: { members: [] },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Share this project" }));
    const accounts = await screen.findByRole("list", { name: "Member accounts" });
    // Administrators see every project: only member accounts are offered.
    expect(within(accounts).queryByText("admin@example.com")).toBeNull();
    expect((within(accounts).getByLabelText("other@example.com") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(accounts).getByLabelText("designer@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "PUT" && call.path === `${APP}/members`)?.body,
      ).toEqual({
        userIds: ["u3", "u2"],
      }),
    );
  });

  it("shows a message as soon as it is sent", async () => {
    let answer: (value: unknown) => void = () => {};
    installFakeServer(
      base({
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");

    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Plus grand" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const log = screen.getByRole("log", { name: "Messages" });
    expect(await within(log).findByText("Plus grand")).toBeTruthy();
    expect(within(log).getByText("Sending…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ajoute un mode sombre" })).toBeNull();
    answer(conversation);
  });

  it("shows what the agent says as it works, and its plan", async () => {
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          status: "running",
          items: [
            {
              kind: "action",
              id: "e9",
              timestamp: "2026-11-15T12:00:09Z",
              tool: "task_tracker",
              verb: "plan",
              summary: "Updated its plan",
              described: false,
              detail: null,
              thought: "Je planifie les modifications.",
              tasks: [
                { title: "Trouver le menu", status: "done" },
                { title: "Arrondir les boutons", status: "in_progress" },
              ],
            },
          ],
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("Je planifie les modifications.")).toBeTruthy();
    const plan = screen.getByRole("list", { name: "The agent's plan" });
    expect(within(plan).getByText("Trouver le menu")).toBeTruthy();
    expect(within(plan).getByText("in progress")).toBeTruthy();
  });

  it("sends a suggestion of the agent in one click", async () => {
    const server = installFakeServer(
      base({ [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Ajoute un mode sombre" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.path.endsWith("/messages"))?.body).toEqual({
        text: "Ajoute un mode sombre",
        images: [],
      }),
    );
  });

  it("joins the element pointed at in the preview to the next message", async () => {
    const server = installFakeServer(
      base({ [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    const frame = (await screen.findByTitle("Live preview of cd-studio-preview")) as HTMLIFrameElement;
    const fromPreview = (data: Record<string, unknown>) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "opsifier-studio-preview", ...data },
          origin: "https://lovable-cd-studio-preview.app.example.com",
          source: frame.contentWindow,
        }),
      );

    expect(screen.getByRole("button", { name: "Point at an element" }).hasAttribute("disabled")).toBe(true);
    fromPreview({ type: "ready", path: "/fr" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Point at an element" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect((screen.getByLabelText("Address of the page shown") as HTMLInputElement).value).toBe("/fr");
    fromPreview({
      type: "selected",
      element: {
        tag: "button",
        text: "Nous contacter",
        classes: ["toolbox"],
        attributes: { "aria-label": "Contact" },
        selector: "aside > button:nth-of-type(2)",
        components: ["Toolbox", "SiteLayout"],
        path: "/fr",
      },
    });
    expect(await screen.findByText("Toolbox <button> « Nous contacter »")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Arrondis-le" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as
        | { text: string }
        | undefined;
      expect(sent?.text).toContain("Arrondis-le");
      expect(sent?.text).toContain('Element: <button class="toolbox"> "Nous contacter"');
      expect(sent?.text).toContain("React components: Toolbox < SiteLayout");
    });
    // The composer lets the element go; the message on its way shows it as a tag.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove this element" })).toBeNull());
  });

  it("shows an element a message pointed at as a tag, not as its block", async () => {
    const text =
      'Arrondis-le\n\n<selected_element>\nPage: /fr\nElement: <button class="toolbox"> "Nous contacter"\nReact components: Toolbox < SiteLayout\nSelector: aside > button\n</selected_element>';
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          items: [
            {
              kind: "message",
              id: "e1",
              timestamp: "2026-11-15T12:00:01Z",
              role: "user",
              text,
              images: [],
              suggestions: [],
            },
          ],
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("Arrondis-le")).toBeTruthy();
    expect(screen.getByText("Toolbox <button> « Nous contacter »")).toBeTruthy();
    expect(screen.queryByText(/selected_element/)).toBeNull();
  });

  it("shows the preview at a phone's width", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Phone" }));

    expect((screen.getByTitle("Live preview of cd-studio-preview") as HTMLIFrameElement).style.width).toBe(
      "390px",
    );
    expect(screen.getByRole("button", { name: "Phone" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("sends a message to the conversation shown, and asks for what follows", async () => {
    const server = installFakeServer(
      base({ [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");

    fireEvent.change(screen.getByLabelText("Message to the agent"), {
      target: { value: "Et le pied de page ?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.path.endsWith("/messages"))?.body).toEqual({
        text: "Et le pied de page ?",
        images: [],
      }),
    );
    await waitFor(() =>
      expect(server.calls.filter((call) => call.path.endsWith("/events")).length).toBeGreaterThan(1),
    );
  });

  it("keeps a file attached to a message in the project's folder, and says where in the message", async () => {
    const attached = {
      path: ".git/opsifier-attachments/0a1b2c3d4e5f6a7b/Tarifs 2027.pdf",
      name: "Tarifs 2027.pdf",
      size: 9,
      type: "application/pdf",
    };
    const names: string[] = [];
    const conversations: (string | null)[] = [];
    const server = installFakeServer(
      base({
        [`POST ${APP}/attachments`]: (_body: unknown, url: URL) => {
          names.push(url.searchParams.get("name") ?? "");
          conversations.push(url.searchParams.get("conversation"));
          return withStatus(201, attached);
        },
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation,
      }),
    );
    const rendered = renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");
    const picker = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.accept).toContain(".pdf");
    expect(picker.accept).toContain(".xlsx");

    fireEvent.change(picker, {
      target: { files: [new File(["%PDF-1.7"], "Tarifs 2027.pdf", { type: "application/pdf" })] },
    });
    const files = await screen.findByRole("list", { name: "Files to send" });
    expect(within(files).getByText("Tarifs 2027.pdf")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to the agent"), {
      target: { value: "Reprends ces tarifs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(server.calls.find((call) => call.path.endsWith("/messages"))).toBeTruthy());
    expect(names).toEqual(["Tarifs 2027.pdf"]);
    // The file goes to the agent server of the conversation shown.
    expect(conversations).toEqual([CONVERSATION]);
    const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as { text: string };
    expect(sent.text).toContain("Reprends ces tarifs");
    expect(sent.text).toContain(`<attached_files>`);
    expect(sent.text).toContain(`- ${JSON.stringify(attached.path)} (application/pdf, 9 B)`);
    // The file went before the message, and leaves the message box with it.
    const order = server.calls.map((call) => call.path);
    expect(order.findIndex((path) => path.endsWith("/attachments"))).toBeLessThan(
      order.findIndex((path) => path.endsWith("/messages")),
    );
    await waitFor(() => expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull());
  });

  it("sends a message again without keeping its files a second time", async () => {
    let attachments = 0;
    let messages = 0;
    const server = installFakeServer(
      base({
        [`POST ${APP}/attachments`]: () => {
          attachments += 1;
          return withStatus(201, {
            path: ".git/opsifier-attachments/0a1b2c3d4e5f6a7b/notes.md",
            name: "notes.md",
            size: 7,
            type: "text/markdown",
          });
        },
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: () => {
          messages += 1;
          return messages === 1
            ? withStatus(503, { error: { code: "studio_agent_unavailable", message: "Unreachable." } })
            : conversation;
        },
      }),
    );
    const rendered = renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");
    const picker = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File(["# Notes"], "notes.md", { type: "text/markdown" })] },
    });
    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Lis mes notes" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(messages).toBe(1));
    // The message and its file are still there to send again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByRole("list", { name: "Files to send" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(messages).toBe(2));
    expect(attachments).toBe(1);
    expect(server.calls.filter((call) => call.path.endsWith("/attachments"))).toHaveLength(1);
  });

  it("says which files a message cannot carry", async () => {
    installFakeServer(base());
    const rendered = renderApp("/studio/lovable/cd-studio-preview");
    await screen.findByText("Change le titre");
    const picker = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(picker, { target: { files: [new File(["MZ"], "setup.exe")] } });

    expect(
      await screen.findByText(
        "setup.exe: attach an image, or a PDF, Word, Excel, PowerPoint, CSV or text file.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull();
  });

  it("ignores an address that names no conversation, and sends to the one shown", async () => {
    const server = installFakeServer(
      base({ [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation }),
    );
    // A link that would turn the next message into a request to another route.
    renderApp(
      "/studio/lovable/cd-studio-preview?c=..%2F..%2F..%2F..%2F..%2F..%2Fprojects%2Fprod%2Fservices%2Fdb%2Fstop%3F",
    );
    await screen.findByText("Change le titre");

    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Bonjour" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.path.endsWith("/messages"))?.path).toBe(
        `${APP}/conversations/${CONVERSATION}/messages`,
      ),
    );
    expect(server.calls.some((call) => call.path.includes("/stop"))).toBe(false);
  });

  it("offers a few first requests for a new conversation", async () => {
    const started = { ...conversation, id: "c0ffee00-0000-4000-8000-000000000004", title: null };
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ conversations: [], lastConversation: null }),
        [`POST ${APP}/conversations`]: started,
        [`GET ${APP}/conversations/${started.id}/events`]: page({
          items: [],
          cursor: null,
          status: "running",
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Make the site pleasant on a phone" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path.endsWith("/conversations"))?.body,
      ).toEqual({
        text: "Make the site pleasant on a phone",
        images: [],
      }),
    );
  });

  it("keeps a conversation of the shared agent server for reading, once the project has its own", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({
          agentMode: "own",
          agentStatus: "running",
          conversations: [{ ...conversation, readOnly: true }],
        }),
      }),
    );
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    expect(await screen.findByText(/happened with the agent shared by every project/)).toBeTruthy();
    expect(screen.queryByLabelText("Message to the agent")).toBeNull();
  });

  it("says the project's agent server is starting while a first message waits for it", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({
          agentMode: "own",
          agentStatus: "stopped",
          conversations: [],
          lastConversation: null,
        }),
        [`POST ${APP}/conversations`]: withStatus(409, {
          error: { code: "studio_agent_starting", message: "The project's agent server is starting." },
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.change(await screen.findByLabelText("Message to the agent"), {
      target: { value: "Ajoute un bouton" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message to the agent"), { key: "Enter" });

    expect(await screen.findByText("The project's agent is starting…")).toBeTruthy();
    expect(
      server.calls.filter((call) => call.method === "POST" && call.path === `${APP}/conversations`).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("starts a new conversation with its first message", async () => {
    const started = { ...conversation, id: "c0ffee00-0000-4000-8000-000000000002", title: null };
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ conversations: [], lastConversation: null }),
        [`POST ${APP}/conversations`]: started,
        [`GET ${APP}/conversations/${started.id}/events`]: page({
          items: [],
          cursor: null,
          status: "running",
        }),
      }),
    );
    const rendered = renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("What should change in cd-studio?")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to the agent"), {
      target: { value: "Ajoute un bouton" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message to the agent"), { key: "Enter" });

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path.endsWith("/conversations"))?.body,
      ).toEqual({
        text: "Ajoute un bouton",
        images: [],
      }),
    );
    await waitFor(() => expect(rendered.router.state.location.search).toEqual({ c: started.id }));
  });

  it("keeps the other conversations one choice away while a new one waits for its first message", async () => {
    installFakeServer(base());
    const rendered = renderApp("/studio/lovable/cd-studio-preview?c=new");

    const picker = await screen.findByRole("combobox", { name: "Conversation shown" });
    expect(picker.textContent).toContain("New conversation");
    expect(screen.queryByText("Change le titre")).toBeNull();
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Titre de la page d'accueil" }));

    await waitFor(() => expect(rendered.router.state.location.search).toEqual({ c: CONVERSATION }));
    expect(await screen.findByText("Change le titre")).toBeTruthy();
  });

  it("shows a conversation from the panel's copy while the project's agent sleeps", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({ agentMode: "own", agentStatus: "stopped" }),
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          status: "idle",
          model: null,
          asleep: true,
        }),
      }),
    );
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    expect(await screen.findByText("Change le titre")).toBeTruthy();
    expect(
      screen.getByText(
        "The project's agent is resting: the conversation shows as it left it. A message wakes it.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Message to the agent")).toBeTruthy();
  });

  it("says nothing of a sleeping agent while it is already starting", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({ agentMode: "own", agentStatus: "starting" }),
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          status: "idle",
          model: null,
          asleep: true,
        }),
      }),
    );
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    expect(await screen.findByText("Change le titre")).toBeTruthy();
    expect(screen.queryByText(/The project's agent is resting/)).toBeNull();
  });

  it("says when a sleeping agent's conversation has no copy to show yet", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({ agentMode: "own", agentStatus: "stopped" }),
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          items: [],
          cursor: null,
          status: "idle",
          model: null,
          asleep: true,
        }),
      }),
    );
    renderApp(`/studio/lovable/cd-studio-preview?c=${CONVERSATION}`);

    expect(
      await screen.findByText(
        "The project's agent is resting: this conversation shows once it wakes. A message wakes it.",
      ),
    ).toBeTruthy();
  });

  it("chooses the model of a new conversation, and says where it runs", async () => {
    const started = { ...conversation, id: "c0ffee00-0000-4000-8000-000000000003", title: null };
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ conversations: [], lastConversation: null }),
        "GET /studio/models": { active: "qwen-rtx", models: [QWEN, CLOUD] },
        [`POST ${APP}/conversations`]: started,
        [`GET ${APP}/conversations/${started.id}/events`]: page({ items: [], cursor: null, model: CLOUD }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("· private network (100.89.0.1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "claude-sonnet-4-5 · outside provider" }));
    expect(await screen.findByText("· outside provider: its provider's address")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "Bonjour" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path.endsWith("/conversations"))?.body,
      ).toEqual({
        text: "Bonjour",
        images: [],
        model: "cloud",
      }),
    );
  });

  it("stops the agent while it works", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({ status: "running" }),
        [`POST ${APP}/conversations/${CONVERSATION}/stop`]: conversation,
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("The agent is working…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(server.calls.some((call) => call.path.endsWith("/stop"))).toBe(true));
  });

  it("leaves a project on pause stopped as it opens, and resumes it on demand", async () => {
    let paused: { at: string; by: string | null } | null = {
      at: "2026-11-20T09:00:00.000Z",
      by: "karim@example.com",
    };
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: () => detail({ paused, previewStatus: "stopped" }),
        [`POST ${APP}/preview/start`]: { started: true, agentStarted: false },
        [`POST ${APP}/resume`]: () => {
          paused = null;
          return { started: true, agentStarted: false };
        },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    const preview = await screen.findByRole("region", { name: "Live preview" });
    expect(await within(preview).findByText("This project is on pause")).toBeTruthy();
    expect(within(preview).getByText(/karim@example.com put it on pause on/)).toBeTruthy();
    // What would be sent waits for the project to be resumed.
    expect(screen.getByText("This project is on pause: resume it to write to the agent.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "Encore" },
    });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();
    // Opening it started nothing.
    expect(server.calls.some((call) => call.path === `${APP}/preview/start`)).toBe(false);

    fireEvent.click(within(preview).getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "POST" && call.path === `${APP}/resume`)).toBe(true),
    );
    await waitFor(() => expect(within(preview).queryByText("This project is on pause")).toBeNull());
    expect(screen.queryByText("This project is on pause: resume it to write to the agent.")).toBeNull();
  });

  it("says in plain words why the agent stopped, and offers a new conversation after its last stop", async () => {
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          status: "error",
          items: [
            ...page().items,
            {
              kind: "error",
              id: "e4",
              timestamp: "2026-11-15T12:10:00Z",
              text: "litellm.Timeout: LLM hard timeout after 300 seconds",
            },
            {
              kind: "message",
              id: "e5",
              timestamp: "2026-11-15T12:20:00Z",
              role: "user",
              text: "Continue",
              images: [],
              suggestions: [],
            },
            {
              kind: "error",
              id: "e6",
              timestamp: "2026-11-15T12:30:00Z",
              text: "litellm.ContextWindowExceededError: maximum context length is 262144 tokens",
            },
          ],
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("The model took too long to answer")).toBeTruthy();
    expect(screen.getByText("The conversation is too long for the model")).toBeTruthy();
    // The error itself is one click away.
    expect(screen.getByText("litellm.Timeout: LLM hard timeout after 300 seconds")).toBeTruthy();
    // Only the last stop offers a new conversation.
    const offers = screen.getAllByRole("link", { name: "Open a new conversation" });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.getAttribute("href")).toBe("/studio/lovable/cd-studio-preview?c=new");
    expect(screen.queryByText(/The agent stopped: litellm/)).toBeNull();
  });

  it("shows any other error as it came", async () => {
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          status: "error",
          items: [
            ...page().items,
            {
              kind: "error",
              id: "e4",
              timestamp: "2026-11-15T12:10:00Z",
              text: "litellm.APIConnectionError: Connection refused",
            },
          ],
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(
      await screen.findByText("The agent stopped: litellm.APIConnectionError: Connection refused"),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open a new conversation" })).toBeNull();
  });

  it("builds a preview that never ran as the project opens, for whoever opens it", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ previewStatus: "undeployed" }),
        [`POST ${APP}/preview/start`]: { started: true, agentStarted: false },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    await waitFor(() =>
      expect(
        server.calls.some((call) => call.method === "POST" && call.path === `${APP}/preview/start`),
      ).toBe(true),
    );
    expect(await screen.findByText("The preview is starting")).toBeTruthy();
  });

  it("says why a preview did not start, and offers to start it again", async () => {
    installFakeServer(
      base({
        [`GET ${APP}`]: detail({ previewStatus: "undeployed" }),
        [`POST ${APP}/preview/start`]: {
          __status: 409,
          body: {
            error: {
              code: "studio_deploy_failed",
              message:
                "lovable/cd-studio-preview could not be deployed: an administrator looks at its last deployment.",
            },
          },
        },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect((await screen.findAllByText(/could not be deployed/)).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: "Start the preview" })).toBeTruthy();
    expect(screen.queryByText("The preview is starting")).toBeNull();
  });

  it("keeps the address being typed while the page moves, and Escape puts the page's back", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");
    const frame = (await screen.findByTitle("Live preview of cd-studio-preview")) as HTMLIFrameElement;
    const fromPreview = (data: Record<string, unknown>) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "opsifier-studio-preview", ...data },
          origin: "https://lovable-cd-studio-preview.app.example.com",
          source: frame.contentWindow,
        }),
      );
    const address = screen.getByRole("textbox", { name: "Address of the page shown" }) as HTMLInputElement;
    fromPreview({ type: "ready", path: "/fr" });
    await waitFor(() => expect(address.value).toBe("/fr"));

    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: "/contact" } });
    fromPreview({ type: "location", path: "/fr/offres" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(address.value).toBe("/contact");

    fireEvent.keyDown(address, { key: "Escape" });
    expect(address.value).toBe("/fr/offres");
  });

  it("starts a stopped preview as the project opens", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ previewStatus: "stopped" }),
        [`POST ${APP}/preview/start`]: { started: true, agentStarted: false },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    // Through the Studio, which lets the accounts a project is shared with start its preview.
    await waitFor(() =>
      expect(
        server.calls.some((call) => call.method === "POST" && call.path === `${APP}/preview/start`),
      ).toBe(true),
    );
    expect(await screen.findByText("The preview is starting")).toBeTruthy();
  });
});

describe("the Studio's settings", () => {
  const settings = {
    enabled: false,
    agent: {
      project: "lovable",
      service: "openhands",
      url: "http://127.0.0.1:18000",
      keyFile: "/home/openhands/.openhands/agent-canvas/api-key.txt",
      projectsDir: null,
    },
    previewSignIn: false,
    agentPerProject: false,
  };

  it("turns on an agent server for each project", async () => {
    const server = installFakeServer(
      base({ "GET /settings/studio": settings, "PUT /settings/studio": settings }),
    );
    renderApp("/settings/server/studio");

    fireEvent.click(await screen.findByRole("switch", { name: "One agent per project" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        (server.calls.find((call) => call.method === "PUT")?.body as typeof settings | undefined)
          ?.agentPerProject,
      ).toBe(true),
    );
  });

  it("adds a GitHub key for an organization, and never shows a token back", async () => {
    const on = { ...settings, enabled: true, agentPerProject: true };
    const key = {
      id: "k1",
      owner: "voidagency",
      createdAt: "2026-11-16T20:00:00Z",
      updatedAt: "2026-11-16T20:00:00Z",
      login: null,
      valid: null,
      expiresAt: null,
      checkedAt: null,
    };
    const server = installFakeServer(
      base({
        "GET /settings/studio": on,
        "GET /studio": { ...(base()["GET /studio"] as object), agentPerProject: true },
        "GET /settings/studio/github-keys": { keys: [] },
        "POST /settings/studio/github-keys": key,
      }),
    );
    renderApp("/settings/server/studio");

    expect(await screen.findByText(/No key yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a key" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Owner"), { target: { value: "voidagency" } });
    fireEvent.change(within(dialog).getByLabelText("Token"), {
      target: { value: "github_pat_11AAAAAAA0voidagency0token" },
    });
    server.set({ "GET /settings/studio/github-keys": { keys: [key] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path === "/settings/studio/github-keys")
          ?.body,
      ).toEqual({
        owner: "voidagency",
        token: "github_pat_11AAAAAAA0voidagency0token",
      }),
    );
    expect(await screen.findByText("voidagency")).toBeTruthy();
    expect(screen.queryByText(/github_pat_/)).toBeNull();
  });

  it("gives the projects still on the shared agent server their own, and says which could not move", async () => {
    const on = { ...settings, enabled: true, agentPerProject: true };
    const server = installFakeServer(
      base({
        "GET /settings/studio": on,
        "GET /studio": {
          enabled: true,
          agentConfigured: true,
          canAddProjects: true,
          agentPerProject: true,
          apps: [app({ agentMode: "missing" })],
        },
        "POST /studio/isolate": {
          isolated: [],
          failed: [{ project: "lovable", service: "cd-studio-preview", message: "Its folder is elsewhere." }],
        },
      }),
    );
    renderApp("/settings/server/studio");

    expect(await screen.findByText(/1 project still works with the shared agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Give each project its own agent" }));

    expect(await screen.findByText("lovable/cd-studio-preview: Its folder is elsewhere.")).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST" && call.path === "/studio/isolate")).toBe(true);
  });

  it("turns the Studio on, keeping its agent server", async () => {
    const server = installFakeServer(
      base({ "GET /settings/studio": settings, "PUT /settings/studio": { ...settings, enabled: true } }),
    );
    renderApp("/settings/server/studio");

    fireEvent.click(await screen.findByRole("switch", { name: "Turn the Studio on" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        ...settings,
        enabled: true,
      }),
    );
  });

  it("keeps where projects go in the agent server's container", async () => {
    const server = installFakeServer(
      base({ "GET /settings/studio": settings, "PUT /settings/studio": settings }),
    );
    renderApp("/settings/server/studio");

    fireEvent.change(await screen.findByLabelText(/Projects folder/), { target: { value: "/projects" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        (server.calls.find((call) => call.method === "PUT")?.body as typeof settings | undefined)?.agent,
      ).toEqual({ ...settings.agent, projectsDir: "/projects" }),
    );
  });

  it("puts the previews behind the panel's sign-in", async () => {
    const server = installFakeServer(
      base({ "GET /settings/studio": settings, "PUT /settings/studio": settings }),
    );
    renderApp("/settings/server/studio");

    fireEvent.click(await screen.findByRole("switch", { name: "Previews behind the panel's sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        (server.calls.find((call) => call.method === "PUT")?.body as typeof settings | undefined)
          ?.previewSignIn,
      ).toBe(true),
    );
  });

  it("checks the connection and says what it found", async () => {
    installFakeServer(
      base({
        "GET /settings/studio": settings,
        "POST /settings/studio/check": {
          reachable: false,
          version: null,
          message: "The agent server refused the panel's key.",
        },
      }),
    );
    renderApp("/settings/server/studio");

    fireEvent.click(await screen.findByRole("button", { name: "Check the connection" }));

    const banner = await screen.findByText(/does not reach the agent server/);
    expect(within(banner).getByText(/refused the panel's key/)).toBeTruthy();
  });
});

const remark = (overrides: Partial<StudioRemark> = {}): StudioRemark => ({
  id: "r2",
  number: 2,
  path: "/comptes",
  element: {
    tag: "button",
    text: "Ouvrir un compte",
    classes: ["btn"],
    attributes: {},
    selector: "main > button.btn",
    components: ["Hero"],
  },
  point: { x: 0.5, y: 0.5 },
  viewport: { width: 390, height: 844 },
  text: "Le bouton devrait être vert, comme dans la charte.",
  screenshot: false,
  author: "Karim Benali · Acme",
  authorKind: "guest",
  status: "new",
  conversationId: null,
  createdAt: "2026-11-15T12:10:00.000Z",
  updatedAt: "2026-11-15T12:10:00.000Z",
  ...overrides,
});
const DONE = remark({ id: "r1", number: 1, status: "done", text: "Le logo est flou", path: "/" });

describe("remarks left on a Studio project's preview", () => {
  // Radix's tabs change on the press of the button, as a browser sends it before the click.
  const openRemarks = async () => fireEvent.mouseDown(await screen.findByRole("tab", { name: /^Remarks/ }));

  it("are listed to do and done, and one handed to the agent goes with the next message", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [remark(), DONE] },
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation,
        [`PATCH ${APP}/remarks/r2`]: remark({ status: "in_progress", conversationId: CONVERSATION }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    // What is being typed waits while the person looks at the remarks.
    fireEvent.change(await screen.findByLabelText("Message to the agent"), {
      target: { value: "Garde le même vert que le logo" },
    });

    await openRemarks();
    expect(await screen.findByText("Le bouton devrait être vert, comme dans la charte.")).toBeTruthy();
    expect(screen.getByText("Karim Benali · Acme · client")).toBeTruthy();
    expect(screen.getByRole("button", { name: "To do · 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Le logo est flou")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hand to the agent" }));
    // Back in the conversation, the remark waits in the composer, next to what was typed.
    expect(await screen.findByText("Remark 2 · /comptes · Phone")).toBeTruthy();
    expect((screen.getByLabelText("Message to the agent") as HTMLTextAreaElement).value).toBe(
      "Garde le même vert que le logo",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as
        | { text: string }
        | undefined;
      expect(sent?.text).toMatch(/^Garde le même vert que le logo\n\n<client_remark>/);
      expect(sent?.text).toContain("<client_remark>\nRemark: 2\nFrom: Karim Benali · Acme\nPage: /comptes");
      expect(sent?.text).toContain("Window: 390 × 844 (mobile)");
      expect(sent?.text).toContain("Text:\nLe bouton devrait être vert, comme dans la charte.");
      expect(sent?.text).toContain('Element: <button class="btn"> "Ouvrir un compte"');
    });
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PATCH")?.body).toEqual({
        status: "in_progress",
        conversationId: CONVERSATION,
      }),
    );
  });

  it("show the screenshot a remark came with, at its size on demand, and hand it to the agent", async () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const shotUrl = `data:image/jpeg;base64,${btoa(String.fromCharCode(...JPEG))}`;
    const server = installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [remark({ screenshot: true }), DONE] },
        [`GET ${APP}/remarks/r2/screenshot`]: () =>
          new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }),
        [`POST ${APP}/conversations/${CONVERSATION}/messages`]: conversation,
        [`PATCH ${APP}/remarks/r2`]: remark({ status: "in_progress", screenshot: true }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    await openRemarks();
    const thumbnail = await screen.findByRole("button", { name: "Show the screenshot of remark 2" });
    const image = (await within(thumbnail).findByRole("img")) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(shotUrl);
    fireEvent.click(thumbnail);
    const dialog = await screen.findByRole("dialog", { name: "Screenshot of remark 2" });
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe(shotUrl);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Hand to the agent" }));
    // The screenshot waits among the message's images, where it can be taken off.
    const images = await screen.findByRole("list", { name: "Images to send" });
    await waitFor(() => expect(within(images).getAllByRole("img")).toHaveLength(1));
    expect(within(images).getByRole("img").getAttribute("src")).toBe(shotUrl);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const sent = server.calls.find((call) => call.path.endsWith("/messages"))?.body as
        | { text: string; images: string[] }
        | undefined;
      expect(sent?.images).toEqual([shotUrl]);
      // The agent is told which image is the client's, inside the remark's block.
      expect(sent?.text).toContain(
        "Window: 390 × 844 (mobile)\nScreenshot: image 1 of this message, taken in the client's browser\nText:",
      );
    });
    // Read once, for the card and the message alike.
    expect(server.calls.filter((call) => call.path.endsWith("/screenshot"))).toHaveLength(1);
  });

  it("take their screenshot back out of the message when they are left out of it", async () => {
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [remark({ screenshot: true })] },
        [`GET ${APP}/remarks/r2/screenshot`]: () =>
          new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    await openRemarks();
    fireEvent.click(await screen.findByRole("button", { name: "Hand to the agent" }));
    const images = await screen.findByRole("list", { name: "Images to send" });
    await waitFor(() => expect(within(images).getAllByRole("img")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Leave this remark out" }));

    await waitFor(() => expect(screen.queryByRole("list", { name: "Images to send" })).toBeNull());
  });

  it("ask for no screenshot when they came without one", async () => {
    const server = installFakeServer(base({ [`GET ${APP}/remarks`]: { remarks: [remark()] } }));
    renderApp("/studio/lovable/cd-studio-preview");

    await openRemarks();
    expect(await screen.findByText("Le bouton devrait être vert, comme dans la charte.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hand to the agent" }));
    expect(await screen.findByText("Remark 2 · /comptes · Phone")).toBeTruthy();

    expect(screen.queryByRole("button", { name: /^Show the screenshot/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Images to send" })).toBeNull();
    expect(server.calls.some((call) => call.path.endsWith("/screenshot"))).toBe(false);
  });

  it("are marked done, and shown on the preview when picked", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [remark(), DONE] },
        [`PATCH ${APP}/remarks/r2`]: remark({ status: "done" }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");
    const frame = (await screen.findByTitle("Live preview of cd-studio-preview")) as HTMLIFrameElement;
    const told: unknown[] = [];
    const contentWindow = frame.contentWindow as Window;
    contentWindow.postMessage = ((message: unknown) =>
      told.push(message)) as typeof contentWindow.postMessage;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "opsifier-studio-preview", type: "ready", path: "/" },
        origin: "https://lovable-cd-studio-preview.app.example.com",
        source: frame.contentWindow,
      }),
    );

    await openRemarks();
    // The remarks to do are pinned on the page.
    await waitFor(() =>
      expect(told).toContainEqual(
        expect.objectContaining({
          type: "remarks",
          items: [expect.objectContaining({ id: "r2", number: 2, selector: "main > button.btn" })],
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show remark 2 on the preview" }));
    // Its page is not the one shown: the preview goes there first.
    await waitFor(() =>
      expect(
        (screen.getByTitle("Live preview of cd-studio-preview") as HTMLIFrameElement).getAttribute("src"),
      ).toBe("https://lovable-cd-studio-preview.app.example.com/comptes"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PATCH")?.body).toEqual({ status: "done" }),
    );
  });

  it("follow a pin clicked on the preview back to the list", async () => {
    installFakeServer(base({ [`GET ${APP}/remarks`]: { remarks: [remark()] } }));
    renderApp("/studio/lovable/cd-studio-preview");
    const frame = (await screen.findByTitle("Live preview of cd-studio-preview")) as HTMLIFrameElement;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "opsifier-studio-preview", type: "remark", id: "r2" },
        origin: "https://lovable-cd-studio-preview.app.example.com",
        source: frame.contentWindow,
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^Remarks/ }).getAttribute("aria-selected")).toBe("true"),
    );
    expect(await screen.findByText("Le bouton devrait être vert, comme dans la charte.")).toBeTruthy();
  });

  it("come from a link made for a client, whose address is shown once", async () => {
    const made = {
      id: "l1",
      label: "Karim Benali · Acme",
      remarks: true,
      remarkCount: 0,
      createdBy: "admin@example.com",
      createdAt: "2026-11-15T12:00:00.000Z",
      expiresAt: "2026-12-15T12:00:00.000Z",
      lastUsedAt: null,
      expired: false,
      url: "https://lovable-cd-studio-preview.app.example.com/__opsifier/studio/link/abcdefghijklmnopqrstuvwxyz012345",
    };
    const server = installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [] },
        [`GET ${APP}/links`]: { links: [] },
        [`POST ${APP}/links`]: made,
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    await openRemarks();
    expect(await screen.findByText("No remark yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Client links" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Who it is for/), {
      target: { value: "Karim Benali · Acme" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "7 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a client link" }));

    await waitFor(() =>
      expect(
        server.calls.find((call) => call.method === "POST" && call.path === `${APP}/links`)?.body,
      ).toEqual({
        label: "Karim Benali · Acme",
        remarks: true,
        days: 7,
      }),
    );
    expect(((await within(dialog).findByLabelText("The link's address")) as HTMLInputElement).value).toBe(
      made.url,
    );
  });

  it("come from a link a designer shares from the preview itself", async () => {
    installFakeServer(base({ [`GET ${APP}/remarks`]: { remarks: [] }, [`GET ${APP}/links`]: { links: [] } }));
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Share with a client" }));

    expect(await screen.findByRole("dialog", { name: "Links for your clients" })).toBeTruthy();
  });

  it("go with their link when the designer says so", async () => {
    const link = {
      id: "l1",
      label: "Karim Benali · Acme",
      remarks: true,
      remarkCount: 2,
      createdBy: "admin@example.com",
      createdAt: "2026-11-15T12:00:00.000Z",
      expiresAt: null,
      lastUsedAt: "2026-11-15T13:00:00.000Z",
      expired: false,
    };
    let asked = "";
    installFakeServer(
      base({
        [`GET ${APP}/remarks`]: { remarks: [] },
        [`GET ${APP}/links`]: { links: [link] },
        [`DELETE ${APP}/links/l1`]: (_body: unknown, url: URL) => {
          asked = url.search;
          return { id: "l1" };
        },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    fireEvent.click(await screen.findByRole("button", { name: "Share with a client" }));
    const dialog = await screen.findByRole("dialog", { name: "Links for your clients" });
    expect(await within(dialog).findByText(/2 remarks/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Take back" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Take back the link for Karim Benali · Acme?",
    });
    fireEvent.click(within(confirm).getByLabelText("Also delete the 2 remarks written through this link"));
    fireEvent.click(within(confirm).getByRole("button", { name: "Take back" }));

    await waitFor(() => expect(asked).toBe("?remarks=delete"));
  });

  it("show as a tag in the conversation once handed to the agent", async () => {
    const text =
      "<client_remark>\nRemark: 2\nFrom: Karim Benali · Acme\nPage: /comptes\nWindow: 390 × 844 (mobile)\nText:\nLe bouton devrait être vert.\n</client_remark>";
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
          items: [
            {
              kind: "message",
              id: "e1",
              timestamp: "2026-11-15T12:00:01Z",
              role: "user",
              text,
              images: [],
              suggestions: [],
            },
          ],
        }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("Remark 2 · /comptes · Phone")).toBeTruthy();
    expect(screen.getByText("Le bouton devrait être vert.")).toBeTruthy();
    expect(screen.queryByText(/client_remark/)).toBeNull();
  });
});

describe("a project brought up to date with GitHub when it opens", () => {
  /** A project with an agent server of its own, which alone brings its folder up to date. */
  const own = (extra: FakeRoute = {}) => base({ [`GET ${APP}`]: detail({ agentMode: "own" }), ...extra });
  const syncs = (server: { calls: Array<{ method: string; path: string }> }) =>
    server.calls.filter((call) => call.method === "POST" && call.path === `${APP}/sync`).length;

  it("asks for GitHub's changes once as it opens, and says what came in", async () => {
    const forced: Array<string | null> = [];
    const server = installFakeServer(
      own({
        [`POST ${APP}/sync`]: (_body: unknown, url: URL) => {
          forced.push(url.searchParams.get("force"));
          return synced({ state: "updated", pulled: 3 });
        },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("3 changes brought in from GitHub (main).")).toBeTruthy();
    expect(syncs(server)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide this message" }));
    expect(screen.queryByText("3 changes brought in from GitHub (main).")).toBeNull();

    // And again whenever someone asks, asking GitHub anew.
    fireEvent.click(screen.getByRole("button", { name: "Bring in the changes on GitHub" }));
    await waitFor(() => expect(syncs(server)).toBe(2));
    expect(forced).toEqual([null, "true"]);
  });

  it("asks again, by itself, while the project's agent server starts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = installFakeServer(
        own({ [`POST ${APP}/sync`]: synced({ state: "unavailable", reason: "agent_starting" }) }),
      );
      renderApp("/studio/lovable/cd-studio-preview");

      expect(
        await screen.findByText(
          "The project's agent server is starting: the changes on GitHub come in a moment.",
        ),
      ).toBeTruthy();
      server.set({ [`POST ${APP}/sync`]: synced({ state: "updated", pulled: 2 }) });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await screen.findByText("2 changes brought in from GitHub (main).")).toBeTruthy();
      expect(syncs(server)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking once the page is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The answer comes once the page is gone.
      let answer: (value: unknown) => void = () => {};
      const server = installFakeServer(
        own({
          [`POST ${APP}/sync`]: () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        }),
      );
      const view = renderApp("/studio/lovable/cd-studio-preview");
      await waitFor(() => expect(syncs(server)).toBe(1));

      view.unmount();
      answer(synced({ state: "unavailable", reason: "agent_starting" }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(syncs(server)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when the agent is at work, and leaves its folder be", async () => {
    installFakeServer(own({ [`POST ${APP}/sync`]: synced({ state: "deferred", behind: 3 }) }));
    renderApp("/studio/lovable/cd-studio-preview");

    expect(
      await screen.findByText(
        "The agent is at work: GitHub's 3 new changes come in at its next request, or when the project opens again.",
      ),
    ).toBeTruthy();
  });

  it("says nothing when the folder is up to date", async () => {
    const server = installFakeServer(own());
    renderApp("/studio/lovable/cd-studio-preview");

    await waitFor(() => expect(syncs(server)).toBe(1));
    expect(await screen.findByLabelText("Message to the agent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide this message" })).toBeNull();
  });

  it("says when changes made here keep GitHub's out, and which files", async () => {
    installFakeServer(
      own({
        [`POST ${APP}/sync`]: synced({ state: "blocked", behind: 2, changed: 1, blocking: ["src/App.tsx"] }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(
      await screen.findByText(
        "GitHub has 2 changes this folder does not, but files made here are in the way (src/App.tsx). The agent brings them together at its next request.",
      ),
    ).toBeTruthy();
  });

  it("waits for the preview when the changes bring new packages", async () => {
    installFakeServer(
      own({
        [`POST ${APP}/sync`]: synced({ state: "updated", pulled: 1, previewRestarted: true }),
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    expect(
      await screen.findByText(
        "1 change brought in from GitHub (main). The preview starts again to install the new packages.",
      ),
    ).toBeTruthy();
  });

  it("says why GitHub could not be asked", async () => {
    installFakeServer(own({ [`POST ${APP}/sync`]: synced({ state: "unavailable", reason: "no_access" }) }));
    renderApp("/studio/lovable/cd-studio-preview");

    expect(
      await screen.findByText(
        "GitHub refuses the Studio access to this repository: an administrator checks the Studio's access to GitHub.",
      ),
    ).toBeTruthy();
  });

  it("asks nothing for a project on the shared agent server, and shows no button for it", async () => {
    const server = installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByLabelText("Message to the agent")).toBeTruthy();
    expect(syncs(server)).toBe(0);
    expect(screen.queryByRole("button", { name: "Bring in the changes on GitHub" })).toBeNull();
  });
});
