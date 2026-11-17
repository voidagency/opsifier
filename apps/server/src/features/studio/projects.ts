import { posix } from "node:path";
import type { AddStudioProjectRequest, StudioAgent, StudioAppDetail } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { AppError, badRequest, conflict, serviceUnavailable } from "../../core/errors";
import type { Access } from "../access/rules";
import { runInDatabase } from "../databases/exec";
import { getPanelDomainSettings } from "../server/settings";
import { createFromDefinition } from "../service-definition/service";
import { qualifiedName } from "../services/compile";
import { findService } from "../services/repo";
import { requireService } from "../services/service";
import { OWN_PREVIEW, requireModel, requirePanelUrl } from "./agents";
import { GITHUB_SECRET, scriptPrelude } from "./git-scripts";
import { githubKeyFor, hasGithubKeyFor } from "./github-keys";
import { createOwnProject, deployOwnProject, inspectFolder, requireNoCredentials } from "./own-project";
import { inspectorEnv, PREVIEW_RESOURCES, previewDockerfile } from "./preview";
import * as repo from "./repo";
import { getStudioApp, linkStudioApp } from "./service";
import { readStudioSettings } from "./settings";

/** Copying a large repository takes a while. */
const CLONE_TIMEOUT_MS = 300_000;
const CLONE_PREFIX = "opsifier-studio-clone ";
/** A service's default address is `<project>-<service>.<base>`, and a DNS label holds 63 characters. */
const MAX_LABEL = 63;
const PREVIEW_SUFFIX = "-preview";

export interface GithubRepository {
  owner: string;
  name: string;
  /** owner/name */
  slug: string;
  /** The plain https address the agent clones and pushes with. */
  url: string;
}

const REPOSITORY =
  /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** A GitHub repository from its address, its SSH address, or owner/name. */
export function parseRepository(input: string): GithubRepository {
  const match = REPOSITORY.exec(input.trim());
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined || name === "." || name === "..") {
    throw badRequest(
      "studio_repository_invalid",
      "Give a GitHub repository: its address, such as https://github.com/owner/name, or owner/name.",
      { repository: "A GitHub repository, such as https://github.com/owner/name" },
    );
  }
  return { owner, name, slug: `${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` };
}

/** The project's folder name, from the repository's: lowercase letters, digits and dashes. */
export function folderName(repository: GithubRepository): string {
  const name = repository.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" ? "project" : name;
}

/** The preview's service name, short enough for its default address in the agent server's project. */
export function previewName(project: string, folder: string): string {
  const room = MAX_LABEL - project.length - 1 - PREVIEW_SUFFIX.length;
  const base = folder.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return `${base || "project"}${PREVIEW_SUFFIX}`;
}

/**
 * The server's folder behind the projects folder, from the agent server's mounts. A preview mounts
 * the same folder, so that what the agent writes shows at once.
 */
export function projectsHostDir(deps: AppDeps, agent: StudioAgent & { projectsDir: string }): string {
  const record = requireService(deps, { projectName: agent.project, serviceName: agent.service });
  const covering = record.spec.mounts
    .filter((mount) => mount.type === "bind")
    .filter(
      (mount) => agent.projectsDir === mount.mountPath || agent.projectsDir.startsWith(`${mount.mountPath}/`),
    )
    .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  if (covering === undefined || covering.type !== "bind") {
    throw conflict(
      "studio_projects_unmounted",
      `The agent server's service has no folder of the server mounted at ${agent.projectsDir}. Add one in its Storage tab, then add the project again.`,
    );
  }
  return posix.join(covering.hostPath, posix.relative(covering.mountPath, agent.projectsDir));
}

/**
 * Copies the repository into the projects folder, with the credential helper of `scriptPrelude`. A
 * folder that already holds a copy of the same repository is kept, so that adding a project again goes
 * on from where it stopped.
 */
export const CLONE_SCRIPT = `${scriptPrelude(CLONE_PREFIX)}target = request["dir"]
reused = False
if os.path.exists(target):
    origin = ""
    if os.path.isdir(os.path.join(target, ".git")):
        origin = subprocess.run(["git", "-C", target, "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    if origin.removesuffix("/").removesuffix(".git").lower() != request["url"].removesuffix(".git").lower():
        done({"ok": False, "code": "exists"})
    reused = True
else:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    command = ["git", "-c", "credential.helper=", "-c", "credential.https://github.com.helper=" + helper, "clone", "--quiet"]
    if request.get("branch"):
        command += ["--branch", request["branch"]]
    try:
        cloned = subprocess.run(command + ["--", request["url"], target], env=env, capture_output=True, text=True, timeout=280)
    except subprocess.TimeoutExpired:
        done({"ok": False, "code": "failed", "message": "The copy took longer than 280 seconds."})
    if cloned.returncode != 0:
        said = cloned.stderr.lower()
        if "remote branch" in said and "not found" in said:
            done({"ok": False, "code": "branch", "message": clean(cloned.stderr)})
        if any(sign in said for sign in ("403", "404", "not found", "authentication failed", "could not read username", "access to repository not granted")):
            done({"ok": False, "code": "no_access", "token": bool(token), "message": clean(cloned.stderr)})
        done({"ok": False, "code": "failed", "message": clean(cloned.stderr)})
subprocess.run(["git", "-C", target, "config", "credential.https://github.com.helper", helper], capture_output=True)
branch = subprocess.run(["git", "-C", target, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True).stdout.strip()
packages = {}
try:
    with open(os.path.join(target, "package.json")) as handle:
        manifest = json.load(handle)
    for field in ("dependencies", "devDependencies"):
        if isinstance(manifest.get(field), dict):
            packages.update(manifest[field])
except Exception:
    manifest = None
done({"ok": True, "reused": reused, "uid": os.getuid(), "gid": os.getgid(), "branch": branch, "manifest": manifest is not None, "vite": "vite" in packages})
`;

export type CloneResult =
  | {
      ok: true;
      reused: boolean;
      uid: number;
      gid: number;
      branch: string;
      manifest: boolean;
      vite: boolean;
    }
  | { ok: false; code: "refused" | "unreachable" | "exists" | "branch" | "failed"; message?: string }
  | { ok: false; code: "no_access"; token: boolean; message?: string };

/** The script's verdict, from its output. Null when it printed none. */
export function readCloneResult(output: string): CloneResult | null {
  const line = output
    .split("\n")
    .reverse()
    .find((one) => one.startsWith(CLONE_PREFIX));
  if (line === undefined) {
    return null;
  }
  try {
    return JSON.parse(line.slice(CLONE_PREFIX.length)) as CloneResult;
  } catch {
    return null;
  }
}

/** Why GitHub kept a repository out of the copy, and what lets it in, as things stand on this server. */
function unreachableMessage(
  deps: Pick<AppDeps, "db">,
  slug: string,
  tried: { own: boolean; keyRefused: boolean; token: boolean },
): string {
  const owner = slug.split("/", 1)[0];
  if (tried.keyRefused) {
    return `Neither the Studio's GitHub key for ${owner} nor the agent server's token reaches ${slug}. Give the key's token access to the repository on GitHub, with Contents in read and write, or check its address.`;
  }
  if (!tried.own) {
    // The keys serve projects with an agent server of their own: one for this owner is not used here.
    const unused = hasGithubKeyFor(deps, slug)
      ? ` The Studio's GitHub key for ${owner} serves projects with an agent server of their own only.`
      : "";
    return tried.token
      ? `The agent server's GitHub token does not reach ${slug}. Give that token access to the repository, with Contents in read and write, or check its address.${unused}`
      : `GitHub did not let the agent server read ${slug}, and the agent server has no ${GITHUB_SECRET} secret. Give it one with Contents in read and write on the repository.${unused}`;
  }
  return tried.token
    ? `The agent server's GitHub token does not reach ${slug}. Add a GitHub key for ${owner} in the Studio's settings, or give that token access to the repository, with Contents in read and write.`
    : `GitHub did not let the agent server read ${slug}, and the Studio has no GitHub key for ${owner}. Add one in the Studio's settings, with Contents in read and write on the repository.`;
}

async function cloneInAgent(
  deps: AppDeps,
  agent: StudioAgent,
  repository: GithubRepository,
  dir: string,
  branch: string | undefined,
  own: boolean,
  keyRefused = false,
): Promise<Extract<CloneResult, { ok: true }>> {
  // The Studio's key for the repository's owner goes on standard input, never on a command line. It
  // serves projects with an agent server of their own only: on the shared one, the agents push with
  // the agent server's token, and the key would sit in the container they all run in.
  const key = own && !keyRefused ? githubKeyFor(deps, repository.slug) : null;
  const input = JSON.stringify({
    agentUrl: agent.url,
    keyFile: agent.keyFile,
    secret: GITHUB_SECRET,
    url: repository.url,
    dir,
    ...(key === null ? {} : { token: key }),
    ...(branch === undefined ? {} : { branch }),
  });
  let outcome: Awaited<ReturnType<typeof runInDatabase>>;
  try {
    outcome = await runInDatabase(
      deps,
      qualifiedName(agent.project, agent.service),
      { command: ["python3", "-c", CLONE_SCRIPT], stdin: input },
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${agent.project}/${agent.service} is not running.`,
      );
    }
    throw error;
  }
  const result = readCloneResult(outcome.output);
  if (result === null) {
    throw serviceUnavailable(
      "studio_agent_unavailable",
      "The agent server's container did not run the copy.",
    );
  }
  if (result.ok) {
    return result;
  }
  if (key !== null && result.code === "no_access") {
    // A key narrower than the agent server's token must not keep the owner's other repositories out.
    return cloneInAgent(deps, agent, repository, dir, branch, own, true);
  }
  switch (result.code) {
    case "exists":
      throw conflict(
        "studio_project_exists",
        `The projects folder already holds ${posix.basename(dir)}, which is not a copy of ${repository.slug}.`,
      );
    case "no_access":
      throw new AppError(
        422,
        "studio_repository_unreachable",
        unreachableMessage(deps, repository.slug, { own, keyRefused, token: result.token }),
      );
    case "branch":
      throw new AppError(422, "studio_branch_missing", `${repository.slug} has no branch by that name.`);
    case "refused":
      throw serviceUnavailable("studio_agent_refused", "The agent server refused the panel's key.");
    case "unreachable":
      throw serviceUnavailable("studio_agent_unavailable", "The agent server could not be reached.");
    default:
      throw new AppError(
        502,
        "studio_clone_failed",
        `The copy of ${repository.slug} failed${result.message ? `: ${result.message}` : "."}`,
      );
  }
}

/**
 * Adds a GitHub project to the Studio: copies it into the projects folder from inside the agent
 * server's container, makes its preview next to the agent server, and links the two. When each
 * project has an agent server of its own, the preview and that agent server go in an Opsifier
 * project of their own instead. The preview's first deployment installs the project's dependencies;
 * the Studio starts it again when it is opened.
 */
export async function addStudioProject(
  deps: AppDeps,
  request: AddStudioProjectRequest,
  access: Access,
  actorEmail: string | undefined,
  isAdmin: boolean,
): Promise<StudioAppDetail> {
  const settings = readStudioSettings(deps);
  const agent = settings.agent;
  if (!settings.enabled || agent === null) {
    throw conflict("studio_off", "Turn the Studio on and choose its agent server first.");
  }
  const projectsDir = agent.projectsDir;
  if (projectsDir === null) {
    throw conflict(
      "studio_projects_unset",
      "Set the Studio's projects folder first, in its settings: where projects go in the agent server's container.",
    );
  }
  const repository = parseRepository(request.repository);
  const folder = folderName(repository);
  const service = previewName(agent.project, folder);
  const own = settings.agentPerProject;
  if (!own && findService(deps.db, agent.project, service) !== undefined) {
    throw conflict(
      "studio_project_exists",
      `${agent.project}/${service} already exists: link it from the Studio, or remove it first.`,
    );
  }
  const hostDir = posix.join(projectsHostDir(deps, { ...agent, projectsDir }), folder);
  const workspaceDir = posix.join(projectsDir, folder);
  if (repo.listLinkedApps(deps.db).some((app) => app.workspaceDir === workspaceDir)) {
    throw conflict("studio_project_exists", `The Studio has a project on ${workspaceDir} already.`);
  }
  // Checked before anything is copied: what each project's own agent server needs.
  const model = own ? requireModel(deps, settings) : null;
  if (own) {
    requirePanelUrl(deps);
  }

  const copy = await cloneInAgent(deps, agent, repository, workspaceDir, request.branch, own);
  // No package.json, or no Vite in it: there is no development server the preview knows how to run.
  if (!copy.vite) {
    throw new AppError(
      422,
      "studio_project_unsupported",
      `${repository.slug} does not use Vite, the only development server the Studio's previews run for now.`,
    );
  }

  if (model !== null) {
    // A copy reused as it was may carry a credential in its git settings, which its agent would read.
    requireNoCredentials(await inspectFolder(deps, model, workspaceDir), workspaceDir);
    const created = await createOwnProject(deps, {
      model,
      folder,
      hostDir,
      workspaceDir,
      slug: repository.slug,
      origin: repository.url,
      preview: { kind: "vite", uid: copy.uid, gid: copy.gid },
      access,
      actorEmail,
      isAdmin,
    });
    const ownTarget = { projectName: created.project, serviceName: OWN_PREVIEW };
    await linkStudioApp(deps, ownTarget, { workspaceDir });
    repo.setAppAgent(
      deps.db,
      created.preview.id,
      {
        agentServiceId: created.agent.id,
        repository: created.repository,
        gitTokenHash: created.gitTokenHash,
      },
      new Date(deps.now()),
    );
    // Linked first, so that the preview never answers without the Studio's sign-in.
    deployOwnProject(deps, created, actorEmail);
    deps.actions.record({
      type: "studio.add-project",
      title: `Add ${repository.slug} to the Studio, with an agent server of its own`,
      ...ownTarget,
      actorEmail,
    });
    return getStudioApp(deps, ownTarget);
  }

  const target = { projectName: agent.project, serviceName: service };
  const panel = getPanelDomainSettings(deps).url;
  await createFromDefinition(
    deps,
    agent.project,
    {
      name: service,
      source: { type: "dockerfile", dockerfile: previewDockerfile(copy) },
      env: inspectorEnv(panel),
      domains: [],
      mounts: [{ type: "bind", hostPath: hostDir, mountPath: "/app", acknowledgeRisk: false }],
      resources: PREVIEW_RESOURCES,
      deploy: true,
    },
    access,
    actorEmail,
    isAdmin,
  );
  await linkStudioApp(deps, target, { workspaceDir });
  deps.actions.record({
    type: "studio.add-project",
    title: `Add ${repository.slug} to the Studio`,
    ...target,
    actorEmail,
  });
  return getStudioApp(deps, target);
}
