import type {
  LinkStudioAppRequest,
  StudioAgent,
  StudioApp,
  StudioAppDetail,
  StudioCheck,
  StudioConversation,
  StudioEventPage,
  StudioOverview,
  StudioSettings,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest, conflict, notFound, serviceUnavailable } from "../../core/errors";
import { primaryUrl } from "../service-tabs/domains/service";
import { findService, type ServiceRecord } from "../services/repo";
import { requireService, type ServiceTarget } from "../services/service";
import { indexActiveActions, type LiveState, readLiveState, summarize } from "../services/status";
import { AGENT_KEY_PLACEHOLDER, callAgent, expectJson } from "./agent";
import { toStudioEvents, toStudioStatus } from "./events";
import * as repo from "./repo";
import { readStudioSettings, writeStudioSettings } from "./settings";

/** What the agent is told about where it is talked to from, on top of its profile's own instructions. */
const STUDIO_CONTEXT = [
  "<OPSIFIER_STUDIO>",
  "The user talks to you from Opsifier Studio. The project's live preview is shown next to this",
  "conversation and reloads by itself when a file changes, so never open it only to show it to the user:",
  "open it in your browser to check your own work. Keep your answers short and in the user's language,",
  "without technical jargon unless they ask for details.",
  "</OPSIFIER_STUDIO>",
].join("\n");

/** One page of events at a time: a busy agent's backlog arrives over several polls. */
const EVENT_PAGE_SIZE = 100;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

export interface StudioMessage {
  text: string;
  images: string[];
}

function requireAgent(deps: Pick<AppDeps, "db">): StudioAgent {
  const settings = readStudioSettings(deps);
  if (!settings.enabled) {
    throw conflict(
      "studio_disabled",
      "The Studio is turned off. An administrator turns it on in Settings, Studio.",
    );
  }
  if (settings.agent === null) {
    throw conflict("studio_agent_missing", "No agent server is set for the Studio, in Settings, Studio.");
  }
  return settings.agent;
}

const toConversation = (row: repo.StudioConversationRow): StudioConversation => ({
  id: row.id,
  title: row.title,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

function appView(
  deps: AppDeps,
  record: ServiceRecord,
  app: repo.StudioAppRow,
  live: LiveState,
  active: ReturnType<typeof indexActiveActions>,
): StudioApp {
  const last = repo.listConversations(deps.db, app.serviceId)[0];
  return {
    project: record.projectName,
    service: record.name,
    workspaceDir: app.workspaceDir,
    previewUrl: primaryUrl(deps.db, { projectName: record.projectName, serviceName: record.name }),
    previewStatus: summarize(deps, record, live, active).status,
    lastConversation: last === undefined ? null : toConversation(last),
  };
}

function requireLinked(
  deps: Pick<AppDeps, "db">,
  target: ServiceTarget,
): { record: ServiceRecord; app: repo.StudioAppRow } {
  const record = requireService(deps, target);
  const app = record.id === null ? undefined : repo.findApp(deps.db, record.id);
  if (app === undefined) {
    throw notFound("This service is not linked to the Studio.");
  }
  return { record, app };
}

function requireConversation(
  deps: Pick<AppDeps, "db">,
  target: ServiceTarget,
  id: string,
): repo.StudioConversationRow {
  const { app } = requireLinked(deps, target);
  const row = repo.findConversation(deps.db, app.serviceId, id);
  if (row === undefined) {
    throw notFound("This service has no such Studio conversation.");
  }
  return row;
}

export function getStudioSettings(deps: Pick<AppDeps, "db">): StudioSettings {
  return readStudioSettings(deps);
}

export function saveStudioSettings(
  deps: Pick<AppDeps, "db" | "now">,
  settings: StudioSettings,
): StudioSettings {
  if (
    settings.agent !== null &&
    findService(deps.db, settings.agent.project, settings.agent.service) === undefined
  ) {
    throw badRequest("studio_agent_unknown", "There is no such service.", {
      agent: "There is no such service",
    });
  }
  return writeStudioSettings(deps, settings);
}

/** Reaches the agent server the way every Studio request does, and says what stood in the way. */
export async function checkStudioAgent(deps: AppDeps): Promise<StudioCheck> {
  const { agent } = readStudioSettings(deps);
  if (agent === null) {
    return { reachable: false, version: null, message: "No agent server is set." };
  }
  try {
    const { keyFound, replies } = await callAgent(deps, agent, [
      { method: "GET", path: "/server_info" },
      { method: "GET", path: "/api/agent-profiles" },
    ]);
    const info = expectJson(replies[0], keyFound);
    expectJson(replies[1], keyFound);
    return { reachable: true, version: isRecord(info) ? stringOrNull(info.version) : null, message: null };
  } catch (error) {
    if (error instanceof AppError) {
      return { reachable: false, version: null, message: error.message };
    }
    throw error;
  }
}

export async function getStudioOverview(deps: AppDeps): Promise<StudioOverview> {
  const settings = readStudioSettings(deps);
  const linked = repo.listLinkedApps(deps.db);
  const live = linked.length === 0 ? null : await readLiveState(deps);
  const active = indexActiveActions(deps);
  const apps = linked.flatMap((app) => {
    const record = findService(deps.db, app.projectName, app.serviceName);
    return record === undefined || live === null ? [] : [appView(deps, record, app, live, active)];
  });
  return { enabled: settings.enabled, agentConfigured: settings.agent !== null, apps };
}

export async function getStudioApp(deps: AppDeps, target: ServiceTarget): Promise<StudioAppDetail> {
  const { record, app } = requireLinked(deps, target);
  const live = await readLiveState(deps);
  return {
    ...appView(deps, record, app, live, indexActiveActions(deps)),
    conversations: repo.listConversations(deps.db, app.serviceId).map(toConversation),
  };
}

export async function linkStudioApp(
  deps: AppDeps,
  target: ServiceTarget,
  request: LinkStudioAppRequest,
): Promise<StudioAppDetail> {
  const record = requireService(deps, target);
  if (record.id === null) {
    throw conflict("service_without_id", "This service has no identifier yet: deploy it once, then link it.");
  }
  repo.saveApp(deps.db, record.id, request.workspaceDir, new Date(deps.now()));
  return getStudioApp(deps, target);
}

export function unlinkStudioApp(deps: Pick<AppDeps, "db">, target: ServiceTarget): void {
  const { app } = requireLinked(deps, target);
  repo.deleteApp(deps.db, app.serviceId);
}

function messageContent(message: StudioMessage): unknown[] {
  return [
    ...(message.text.trim() === "" ? [] : [{ type: "text", text: message.text }]),
    ...message.images.map((url) => ({ type: "image", image_urls: [url] })),
  ];
}

/**
 * Starts a conversation on the project's folder with its first message, the way the agent server's
 * own interface does: with its active agent profile, and its secrets looked up by name.
 */
export async function startStudioConversation(
  deps: AppDeps,
  target: ServiceTarget,
  message: StudioMessage,
  actorEmail: string | undefined,
): Promise<StudioConversation> {
  const agent = requireAgent(deps);
  const { app } = requireLinked(deps, target);

  const setup = await callAgent(deps, agent, [
    { method: "GET", path: "/api/agent-profiles" },
    { method: "GET", path: "/api/settings/secrets" },
  ]);
  const profiles = expectJson(setup.replies[0], setup.keyFound);
  const secrets = expectJson(setup.replies[1], setup.keyFound);
  const profileId = isRecord(profiles) ? stringOrNull(profiles.active_agent_profile_id) : null;
  if (profileId === null) {
    throw serviceUnavailable("studio_agent_error", "The agent server has no active agent profile.");
  }
  const names = (isRecord(secrets) && Array.isArray(secrets.secrets) ? secrets.secrets : [])
    .map((secret) => (isRecord(secret) ? stringOrNull(secret.name) : null))
    .filter((name): name is string => name !== null);

  const started = await callAgent(deps, agent, [
    {
      method: "POST",
      path: "/api/conversations",
      body: {
        agent_profile_id: profileId,
        agent_launch_additions: { system_message_suffix_append: STUDIO_CONTEXT },
        workspace: { working_dir: app.workspaceDir, kind: "LocalWorkspace" },
        secrets: Object.fromEntries(
          names.map((name) => [
            name,
            {
              kind: "LookupSecret",
              url: `/api/settings/secrets/${encodeURIComponent(name)}`,
              headers: { "X-Session-API-Key": AGENT_KEY_PLACEHOLDER },
            },
          ]),
        ),
        initial_message: { role: "user", content: messageContent(message), run: true },
        autotitle: true,
      },
    },
  ]);
  const conversation = expectJson(started.replies[0], started.keyFound);
  const id = isRecord(conversation) ? stringOrNull(conversation.id) : null;
  if (id === null) {
    throw serviceUnavailable(
      "studio_agent_error",
      "The agent server did not say which conversation it started.",
    );
  }

  const now = new Date(deps.now());
  const row: repo.StudioConversationRow = {
    id,
    serviceId: app.serviceId,
    title: isRecord(conversation) ? stringOrNull(conversation.title) : null,
    createdBy: actorEmail ?? null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertConversation(deps.db, row);
  deps.actions.record({
    type: "studio.conversation",
    title: `Start a Studio conversation on ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return toConversation(row);
}

export async function sendStudioMessage(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  message: StudioMessage,
): Promise<StudioConversation> {
  const agent = requireAgent(deps);
  const row = requireConversation(deps, target, id);
  const { keyFound, replies } = await callAgent(deps, agent, [
    {
      method: "POST",
      path: `/api/conversations/${id}/events`,
      body: { role: "user", content: messageContent(message), run: true },
    },
  ]);
  expectJson(replies[0], keyFound);
  const updatedAt = new Date(deps.now());
  repo.updateConversation(deps.db, id, { updatedAt });
  return toConversation({ ...row, updatedAt });
}

export async function stopStudioConversation(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
): Promise<StudioConversation> {
  const agent = requireAgent(deps);
  const row = requireConversation(deps, target, id);
  const { keyFound, replies } = await callAgent(deps, agent, [
    { method: "POST", path: `/api/conversations/${id}/pause` },
  ]);
  expectJson(replies[0], keyFound);
  return toConversation(row);
}

/** The events after `after`, with the conversation's status and title. */
export async function getStudioEvents(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  after: string | undefined,
): Promise<StudioEventPage> {
  const agent = requireAgent(deps);
  const row = requireConversation(deps, target, id);
  const query = new URLSearchParams({ limit: String(EVENT_PAGE_SIZE), sort_order: "TIMESTAMP" });
  if (after !== undefined) {
    // The page starts with the event it is given, which the caller already has.
    query.set("page_id", after);
  }
  const { keyFound, replies } = await callAgent(deps, agent, [
    { method: "GET", path: `/api/conversations/${id}` },
    { method: "GET", path: `/api/conversations/${id}/events/search?${query}` },
  ]);
  const conversation = expectJson(replies[0], keyFound);
  const page = expectJson(replies[1], keyFound);
  const raws = isRecord(page) && Array.isArray(page.items) ? page.items.filter(isRecord) : [];
  const fresh = after !== undefined && raws[0]?.id === after ? raws.slice(1) : raws;
  const lastId = stringOrNull(raws.at(-1)?.id) ?? after ?? null;

  const title = isRecord(conversation) ? stringOrNull(conversation.title) : null;
  if (title !== null && title !== row.title) {
    repo.updateConversation(deps.db, id, { title });
  }
  return {
    items: toStudioEvents(fresh),
    cursor: lastId,
    status: toStudioStatus(isRecord(conversation) ? conversation.execution_status : null),
    title,
  };
}
