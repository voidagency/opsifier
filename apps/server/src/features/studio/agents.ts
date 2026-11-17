import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StudioAgent, StudioAgentMode, StudioSettings } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { AppError, conflict, serviceUnavailable } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { findProject } from "../projects/repo";
import { getPanelDomainSettings } from "../server/settings";
import { deleteDomain } from "../service-tabs/domains/changes";
import { listDomainRows } from "../service-tabs/domains/service";
import { qualifiedName } from "../services/compile";
import { sealEnv } from "../services/env-store";
import { enqueueDeploy, enqueueRestart, enqueueStart, enqueueStop } from "../services/lifecycle";
import { findService, findServiceById, type ServiceRecord, saveServiceSpec } from "../services/repo";
import { createService, requireService, type ServiceTarget } from "../services/service";
import { indexActiveActions } from "../services/status";
import { callAgent } from "./agent";
import { toStudioStatus } from "./events";
import * as repo from "./repo";
import { readStudioSettings } from "./settings";

/**
 * One agent server per project. Each Studio project then lives in an Opsifier project of its own,
 * `studio-<folder>`, with two services: its preview and its agent server. The project's network
 * keeps the agent away from every other service, its only folder of the server is its project's,
 * and it holds no GitHub token: its git goes through the panel, which adds the token for this one
 * repository. The agent server named in the Studio's settings is the model: each project's is built
 * like it and starts with a copy of its settings and models, never its secrets.
 */

export const OWN_PREVIEW = "preview";
export const OWN_AGENT = "agent";
const PROJECT_PREFIX = "studio-";

/** Whether a project's name is one the Studio gives the projects it makes. */
export const isStudioProjectName = (project: string): boolean => project.startsWith(PROJECT_PREFIX);
/** The longest Opsifier project name. */
const MAX_PROJECT = 40;
/** An agent server runs a browser for its screenshots, next to the model's client. */
const AGENT_RESOURCES = { memoryReservation: 0, memoryLimit: 4096, cpuReservation: 0, cpuLimit: 2 };
/** Where the panel answers each project's agent server for its git. */
export const GIT_RELAY_PREFIX = "/api/v1/studio/git";
const TOKEN_ENV = "OPSIFIER_STUDIO_GIT_TOKEN";
/** What `git` sends as the user name to the panel. Anything else would do: the token is the check. */
const RELAY_USER = "opsifier-studio";

/** An unused agent server is stopped after this long, unless one of its conversations is at work. */
export const AGENT_IDLE_MS = 45 * 60_000;
const SWEEP_MS = 5 * 60_000;

/** The agent server shared by every project, as the Studio's settings name it, with what is known of it. */
export interface Model {
  agent: StudioAgent & { projectsDir: string };
  record: ServiceRecord;
  /** Where it keeps its settings, inside its container. */
  stateDir: string;
}

const starting = () =>
  conflict(
    "studio_agent_starting",
    "The project's agent server is starting: try again in a few seconds. If it lasts, an administrator looks at the project's agent service.",
  );

/** Which agent server works on a project. */
export function agentModeOf(
  deps: Pick<AppDeps, "db">,
  settings: StudioSettings,
  app: Pick<repo.StudioAppRow, "agentServiceId">,
): StudioAgentMode {
  if (!settings.agentPerProject) {
    return "shared";
  }
  return app.agentServiceId !== null && findServiceById(deps.db, app.agentServiceId) !== undefined
    ? "own"
    : "missing";
}

/** The project's own agent server, reached as the model is, in its own service's container. */
export const ownAgentOf = (model: StudioAgent, record: ServiceRecord): StudioAgent => ({
  ...model,
  project: record.projectName,
  service: record.name,
});

/**
 * Where an OpenHands agent server keeps its settings: next to its key file, `<state>/agent-canvas/
 * api-key.txt`, or in its volume at `~/.openhands`. Each project's agent server gets the same volumes,
 * so the same folder.
 */
export function stateDirOf(record: ServiceRecord, agent: StudioAgent): string {
  const suffix = "/agent-canvas/api-key.txt";
  const volumes = record.spec.mounts.filter((mount) => mount.type === "volume");
  const fromKey = agent.keyFile?.endsWith(suffix) ? agent.keyFile.slice(0, -suffix.length) : null;
  const kept = (path: string) =>
    volumes.some((mount) => path === mount.mountPath || path.startsWith(`${mount.mountPath}/`));
  if (fromKey !== null && kept(fromKey)) {
    return fromKey;
  }
  const home = volumes.find((mount) => mount.mountPath.endsWith("/.openhands"));
  if (home !== undefined) {
    return home.mountPath;
  }
  throw conflict(
    "studio_agent_state_unknown",
    "The agent server's settings are not in a volume of its service, so they cannot be copied to each project's: keep its ~/.openhands folder in a volume, and its key file there.",
  );
}

/** The model every project's agent server is copied from, refused early when it cannot be. */
export function requireModel(deps: Pick<AppDeps, "db">, settings = readStudioSettings(deps)): Model {
  const agent = settings.agent;
  if (!settings.enabled || agent === null) {
    throw conflict("studio_off", "Turn the Studio on and choose its agent server first.");
  }
  if (agent.projectsDir === null) {
    throw conflict(
      "studio_projects_unset",
      "Set the Studio's projects folder first, in its settings: where projects go in the agent server's container.",
    );
  }
  const record = findService(deps.db, agent.project, agent.service);
  if (record === undefined) {
    throw conflict("studio_agent_unknown", `There is no service ${agent.project}/${agent.service}.`);
  }
  if (agent.keyFile === null) {
    // Its variables are not copied, since they may hold secrets: each copy makes its own key in its file.
    throw conflict(
      "studio_agent_key_file_required",
      "Each project's agent server makes its own key in its key file: name the agent server's key file in the Studio's settings, rather than a key in SESSION_API_KEY.",
    );
  }
  const source = record.spec.source;
  if (source === null || (source.type !== "image" && source.type !== "dockerfile")) {
    throw conflict(
      "studio_agent_source_unsupported",
      "Each project's agent server is built like the Studio's, so that service must run an image or a Dockerfile.",
    );
  }
  return { agent: { ...agent, projectsDir: agent.projectsDir }, record, stateDir: stateDirOf(record, agent) };
}

/** The panel's own address, which each project's agent server reaches for its git. */
export function requirePanelUrl(deps: AppDeps): string {
  const url = getPanelDomainSettings(deps).url;
  if (url === null) {
    throw conflict(
      "studio_panel_address_unset",
      "Give the panel an address of its own first, in Settings: each project's agent server reaches GitHub through it.",
    );
  }
  return url.replace(/\/+$/, "");
}

/** A free name for a project's agent server in an Opsifier project the Studio did not make. */
export function freeAgentName(deps: Pick<AppDeps, "db">, project: string): string {
  for (const name of [
    OWN_AGENT,
    "studio-agent",
    ...Array.from({ length: 18 }, (_, index) => `studio-agent-${index + 2}`),
  ]) {
    if (findService(deps.db, project, name) === undefined) {
      return name;
    }
  }
  throw conflict("studio_agent_name_taken", `Every name for an agent server in ${project} is taken.`);
}

/** An Opsifier project's name for a Studio project, free on this server: `studio-<folder>`. */
export function ownProjectName(deps: Pick<AppDeps, "db">, folder: string): string {
  const clean =
    folder
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const name = `${`${PROJECT_PREFIX}${clean}`.slice(0, MAX_PROJECT - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (findProject(deps.db, name) === undefined) {
      return name;
    }
  }
  throw conflict("studio_project_name_taken", `Every name for ${folder}'s own Opsifier project is taken.`);
}

export const newGitToken = (): string => randomBytes(32).toString("base64url");
export const hashGitToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Whether a token is the one whose hash is kept, compared in constant time. */
export function gitTokenMatches(token: string, hash: string | null): boolean {
  if (hash === null || token === "") {
    return false;
  }
  const given = Buffer.from(hashGitToken(token), "hex");
  const kept = Buffer.from(hash, "hex");
  return given.length === kept.length && timingSafeEqual(given, kept);
}

/** The addresses a copy of this repository may know its GitHub remote by. */
export function remoteAddresses(slug: string, origin: string | null): string[] {
  const known = [
    `https://github.com/${slug}.git`,
    `https://github.com/${slug}`,
    `git@github.com:${slug}.git`,
    `git@github.com:${slug}`,
  ];
  // An address with a user or a token in it is left out: it is never repeated anywhere.
  if (origin !== null && origin !== "" && !/^[a-z]+:\/\/[^/]*@/i.test(origin) && !known.includes(origin)) {
    known.push(origin);
  }
  return known;
}

/**
 * The variables that send the agent server's git to the panel: its GitHub remote is read as the
 * panel's address for the project, where a credential helper gives the token the panel knows it by.
 * Helpers set anywhere else in the container or the repository are dropped first. Nothing here is
 * GitHub's: the token opens this one repository, through the panel, and nothing more.
 */
export function ownAgentEnv(
  panelUrl: string,
  appId: string,
  addresses: readonly string[],
  token: string,
): string {
  const relay = `${panelUrl}${GIT_RELAY_PREFIX}/${appId}.git`;
  const entries: Array<[string, string]> = [
    ["credential.helper", ""],
    [
      `credential.${new URL(panelUrl).origin}.helper`,
      `!f() { test "$1" = get && echo username=${RELAY_USER} && echo password=$${TOKEN_ENV}; }; f`,
    ],
    ...addresses.map((address): [string, string] => [`url.${relay}.insteadOf`, address]),
  ];
  return [
    `${TOKEN_ENV}=${token}`,
    "GIT_TERMINAL_PROMPT=0",
    `GIT_CONFIG_COUNT=${entries.length}`,
    ...entries.flatMap(([key, value], index) => [
      `GIT_CONFIG_KEY_${index}=${key}`,
      `GIT_CONFIG_VALUE_${index}=${value}`,
    ]),
    "",
  ].join("\n");
}

export interface OwnAgentOptions {
  project: string;
  /** The agent server's service name: `agent` in a project the Studio made, a free one elsewhere. */
  name?: string;
  model: Model;
  /** The project's folder on the server, and where the agent server sees it. */
  hostDir: string;
  workspaceDir: string;
  /** The Studio project's identifier, its preview's: the panel's git address for it names it. */
  appId: string;
  addresses: readonly string[];
  token: string;
  actorEmail: string | undefined;
}

/**
 * Makes a project's agent server: built like the model, with fresh volumes of the same names, the
 * project's folder as its only folder of the server, no address of its own, and its git sent to the
 * panel. Nothing is deployed here; its settings are copied when it is first used.
 */
export async function createOwnAgent(deps: AppDeps, options: OwnAgentOptions): Promise<ServiceRecord> {
  const { model } = options;
  const panel = requirePanelUrl(deps);
  const name = options.name ?? OWN_AGENT;
  const target = { projectName: options.project, serviceName: name };
  await createService(deps, options.project, { name, type: "app" }, options.actorEmail);
  // The panel talks to it from inside its container: nothing outside needs to reach it.
  for (const row of listDomainRows(deps.db, target)) {
    await deleteDomain(deps, target, row.id);
  }
  const fresh = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    options.project,
    name,
    {
      ...fresh.spec,
      source: model.record.spec.source,
      build: { ...fresh.spec.build, config: model.record.spec.build.config },
      sealedEnv: sealEnv(deps, ownAgentEnv(panel, options.appId, options.addresses, options.token)),
      deploy: { ...model.record.spec.deploy, replicas: 1 },
      resources: AGENT_RESOURCES,
      mounts: [
        ...model.record.spec.mounts.filter((mount) => mount.type === "volume"),
        {
          type: "bind",
          hostPath: options.hostDir,
          mountPath: options.workspaceDir,
          acknowledgeRisk: false,
        },
      ],
    },
    new Date(deps.now()),
  );
  return requireService(deps, target);
}

const SEED_PREFIX = "opsifier-studio-seed ";
/**
 * What a project's agent server copies of the model's settings. Its secrets stay where they are, and so
 * do its standing instructions: written for the model's own place, they would send a project's agent
 * to previews and folders it does not have. The Studio tells each conversation what it needs.
 */
const SEED_FILES = [
  "settings.json",
  "profiles",
  "agent-profiles",
  "meta-profiles",
  "agent-canvas/secret-key.txt",
];
/** Folders whose files the model no longer has are removed from the copy too. */
const SEED_FOLDERS = ["profiles", "agent-profiles", "meta-profiles"];
const SEED_TIMEOUT_MS = 30_000;

/**
 * Runs in the model's container: packs its settings, models and agent profiles, with the key their
 * stored keys are encrypted with, and a digest of them all, in base64 lines short enough to come back
 * whole. Lock files are left out, and so are the standing instructions in its JSON files.
 */
export const SEED_READ_SCRIPT = `
import base64, hashlib, io, json, os, sys, tarfile
request = json.load(sys.stdin)
state = request["state"]
STANDING = {"system_message_suffix", "user_message_suffix"}
def without_standing(node):
    if isinstance(node, dict):
        return {key: without_standing(value) for key, value in node.items() if key not in STANDING}
    if isinstance(node, list):
        return [without_standing(value) for value in node]
    return node
digest = hashlib.sha256()
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
    for name in request["files"]:
        path = os.path.join(state, name)
        if os.path.isdir(path):
            found = []
            for root, dirs, files in os.walk(path):
                dirs.sort()
                found += [os.path.join(root, file) for file in sorted(files) if not file.startswith(".")]
        elif os.path.isfile(path):
            found = [path]
        else:
            found = []
        for full in found:
            relative = os.path.relpath(full, state)
            with open(full, "rb") as handle:
                data = handle.read()
            if relative.endswith(".json"):
                try:
                    data = json.dumps(without_standing(json.loads(data)), indent=2).encode()
                except ValueError:
                    pass
            digest.update(relative.encode() + b"\\0" + data + b"\\0")
            info = tarfile.TarInfo(relative)
            info.size = len(data)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))
encoded = base64.b64encode(buffer.getvalue()).decode()
for start in range(0, len(encoded), 30000):
    print(${JSON.stringify(SEED_PREFIX)} + "archive " + encoded[start:start + 30000])
print(${JSON.stringify(SEED_PREFIX)} + "digest " + digest.hexdigest())
print("opsifier-ok")
`;

/**
 * Runs in a project's agent server's container: writes the model's copy over its own, unless it
 * holds that copy already, and removes what the model no longer has. Each file is written whole,
 * then put in place, so that the agent server never reads half of one.
 */
export const SEED_WRITE_SCRIPT = `
import base64, io, json, os, sys, tarfile
request = json.load(sys.stdin)
state = request["state"]
marker = os.path.join(state, ".opsifier-studio-seed")
try:
    with open(marker) as handle:
        current = handle.read().strip()
except OSError:
    current = ""
if current == request["digest"]:
    print(${JSON.stringify(SEED_PREFIX)} + "same")
    print("opsifier-ok")
    sys.exit(0)
def key_now():
    try:
        with open(os.path.join(state, "agent-canvas", "secret-key.txt"), "rb") as handle:
            return handle.read()
    except OSError:
        return b""
key_before = key_now()
written = set()
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(request["archive"])), mode="r:gz") as archive:
    for member in archive.getmembers():
        parts = member.name.split("/")
        if not member.isfile() or member.name.startswith("/") or ".." in parts:
            continue
        target = os.path.join(state, member.name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        data = archive.extractfile(member).read()
        temporary = target + ".opsifier-tmp"
        with open(temporary, "wb") as handle:
            handle.write(data)
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
        written.add(member.name)
for folder in request["folders"]:
    path = os.path.join(state, folder)
    if not os.path.isdir(path):
        continue
    for file in os.listdir(path):
        full = os.path.join(path, file)
        if not file.startswith(".") and os.path.isfile(full) and folder + "/" + file not in written:
            os.remove(full)
with open(marker, "w") as handle:
    handle.write(request["digest"])
print(${JSON.stringify(SEED_PREFIX)} + ("written key-changed" if key_now() != key_before else "written"))
print("opsifier-ok")
`;

interface SeedCopy {
  archive: string;
  digest: string;
}

/** The model's settings, packed in its container. */
export function readSeed(output: string): SeedCopy | null {
  const lines = output
    .split("\n")
    .filter((line) => line.startsWith(SEED_PREFIX))
    .map((line) => line.slice(SEED_PREFIX.length).trim());
  const digest = lines.find((line) => line.startsWith("digest "))?.slice("digest ".length);
  if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) {
    return null;
  }
  const archive = lines
    .filter((line) => line.startsWith("archive "))
    .map((line) => line.slice("archive ".length))
    .join("");
  return { archive, digest };
}

/**
 * Copies the model's settings, models and agent profiles into a project's agent server, when it does
 * not hold that copy already. The agent server reads those files as it needs them, but may read the
 * key their stored keys are encrypted with only as it starts: true when that key changed, which the
 * first copy into a new agent server always does.
 */
export async function seedOwnAgent(
  deps: Pick<AppDeps, "docker">,
  model: Model,
  agent: StudioAgent,
): Promise<boolean> {
  let packed: Awaited<ReturnType<typeof runInDatabase>>;
  try {
    packed = await runInDatabase(
      deps,
      qualifiedName(model.agent.project, model.agent.service),
      {
        command: ["python3", "-c", SEED_READ_SCRIPT],
        stdin: JSON.stringify({ state: model.stateDir, files: SEED_FILES }),
      },
      { timeoutMs: SEED_TIMEOUT_MS, maxOutputChars: 8 * 1024 * 1024 },
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${model.agent.project}/${model.agent.service} is not running: each project's agent server is copied from it.`,
      );
    }
    throw error;
  }
  const copy = packed.ok ? readSeed(packed.output) : null;
  if (copy === null) {
    throw serviceUnavailable("studio_agent_unavailable", "The agent server's settings could not be read.");
  }

  let written: Awaited<ReturnType<typeof runInDatabase>>;
  try {
    written = await runInDatabase(
      deps,
      qualifiedName(agent.project, agent.service),
      {
        command: ["python3", "-c", SEED_WRITE_SCRIPT],
        stdin: JSON.stringify({
          state: model.stateDir,
          digest: copy.digest,
          archive: copy.archive,
          folders: SEED_FOLDERS,
        }),
      },
      { timeoutMs: SEED_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw starting();
    }
    throw error;
  }
  if (!written.ok || !written.output.includes(SEED_PREFIX)) {
    throw starting();
  }
  return written.output.includes("key-changed");
}

const lastActivity = new Map<string, number>();

/** Someone works on the project: its agent server stays up for {@link AGENT_IDLE_MS} more. */
export function noteAgentActivity(serviceId: string, now: number): void {
  lastActivity.set(serviceId, now);
}

/** For tests: nothing is remembered. */
export function forgetAgentActivity(): void {
  lastActivity.clear();
}

const targetOf = (record: ServiceRecord): ServiceTarget => ({
  projectName: record.projectName,
  serviceName: record.name,
});

/**
 * Brings a Studio service up: its first deployment when it never had one, a start when it is stopped.
 * True when something was asked for, or is under way already: a deployment, start or stop of it that
 * has not finished is waited for, never asked for twice.
 */
export async function wakeService(
  deps: AppDeps,
  record: ServiceRecord,
  actorEmail: string | undefined,
): Promise<boolean> {
  if (indexActiveActions(deps).has(`${record.projectName}/${record.name}`)) {
    return true;
  }
  if (record.deployed === null) {
    if (repo.lastDeployFailed(deps.db, record.projectName, record.name)) {
      throw conflict(
        "studio_deploy_failed",
        `${record.projectName}/${record.name} could not be deployed: an administrator looks at its last deployment, then deploys it again.`,
      );
    }
    enqueueDeploy(deps, targetOf(record), actorEmail);
    return true;
  }
  if (!record.spec.stopped) {
    return false;
  }
  try {
    await enqueueStart(deps, targetOf(record), actorEmail);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "service_running") {
      return false;
    }
    throw error;
  }
}

/** Starts a project's agent server, or does nothing when it runs or is on its way already. */
export async function startOwnAgent(
  deps: AppDeps,
  record: ServiceRecord,
  actorEmail: string | undefined,
): Promise<boolean> {
  if (record.id !== null) {
    noteAgentActivity(record.id, deps.now());
  }
  return wakeService(deps, record, actorEmail);
}

/**
 * The project's own agent server, running and holding the model's settings, for a conversation to
 * start on. A stopped one is started, and the caller is told to try again in a moment.
 */
export async function ensureOwnAgent(
  deps: AppDeps,
  model: Model,
  app: Pick<repo.StudioAppRow, "agentServiceId">,
  actorEmail: string | undefined,
): Promise<StudioAgent> {
  const record = app.agentServiceId === null ? undefined : findServiceById(deps.db, app.agentServiceId);
  if (record === undefined) {
    throw conflict(
      "studio_project_agent_missing",
      "This project waits for an agent server of its own: an administrator gives it one from the Studio's settings.",
    );
  }
  if (await startOwnAgent(deps, record, actorEmail)) {
    throw starting();
  }
  const agent = ownAgentOf(model.agent, record);
  // Copied only once it answers: a server still starting would write its own settings over the copy.
  await probeOwnAgent(deps, agent);
  if (await seedOwnAgent(deps, model, agent)) {
    await enqueueRestart(deps, targetOf(record), actorEmail);
    throw starting();
  }
  return agent;
}

/** Whether a project's agent server answers yet: one whose container runs may still be starting. */
export async function probeOwnAgent(deps: AppDeps, agent: StudioAgent): Promise<void> {
  try {
    const { replies } = await callAgent(deps, agent, [{ method: "GET", path: "/server_info" }]);
    if (replies[0] === undefined || replies[0].status === 0) {
      throw starting();
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === "studio_agent_not_running" || error.code === "studio_agent_unavailable")
    ) {
      throw starting();
    }
    throw error;
  }
}

/**
 * A project's agent server that runs, for reading what it holds: one that is stopped, or on its way
 * up or down, is not started for a read. Someone reading a conversation keeps no agent server up.
 */
export function awakeOwnAgent(deps: AppDeps, model: StudioAgent, record: ServiceRecord): StudioAgent {
  if (
    record.deployed === null ||
    record.spec.stopped ||
    indexActiveActions(deps).has(`${record.projectName}/${record.name}`)
  ) {
    throw conflict(
      "studio_agent_asleep",
      "The project's agent server is not running: send a message, or open the project again, to start it.",
    );
  }
  return ownAgentOf(model, record);
}

/** Whether one of the project's recent conversations with its own agent server is at work. */
export async function isWorking(deps: AppDeps, agent: StudioAgent, appId: string): Promise<boolean> {
  const recent = repo
    .listConversations(deps.db, appId)
    .filter((conversation) => !conversation.sharedAgent)
    .slice(0, 5);
  if (recent.length === 0) {
    return false;
  }
  try {
    const { replies } = await callAgent(
      deps,
      agent,
      recent.map((conversation) => ({
        method: "GET" as const,
        path: `/api/conversations/${conversation.id}`,
        shape: "conversation" as const,
      })),
    );
    return replies.some((reply) => {
      if (reply.status !== 200) {
        return false;
      }
      try {
        // One waiting for a confirmation is idle: its state is kept, and it resumes after a start.
        return (
          toStudioStatus((JSON.parse(reply.text) as { execution_status?: unknown }).execution_status) ===
          "running"
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Stops the projects' agent servers nobody has used for {@link AGENT_IDLE_MS}, unless one of their
 * conversations is at work. One seen running for the first time gets its full time.
 */
export async function stopIdleAgents(deps: AppDeps): Promise<string[]> {
  const settings = readStudioSettings(deps);
  if (!settings.enabled || !settings.agentPerProject || settings.agent === null) {
    return [];
  }
  const now = deps.now();
  const stopped: string[] = [];
  for (const app of repo.listLinkedApps(deps.db)) {
    const record = app.agentServiceId === null ? undefined : findServiceById(deps.db, app.agentServiceId);
    if (
      record?.id == null ||
      record.deployed === null ||
      record.spec.stopped ||
      indexActiveActions(deps).has(`${record.projectName}/${record.name}`)
    ) {
      continue;
    }
    const last = lastActivity.get(record.id);
    if (last === undefined) {
      lastActivity.set(record.id, now);
      continue;
    }
    if (now - last < AGENT_IDLE_MS) {
      continue;
    }
    if (await isWorking(deps, ownAgentOf(settings.agent, record), app.serviceId)) {
      lastActivity.set(record.id, deps.now());
      continue;
    }
    // Someone may have sent a message while the agent server was asked.
    if (deps.now() - (lastActivity.get(record.id) ?? 0) < AGENT_IDLE_MS) {
      continue;
    }
    try {
      await enqueueStop(deps, targetOf(record), undefined);
      lastActivity.delete(record.id);
      stopped.push(`${record.projectName}/${record.name}`);
    } catch (error) {
      deps.logger.warn({ err: error, ...targetOf(record) }, "Could not stop an unused Studio agent server");
    }
  }
  return stopped;
}

/** Looks for unused agent servers every few minutes. Returns what stops it. */
export function startIdleAgentSweeper(deps: AppDeps): () => void {
  const timer = setInterval(() => {
    stopIdleAgents(deps).catch((error: unknown) => {
      deps.logger.warn({ err: error }, "Could not look for unused Studio agent servers");
    });
  }, SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
