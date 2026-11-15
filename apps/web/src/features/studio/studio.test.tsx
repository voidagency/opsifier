// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { StudioApp, StudioAppDetail, StudioEventPage } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeRoute, installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../testing/appHarness";

afterEach(resetApp);

const APP = "/projects/lovable/services/cd-studio-preview/studio";
const CONVERSATION = "c0ffee00-0000-4000-8000-000000000001";

const conversation = {
  id: CONVERSATION,
  title: "Titre de la page d'accueil",
  createdBy: "admin@example.com",
  createdAt: "2026-11-15T12:00:00.000Z",
  updatedAt: "2026-11-15T12:05:00.000Z",
};

const app = (overrides: Partial<StudioApp> = {}): StudioApp => ({
  project: "lovable",
  service: "cd-studio-preview",
  workspaceDir: "/projects/cd-studio",
  previewUrl: "https://lovable-cd-studio-preview.app.example.com",
  previewStatus: "running",
  lastConversation: conversation,
  ...overrides,
});

const detail = (overrides: Partial<StudioAppDetail> = {}): StudioAppDetail => ({
  ...app(),
  conversations: [conversation],
  ...overrides,
});

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
  "GET /studio": { enabled: true, agentConfigured: true, apps: [app()] },
  [`GET ${APP}`]: detail(),
  [`GET ${APP}/conversations/${CONVERSATION}/events`]: page(),
  "GET /studio/models": { active: "qwen-rtx", models: [QWEN] },
  ...extra,
});

describe("the Studio's list", () => {
  it("shows the linked projects and opens one", async () => {
    installFakeServer(base());
    const rendered = renderApp("/studio");

    const open = await screen.findByRole("link", { name: "Open cd-studio-preview in the Studio" });
    expect(screen.getByText(/Titre de la page d'accueil/)).toBeTruthy();
    fireEvent.click(open);

    await waitFor(() => expect(rendered.location()).toBe("/studio/lovable/cd-studio-preview"));
  });

  it("says how to turn it on while it is off", async () => {
    installFakeServer(base({ "GET /studio": { enabled: false, agentConfigured: false, apps: [] } }));
    renderApp("/studio");

    expect(await screen.findByText("The Studio is turned off")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Studio settings" }).getAttribute("href")).toBe(
      "/settings/server/studio",
    );
  });

  it("is in the bar for administrators only", async () => {
    installFakeServer(
      base({ "GET /auth/session": { status: "signed-in", user: { ...SIGNED_IN.user, role: "member" } } }),
    );
    renderApp("/studio");

    expect(await screen.findByText("For the server's administrators")).toBeTruthy();
    expect(screen.queryAllByRole("link", { name: "Studio" })).toEqual([]);
  });
});

describe("a Studio project", () => {
  it("shows the conversation next to the live preview", async () => {
    installFakeServer(base());
    renderApp("/studio/lovable/cd-studio-preview");

    expect(await screen.findByText("Change le titre")).toBeTruthy();
    expect(screen.getByText("Edited")).toBeTruthy();
    expect(screen.getByText("src/routes/index.tsx")).toBeTruthy();
    expect(screen.getByText("Qwen3.6-27B")).toBeTruthy();
    expect(screen.getByText("· private network (100.89.0.1)")).toBeTruthy();
    expect(screen.getByText("fait")).toBeTruthy();
    const frame = screen.getByTitle("Live preview of cd-studio-preview");
    expect(frame.getAttribute("src")).toBe("https://lovable-cd-studio-preview.app.example.com");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("shows what the agent says as it works, and its plan", async () => {
    installFakeServer(
      base({
        [`GET ${APP}/conversations/${CONVERSATION}/events`]: page({
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
    await waitFor(() => expect(screen.queryByText("Toolbox <button> « Nous contacter »")).toBeNull());
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

    expect(await screen.findByText("What should change in cd-studio-preview?")).toBeTruthy();
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

  it("starts a stopped preview as the project opens", async () => {
    const server = installFakeServer(
      base({
        [`GET ${APP}`]: detail({ previewStatus: "stopped" }),
        "POST /projects/lovable/services/cd-studio-preview/start": {
          id: "a1",
          type: "service.start",
          title: "Start",
          status: "queued",
        },
      }),
    );
    renderApp("/studio/lovable/cd-studio-preview");

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "POST" && call.path.endsWith("/start"))).toBe(true),
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
    },
  };

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
