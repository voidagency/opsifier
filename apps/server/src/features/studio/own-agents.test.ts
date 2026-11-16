import type {
  ActionPage,
  StudioAppDetail,
  StudioConversation,
  StudioIsolateAll,
  StudioIsolated,
  StudioOverview,
  StudioSettings,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { AGENT_IDLE_MS, forgetAgentActivity, stopIdleAgents } from "./agents";
import { forgetGithubToken } from "./relay";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });

const MODEL_PATH = "/projects/lovable/services/openhands";
const MODEL = {
  project: "lovable",
  service: "openhands",
  url: "http://127.0.0.1:18000",
  keyFile: "/home/openhands/.openhands/agent-canvas/api-key.txt",
  projectsDir: "/projects" as string | null,
};
const IMAGE = "ghcr.io/openhands/agent-canvas:1.40.0";
const GITHUB_TOKEN = "github_pat_kept_in_the_model_only";
const REPOSITORY = "https://github.com/mehdinajeddine/un-mot-par-jour-landing";
const ADDED = "/projects/studio-un-mot-par-jour-landing/services";
const OWN_AGENT = "studio-un-mot-par-jour-landing_agent";

type Raw = Record<string, unknown>;
type Script = "folder" | "seed-read" | "seed-write" | "clone" | "agent";
interface Exec {
  service: string;
  script: Script;
  input: Raw;
}

const kindOf = (script: string): Script =>
  script.includes("opsifier-studio-folder")
    ? "folder"
    : script.includes('mode="w:gz"')
      ? "seed-read"
      : script.includes('mode="r:gz"')
        ? "seed-write"
        : script.includes("opsifier-studio-clone")
          ? "clone"
          : "agent";

/**
 * Plays the agent servers in their containers: the model, `lovable_openhands`, which alone has a
 * GitHub token, and each project's own, which holds its own conversations and the settings copied
 * into it.
 */
function installFakeAgents() {
  const state = {
    execs: [] as Exec[],
    conversations: new Map<string, { service: string; started: Raw; status: string }>(),
    seeded: new Map<string, string>(),
    folders: new Map<string, Raw>(),
  };
  let sequence = 0;
  const ok = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });

  const answer = (service: string, request: { method: string; path: string; body?: unknown }) => {
    const url = new URL(request.path, "http://127.0.0.1:18000");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/agent-profiles") {
      return ok({ profiles: [{ id: "profile-1" }], active_agent_profile_id: "profile-1" });
    }
    if (url.pathname === "/api/profiles") {
      return ok({
        active_profile: "qwen-rtx",
        profiles: [{ name: "qwen-rtx", model: "openai/Qwen", base_url: "http://100.89.0.1:8000/v1" }],
      });
    }
    if (url.pathname === "/api/settings/secrets") {
      return ok({ secrets: service === "lovable_openhands" ? [{ name: "GITHUB_TOKEN" }] : [] });
    }
    if (url.pathname === "/api/settings/secrets/GITHUB_TOKEN") {
      return service === "lovable_openhands"
        ? { status: 200, text: GITHUB_TOKEN }
        : ok({ detail: "Not Found" }, 404);
    }
    if (request.method === "POST" && url.pathname === "/api/conversations") {
      const id = `c0ffee00-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      state.conversations.set(id, { service, started: request.body as Raw, status: "running" });
      return ok({ id, title: null, execution_status: "running" }, 201);
    }
    const conversation = state.conversations.get(parts[2] ?? "");
    if (conversation === undefined || conversation.service !== service) {
      return ok({ detail: "Not Found" }, 404);
    }
    if (request.method === "GET" && parts.length === 3) {
      return ok({ id: parts[2], title: null, execution_status: conversation.status, llm: {} });
    }
    if (request.method === "GET" && parts[3] === "events") {
      return ok({ items: [], next_page_id: null });
    }
    if (request.method === "POST" && parts[3] === "events") {
      conversation.status = "running";
      return ok({ success: true });
    }
    if (request.method === "POST" && parts[3] === "pause") {
      conversation.status = "paused";
      return ok({ success: true });
    }
    return ok({ detail: "Not Found" }, 404);
  };

  context.docker.execHandler = (options) => {
    if (options.command[0] !== "python3") {
      return undefined;
    }
    const script = kindOf(String(options.command[2]));
    const service = options.service;
    return (input: string) => {
      const request = JSON.parse(input) as Raw;
      state.execs.push({ service, script, input: request });
      switch (script) {
        case "folder": {
          const report = state.folders.get(String(request.dir)) ?? {
            exists: false,
            origin: "",
            uid: 10001,
            gid: 10001,
            vite: false,
          };
          return { output: `opsifier-studio-folder ${JSON.stringify(report)}\nopsifier-ok\n`, exitCode: 0 };
        }
        case "seed-read":
          return {
            output: `opsifier-studio-seed archive ${Buffer.from("settings").toString("base64")}\nopsifier-studio-seed digest ${"a".repeat(64)}\nopsifier-ok\n`,
            exitCode: 0,
          };
        case "seed-write": {
          const before = state.seeded.get(service);
          state.seeded.set(service, String(request.digest));
          const said =
            before === request.digest ? "same" : before === undefined ? "written key-changed" : "written";
          return { output: `opsifier-studio-seed ${said}\nopsifier-ok\n`, exitCode: 0 };
        }
        case "clone":
          return {
            output: `opsifier-studio-clone ${JSON.stringify({ ok: true, reused: false, uid: 10001, gid: 10001, branch: "main", manifest: true, vite: true })}\n`,
            exitCode: 0,
          };
        default: {
          const calls = request.calls as { method: string; path: string; body?: unknown }[];
          const answers = calls.map((one) => answer(service, one));
          const encoded = Buffer.from(JSON.stringify({ keyFound: true, answers })).toString("base64");
          return { output: `opsifier-studio ${encoded}\nopsifier-ok\n`, exitCode: 0 };
        }
      }
    };
  };
  return state;
}

/** Waits until no Action is queued or running. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const page = await api<ActionPage>("/actions?limit=100");
    if (page.body.items.every((action) => action.status !== "queued" && action.status !== "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The Actions did not finish");
}

const saveSettings = (patch: Partial<StudioSettings> = {}) =>
  api<StudioSettings>("/settings/studio", "PUT", {
    enabled: true,
    agent: MODEL,
    previewSignIn: false,
    agentPerProject: false,
    ...patch,
  });

/** The model, as the Studio needs it: an image, its settings in a volume, the projects folder, the panel's address. */
async function prepareModel(): Promise<void> {
  expect(
    (await api("/server/panel-domain", "PUT", { customDomain: "panel.example.com", serveOnIp: true })).status,
  ).toBe(200);
  await api(`${MODEL_PATH}/source`, "PUT", { image: IMAGE });
  await api(`${MODEL_PATH}/storage/mounts`, "POST", {
    type: "volume",
    name: "state",
    mountPath: "/home/openhands/.openhands",
  });
  await api(`${MODEL_PATH}/storage/mounts`, "POST", {
    type: "bind",
    hostPath: "/srv/studio",
    mountPath: "/projects",
  });
  expect((await api(`${MODEL_PATH}/deploy`, "POST")).status).toBe(202);
  await settle();
}

/** Adds a project with its own agent server, and waits for both its services to be deployed. */
async function addOwnProject(): Promise<StudioAppDetail> {
  await prepareModel();
  await saveSettings({ agentPerProject: true });
  const added = await api<StudioAppDetail>("/studio/projects", "POST", { repository: REPOSITORY });
  expect(added.status).toBe(201);
  await settle();
  return added.body;
}

async function agentEnv(path = `${ADDED}/agent`): Promise<string> {
  const revealed = await api<{ env: string }>(`${path}/environment/reveal`, "POST", {});
  expect(revealed.status).toBe(200);
  return revealed.body.env;
}

/** Starts a conversation, waiting while the project's agent server starts, as the Studio's page does. */
async function startConversation(path: string, text: string): Promise<{ id: string; waits: number }> {
  for (let waits = 0; waits < 5; waits += 1) {
    const started = await api<StudioConversation>(`${path}/studio/conversations`, "POST", { text });
    if (started.status === 201) {
      return { id: started.body.id, waits };
    }
    expect(apiErrorOf(started).code).toBe("studio_agent_starting");
    await settle();
  }
  throw new Error("The agent server never became ready");
}

let agents: ReturnType<typeof installFakeAgents>;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  forgetAgentActivity();
  forgetGithubToken();
  await api("/projects", "POST", { name: "lovable" });
  await api("/projects/lovable/services", "POST", { name: "openhands" });
  agents = installFakeAgents();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context.close();
});

describe("an agent server for each project", () => {
  it("is refused until the model can be copied: its settings in a volume, and a projects folder", async () => {
    await api(`${MODEL_PATH}/source`, "PUT", { image: IMAGE });
    const noVolume = await saveSettings({ agentPerProject: true });
    expect(noVolume.status).toBe(400);
    expect(apiErrorOf(noVolume).code).toBe("studio_agent_state_unknown");

    await api(`${MODEL_PATH}/storage/mounts`, "POST", {
      type: "volume",
      name: "state",
      mountPath: "/home/openhands/.openhands",
    });
    await api("/server/panel-domain", "PUT", { customDomain: "panel.example.com", serveOnIp: true });
    const noFolder = await saveSettings({ agentPerProject: true, agent: { ...MODEL, projectsDir: null } });
    expect(apiErrorOf(noFolder).code).toBe("studio_projects_unset");

    const noKeyFile = await saveSettings({ agentPerProject: true, agent: { ...MODEL, keyFile: null } });
    expect(apiErrorOf(noKeyFile).code).toBe("studio_agent_key_file_required");

    const saved = await saveSettings({ agentPerProject: true });
    expect(saved.status).toBe(200);
    expect(saved.body.agentPerProject).toBe(true);
  });

  it("puts a project added in an Opsifier project of its own, with its preview and an agent server holding no token", async () => {
    const added = await addOwnProject();

    expect(added).toMatchObject({
      project: "studio-un-mot-par-jour-landing",
      service: "preview",
      workspaceDir: "/projects/un-mot-par-jour-landing",
      agentMode: "own",
    });
    const source = await api<{ source: { type: string; image?: string } }>(`${ADDED}/agent/source`);
    expect(source.body.source).toMatchObject({ type: "image", image: IMAGE });
    const storage = await api<{ mounts: Raw[] }>(`${ADDED}/agent/storage`);
    expect(storage.body.mounts).toEqual([
      expect.objectContaining({ type: "volume", name: "state", mountPath: "/home/openhands/.openhands" }),
      expect.objectContaining({
        type: "bind",
        hostPath: "/srv/studio/un-mot-par-jour-landing",
        mountPath: "/projects/un-mot-par-jour-landing",
      }),
    ]);
    // Talked to from inside its container only.
    expect((await api<{ domains: unknown[] }>(`${ADDED}/agent/domains`)).body.domains).toEqual([]);
    const previewStorage = await api<{ mounts: Raw[] }>(`${ADDED}/preview/storage`);
    expect(previewStorage.body.mounts).toEqual([
      expect.objectContaining({
        type: "bind",
        hostPath: "/srv/studio/un-mot-par-jour-landing",
        mountPath: "/app",
      }),
    ]);

    // Its git goes to the panel, for this repository, with a token of its own: never GitHub's.
    const env = await agentEnv();
    expect(env).not.toContain(GITHUB_TOKEN);
    expect(env).toMatch(/^OPSIFIER_STUDIO_GIT_TOKEN=[A-Za-z0-9_-]{43}$/m);
    expect(env).toContain("GIT_CONFIG_KEY_0=credential.helper\nGIT_CONFIG_VALUE_0=\n");
    expect(env).toMatch(
      /GIT_CONFIG_KEY_2=url\.https:\/\/panel\.example\.com\/api\/v1\/studio\/git\/[^\s]+\.git\.insteadOf/,
    );
    expect(env).toContain("GIT_CONFIG_VALUE_2=https://github.com/mehdinajeddine/un-mot-par-jour-landing.git");
  });

  it("runs a conversation in the project's own agent server, with the model's settings and no secret", async () => {
    await addOwnProject();

    const started = await startConversation(`${ADDED}/preview`, "Bonjour");

    // The first copy brought the key the model's stored keys are encrypted with: one restart reads it.
    expect(started.waits).toBe(1);
    const actions = await api<ActionPage>("/actions?limit=100");
    expect(
      actions.body.items.some(
        (action) => action.type === "service.restart" && action.serviceName === "agent",
      ),
    ).toBe(true);
    const app = await api<StudioAppDetail>(`${ADDED}/preview/studio`);
    expect(app.body.conversations[0]).toMatchObject({ id: started.id, readOnly: false });
    const conversation = agents.conversations.get(started.id);
    expect(conversation?.service).toBe(OWN_AGENT);
    expect(conversation?.started.secrets).toEqual({});
    const additions = (conversation?.started.agent_launch_additions ?? {}) as Raw;
    const suffix = String(additions.system_message_suffix_append);
    expect(suffix).toContain("git pull --rebase --autostash");
    expect(suffix).not.toContain("GITHUB_TOKEN");
    expect(suffix).toContain("the preview answers at http://preview.");
    // The model's settings were copied in first, from the model's container into the project's.
    const order = agents.execs.map((exec) => `${exec.script}@${exec.service}`);
    expect(order.indexOf("seed-read@lovable_openhands")).toBeGreaterThanOrEqual(0);
    const posted = agents.execs.findIndex(
      (exec) =>
        exec.service === OWN_AGENT &&
        (exec.input.calls as { method: string; path: string }[] | undefined)?.some(
          (one) => one.method === "POST" && one.path === "/api/conversations",
        ),
    );
    expect(order.indexOf(`seed-write@${OWN_AGENT}`)).toBeLessThan(posted);
    expect(agents.execs.find((exec) => exec.script === "seed-write")?.input.state).toBe(
      "/home/openhands/.openhands",
    );

    const page = await api(`${ADDED}/preview/studio/conversations/${started.id}/events`);
    expect(page.status).toBe(200);
  });

  it("starts a stopped agent server for a message, never for a read", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    const before = (await api<ActionPage>("/actions?limit=100")).body.items.length;

    const read = await api(`${ADDED}/preview/studio/conversations/${id}/events`);
    expect(read.status).toBe(409);
    expect(apiErrorOf(read).code).toBe("studio_agent_asleep");
    expect((await api<ActionPage>("/actions?limit=100")).body.items.length).toBe(before);

    const early = await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
      text: "Encore",
    });
    expect(early.status).toBe(409);
    expect(apiErrorOf(early).code).toBe("studio_agent_starting");
    await settle();
    const later = await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
      text: "Encore",
    });
    expect(later.status).toBe(200);
  });
});

describe("a project moved to an agent server of its own", () => {
  const OLD = "/projects/lovable/services/cd-studio-preview";
  const NEW = "/projects/studio-cd-studio/services/preview";

  async function linkShared(): Promise<void> {
    await prepareModel();
    await saveSettings();
    await api("/projects/lovable/services", "POST", { name: "cd-studio-preview" });
    await api(`${OLD}/source`, "PUT", { image: "node:22" });
    expect((await api(`${OLD}/deploy`, "POST")).status).toBe(202);
    await settle();
    expect((await api(`${OLD}/studio`, "PUT", { workspaceDir: "/projects/cd-studio" })).status).toBe(200);
    agents.folders.set("/projects/cd-studio", {
      exists: true,
      origin: "https://github.com/mehdinajeddine/cd-studio.git",
      uid: 10001,
      gid: 10001,
      vite: true,
      credentials: [],
    });
  }

  it("keeps its accounts, and its conversations so far for reading only", async () => {
    await linkShared();
    const before = await api<StudioConversation>(`${OLD}/studio/conversations`, "POST", { text: "Avant" });
    expect(agents.conversations.get(before.body.id)?.service).toBe("lovable_openhands");
    const designer = await signInMember(context.app, cookie, "designer@example.com", []);
    const users = await api<{ users: { id: string; email: string }[] }>("/users");
    const designerId = users.body.users.find((user) => user.email === "designer@example.com")?.id;
    await api(`${OLD}/studio/members`, "PUT", { userIds: [designerId] });

    await saveSettings({ agentPerProject: true });
    expect((await api<StudioOverview>("/studio")).body.apps[0]?.agentMode).toBe("missing");
    const waiting = await api(`${OLD}/studio/conversations`, "POST", { text: "Pendant" });
    expect(waiting.status).toBe(409);
    expect(apiErrorOf(waiting).code).toBe("studio_project_agent_missing");

    const isolated = await api<StudioIsolated>(`${OLD}/studio/isolate`, "POST");

    expect(isolated.status).toBe(200);
    expect(isolated.body).toEqual({ project: "studio-cd-studio", service: "preview" });
    const app = await api<StudioAppDetail>(`${NEW}/studio`);
    expect(app.body).toMatchObject({ workspaceDir: "/projects/cd-studio", agentMode: "own" });
    expect(app.body.conversations).toEqual([expect.objectContaining({ id: before.body.id, readOnly: true })]);
    // The old preview stays where it was, out of the Studio, and stopped; the shared agent stops too.
    expect((await api(`${OLD}/studio`)).status).toBe(404);
    await settle();
    expect((await api<{ stopped: boolean }>(OLD)).body.stopped).toBe(true);
    expect(agents.conversations.get(before.body.id)?.status).toBe("paused");
    const members = await api<{ members: { email: string }[] }>(`${NEW}/studio/members`);
    expect(members.body.members.map((member) => member.email)).toEqual(["designer@example.com"]);
    const env = await agentEnv("/projects/studio-cd-studio/services/agent");
    expect(env).toContain("https://github.com/mehdinajeddine/cd-studio.git");

    // The old conversation is read from the shared agent server, and cannot go on.
    expect((await api(`${NEW}/studio/conversations/${before.body.id}/events`)).status).toBe(200);
    const more = await api(`${NEW}/studio/conversations/${before.body.id}/messages`, "POST", {
      text: "Encore",
    });
    expect(more.status).toBe(409);
    expect(apiErrorOf(more).code).toBe("studio_conversation_read_only");

    // The designer finds it at its new place, and opening it brings both services up for the first time.
    const theirs = await api<StudioOverview>("/studio", "GET", undefined, designer);
    expect(theirs.body.apps.map((one) => `${one.project}/${one.service}`)).toEqual([
      "studio-cd-studio/preview",
    ]);
    const opened = await api(`${NEW}/studio/preview/start`, "POST", undefined, designer);
    expect(opened.body).toEqual({ started: true, agentStarted: true });
    await settle();
  });

  it("puts the agent next to a service that has an Opsifier project of its own, and moves or stops nothing", async () => {
    await prepareModel();
    await saveSettings();
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/source", "PUT", { image: "drupal:11" });
    expect((await api("/projects/shop/services/web/deploy", "POST")).status).toBe(202);
    await settle();
    expect(
      (await api("/projects/shop/services/web/studio", "PUT", { workspaceDir: "/projects/shop" })).status,
    ).toBe(200);
    agents.folders.set("/projects/shop", {
      exists: true,
      origin: "https://github.com/acme/shop.git",
      uid: 10001,
      gid: 10001,
      vite: false,
      credentials: [],
    });
    await saveSettings({ agentPerProject: true });

    const isolated = await api<StudioIsolated>("/projects/shop/services/web/studio/isolate", "POST");

    expect(isolated.status).toBe(200);
    expect(isolated.body).toEqual({ project: "shop", service: "web" });
    expect((await api<StudioAppDetail>("/projects/shop/services/web/studio")).body.agentMode).toBe("own");
    const storage = await api<{ mounts: Raw[] }>("/projects/shop/services/agent/storage");
    expect(storage.body.mounts).toContainEqual(
      expect.objectContaining({ type: "bind", hostPath: "/srv/studio/shop", mountPath: "/projects/shop" }),
    );
    await settle();
    expect((await api<{ stopped: boolean }>("/projects/shop/services/web")).body.stopped).toBe(false);
    expect((await api("/projects/studio-shop")).status).toBe(404);
  });

  it("does not move a preview the Studio does not know how to make again", async () => {
    await linkShared();
    agents.folders.set("/projects/cd-studio", {
      exists: true,
      origin: "https://github.com/mehdinajeddine/cd-studio.git",
      uid: 10001,
      gid: 10001,
      vite: false,
      credentials: [],
    });
    await saveSettings({ agentPerProject: true });

    const refused = await api(`${OLD}/studio/isolate`, "POST");

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_preview_not_movable");
    expect((await api("/projects/studio-cd-studio")).status).toBe(404);
    expect((await api<{ stopped: boolean }>(OLD)).body.stopped).toBe(false);
  });

  it("refuses a folder whose git settings hold a credential, before making anything", async () => {
    await linkShared();
    agents.folders.set("/projects/cd-studio", {
      exists: true,
      origin: "https://github.com/mehdinajeddine/cd-studio.git",
      uid: 10001,
      gid: 10001,
      vite: true,
      credentials: ["remote.origin.url"],
    });
    await saveSettings({ agentPerProject: true });

    const refused = await api(`${OLD}/studio/isolate`, "POST");

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_folder_credentials");
    expect(apiErrorOf(refused).message).toContain("remote.origin.url");
    expect((await api("/projects/studio-cd-studio")).status).toBe(404);
    expect((await api(`${OLD}/studio`)).status).toBe(200);
  });

  it("moves every project still on the shared agent server, and says which could not be", async () => {
    await linkShared();
    await api("/projects/lovable/services", "POST", { name: "elsewhere-preview" });
    await api("/projects/lovable/services/elsewhere-preview/studio", "PUT", {
      workspaceDir: "/srv/elsewhere",
    });
    await saveSettings({ agentPerProject: true });

    const moved = await api<StudioIsolateAll>("/studio/isolate", "POST");

    expect(moved.status).toBe(200);
    expect(moved.body.isolated).toEqual([
      {
        from: { project: "lovable", service: "cd-studio-preview" },
        to: { project: "studio-cd-studio", service: "preview" },
      },
    ]);
    expect(moved.body.failed).toEqual([
      expect.objectContaining({ project: "lovable", service: "elsewhere-preview" }),
    ]);
    expect(moved.body.failed[0]?.message).toContain("not inside the Studio's projects folder");
  });

  it("is for administrators only, and only once each project gets its own agent server", async () => {
    await linkShared();
    const off = await api(`${OLD}/studio/isolate`, "POST");
    expect(off.status).toBe(409);
    expect(apiErrorOf(off).code).toBe("studio_agent_per_project_off");

    await saveSettings({ agentPerProject: true });
    const member = await signInMember(context.app, cookie, "member@example.com", []);
    expect((await api(`${OLD}/studio/isolate`, "POST", undefined, member)).status).toBe(403);
    expect((await api("/studio/isolate", "POST", undefined, member)).status).toBe(403);
  });
});

describe("taking a project out of the Studio", () => {
  const REMOVE = `${ADDED}/preview/studio/remove`;

  it("deletes what the Studio made for it, once its name is typed, and leaves its folder", async () => {
    await addOwnProject();

    const wrong = await api(REMOVE, "POST", { confirm: "studio-un-mot-par-jour-landing" });
    expect(wrong.status).toBe(409);
    expect(apiErrorOf(wrong).code).toBe("confirmation_mismatch");

    const execsBefore = context.docker.execs.length;
    const removed = await api<{ type: string }>(REMOVE, "POST", { confirm: "un-mot-par-jour-landing" });
    expect(removed.status).toBe(202);
    expect(removed.body.type).toBe("studio.remove");
    await settle();

    expect((await api<StudioOverview>("/studio")).body.apps).toEqual([]);
    expect((await api(`${ADDED}/preview`)).status).toBe(404);
    expect((await api(`${ADDED}/agent`)).status).toBe(404);
    expect((await api("/projects/studio-un-mot-par-jour-landing")).status).toBe(404);
    // The folder is not the panel's to delete: nothing ran in the model's container, which sees it.
    const ran = context.docker.execs.slice(execsBefore).map((exec) => exec.options.service);
    expect(ran).not.toContain("lovable_openhands");

    // Added again, it comes back under the same name.
    const again = await api<StudioAppDetail>("/studio/projects", "POST", { repository: REPOSITORY });
    expect(again.status).toBe(201);
    expect(again.body.project).toBe("studio-un-mot-par-jour-landing");
  });

  it("waits for work already running on the project, and changes nothing meanwhile", async () => {
    await addOwnProject();
    expect((await api(`${ADDED}/agent/deploy`, "POST")).status).toBe(202);

    const refused = await api(REMOVE, "POST", { confirm: "un-mot-par-jour-landing" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_project_busy");
    await settle();
    expect((await api<StudioOverview>("/studio")).body.apps).toHaveLength(1);
  });

  it("deletes the agent it put next to a site, and nothing of the site", async () => {
    await prepareModel();
    await saveSettings();
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/source", "PUT", { image: "drupal:11" });
    expect((await api("/projects/shop/services/web/deploy", "POST")).status).toBe(202);
    await settle();
    await api("/projects/shop/services/web/studio", "PUT", { workspaceDir: "/projects/shop" });
    agents.folders.set("/projects/shop", {
      exists: true,
      origin: "https://github.com/acme/shop.git",
      uid: 10001,
      gid: 10001,
      vite: false,
      credentials: [],
    });
    await saveSettings({ agentPerProject: true });
    expect((await api("/projects/shop/services/web/studio/isolate", "POST")).status).toBe(200);
    await settle();

    expect((await api("/projects/shop/services/web/studio/remove", "POST", { confirm: "shop" })).status).toBe(
      202,
    );
    await settle();

    expect((await api("/projects/shop/services/agent")).status).toBe(404);
    expect((await api<{ stopped: boolean }>("/projects/shop/services/web")).body.stopped).toBe(false);
    expect((await api("/projects/shop")).status).toBe(200);
    expect((await api("/projects/shop/services/web/studio")).status).toBe(404);
  });
});

describe("the git relay of a project's agent server", () => {
  const PANEL = "https://panel.example.com";
  const basic = (password: string) =>
    `Basic ${Buffer.from(`opsifier-studio:${password}`).toString("base64")}`;

  async function relayOf(): Promise<{ path: string; token: string }> {
    await addOwnProject();
    const env = await agentEnv();
    const token = /^OPSIFIER_STUDIO_GIT_TOKEN=(\S+)$/m.exec(env)?.[1] ?? "";
    const relay = /^GIT_CONFIG_KEY_2=url\.(\S+)\.insteadOf$/m.exec(env)?.[1] ?? "";
    return { path: new URL(relay).pathname, token };
  }

  it("passes the project's git to its repository only, with a token the agent never sees", async () => {
    const { path, token } = await relayOf();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("001e# service=git-upload-pack\n", {
          status: 200,
          headers: { "content-type": "application/x-git-upload-pack-advertisement", "set-cookie": "no=1" },
        }),
    );

    const refs = await context.app.request(`${PANEL}${path}/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(token), "git-protocol": "version=2", cookie: "not=forwarded" },
    });

    expect(refs.status).toBe(200);
    expect(await refs.text()).toContain("service=git-upload-pack");
    expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(refs.headers.get("set-cookie")).toBeNull();
    const [url, init] = fetched.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git/info/refs?service=git-upload-pack",
    );
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe(
      `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`,
    );
    expect(sent.get("git-protocol")).toBe("version=2");
    expect(sent.get("cookie")).toBeNull();
  });

  it("asks anything else to sign in, and sends nothing to GitHub", async () => {
    const { path, token } = await relayOf();
    const fetched = vi.spyOn(globalThis, "fetch");

    const wrong = await context.app.request(`${PANEL}${path}/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic("not-the-token") },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("Basic");
    const none = await context.app.request(`${PANEL}${path}/info/refs?service=git-upload-pack`);
    expect(none.status).toBe(401);
    const another = await context.app.request(
      `${PANEL}/api/v1/studio/git/someone-else.git/info/refs?service=git-upload-pack`,
      {
        headers: { authorization: basic(token) },
      },
    );
    expect(another.status).toBe(401);
    const dumb = await context.app.request(`${PANEL}${path}/info/refs`, {
      headers: { authorization: basic(token) },
    });
    expect(dumb.status).toBe(403);
    const elsewhere = await context.app.request(`${PANEL}${path}/objects/info/packs`, {
      headers: { authorization: basic(token) },
    });
    expect(elsewhere.status).toBe(404);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("streams a push to GitHub and records it, and turns GitHub's refusal into one git does not ask again for", async () => {
    const { path, token } = await relayOf();
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = await new Response(init?.body ?? null).text();
      return new Response(`received ${body}`, {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    });

    const pushed = await context.app.request(`${PANEL}${path}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basic(token), "content-type": "application/x-git-receive-pack-request" },
      body: "0000PACK",
    });

    expect(pushed.status).toBe(200);
    expect(await pushed.text()).toBe("received 0000PACK");
    expect(String(fetched.mock.calls[0]?.[0])).toBe(
      "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git/git-receive-pack",
    );
    const actions = await api<ActionPage>("/actions?limit=50");
    expect(actions.body.items.some((action) => action.type === "studio.push")).toBe(true);

    fetched.mockResolvedValue(new Response("Bad credentials", { status: 401 }));
    const refused = await context.app.request(`${PANEL}${path}/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic(token) },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("add the repository to that token");
  });
});

describe("an unused agent server", () => {
  it("is stopped after a while, unless one of its conversations is at work", async () => {
    await addOwnProject();
    const started = { body: await startConversation(`${ADDED}/preview`, "Bonjour") };

    context.advance(AGENT_IDLE_MS + 1);
    expect(await stopIdleAgents(context.deps)).toEqual([]);
    expect((await api<{ stopped: boolean }>(`${ADDED}/agent`)).body.stopped).toBe(false);

    const conversation = agents.conversations.get(started.body.id);
    if (conversation !== undefined) {
      conversation.status = "finished";
    }
    context.advance(AGENT_IDLE_MS + 1);
    expect(await stopIdleAgents(context.deps)).toEqual(["studio-un-mot-par-jour-landing/agent"]);
    await settle();
    expect((await api<{ stopped: boolean }>(`${ADDED}/agent`)).body.stopped).toBe(true);
  });
});
