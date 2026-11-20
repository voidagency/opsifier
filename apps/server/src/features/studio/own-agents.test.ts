import type {
  ActionPage,
  StudioAppDetail,
  StudioAttachment,
  StudioConversation,
  StudioEventPage,
  StudioIsolateAll,
  StudioIsolated,
  StudioOverview,
  StudioSettings,
  StudioSync,
  StudioVersions,
  StudioViewingState,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioConversationEvents } from "../../core/db/schema";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_EMAIL,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { AGENT_IDLE_MS, forgetAgentActivity, stopIdleAgents } from "./agents";
import { keepCopy, readCopy } from "./conversation-copy";
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
type Script = "folder" | "seed-read" | "seed-write" | "clone" | "sync" | "attach" | "versions" | "agent";
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
          : script.includes("opsifier-studio-sync")
            ? "sync"
            : script.includes("opsifier-studio-attach")
              ? "attach"
              : script.includes("opsifier-studio-versions")
                ? "versions"
                : "agent";

/**
 * Plays the agent servers in their containers: the model, `lovable_openhands`, which alone has a
 * GitHub token, and each project's own, which holds its own conversations and the settings copied
 * into it.
 */
function installFakeAgents() {
  const state = {
    execs: [] as Exec[],
    conversations: new Map<string, { service: string; started: Raw; status: string; events: Raw[] }>(),
    seeded: new Map<string, string>(),
    folders: new Map<string, Raw>(),
    /** What the copy answers; GitHub lets every token in unless a test says otherwise. */
    clone: (_request: Raw): Raw => ({
      ok: true,
      reused: false,
      uid: 10001,
      gid: 10001,
      branch: "main",
      manifest: true,
      vite: true,
    }),
    /** The commit the project's folder shows in place of its branch, if any. */
    shown: null as string | null,
    /** What the folder's versions are, and what showing one answers: null for no answer at all. */
    versions: (request: Raw): Raw | null | Promise<Raw | null> => usualVersions(request),
    /** Holds the messages that reach an agent server until it settles. */
    holdMessages: null as Promise<void> | null,
    /** What bringing a folder up to date answers: nothing new on GitHub, unless a test says otherwise. */
    sync: (_request: Raw): Raw => ({
      ok: true,
      state: "current",
      branch: "main",
      pulled: 0,
      behind: 0,
      ahead: 0,
      changed: 0,
      blocking: [],
      dependencies: false,
    }),
  };
  const VERSIONS: Record<string, Raw> = {
    ["b".repeat(40)]: { sha: "b".repeat(40), at: 1_795_100_000, subject: "Ajoute le formulaire de contact" },
    ["a".repeat(40)]: { sha: "a".repeat(40), at: 1_795_000_000, subject: "Premier jet de la page" },
  };
  function usualVersions(request: Raw): Raw {
    switch (request.action) {
      case "list":
        return {
          ok: true,
          branch: state.shown === null ? "main" : null,
          detached: state.shown !== null,
          shown: state.shown === null ? null : { ...VERSIONS[state.shown], branch: "main" },
          versions: Object.values(VERSIONS),
        };
      case "view":
        state.shown = String(request.sha);
        return { ok: true, branch: "main", stashed: false, ...VERSIONS[String(request.sha)] };
      case "return":
        state.shown = null;
        return { ok: true, branch: "main", stashed: false };
      default:
        return { ok: true };
    }
  }
  let sequence = 0;
  let stamp = 0;
  const ok = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
  /** A message as the agent server records it. */
  const message = (source: "user" | "agent", words: string): Raw => {
    stamp += 1;
    return {
      id: `ev-${String(stamp).padStart(4, "0")}`,
      kind: "MessageEvent",
      source,
      timestamp: new Date(Date.UTC(2026, 10, 19, 12, 0, stamp)).toISOString(),
      llm_message: {
        role: source === "user" ? "user" : "assistant",
        content: [{ type: "text", text: words }],
      },
    };
  };

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
      state.conversations.set(id, {
        service,
        started: request.body as Raw,
        status: "running",
        events: [message("user", "Bonjour"), message("agent", "Bonjour ! Que changeons-nous ?")],
      });
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
      // A page starts with the event it is given, as the agent server's does.
      const pageId = url.searchParams.get("page_id");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const from =
        pageId === null
          ? 0
          : Math.max(
              0,
              conversation.events.findIndex((one) => one.id === pageId),
            );
      const next = conversation.events[from + limit];
      return ok({ items: conversation.events.slice(from, from + limit), next_page_id: next?.id ?? null });
    }
    if (request.method === "POST" && parts[3] === "events") {
      conversation.status = "running";
      conversation.events.push(message("user", "Encore"), message("agent", "C'est fait."));
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
      // A file comes as it is, with where it goes as the script's arguments.
      const request: Raw =
        script === "attach"
          ? {
              dir: options.command[3],
              folder: options.command[4],
              name: options.command[5],
              quota: options.command[6],
              data: input,
            }
          : (JSON.parse(input) as Raw);
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
          return { output: `opsifier-studio-clone ${JSON.stringify(state.clone(request))}\n`, exitCode: 0 };
        case "sync":
          return { output: `opsifier-studio-sync ${JSON.stringify(state.sync(request))}\n`, exitCode: 0 };
        case "attach":
          return { output: `opsifier-studio-attach ${JSON.stringify({ ok: true })}\n`, exitCode: 0 };
        case "versions":
          return Promise.resolve(state.versions(request)).then((said) => ({
            output: said === null ? "" : `opsifier-studio-versions ${JSON.stringify(said)}\n`,
            exitCode: 0,
          }));
        default: {
          const calls = request.calls as { method: string; path: string; body?: unknown }[];
          const reply = () => {
            const answers = calls.map((one) => answer(service, one));
            const encoded = Buffer.from(JSON.stringify({ keyFound: true, answers })).toString("base64");
            return { output: `opsifier-studio ${encoded}\nopsifier-ok\n`, exitCode: 0 };
          };
          const posting = calls.some((one) => one.method === "POST" && one.path.endsWith("/events"));
          return posting && state.holdMessages !== null ? state.holdMessages.then(reply) : reply();
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

  it("shows a conversation from the panel's copy while its agent server sleeps, then goes on", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const events = `${ADDED}/preview/studio/conversations/${id}/events`;
    const live = await api<StudioEventPage>(events);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ asleep: false, cursor: "ev-0002" });
    expect(live.body.items.map((event) => event.id)).toEqual(["ev-0001", "ev-0002"]);

    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    const before = (await api<ActionPage>("/actions?limit=100")).body.items.length;

    // From the start, as a page opened while it sleeps: the same events, from the copy.
    const copy = await api<StudioEventPage>(events);
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ asleep: true, status: "idle", model: null, cursor: "ev-0002" });
    expect(copy.body.items).toEqual(live.body.items);
    // From where a page already is: nothing new, and it stays there.
    expect((await api<StudioEventPage>(`${events}?after=ev-0002`)).body).toMatchObject({
      asleep: true,
      items: [],
      cursor: "ev-0002",
    });
    // From an event the copy does not know: nothing, and the place is kept.
    expect((await api<StudioEventPage>(`${events}?after=ev-9999`)).body).toMatchObject({
      items: [],
      cursor: "ev-9999",
    });
    // None of those reads started the agent server.
    expect((await api<ActionPage>("/actions?limit=100")).body.items.length).toBe(before);

    // A message wakes it, and the page goes on from the copy's end.
    expect(
      apiErrorOf(
        await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" }),
      ).code,
    ).toBe("studio_agent_starting");
    await settle();
    expect(
      (await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" })).status,
    ).toBe(200);
    const next = await api<StudioEventPage>(`${events}?after=ev-0002`);
    expect(next.body.asleep).toBe(false);
    expect(next.body.items.map((event) => event.id)).toEqual(["ev-0003", "ev-0004"]);

    // Asleep again, the copy has everything that was read.
    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    const later = await api<StudioEventPage>(events);
    expect(later.body.asleep).toBe(true);
    expect(later.body.items.map((event) => event.id)).toEqual(["ev-0001", "ev-0002", "ev-0003", "ev-0004"]);
  });

  it("keeps a copy without gaps, and only from a conversation's start or the copy's end", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const events = `${ADDED}/preview/studio/conversations/${id}/events`;
    const copied = () =>
      context.deps.db
        .select()
        .from(studioConversationEvents)
        .all()
        .filter((row) => row.conversationId === id)
        .map((row) => `${row.position}:${row.eventId}`);

    // A page that starts mid-way, with nothing copied before it, is left out.
    expect((await api(`${events}?after=ev-0001`)).status).toBe(200);
    expect(copied()).toEqual([]);
    // From the start, it is kept; read again, nothing doubles.
    await api(events);
    await api(events);
    expect(copied()).toEqual(["1:ev-0001", "2:ev-0002"]);
    // What follows the copy's end is added after it.
    expect(
      (await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" })).status,
    ).toBe(200);
    await api(`${events}?after=ev-0002`);
    expect(copied()).toEqual(["1:ev-0001", "2:ev-0002", "3:ev-0003", "4:ev-0004"]);
  });

  it("keeps a file attached to a message in the project's folder, from inside its agent server", async () => {
    const app = await addOwnProject();
    await startConversation(`${ADDED}/preview`, "Bonjour");
    const attach = (name: string, body: Uint8Array) =>
      call<StudioAttachment>(
        context.app,
        `/api/v1${ADDED}/preview/studio/attachments?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          rawBody: new Blob([body]),
          headers: { "content-type": "application/octet-stream" },
          cookie,
          origin: TEST_ORIGIN,
        },
      );
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n");

    const saved = await attach("Cahier des charges.PDF", pdf);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      name: "Cahier des charges.pdf",
      size: pdf.length,
      type: "application/pdf",
    });
    expect(saved.body.path).toMatch(/^\.git\/opsifier-attachments\/[0-9a-f]{16}\/Cahier des charges\.pdf$/);
    const written = agents.execs.filter((one) => one.script === "attach");
    expect(written).toHaveLength(1);
    expect(written[0]?.service).toBe(OWN_AGENT);
    expect(written[0]?.input).toMatchObject({
      dir: app.workspaceDir,
      name: "Cahier des charges.pdf",
      quota: String(100 * 1024 * 1024),
      data: pdf.toString(),
    });
    // Where it is, as the panel chose it.
    expect(saved.body.path).toBe(
      `.git/opsifier-attachments/${String(written[0]?.input.folder)}/Cahier des charges.pdf`,
    );

    // An image goes with a message as an image; a file is what its name says; and it is at most 10 MB.
    expect(apiErrorOf(await attach("logo.png", pdf)).code).toBe("studio_attachment_type");
    expect(apiErrorOf(await attach("faux.pdf", Buffer.from("<html>"))).code).toBe("studio_attachment_type");
    const big = await attach("gros.csv", Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(big.status).toBe(413);
    expect(apiErrorOf(big).code).toBe("studio_attachment_too_large");
    expect(agents.execs.filter((one) => one.script === "attach")).toHaveLength(1);
  });

  it("shows an earlier version in the preview from inside its agent server, and holds messages meanwhile", async () => {
    const app = await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const VERSIONS = `${ADDED}/preview/studio/versions`;
    const earlier = "a".repeat(40);
    const runs = () => agents.execs.filter((exec) => exec.script === "versions");

    const listed = await api<StudioVersions>(VERSIONS);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      versions: [
        {
          sha: "b".repeat(40),
          at: new Date(1_795_100_000_000).toISOString(),
          subject: "Ajoute le formulaire de contact",
        },
        { sha: earlier, at: new Date(1_795_000_000_000).toISOString(), subject: "Premier jet de la page" },
      ],
      asleep: false,
      viewing: null,
    });
    expect(runs()[0]).toMatchObject({
      service: OWN_AGENT,
      input: { action: "list", dir: app.workspaceDir, branch: null, limit: 50 },
    });

    // Not while the agent is at work: the folder would move under it.
    const working = await api(`${VERSIONS}/${earlier}/view`, "POST");
    expect(working.status).toBe(409);
    expect(apiErrorOf(working).code).toBe("studio_agent_working");
    expect(runs().filter((exec) => exec.input.action === "view")).toHaveLength(0);

    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    const shown = await api<StudioViewingState>(`${VERSIONS}/${earlier}/view`, "POST");
    expect(shown.status).toBe(200);
    expect(shown.body.viewing).toMatchObject({
      sha: earlier,
      subject: "Premier jet de la page",
      by: TEST_EMAIL,
    });
    expect(shown.body.viewing).not.toHaveProperty("branch");
    expect(runs().at(-1)?.input).toMatchObject({ action: "view", sha: earlier, branch: null });

    // Everyone sees it, and the list goes on from the branch, not from the version shown.
    expect((await api<StudioAppDetail>(`${ADDED}/preview/studio`)).body.viewing).toMatchObject({
      sha: earlier,
    });
    expect((await api<StudioVersions>(VERSIONS)).body.viewing).toMatchObject({ sha: earlier });
    expect(runs().at(-1)?.input).toMatchObject({ action: "list", branch: "main" });

    // Nothing reaches the agent while an earlier version is in its folder.
    const message = await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
      text: "Encore",
    });
    expect(message.status).toBe(409);
    expect(apiErrorOf(message).code).toBe("studio_viewing_version");
    const another = await api(`${ADDED}/preview/studio/conversations`, "POST", { text: "Bonjour" });
    expect(apiErrorOf(another).code).toBe("studio_viewing_version");
    const file = await call(context.app, `/api/v1${ADDED}/preview/studio/attachments?name=notes.md`, {
      method: "POST",
      rawBody: new Blob(["# Notes"]),
      headers: { "content-type": "application/octet-stream" },
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(apiErrorOf(file).code).toBe("studio_viewing_version");

    const back = await api<StudioViewingState>(`${VERSIONS}/current`, "POST");
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ viewing: null });
    expect(runs().at(-1)?.input).toMatchObject({ action: "return", dir: app.workspaceDir, branch: "main" });
    expect((await api<StudioAppDetail>(`${ADDED}/preview/studio`)).body.viewing).toBeNull();
    const after = await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
      text: "Encore",
    });
    expect(after.status).toBe(200);

    const recorded = (await api<ActionPage>("/actions?limit=100")).body.items.filter(
      (action) => action.type === "studio.version",
    );
    expect(recorded.map((action) => action.title)).toEqual([
      expect.stringContaining("Show the current version of studio-un-mot-par-jour-landing/preview"),
      expect.stringContaining("Show the version of 2026-11-18T11:06:40.000Z of"),
    ]);

    // Back already: nothing to run.
    const count = runs().length;
    expect((await api(`${VERSIONS}/current`, "POST")).status).toBe(200);
    expect(runs()).toHaveLength(count);
  });

  it("says why a version could not be shown, and changes nothing", async () => {
    await addOwnProject();
    await startConversation(`${ADDED}/preview`, "Bonjour");
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    const VERSIONS = `${ADDED}/preview/studio/versions`;
    agents.versions = () => ({ ok: false, code: "changed", files: ["src/App.tsx"] });
    const unsaved = await api(`${VERSIONS}/${"a".repeat(40)}/view`, "POST");
    expect(unsaved.status).toBe(409);
    expect(apiErrorOf(unsaved).code).toBe("studio_version_unsaved");
    agents.versions = () => ({ ok: false, code: "unknown" });
    expect((await api(`${VERSIONS}/${"c".repeat(40)}/view`, "POST")).status).toBe(404);
    expect((await api(`${VERSIONS}/HEAD~1/view`, "POST")).status).toBe(400);
    expect((await api<StudioAppDetail>(`${ADDED}/preview/studio`)).body.viewing).toBeNull();
  });

  it("never moves the folder under a message on its way, nor lets one in while it moves", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    const VERSIONS = `${ADDED}/preview/studio/versions`;
    const earlier = "a".repeat(40);
    const usual = agents.versions;
    const ran = (action: string) =>
      agents.execs.some((exec) => exec.script === "versions" && exec.input.action === action);

    // A version being shown: a message waits for it.
    let showIt = () => {};
    agents.versions = (request) =>
      request.action === "view"
        ? new Promise((resolve) => {
            showIt = () => resolve(usual(request) as Raw);
          })
        : usual(request);
    const showing = api(`${VERSIONS}/${earlier}/view`, "POST");
    await vi.waitFor(() => expect(ran("view")).toBe(true));
    const early = await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
      text: "Encore",
    });
    expect(apiErrorOf(early).code).toBe("studio_viewing_version");
    const twice = await api(`${VERSIONS}/${earlier}/view`, "POST");
    expect(apiErrorOf(twice).code).toBe("studio_version_busy");
    showIt();
    expect((await showing).status).toBe(200);
    expect((await api(`${VERSIONS}/current`, "POST")).status).toBe(200);
    agents.versions = usual;

    // A message on its way: the version waits for the agent to have it.
    let deliver = () => {};
    agents.holdMessages = new Promise((resolve) => {
      deliver = resolve;
    });
    const sending = api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" });
    await vi.waitFor(() =>
      expect(
        agents.execs.some(
          (exec) => exec.script === "agent" && JSON.stringify(exec.input).includes("/events"),
        ),
      ).toBe(true),
    );
    const meanwhile = await api(`${VERSIONS}/${earlier}/view`, "POST");
    expect(apiErrorOf(meanwhile).code).toBe("studio_agent_working");
    deliver();
    expect((await sending).status).toBe(200);
    agents.holdMessages = null;
  });

  it("follows what the folder says it shows, and holds messages while it says nothing", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    const VERSIONS = `${ADDED}/preview/studio/versions`;
    const earlier = "a".repeat(40);
    const message = () =>
      api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" });

    // The folder moved, but its answer was lost on the way: messages wait until it is read again.
    const usual = agents.versions;
    agents.versions = (request) => {
      if (request.action === "view") {
        agents.shown = String(request.sha);
        return null;
      }
      return usual(request);
    };
    const lost = await api(`${VERSIONS}/${earlier}/view`, "POST");
    expect(lost.status).toBe(503);
    expect(apiErrorOf(lost).code).toBe("studio_version_failed");
    expect(apiErrorOf(await message()).code).toBe("studio_viewing_version");
    agents.versions = usual;
    const read = await api<StudioVersions>(VERSIONS);
    expect(read.body.viewing).toMatchObject({ sha: earlier, subject: "Premier jet de la page" });
    expect((await api<StudioAppDetail>(`${ADDED}/preview/studio`)).body.viewing).toMatchObject({
      subject: "Premier jet de la page",
    });

    // Someone went back by hand: the folder is on its branch again, and messages go.
    agents.shown = null;
    expect((await api<StudioVersions>(VERSIONS)).body.viewing).toBeNull();
    expect((await message()).status).toBe(200);

    // A folder shown from elsewhere, say after the project was linked again, is followed too.
    agents.shown = earlier;
    expect((await api<StudioVersions>(VERSIONS)).body.viewing).toMatchObject({ sha: earlier, by: null });
    expect(apiErrorOf(await message()).code).toBe("studio_viewing_version");

    // A refusal leaves the folder, and the project's row, as they were.
    expect((await api(`${VERSIONS}/current`, "POST")).status).toBe(200);
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    agents.versions = (request) =>
      request.action === "view" ? { ok: false, code: "overwrite", files: [".env"] } : usual(request);
    const refused = await api(`${VERSIONS}/${earlier}/view`, "POST");
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_version_overwrite");
    expect((await api<StudioAppDetail>(`${ADDED}/preview/studio`)).body.viewing).toBeNull();
    expect((await message()).status).toBe(200);
  });

  it("asks the folder before a message brings an earlier version back", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const restore = () =>
      api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", {
        text: `Restaure la version du 15 nov.\n\n<version_restore>\nCommit: ${"a".repeat(40)}\n</version_restore>`,
      });
    const statuses = () =>
      agents.execs.filter((exec) => exec.script === "versions" && exec.input.action === "status").length;

    // The agent at work: it would write the folder under it.
    const working = await restore();
    expect(apiErrorOf(working).code).toBe("studio_agent_working");
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    const usual = agents.versions;
    agents.versions = (request) =>
      request.action === "status" ? { ok: false, code: "changed", files: ["src/App.tsx"] } : usual(request);
    const unsaved = await restore();
    expect(apiErrorOf(unsaved).code).toBe("studio_version_unsaved");
    agents.versions = usual;
    const before = statuses();
    expect((await restore()).status).toBe(200);
    expect(statuses()).toBe(before + 1);

    // Any other message goes without asking the folder.
    for (const conversation of agents.conversations.values()) {
      conversation.status = "finished";
    }
    expect(
      (await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Merci" })).status,
    ).toBe(200);
    expect(statuses()).toBe(before + 1);
  });

  it("leaves out a version whose date cannot be read", async () => {
    await addOwnProject();
    await startConversation(`${ADDED}/preview`, "Bonjour");
    agents.versions = () => ({
      ok: true,
      branch: "main",
      detached: false,
      shown: null,
      versions: [
        { sha: "c".repeat(40), at: 99_999_999_999_999, subject: "Du futur" },
        { sha: "a".repeat(40), at: 1_795_000_000, subject: "Premier jet de la page" },
      ],
    });
    const listed = await api<StudioVersions>(`${ADDED}/preview/studio/versions`);
    expect(listed.status).toBe(200);
    expect(listed.body.versions.map((one) => one.subject)).toEqual(["Premier jet de la page"]);
  });

  it("lists no version while the agent server sleeps, and never wakes it to", async () => {
    await addOwnProject();
    await startConversation(`${ADDED}/preview`, "Bonjour");
    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    const before = agents.execs.length;
    const listed = await api<StudioVersions>(`${ADDED}/preview/studio/versions`);
    expect(listed.body).toEqual({ versions: [], asleep: true, viewing: null });
    expect(agents.execs).toHaveLength(before);
  });

  it("keeps a file for a conversation under way with its agent server, and sets nothing up again", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const before = agents.execs.length;

    const saved = await call<StudioAttachment>(
      context.app,
      `/api/v1${ADDED}/preview/studio/attachments?name=notes.md&conversation=${id}`,
      {
        method: "POST",
        rawBody: new Blob(["# Notes"]),
        headers: { "content-type": "application/octet-stream" },
        cookie,
        origin: TEST_ORIGIN,
      },
    );
    expect(saved.status).toBe(201);
    const since = agents.execs.slice(before).map((exec) => exec.script);
    expect(since).toContain("attach");
    expect(since).not.toContain("seed-read");
    expect(since).not.toContain("seed-write");

    const unknown = await call(
      context.app,
      `/api/v1${ADDED}/preview/studio/attachments?name=notes.md&conversation=c0ffee00-0000-4000-8000-00000000ffff`,
      {
        method: "POST",
        rawBody: new Blob(["# Notes"]),
        headers: { "content-type": "application/octet-stream" },
        cookie,
        origin: TEST_ORIGIN,
      },
    );
    expect(unknown.status).toBe(404);
  });

  it("answers a page even when its copy cannot be written", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    context.deps.db.$client.exec("DROP TABLE studio_conversation_events");

    const page = await api<StudioEventPage>(`${ADDED}/preview/studio/conversations/${id}/events`);
    expect(page.status).toBe(200);
    expect(page.body.items.map((event) => event.id)).toEqual(["ev-0001", "ev-0002"]);
  });

  it("serves the copy page after page, and keeps its newest events", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const said = (n: number) => ({
      id: `r${n}`,
      kind: "MessageEvent",
      source: "user",
      timestamp: new Date(Date.UTC(2026, 10, 19, 13, 0, n)).toISOString(),
      llm_message: { role: "user", content: [{ type: "text", text: `Message ${n}` }] },
    });
    keepCopy(context.deps.db, id, undefined, [1, 2, 3, 4].map(said), 5);
    keepCopy(context.deps.db, id, "r4", [4, 5, 6, 7].map(said), 5);
    const read = (after: string | undefined) => readCopy(context.deps.db, id, after, null, undefined, 2);

    // The oldest two went past five; what is left comes two by two, as the agent server's pages do.
    expect(read(undefined)).toMatchObject({ cursor: "r4", more: true, asleep: true });
    expect(read(undefined).items.map((event) => event.id)).toEqual(["r3", "r4"]);
    expect(read("r4").items.map((event) => event.id)).toEqual(["r5", "r6"]);
    expect(read("r6")).toMatchObject({ cursor: "r7", more: false });
    expect(read("r6").items).toMatchObject([{ kind: "message", role: "user", text: "Message 7" }]);
    // An event it no longer holds gives nothing, and keeps the reader where it was.
    expect(read("r1")).toMatchObject({ items: [], cursor: "r1", more: false });
  });

  it("brings the copy up to date before an unused agent server sleeps", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    const events = `${ADDED}/preview/studio/conversations/${id}/events`;
    await api(events);
    // The agent goes on after the page was closed: nobody reads what follows.
    expect(
      (await api(`${ADDED}/preview/studio/conversations/${id}/messages`, "POST", { text: "Encore" })).status,
    ).toBe(200);
    const conversation = agents.conversations.get(id);
    if (conversation !== undefined) {
      conversation.status = "finished";
    }

    context.advance(AGENT_IDLE_MS + 1);
    expect(await stopIdleAgents(context.deps)).toEqual(["studio-un-mot-par-jour-landing/agent"]);
    await settle();

    const asleep = await api<StudioEventPage>(events);
    expect(asleep.body.asleep).toBe(true);
    expect(asleep.body.items.map((event) => event.id)).toEqual(["ev-0001", "ev-0002", "ev-0003", "ev-0004"]);
  });

  it("starts a stopped agent server for a message, never for a read", async () => {
    await addOwnProject();
    const { id } = await startConversation(`${ADDED}/preview`, "Bonjour");
    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    const before = (await api<ActionPage>("/actions?limit=100")).body.items.length;

    // Never read while it ran, the conversation has no copy yet: nothing shows until it wakes.
    const read = await api<StudioEventPage>(`${ADDED}/preview/studio/conversations/${id}/events`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ asleep: true, status: "idle", items: [], cursor: null });
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

  it("uses the Studio's GitHub key for the repository's owner, before the agent server's token", async () => {
    const keyToken = "github_pat_33CCCCCCC0the0owners0own0studio0key";
    expect(
      (await api("/settings/studio/github-keys", "POST", { owner: "mehdinajeddine", token: keyToken }))
        .status,
    ).toBe(201);
    const { path, token } = await relayOf();
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("001e# service=git-upload-pack\n", { status: 200 }));

    await context.app.request(`${PANEL}${path}/info/refs?service=git-upload-pack`, {
      headers: { authorization: basic(token) },
    });

    const sent = new Headers(fetched.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe(
      `Basic ${Buffer.from(`x-access-token:${keyToken}`).toString("base64")}`,
    );
    // The copy, when the project was added, got the same key on its standard input.
    const clone = agents.execs.find((exec) => exec.script === "clone");
    expect(clone?.input.token).toBe(keyToken);
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
    expect(await refused.text()).toContain(
      "add a GitHub key for mehdinajeddine in the Studio's settings, with access to this repository",
    );
  });

  it("falls back on the agent server's token when GitHub refuses the key, and keeps to it a while", async () => {
    const keyToken = "github_pat_44DDDDDDD0a0key0for0other0repositories";
    expect(
      (await api("/settings/studio/github-keys", "POST", { owner: "mehdinajeddine", token: keyToken }))
        .status,
    ).toBe(201);
    const { path, token } = await relayOf();
    const withKey = `Basic ${Buffer.from(`x-access-token:${keyToken}`).toString("base64")}`;
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const key = new Headers(init?.headers).get("authorization") === withKey;
      sent.push(key ? "key" : "agent server");
      return key
        ? new Response("Repository not found.", { status: 404 })
        : new Response("001e# service=git-upload-pack\n", { status: 200 });
    });
    const sentWith = () => [...sent];
    const refs = () =>
      context.app.request(`${PANEL}${path}/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic(token) },
      });

    expect((await refs()).status).toBe(200);
    expect(sentWith()).toEqual(["key", "agent server"]);

    // The rest of the exchange, and the next ones for a while, go with the agent server's token at once.
    const pack = await context.app.request(`${PANEL}${path}/git-upload-pack`, {
      method: "POST",
      headers: { authorization: basic(token), "content-type": "application/x-git-upload-pack-request" },
      body: "0000",
    });
    expect(pack.status).toBe(200);
    expect((await refs()).status).toBe(200);
    expect(sentWith()).toEqual(["key", "agent server", "agent server", "agent server"]);

    context.advance(10 * 60 * 1000 + 1);
    expect((await refs()).status).toBe(200);
    expect(sentWith().slice(4)).toEqual(["key", "agent server"]);
  });
});

describe("the Studio's GitHub keys, when a project is copied", () => {
  const KEY = "github_pat_55EEEEEEE0the0owners0narrow0studio0key";
  const addKey = async () =>
    expect(
      (await api("/settings/studio/github-keys", "POST", { owner: "mehdinajeddine", token: KEY })).status,
    ).toBe(201);
  const noAccess = (token: boolean): Raw => ({ ok: false, code: "no_access", token });

  it("copies with the agent server's token what GitHub refuses the key", async () => {
    await addKey();
    agents.clone = (request) =>
      request.token === undefined
        ? { ok: true, reused: false, uid: 10001, gid: 10001, branch: "main", manifest: true, vite: true }
        : noAccess(true);

    await addOwnProject();

    const clones = agents.execs.filter((exec) => exec.script === "clone");
    expect(clones.map((exec) => exec.input.token ?? null)).toEqual([KEY, null]);
  });

  it("says which token to change when neither reaches the repository", async () => {
    await addKey();
    agents.clone = () => noAccess(true);
    await prepareModel();
    await saveSettings({ agentPerProject: true });

    const refused = await api("/studio/projects", "POST", { repository: REPOSITORY });

    expect(refused.status).toBe(422);
    expect(apiErrorOf(refused).code).toBe("studio_repository_unreachable");
    expect(apiErrorOf(refused).message).toContain(
      "Neither the Studio's GitHub key for mehdinajeddine nor the agent server's token",
    );
  });

  it("are left out of a copy the shared agent server makes, which says so when GitHub refuses it", async () => {
    await addKey();
    await prepareModel();
    await saveSettings();

    expect((await api("/studio/projects", "POST", { repository: REPOSITORY })).status).toBe(201);
    const clone = agents.execs.find((exec) => exec.script === "clone");
    expect(clone?.service).toBe("lovable_openhands");
    expect(clone?.input.token).toBeUndefined();

    agents.clone = () => noAccess(true);
    const refused = await api("/studio/projects", "POST", {
      repository: "https://github.com/mehdinajeddine/private-site",
    });
    expect(refused.status).toBe(422);
    expect(apiErrorOf(refused).message).toContain(
      "The Studio's GitHub key for mehdinajeddine serves projects with an agent server of their own only.",
    );
  });
});

describe("bringing a project with its own agent server up to date with GitHub", () => {
  const KEY = "github_pat_55EEEEEEE0the0owners0narrow0studio0key";
  const current: Raw = {
    ok: true,
    state: "current",
    branch: "main",
    pulled: 0,
    behind: 0,
    ahead: 0,
    changed: 0,
    blocking: [],
    dependencies: false,
  };
  const updates = () => agents.execs.filter((exec) => exec.script === "sync");
  const sync = () => api<StudioSync>(`${ADDED}/preview/studio/sync?force=true`, "POST");

  it("runs in the project's own agent server, which reaches GitHub through the panel and holds no key", async () => {
    expect(
      (await api("/settings/studio/github-keys", "POST", { owner: "mehdinajeddine", token: KEY })).status,
    ).toBe(201);
    await addOwnProject();
    agents.sync = () => current;

    expect((await sync()).body.state).toBe("current");

    // Never the model's container, which holds every project's folder: what the folder's own settings
    // could make git do stays within the project.
    expect(updates()).toEqual([
      {
        service: OWN_AGENT,
        script: "sync",
        input: {
          relay: true,
          dir: "/projects/un-mot-par-jour-landing",
          url: "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git",
        },
      },
    ]);
  });

  it("stays in the project's own agent server when agents per project are turned off later", async () => {
    await addOwnProject();
    expect((await saveSettings({ agentPerProject: false })).status).toBe(200);
    agents.sync = () => current;

    expect((await sync()).body.state).toBe("current");
    // The project's agent still writes its folder: the model's container never runs its git.
    expect(updates().map((exec) => exec.service)).toEqual([OWN_AGENT]);
    expect(updates()[0]?.input.relay).toBe(true);
  });

  it("wakes the project's agent server, and waits for it", async () => {
    await addOwnProject();
    expect((await api(`${ADDED}/agent/stop`, "POST")).status).toBe(202);
    await settle();
    agents.sync = () => current;

    expect((await sync()).body.state).toBe("current");
    expect(updates().map((exec) => exec.service)).toEqual([OWN_AGENT]);
    expect((await api<{ stopped: boolean }>(`${ADDED}/agent`)).body.stopped).toBe(false);
  });

  const opened = () => api<StudioSync>(`${ADDED}/preview/studio/sync`, "POST");
  const actionTypes = async () =>
    (await api<ActionPage>("/actions?limit=100")).body.items.map((action) => action.type);

  it("says what came in, and records it", async () => {
    await addOwnProject();
    agents.sync = () => ({ ...current, state: "updated", pulled: 2 });

    expect((await opened()).body).toEqual({
      state: "updated",
      branch: "main",
      pulled: 2,
      behind: 0,
      ahead: 0,
      changed: 0,
      blocking: [],
      previewRestarted: false,
      reason: null,
    });
    expect(await actionTypes()).toContain("studio.sync");
  });

  it("shares one update between openings close together, and asks anew on demand", async () => {
    await addOwnProject();
    agents.sync = () => current;

    await Promise.all([opened(), opened()]);
    await opened();
    expect(updates()).toHaveLength(1);

    context.advance(16_000);
    await opened();
    expect(updates()).toHaveLength(2);
    await sync();
    expect(updates()).toHaveLength(3);
    // Nothing came in: nothing for the activity.
    expect(await actionTypes()).not.toContain("studio.sync");
  });

  it("asks again at once after an answer that was not good news, and says why", async () => {
    await addOwnProject();
    agents.sync = () => ({ ok: false, code: "no_access", branch: "main", token: false });

    expect((await opened()).body).toMatchObject({
      state: "unavailable",
      reason: "no_access",
      branch: "main",
    });
    await opened();
    expect(updates()).toHaveLength(2);
  });

  it("takes nothing it may not answer from the project's container", async () => {
    await addOwnProject();
    agents.sync = () => ({ ...current, state: "updated", branch: "main\nInjected title" });

    expect((await opened()).body).toMatchObject({ state: "unavailable", reason: "failed" });
    expect(await actionTypes()).not.toContain("studio.sync");
  });

  it("starts the preview again when the changes bring new packages", async () => {
    await addOwnProject();
    agents.sync = () => ({ ...current, state: "updated", pulled: 1, dependencies: true });

    expect((await opened()).body.previewRestarted).toBe(true);
    await settle();
    expect(await actionTypes()).toContain("service.restart");
  });

  it("brings the folder up to date before a stopped preview starts and installs its packages", async () => {
    await addOwnProject();
    expect((await api(`${ADDED}/preview/stop`, "POST")).status).toBe(202);
    await settle();
    agents.sync = () => ({ ...current, state: "updated", pulled: 1, dependencies: true });

    const started = await api<{ started: boolean }>(`${ADDED}/preview/studio/preview/start`, "POST");

    expect(started.body.started).toBe(true);
    expect(updates()).toHaveLength(1);
    await settle();
    // The start installs them: no restart on top of it.
    expect(await actionTypes()).not.toContain("service.restart");
  });

  it("only looks while the agent is at work, so that its folder does not move under it", async () => {
    await addOwnProject();
    await startConversation(`${ADDED}/preview`, "Bonjour");
    agents.sync = () => ({ ...current, state: "deferred", behind: 2 });

    const synced = await sync();

    expect(synced.body).toMatchObject({ state: "deferred", behind: 2 });
    expect(updates().at(-1)?.input.fetchOnly).toBe(true);
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
