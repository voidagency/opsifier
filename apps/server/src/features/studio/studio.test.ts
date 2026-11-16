import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  projectsDir: null as string | null,
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
    expect((await api<StudioSettings>("/settings/studio")).body).toEqual({
      enabled: false,
      agent: null,
      previewSignIn: false,
      agentPerProject: false,
    });

    const saved = await enable();

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ enabled: true, agent: AGENT, previewSignIn: false, agentPerProject: false });
    expect((await api<StudioSettings>("/settings/studio")).body).toEqual({
      enabled: true,
      agent: AGENT,
      previewSignIn: false,
      agentPerProject: false,
    });
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

  it("is out of reach of a project's operators until the Studio project is shared with them", async () => {
    await enable();
    await link();
    const member = await signInMember(context.app, cookie, "op@example.com", [
      { project: "lovable", role: "operator" },
    ]);

    expect((await api<StudioOverview>("/studio", "GET", undefined, member)).body.apps).toEqual([]);
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, member)).status).toBe(404);
    expect((await api(`${PREVIEW}/studio/conversations`, "POST", { text: "hi" }, member)).status).toBe(404);
    expect((await api("/settings/studio", "GET", undefined, member)).status).toBe(403);
  });
});

describe("adding a project to the Studio", () => {
  const REPOSITORY = "https://github.com/mehdinajeddine/un-mot-par-jour-landing";
  const ADDED = "/projects/lovable/services/un-mot-par-jour-landing-preview";
  type Clone = Record<string, unknown>;

  /** Plays the copy script in the agent server's container: what it is sent, and what it answers. */
  function installFakeClone(result: Clone) {
    const inputs: Record<string, unknown>[] = [];
    const agentHandler = context.docker.execHandler;
    context.docker.execHandler = (options) => {
      if (
        options.service === "lovable_openhands" &&
        String(options.command[2]).includes("opsifier-studio-clone")
      ) {
        return (input: string) => {
          inputs.push(JSON.parse(input) as Record<string, unknown>);
          return { output: `Cloning…\nopsifier-studio-clone ${JSON.stringify(result)}\n`, exitCode: 0 };
        };
      }
      return agentHandler?.(options);
    };
    return inputs;
  }

  const copied = {
    ok: true,
    reused: false,
    uid: 10001,
    gid: 10001,
    branch: "main",
    manifest: true,
    vite: true,
  };
  const add = (body: unknown) => api<StudioAppDetail>("/studio/projects", "POST", body);

  async function prepare(projectsDir: string | null = "/projects", mounted = true): Promise<void> {
    await deployAgent();
    if (mounted) {
      const mount = await api("/projects/lovable/services/openhands/storage/mounts", "POST", {
        type: "bind",
        hostPath: "/srv/studio",
        mountPath: "/projects",
      });
      expect(mount.status).toBe(201);
    }
    await enable({ ...AGENT, projectsDir });
  }

  it("copies the repository in the agent server's container, makes its preview and links it", async () => {
    await prepare();
    const inputs = installFakeClone(copied);

    const added = await add({ repository: REPOSITORY });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      project: "lovable",
      service: "un-mot-par-jour-landing-preview",
      workspaceDir: "/projects/un-mot-par-jour-landing",
      conversations: [],
    });
    // The token stays in the agent server: the panel names the secret and never sees its value.
    expect(inputs).toEqual([
      {
        agentUrl: AGENT.url,
        keyFile: AGENT.keyFile,
        secret: "GITHUB_TOKEN",
        url: "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git",
        dir: "/projects/un-mot-par-jour-landing",
      },
    ]);
    const settings = await api<{ source: { type: string; dockerfile?: string } | null }>(`${ADDED}/source`);
    expect(settings.body.source?.type).toBe("dockerfile");
    expect(settings.body.source?.dockerfile).toContain("USER 10001:10001");
    expect(settings.body.source?.dockerfile).toContain("--config /opt/opsifier-studio/vite.config.mjs");
    const storage = await api<{ mounts: Record<string, unknown>[] }>(`${ADDED}/storage`);
    expect(storage.body.mounts).toEqual([
      expect.objectContaining({
        type: "bind",
        hostPath: "/srv/studio/un-mot-par-jour-landing",
        mountPath: "/app",
      }),
    ]);
    const overview = await api<StudioOverview>("/studio");
    expect(overview.body.apps.map((app) => app.service)).toContain("un-mot-par-jour-landing-preview");
    const actions = await api<ActionPage>("/actions?limit=30");
    expect(actions.body.items.some((action) => action.type === "studio.add-project")).toBe(true);
  });

  it("takes a branch, and the repository as owner/name", async () => {
    await prepare();
    const inputs = installFakeClone(copied);

    const added = await add({ repository: "mehdinajeddine/un-mot-par-jour-landing", branch: "design" });

    expect(added.status).toBe(201);
    expect(inputs[0]).toMatchObject({ branch: "design", dir: "/projects/un-mot-par-jour-landing" });
  });

  it("says what to do when the agent server's GitHub token does not reach the repository", async () => {
    await prepare();
    installFakeClone({
      ok: false,
      code: "no_access",
      token: true,
      message: "remote: Write access to repository not granted.",
    });

    const refused = await add({ repository: REPOSITORY });

    expect(refused.status).toBe(422);
    expect(apiErrorOf(refused).code).toBe("studio_repository_unreachable");
    expect(apiErrorOf(refused).message).toContain("mehdinajeddine/un-mot-par-jour-landing");
    expect((await api(ADDED)).status).toBe(404);
  });

  it("refuses a project its previews cannot run, before making anything", async () => {
    await prepare();
    installFakeClone({ ...copied, manifest: false, vite: false });

    const refused = await add({ repository: REPOSITORY });

    expect(refused.status).toBe(422);
    expect(apiErrorOf(refused).code).toBe("studio_project_unsupported");
    expect((await api(ADDED)).status).toBe(404);
  });

  it("needs the projects folder, mounted from the server in the agent server's container", async () => {
    await prepare(null);
    const unset = await add({ repository: REPOSITORY });
    expect(unset.status).toBe(409);
    expect(apiErrorOf(unset).code).toBe("studio_projects_unset");

    await enable({ ...AGENT, projectsDir: "/elsewhere" });
    const unmounted = await add({ repository: REPOSITORY });
    expect(unmounted.status).toBe(409);
    expect(apiErrorOf(unmounted).code).toBe("studio_projects_unmounted");
  });

  it("refuses an address that is not a GitHub repository, and a preview that already exists", async () => {
    await prepare();
    installFakeClone(copied);

    const invalid = await add({ repository: "https://gitlab.com/someone/site" });
    expect(invalid.status).toBe(400);
    expect(apiErrorOf(invalid).code).toBe("studio_repository_invalid");

    await api("/projects/lovable/services", "POST", { name: "un-mot-par-jour-landing-preview" });
    const taken = await add({ repository: REPOSITORY });
    expect(taken.status).toBe(409);
    expect(apiErrorOf(taken).code).toBe("studio_project_exists");
  });
});

describe("a Studio project shared with a designer", () => {
  const DESIGNER = "designer@example.com";

  async function designer(): Promise<{ cookie: string; id: string }> {
    const designerCookie = await signInMember(context.app, cookie, DESIGNER, []);
    const users = await api<{ users: { id: string; email: string }[] }>("/users");
    const id = users.body.users.find((user) => user.email === DESIGNER)?.id ?? "";
    return { cookie: designerCookie, id };
  }

  async function prepare(): Promise<void> {
    await deployAgent();
    await api(`${PREVIEW}/source`, "PUT", { image: "node:22" });
    await run(`${PREVIEW}/deploy`);
    await run(`${PREVIEW}/stop`);
    installFakeAgent();
    await enable();
    await link();
    await api("/projects/lovable/services", "POST", { name: "other-preview" });
    await api("/projects/lovable/services/other-preview/studio", "PUT", { workspaceDir: "/projects/other" });
  }

  it("reaches the projects shared with them, their conversations and their preview, and nothing more", async () => {
    await prepare();
    const { cookie: as, id } = await designer();

    expect((await api<StudioOverview>("/studio", "GET", undefined, as)).body.apps).toEqual([]);
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, as)).status).toBe(404);

    const shared = await api<{ members: { email: string }[] }>(`${PREVIEW}/studio/members`, "PUT", {
      userIds: [id],
    });
    expect(shared.status).toBe(200);
    expect(shared.body.members.map((member) => member.email)).toEqual([DESIGNER]);

    const overview = await api<StudioOverview>("/studio", "GET", undefined, as);
    expect(overview.body.apps.map((app) => app.service)).toEqual(["cd-studio-preview"]);
    expect(overview.body.canAddProjects).toBe(false);
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, as)).status).toBe(200);
    const started = await api<StudioConversation>(
      `${PREVIEW}/studio/conversations`,
      "POST",
      { text: "Bonjour" },
      as,
    );
    expect(started.status).toBe(201);
    const page = await api<StudioEventPage>(
      `${PREVIEW}/studio/conversations/${started.body.id}/events`,
      "GET",
      undefined,
      as,
    );
    expect(page.status).toBe(200);
    const sent = await api(
      `${PREVIEW}/studio/conversations/${started.body.id}/messages`,
      "POST",
      { text: "Encore" },
      as,
    );
    expect(sent.status).toBe(200);
    // The preview was stopped: the designer starts it, without any right on its service.
    const start = await api<{ started: boolean }>(`${PREVIEW}/studio/preview/start`, "POST", undefined, as);
    expect(start.status).toBe(200);
    expect(start.body.started).toBe(true);

    // Everything else stays out of reach: another project, administration, and the services themselves.
    expect((await api("/projects/lovable/services/other-preview/studio", "GET", undefined, as)).status).toBe(
      404,
    );
    expect((await api(`${PREVIEW}/studio`, "PUT", { workspaceDir: "/projects/x" }, as)).status).toBe(403);
    expect((await api(`${PREVIEW}/studio/members`, "GET", undefined, as)).status).toBe(403);
    expect((await api("/studio/projects", "POST", { repository: "a/b" }, as)).status).toBe(403);
    expect((await api("/settings/studio", "GET", undefined, as)).status).toBe(403);
    expect((await api(PREVIEW, "GET", undefined, as)).status).toBe(404);
  });

  it("loses the project once it is no longer shared with them", async () => {
    await prepare();
    const { cookie: as, id } = await designer();
    await api(`${PREVIEW}/studio/members`, "PUT", { userIds: [id] });
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, as)).status).toBe(200);

    const unshared = await api<{ members: unknown[] }>(`${PREVIEW}/studio/members`, "PUT", { userIds: [] });

    expect(unshared.body.members).toEqual([]);
    expect((await api(`${PREVIEW}/studio`, "GET", undefined, as)).status).toBe(404);
    const actions = await api<ActionPage>("/actions?limit=30");
    expect(actions.body.items.filter((action) => action.type === "studio.share")).toHaveLength(2);
  });

  it("is shared with accounts that exist only", async () => {
    await prepare();

    const refused = await api(`${PREVIEW}/studio/members`, "PUT", { userIds: ["no-such-account"] });

    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).code).toBe("studio_member_unknown");
  });
});

describe("a Studio preview behind the panel's sign-in", () => {
  const HOST = "preview.example.com";
  const CHECK = "/api/proxy-pages/studio-signin";
  const ROUTES = () =>
    readFileSync(join(context.deps.config.traefikDynamicDir, "lovable__cd-studio-preview.yaml"), "utf8");

  async function prepare(): Promise<{ designer: string; stranger: string }> {
    const domain = await api(`${PREVIEW}/domains`, "POST", { host: HOST });
    expect(domain.status).toBe(201);
    await enable();
    await link();
    const designer = await signInMember(context.app, cookie, "designer@example.com", []);
    const stranger = await signInMember(context.app, cookie, "stranger@example.com", []);
    const users = await api<{ users: { id: string; email: string }[] }>("/users");
    const id = users.body.users.find((user) => user.email === "designer@example.com")?.id;
    await api(`${PREVIEW}/studio/members`, "PUT", { userIds: [id] });
    const saved = await api<StudioSettings>("/settings/studio", "PUT", {
      enabled: true,
      agent: AGENT,
      previewSignIn: true,
    });
    expect(saved.body.previewSignIn).toBe(true);
    return { designer, stranger };
  }

  /** What Traefik sends the panel about a request to the preview. */
  const askedByTraefik = (uri: string, previewCookie?: string) =>
    call(context.app, CHECK, {
      headers: {
        "x-forwarded-host": HOST,
        "x-forwarded-uri": uri,
        "x-forwarded-method": "GET",
        accept: "text/html",
        ...(previewCookie === undefined ? {} : { cookie: previewCookie }),
      },
    });
  const hop = (as: string, to: string) =>
    call(context.app, `/api/v1/studio/preview-signin?${new URLSearchParams({ host: HOST, to })}`, {
      cookie: as,
      origin: TEST_ORIGIN,
    });

  it("lets in, through the panel, the accounts the project is shared with", async () => {
    const { designer } = await prepare();
    expect(ROUTES()).toContain("forwardAuth");
    expect(ROUTES()).toContain(CHECK);

    // No cookie for the preview yet: a page goes to the panel to say who is there, or is refused.
    const first = await askedByTraefik("/page");
    expect([302, 401]).toContain(first.status);
    if (first.status === 302) {
      expect(first.headers.get("location")).toContain(`/api/v1/studio/preview-signin?host=${HOST}`);
    }

    const sent = await hop(designer, "/page");
    expect(sent.status).toBe(302);
    const back = new URL(sent.headers.get("location") ?? "");
    expect(back.host).toBe(HOST);
    expect(back.pathname).toBe("/__opsifier/studio-signin");

    const landed = await askedByTraefik(`${back.pathname}${back.search}`);
    expect(landed.status).toBe(302);
    // Absolute, on the preview: Traefik would make "/page" an address of the panel inside the server.
    expect(landed.headers.get("location")).toBe(`https://${HOST}/page`);
    expect(landed.setCookie).toContain("opsifier_studio_preview=");
    expect(landed.setCookie).toContain("HttpOnly");
    expect(landed.setCookie).toContain("SameSite=Lax");

    expect((await askedByTraefik("/page", landed.cookie)).status).toBe(200);
    // A code is good once.
    expect((await askedByTraefik(`${back.pathname}${back.search}`)).status).toBe(403);
  });

  it("sends someone signed out to the panel's page that signs them in", async () => {
    await prepare();

    const hopped = await call(
      context.app,
      `/api/v1/studio/preview-signin?${new URLSearchParams({ host: HOST, to: "/fr" })}`,
    );

    expect(hopped.status).toBe(302);
    expect(hopped.headers.get("location")).toBe(
      `/studio/open-preview?${new URLSearchParams({ host: HOST, to: "/fr" })}`,
    );
  });

  it("keeps out the accounts the project is not shared with, and a code past its minute", async () => {
    const { designer, stranger } = await prepare();

    expect((await hop(stranger, "/")).status).toBe(403);

    const sent = await hop(designer, "/");
    const back = new URL(sent.headers.get("location") ?? "");
    context.advance(61_000);
    expect((await askedByTraefik(`${back.pathname}${back.search}`)).status).toBe(403);
  });

  it("gives the routes back to the server's gate once it is turned off", async () => {
    await prepare();

    await api("/settings/studio", "PUT", { enabled: true, agent: AGENT, previewSignIn: false });

    expect(ROUTES()).not.toContain("forwardAuth");
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
    const told = additions?.system_message_suffix_append ?? "";
    expect(told).toContain("Opsifier Studio");
    expect(told).toContain("The project is your working directory, /projects/cd-studio.");
    // The agent server is in the preview's project: it reaches the preview by the service's name.
    expect(told).toContain("From your container, the preview answers at http://cd-studio-preview.");
    expect(told).toMatch(/The user sees it at https?:\/\/\S+/);
    expect(told).toContain("GITHUB_TOKEN=$GITHUB_TOKEN git push");
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
