// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { StudioApp, StudioAppDetail, StudioEventPage } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  ...overrides,
});

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [] },
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

    expect(await screen.findByText(/does not reach this repository/)).toBeTruthy();
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
    expect(server.calls.filter((call) => call.method === "POST").length).toBeGreaterThanOrEqual(1);
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
              message: "lovable/cd-studio-preview could not be deployed: an administrator looks at its last deployment.",
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
