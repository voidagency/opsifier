import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { conflict, serviceUnavailable } from "../../core/errors";
import type { Access } from "../access/rules";
import { runInDatabase } from "../databases/exec";
import { removeProjectNetwork } from "../projects/network";
import { deleteProject } from "../projects/repo";
import { createProject } from "../projects/service";
import { getPanelDomainSettings } from "../server/settings";
import { createFromDefinition } from "../service-definition/service";
import { qualifiedName } from "../services/compile";
import { enqueueDeploy } from "../services/lifecycle";
import { deleteServiceRow, type ServiceRecord } from "../services/repo";
import { requireService } from "../services/service";
import {
  createOwnAgent,
  hashGitToken,
  type Model,
  newGitToken,
  OWN_AGENT,
  OWN_PREVIEW,
  ownProjectName,
  remoteAddresses,
} from "./agents";
import { inspectorEnv, PREVIEW_RESOURCES, previewDockerfile } from "./preview";

const FOLDER_PREFIX = "opsifier-studio-folder ";
const FOLDER_TIMEOUT_MS = 30_000;

/**
 * Runs in the model's container: what a project's folder holds, its GitHub remote, whether it is a
 * Vite project, as whom the agent server writes there, and which of its git settings hold a
 * credential: a user or token in a remote's address or a rewrite, an extra header, a credential file.
 * Only the settings' names come back, never their values. The request comes on standard input.
 */
export const FOLDER_SCRIPT = `
import json, os, re, subprocess, sys
request = json.load(sys.stdin)
target = request["dir"]
origin = ""
credentials = []
if os.path.isdir(os.path.join(target, ".git")):
    origin = subprocess.run(["git", "-C", target, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    listed = subprocess.run(["git", "-C", target, "config", "--local", "--list"], capture_output=True, text=True).stdout
    for line in listed.splitlines():
        key, _, value = line.partition("=")
        name = key.lower()
        if name.startswith("http.") and name.endswith(".extraheader"):
            credentials.append(key)
        elif name.startswith("remote.") or name.startswith("url."):
            if re.search(r"[a-z][a-z0-9+.-]*://(?!git@)[^/@\\s]+@", key + " " + value, re.I):
                credentials.append(key)
        elif name.startswith("credential") and name.endswith("helper") and "--file" in value:
            credentials.append(key)
packages = {}
try:
    with open(os.path.join(target, "package.json")) as handle:
        manifest = json.load(handle)
    for field in ("dependencies", "devDependencies"):
        if isinstance(manifest.get(field), dict):
            packages.update(manifest[field])
except Exception:
    pass
print(${JSON.stringify(FOLDER_PREFIX)} + json.dumps({"exists": os.path.isdir(target), "origin": origin, "uid": os.getuid(), "gid": os.getgid(), "vite": "vite" in packages, "credentials": sorted(set(credentials))}))
print("opsifier-ok")
`;

export interface FolderReport {
  exists: boolean;
  origin: string;
  uid: number;
  gid: number;
  vite: boolean;
  /** The names of the git settings that hold a credential. */
  credentials: string[];
}

export function readFolderReport(output: string): FolderReport | null {
  const line = output
    .split("\n")
    .reverse()
    .find((one) => one.startsWith(FOLDER_PREFIX));
  if (line === undefined) {
    return null;
  }
  try {
    const report = JSON.parse(line.slice(FOLDER_PREFIX.length)) as FolderReport;
    return { ...report, credentials: Array.isArray(report.credentials) ? report.credentials : [] };
  } catch {
    return null;
  }
}

/** What a project's folder holds, looked at from inside the model's container. */
export async function inspectFolder(deps: AppDeps, model: Model, dir: string): Promise<FolderReport> {
  let outcome: Awaited<ReturnType<typeof runInDatabase>>;
  try {
    outcome = await runInDatabase(
      deps,
      qualifiedName(model.agent.project, model.agent.service),
      { command: ["python3", "-c", FOLDER_SCRIPT], stdin: JSON.stringify({ dir }) },
      { timeoutMs: FOLDER_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${model.agent.project}/${model.agent.service} is not running.`,
      );
    }
    throw error;
  }
  const report = outcome.ok ? readFolderReport(outcome.output) : null;
  if (report === null) {
    throw serviceUnavailable(
      "studio_agent_unavailable",
      "The agent server's container did not look at the folder.",
    );
  }
  return report;
}

/**
 * A folder whose git settings hold a credential is refused: the project's own agent server would read
 * it, and reach GitHub with it rather than through the panel.
 */
export function requireNoCredentials(report: FolderReport, dir: string): void {
  if (report.credentials.length > 0) {
    throw conflict(
      "studio_folder_credentials",
      `The git settings of ${dir} hold a credential (${report.credentials.join(", ")}): remove it, then try again. A project's own agent server reaches GitHub through the panel only.`,
    );
  }
}

export interface OwnProjectOptions {
  model: Model;
  /** The project's folder name, which its Opsifier project is named after. */
  folder: string;
  /** The project's folder on the server, and where the agent servers see it. */
  hostDir: string;
  workspaceDir: string;
  /** owner/name on GitHub, and the remote its copy knows it by. */
  slug: string;
  origin: string | null;
  /** The Studio's own preview, of a Vite project, run as the agent server's user so that both write the same files. */
  preview: { kind: "vite"; uid: number; gid: number };
  access: Access;
  actorEmail: string | undefined;
  isAdmin: boolean;
}

export interface OwnProject {
  project: string;
  preview: ServiceRecord & { id: string };
  agent: ServiceRecord & { id: string };
  repository: string;
  gitTokenHash: string;
}

const withId = (record: ServiceRecord): ServiceRecord & { id: string } => {
  if (record.id === null) {
    throw conflict("service_without_id", `${record.projectName}/${record.name} has no identifier.`);
  }
  return { ...record, id: record.id };
};

/**
 * A Studio project's own Opsifier project: `studio-<folder>`, with its preview and its agent server.
 * Their network keeps them away from every other project's services; they share the project's folder,
 * the only folder of the server either sees. Nothing is deployed: the caller links the Studio project
 * to the preview first, so that the preview never answers without the Studio's sign-in. When any part
 * fails, what was made is taken back.
 */
export async function createOwnProject(deps: AppDeps, options: OwnProjectOptions): Promise<OwnProject> {
  const project = ownProjectName(deps, options.folder);
  await createProject(deps, { name: project }, options.actorEmail);
  try {
    const previewTarget = { projectName: project, serviceName: OWN_PREVIEW };
    const panel = getPanelDomainSettings(deps).url;
    await createFromDefinition(
      deps,
      project,
      {
        name: OWN_PREVIEW,
        source: { type: "dockerfile", dockerfile: previewDockerfile(options.preview) },
        env: inspectorEnv(panel),
        domains: [],
        mounts: [{ type: "bind", hostPath: options.hostDir, mountPath: "/app", acknowledgeRisk: false }],
        resources: PREVIEW_RESOURCES,
        deploy: false,
      },
      options.access,
      options.actorEmail,
      options.isAdmin,
    );
    const preview = withId(requireService(deps, previewTarget));

    const token = newGitToken();
    const agent = withId(
      await createOwnAgent(deps, {
        project,
        model: options.model,
        hostDir: options.hostDir,
        workspaceDir: options.workspaceDir,
        appId: preview.id,
        addresses: remoteAddresses(options.slug, options.origin),
        token,
        actorEmail: options.actorEmail,
      }),
    );
    return { project, preview, agent, repository: options.slug, gitTokenHash: hashGitToken(token) };
  } catch (error) {
    await discardOwnProject(deps, project);
    throw error;
  }
}

/** Takes back a project whose making failed: nothing of it was deployed yet. */
async function discardOwnProject(deps: AppDeps, project: string): Promise<void> {
  try {
    for (const name of [OWN_AGENT, OWN_PREVIEW]) {
      deleteServiceRow(deps.db, project, name);
      await deps.proxy.removeService(project, name).catch(() => undefined);
    }
    deleteProject(deps.db, project);
    await removeProjectNetwork(deps, project, () => undefined);
  } catch (error) {
    deps.logger.warn({ err: error, project }, "Could not take back a Studio project's own Opsifier project");
  }
}

/** The first deployment of a project's preview and agent server, once the Studio project is linked. */
export function deployOwnProject(
  deps: AppDeps,
  own: Pick<OwnProject, "project">,
  actorEmail: string | undefined,
): void {
  enqueueDeploy(deps, { projectName: own.project, serviceName: OWN_PREVIEW }, actorEmail);
  enqueueDeploy(deps, { projectName: own.project, serviceName: OWN_AGENT }, actorEmail);
}
