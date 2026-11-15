import type {
  ActionEntry,
  ActionPage,
  StudioAppDetail,
  StudioCheck,
  StudioConversation,
  StudioEventPage,
  StudioModels,
  StudioOverview,
  StudioSettings,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });

const PREVIEW = "/projects/lovable/services/cd-studio-preview";
const AGENT = {
  project: "lovable",
  service: "openhands",
  url: "http://127.0.0.1:18000",
  keyFile: "/home/openhands/.openhands/agent-canvas/api-key.txt",
};

type Raw = Record<string, unknown>;
interface AgentCall {
  method: string;
  path: string;
  body?: unknown;
}
interface FakeConversation {
  id: string;
  title: string | null;
  status: string;
  events: Raw[];
  started: Raw;
  sent: unknown[];
}

const PROFILES = [
  { name: "qwen-rtx", model: "openai/Qwen/Qwen3.6-27B", base_url: "http://100.89.0.1:8000/v1" },
  { name: "cloud", model: "anthropic/claude-sonnet-4-5", base_url: null },
];

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const at = () => new Date(Date.UTC(2026, 10, 15, 12, 0, sequence)).toISOString();

const messageEvent = (source: "user" | "agent", content: unknown[]): Raw => ({
  id: nextId("e0000000"),
  timestamp: at(),
  kind: "MessageEvent",
  source,
  llm_message: { role: source === "agent" ? "assistant" : "user", content },
});
const actionEvent = (tool: string, action: Raw, summary?: string): Raw => ({
  id: nextId("e0000000"),
  timestamp: at(),
  kind: "ActionEvent",
  source: "agent",
  tool_name: tool,
  action,
  summary,
});

/**
 * Plays the OpenHands agent server inside its container: what the panel's script would get from
 * 127.0.0.1, with event pages that start at the event they are given, as the real one's do.
 */
function installFakeAgent() {
  const agent = {
    calls: [] as AgentCall[],
    inputs: [] as string[],
    conversations: new Map<string, FakeConversation>(),
  };
  const ok = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });

  const answer = (call: AgentCall): { status: number; text: string } => {
    const url = new URL(call.path, "http://127.0.0.1:18000");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/server_info") {
      return ok({ title: "OpenHands Agent Server", version: "1.62.0" });
    }
    if (url.pathname === "/api/agent-profiles") {
      return ok({ profiles: [{ id: "profile-1", name: "default" }], active_agent_profile_id: "profile-1" });
    }
    if (url.pathname === "/api/profiles") {
      return ok({ active_profile: "qwen-rtx", profiles: PROFILES });
    }
    if (url.pathname === "/api/settings/secrets") {
      return ok({ secrets: [{ name: "GITHUB_TOKEN", description: null }] });
    }
    if (call.method === "POST" && url.pathname === "/api/conversations") {
      const id = nextId("c0ffee00");
      const started = call.body as Raw;
      const initial = started.initial_message as { content: unknown[] };
      agent.conversations.set(id, {
        id,
        title: null,
        status: "running",
        events: [
          { id: nextId("e0000000"), timestamp: at(), kind: "SystemPromptEvent" },
          messageEvent("user", initial.content),
        ],
        started,
        sent: [],
      });
      return ok({ id, title: null, execution_status: "running" }, 201);
    }
    const conversation = parts[1] === "conversations" ? agent.conversations.get(parts[2] ?? "") : undefined;
    if (conversation === undefined) {
      return ok({ detail: "Not Found" }, 404);
    }
    if (call.method === "GET" && parts.length === 3) {
      // The script keeps these fields of a conversation, the shape the panel asks for.
      const profile =
        PROFILES.find(
          (one) => one.name === (conversation.started.agent_launch_additions as Raw).llm_profile_ref,
        ) ?? PROFILES[0];
      return ok({
        id: conversation.id,
        title: conversation.title,
        execution_status: conversation.status,
        llm: { model: profile?.model, base_url: profile?.base_url },
      });
    }
    if (call.method === "GET" && parts[3] === "events" && parts[4] === "search") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const pageId = url.searchParams.get("page_id");
      const start = pageId === null ? 0 : conversation.events.findIndex((event) => event.id === pageId);
      return ok({
        items: conversation.events.slice(start, start + limit),
        next_page_id: conversation.events[start + limit]?.id ?? null,
      });
    }
    if (call.method === "POST" && parts[3] === "events") {
      const body = call.body as { content: unknown[] };
      conversation.sent.push(call.body);
      conversation.events.push(messageEvent("user", body.content));
      conversation.status = "running";
      return ok({ success: true });
    }
    if (call.method === "POST" && parts[3] === "pause") {
      conversation.status = "paused";
      return ok({ success: true });
    }
    return ok({ detail: "Not Found" }, 404);
  };

  context.docker.execHandler = (options) => {
    if (options.service !== "lovable_openhands" || options.command[0] !== "python3") {
      return undefined;
    }
    return (input: string) => {
      agent.inputs.push(input);
      const request = JSON.parse(input) as { calls: AgentCall[] };
      const answers = request.calls.map((one) => {
        agent.calls.push(one);
        return answer(one);
      });
      // As the script prints it: base64, in lines short enough for Docker's output to keep whole.
      const encoded = Buffer.from(JSON.stringify({ keyFound: true, answers })).toString("base64");
      const pieces = encoded.match(/.{1,30000}/g) ?? [];
      return {
        output: `${pieces.map((piece) => `opsifier-studio ${piece}\n`).join("")}opsifier-ok\n`,
        exitCode: 0,
      };
    };
  };
  return agent;
}

async function run(path: string, method = "POST", body?: unknown): Promise<void> {
  const accepted = await api<ActionEntry>(path, method, body);
  expect(accepted.status).toBe(202);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body: action } = await api<ActionEntry>(`/actions/${accepted.body.id}`);
    if (action.status !== "queued" && action.status !== "running") {
      expect(action.status).toBe("succeeded");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function deployAgent(): Promise<void> {
  await api("/projects/lovable/services/openhands/source", "PUT", {
    image: "ghcr.io/openhands/agent-canvas:1.40.0",
  });
  await run("/projects/lovable/services/openhands/deploy");
}

const enable = (agent: typeof AGENT | null = AGENT, enabled = true) =>
  api<StudioSettings>("/settings/studio", "PUT", { enabled, agent });
const link = () => api<StudioAppDetail>(`${PREVIEW}/studio`, "PUT", { workspaceDir: "/projects/cd-studio" });
const start = (text: string, images: string[] = []) =>
  api<StudioConversation>(`${PREVIEW}/studio/conversations`, "POST", { text, images });
const events = (id: string, after?: string) =>
  api<StudioEventPage>(
    `${PREVIEW}/studio/conversations/${id}/events${after === undefined ? "" : `?after=${after}`}`,
  );

beforeEach(async () => {
  sequence = 0;
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "lovable" });
  await api("/projects/lovable/services", "POST", { name: "openhands" });
  await api("/projects/lovable/services", "POST", { name: "cd-studio-preview" });
});

afterEach(async () => {
  await context.close();
});

describe("the Studio's settings", () => {
  it("are off until an administrator turns them on, and hold no secret", async () => {
    expect((await api<StudioSettings>("/settings/studio")).body).toEqual({ enabled: false, agent: null });

    const saved = await enable();

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ enabled: true, agent: AGENT });
    expect((await api<StudioSettings>("/settings/studio")).body).toEqual({ enabled: true, agent: AGENT });
    const actions = await api<ActionPage>("/actions?limit=20");
    expect(actions.body.items.some((action) => action.type === "studio.settings")).toBe(true);
  });

  it("refuse an agent server on a service that does not exist, or reached anywhere but in its container", async () => {
    const unknown = await enable({ ...AGENT, service: "nope" });
    expect(unknown.status).toBe(400);
    expect(apiErrorOf(unknown).code).toBe("studio_agent_unknown");

    const elsewhere = await enable({ ...AGENT, url: "http://10.0.0.5:18000" });
    expect(elsewhere.status).toBe(400);
  });

  it("check the agent server from inside its container, without the panel ever holding its key", async () => {
    await deployAgent();
    const agent = installFakeAgent();
    await enable();

    const check = await api<StudioCheck>("/settings/studio/check", "POST");

    expect(check.body).toEqual({ reachable: true, version: "1.62.0", message: null });
    const sent = JSON.parse(agent.inputs[0] ?? "{}") as Record<string, unknown>;
    expect(sent.url).toBe(AGENT.url);
    expect(sent.keyFile).toBe(AGENT.keyFile);
    expect(Object.keys(sent).sort()).toEqual(["calls", "keyFile", "placeholder", "url"]);
  });

  it("say so when the agent server's service is not running", async () => {
    await enable();

    const check = await api<StudioCheck>("/settings/studio/check", "POST");

    expect(check.body.reachable).toBe(false);
    expect(check.body.message).toMatch(/not running/);
  });
});

describe("the Studio's projects", () => {
  it("lists a linked preview with its folder, and its status", async () => {
    await enable();

    const linked = await link();

    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({
      project: "lovable",
      service: "cd-studio-preview",
      workspaceDir: "/projects/cd-studio",
      lastConversation: null,
      conversations: [],
    });
    const overview = await api<StudioOverview>("/studio");
    expect(overview.body.enabled).toBe(true);
    expect(overview.body.agentConfigured).toBe(true);
    expect(overview.body.apps.map((app) => [app.service, app.previewStatus])).toEqual([
      ["cd-studio-preview", "undeployed"],
    ]);
  });

  it("goes with its service, conversations included", async () => {
    await deployAgent();
    installFakeAgent();
    await enable();
    await link();
    await start("Bonjour");

    await run(PREVIEW, "DELETE", { confirm: "cd-studio-preview" });

    expect((await api<StudioOverview>("/studio")).body.apps).toEqual([]);
    expect((await api(`${PREVIEW}/studio`)).status).toBe(404);
  });

  it("can be taken out of the Studio without touching the service", async () => {
    await link();

    expect((await api(`${PREVIEW}/studio`, "DELETE")).body).toEqual({
      project: "lovable",
      service: "cd-studio-preview",
    });
    expect((await api(`${PREVIEW}/studio`)).status).toBe(404);
    expect((await api(PREVIEW)).status).toBe(200);
  });

  it("is for the server's administrators for now, as one agent works on every project", async () => {
    await enable();
    await link();
    const member = await signInMember(context.app, cookie, "op@example.com", [
      { project: "lovable", role: "operator" },
    ]);

    expect((await api("/studio", "GET", undefined, member)).status).toBe(403);
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, member)).status).toBe(403);
    expect((await api(`${PREVIEW}/studio/conversations`, "POST", { text: "hi" }, member)).status).toBe(403);
    expect((await api("/settings/studio", "GET", undefined, member)).status).toBe(403);
  });
});

describe("a Studio conversation", () => {
  beforeEach(async () => {
    await deployAgent();
    await enable();
    await link();
  });

  it("starts on the project's folder the way the agent server's own interface does", async () => {
    const agent = installFakeAgent();
    const image = "data:image/png;base64,iVBORw0KGgo=";

    const started = await start("Change le titre de la page d'accueil", [image]);

    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ createdBy: "admin@example.com", title: null });
    const conversation = agent.conversations.get(started.body.id);
    expect(conversation?.started).toMatchObject({
      agent_profile_id: "profile-1",
      workspace: { working_dir: "/projects/cd-studio", kind: "LocalWorkspace" },
      initial_message: {
        role: "user",
        run: true,
        content: [
          { type: "text", text: "Change le titre de la page d'accueil" },
          { type: "image", image_urls: [image] },
        ],
      },
      // The key is put in place inside the container: the panel only ever sends a stand-in.
      secrets: {
        GITHUB_TOKEN: {
          kind: "LookupSecret",
          url: "/api/settings/secrets/GITHUB_TOKEN",
          headers: { "X-Session-API-Key": "__OPSIFIER_AGENT_KEY__" },
        },
      },
    });
    const additions = conversation?.started.agent_launch_additions as Record<string, string> | undefined;
    expect(additions?.system_message_suffix_append).toContain("Opsifier Studio");
    const detail = await api<StudioAppDetail>(`${PREVIEW}/studio`);
    expect(detail.body.conversations.map((one) => one.id)).toEqual([started.body.id]);
    const actions = await api<ActionPage>("/actions?limit=20");
    expect(actions.body.items.some((action) => action.type === "studio.conversation")).toBe(true);
  });

  it("lists the agent server's models, and says which keep what they are sent on private addresses", async () => {
    installFakeAgent();

    const models = await api<StudioModels>("/studio/models");

    expect(models.body).toEqual({
      active: "qwen-rtx",
      models: [
        { profile: "qwen-rtx", name: "Qwen3.6-27B", host: "100.89.0.1", private: true },
        { profile: "cloud", name: "claude-sonnet-4-5", host: null, private: false },
      ],
    });
  });

  it("starts a conversation with the model chosen, and says which one it works with", async () => {
    const agent = installFakeAgent();

    const started = await api<StudioConversation>(`${PREVIEW}/studio/conversations`, "POST", {
      text: "Bonjour",
      model: "cloud",
    });

    expect(started.status).toBe(201);
    const additions = agent.conversations.get(started.body.id)?.started.agent_launch_additions as Raw;
    expect(additions.llm_profile_ref).toBe("cloud");
    expect((await events(started.body.id)).body.model).toEqual({
      profile: "cloud",
      name: "claude-sonnet-4-5",
      host: null,
      private: false,
    });
  });

  it("refuses a model the agent server does not have", async () => {
    installFakeAgent();

    const refused = await api(`${PREVIEW}/studio/conversations`, "POST", { text: "Bonjour", model: "nope" });

    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).code).toBe("studio_model_unknown");
  });

  it("shows what a person reads, and picks up after the last event it gave", async () => {
    const agent = installFakeAgent();
    const { body: started } = await start("Change le titre");
    const conversation = agent.conversations.get(started.id) as FakeConversation;
    conversation.events.push(
      actionEvent(
        "terminal",
        { kind: "TerminalAction", command: "grep -rn 'Accueil' src" },
        "Cherche le titre",
      ),
      {
        id: nextId("e0000000"),
        timestamp: at(),
        kind: "ObservationEvent",
        observation: { content: "src/routes/index.tsx" },
      },
      actionEvent("file_editor", {
        kind: "FileEditorAction",
        command: "str_replace",
        path: "/projects/cd-studio/src/routes/index.tsx",
      }),
    );
    conversation.title = "Titre de la page d'accueil";

    const first = await events(started.id);

    expect(first.body.items.map((item) => [item.kind, "text" in item ? item.text : item.summary])).toEqual([
      ["message", "Change le titre"],
      ["action", "Cherche le titre"],
      ["action", "Edited a file"],
    ]);
    expect(first.body.status).toBe("running");
    expect(first.body.title).toBe("Titre de la page d'accueil");
    expect(first.body.model).toEqual({
      profile: "qwen-rtx",
      name: "Qwen3.6-27B",
      host: "100.89.0.1",
      private: true,
    });
    expect(first.body.items[2]).toMatchObject({
      verb: "edit",
      described: false,
      detail: "src/routes/index.tsx",
    });
    expect(first.body.cursor).toBe(conversation.events.at(-1)?.id);

    conversation.events.push(
      actionEvent("finish", { kind: "FinishAction", message: "C'est fait : le titre est changé." }),
    );
    conversation.status = "finished";
    const next = await events(started.id, first.body.cursor ?? undefined);

    expect(next.body.items).toEqual([
      expect.objectContaining({ kind: "message", role: "agent", text: "C'est fait : le titre est changé." }),
    ]);
    expect(next.body.status).toBe("finished");
    const idle = await events(started.id, next.body.cursor ?? undefined);
    expect(idle.body.items).toEqual([]);
    expect(idle.body.cursor).toBe(next.body.cursor);
    const detail = await api<StudioAppDetail>(`${PREVIEW}/studio`);
    expect(detail.body.conversations[0]?.title).toBe("Titre de la page d'accueil");
  });

  it("says when more events are waiting, so that a long conversation reopens at once", async () => {
    const agent = installFakeAgent();
    const { body: started } = await start("Bonjour");
    const conversation = agent.conversations.get(started.id) as FakeConversation;
    for (let index = 0; index < 120; index += 1) {
      conversation.events.push(actionEvent("terminal", { command: `echo ${index}` }));
    }

    const first = await events(started.id);
    const second = await events(started.id, first.body.cursor ?? undefined);

    expect(first.body.more).toBe(true);
    expect(second.body.more).toBe(false);
    expect(first.body.items.length + second.body.items.length).toBe(121);
  });

  it("sends messages and stops the agent where it is", async () => {
    const agent = installFakeAgent();
    const { body: started } = await start("Bonjour");

    const sent = await api<StudioConversation>(
      `${PREVIEW}/studio/conversations/${started.id}/messages`,
      "POST",
      {
        text: "Et le pied de page ?",
      },
    );
    const stopped = await api<StudioConversation>(
      `${PREVIEW}/studio/conversations/${started.id}/stop`,
      "POST",
    );

    expect(sent.status).toBe(200);
    expect(stopped.status).toBe(200);
    const conversation = agent.conversations.get(started.id);
    expect(conversation?.sent).toEqual([
      { role: "user", content: [{ type: "text", text: "Et le pied de page ?" }], run: true },
    ]);
    expect(conversation?.status).toBe("paused");
    expect((await events(started.id)).body.status).toBe("paused");
  });

  it("answers 404 for a conversation of another project or one it never started", async () => {
    installFakeAgent();
    await api("/projects/lovable/services", "POST", { name: "other-preview" });
    await api("/projects/lovable/services/other-preview/studio", "PUT", { workspaceDir: "/projects/other" });
    const { body: started } = await start("Bonjour");

    expect(
      (await api(`/projects/lovable/services/other-preview/studio/conversations/${started.id}/events`))
        .status,
    ).toBe(404);
    expect((await events("c0ffee00-0000-4000-8000-999999999999")).status).toBe(404);
  });

  it("refuses an empty message, and anything that is not an image", async () => {
    installFakeAgent();

    expect((await start("   ")).status).toBe(400);
    expect((await start("", ["data:text/html;base64,PGgxPg=="])).status).toBe(400);
  });

  it("refuses to start while the Studio is off", async () => {
    installFakeAgent();
    await enable(AGENT, false);

    const refused = await start("Bonjour");

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_disabled");
  });
});
