import { posix } from "node:path";
import type { StudioIsolateAll, StudioIsolated } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, conflict, notFound } from "../../core/errors";
import { requireHostAccess } from "../access/guard";
import type { Access } from "../access/rules";
import { enqueueStop } from "../services/lifecycle";
import { findService, findServiceById, listServiceRecords, type ServiceRecord } from "../services/repo";
import { requireService, type ServiceTarget } from "../services/service";
import { indexActiveActions } from "../services/status";
import { callAgent } from "./agent";
import {
  createOwnAgent,
  hashGitToken,
  type Model,
  newGitToken,
  OWN_AGENT,
  OWN_PREVIEW,
  remoteAddresses,
  requireModel,
  requirePanelUrl,
} from "./agents";
import { createOwnProject, inspectFolder, requireNoCredentials } from "./own-project";
import { parseRepository, projectsHostDir } from "./projects";
import * as repo from "./repo";
import { rewriteRoutes } from "./service";
import { readStudioSettings } from "./settings";

/** A remote's address without the user or token some tools write into it. */
const withoutCredentials = (address: string): string => address.replace(/^([a-z]+:\/\/)[^@/]*@/i, "$1");

/** The folder under the projects folder: only a project there can be given a folder of its own. */
function folderOf(model: Model, workspaceDir: string): string {
  const relative = posix.relative(model.agent.projectsDir, workspaceDir);
  if (relative === "" || relative.startsWith("..") || posix.isAbsolute(relative)) {
    throw conflict(
      "studio_folder_outside",
      `${workspaceDir} is not inside the Studio's projects folder, ${model.agent.projectsDir}: only a project there can have an agent server of its own.`,
    );
  }
  return relative;
}

const hasOwnAgent = (deps: Pick<AppDeps, "db">, app: repo.StudioAppRow): boolean =>
  app.agentServiceId !== null && findServiceById(deps.db, app.agentServiceId) !== undefined;

/** A preview the Studio made in a project of its own, which holds nothing but its preview and agent server. */
function inOwnProject(deps: Pick<AppDeps, "db">, model: Model, record: ServiceRecord): boolean {
  return (
    record.name === OWN_PREVIEW &&
    record.projectName !== model.agent.project &&
    listServiceRecords(deps.db, record.projectName).every(
      (service) => service.name === OWN_PREVIEW || service.name === OWN_AGENT,
    )
  );
}

/** The projects being given their own agent server: two requests for one would make two. */
const isolating = new Set<string>();

/**
 * Gives a Studio project an agent server of its own: its own Opsifier project, with a preview on the
 * same folder and the agent server, and the project's link, conversations and accounts move there.
 * Nothing is deployed yet: each project's services start when it is first opened. Its conversations
 * on the shared agent server are paused, and its preview so far is stopped, out of the Studio, for an
 * administrator to remove: still running, it would show the folder without the Studio's sign-in.
 */
export async function isolateStudioApp(
  deps: AppDeps,
  target: ServiceTarget,
  access: Access,
  actorEmail: string | undefined,
  isAdmin: boolean,
): Promise<StudioIsolated> {
  const settings = readStudioSettings(deps);
  if (!settings.agentPerProject) {
    throw conflict(
      "studio_agent_per_project_off",
      "Turn on an agent server for each project, in the Studio's settings, first.",
    );
  }
  const model = requireModel(deps, settings);
  requirePanelUrl(deps);
  requireHostAccess(access);
  const record = requireService(deps, target);
  const app = record.id === null ? undefined : repo.findApp(deps.db, record.id);
  if (app === undefined) {
    throw notFound("This service is not linked to the Studio.");
  }
  if (hasOwnAgent(deps, app)) {
    throw conflict("studio_project_isolated", "This project has an agent server of its own already.");
  }
  if (isolating.has(app.serviceId)) {
    throw conflict("studio_project_isolating", "This project is being given its own agent server already.");
  }
  isolating.add(app.serviceId);
  try {
    return await isolate(deps, { target, record, app, model, access, actorEmail, isAdmin });
  } finally {
    isolating.delete(app.serviceId);
  }
}

interface Isolation {
  target: ServiceTarget;
  record: ServiceRecord;
  app: repo.StudioAppRow;
  model: Model;
  access: Access;
  actorEmail: string | undefined;
  isAdmin: boolean;
}

async function isolate(deps: AppDeps, isolation: Isolation): Promise<StudioIsolated> {
  const { target, record, app, model, access, actorEmail, isAdmin } = isolation;
  const hostDir = posix.join(projectsHostDir(deps, model.agent), folderOf(model, app.workspaceDir));
  const folder = await inspectFolder(deps, model, app.workspaceDir);
  if (!folder.exists) {
    throw conflict("studio_folder_missing", `The agent server has no folder ${app.workspaceDir}.`);
  }
  requireNoCredentials(folder, app.workspaceDir);
  const origin = withoutCredentials(folder.origin);
  let slug: string;
  try {
    slug = parseRepository(origin).slug;
  } catch {
    throw conflict(
      "studio_repository_unknown",
      `${app.workspaceDir} is not a copy of a GitHub repository, so an agent server of its own would have nowhere to push.`,
    );
  }
  const settings = readStudioSettings(deps);
  const now = new Date(deps.now());

  // Its preview lives in a project of its own already, and only lost its agent server: a new one there.
  if (
    inOwnProject(deps, model, record) &&
    findService(deps.db, record.projectName, OWN_AGENT) === undefined
  ) {
    const token = newGitToken();
    const agent = await createOwnAgent(deps, {
      project: record.projectName,
      model,
      hostDir,
      workspaceDir: app.workspaceDir,
      appId: app.serviceId,
      addresses: remoteAddresses(slug, origin),
      token,
      actorEmail,
    });
    repo.setAppAgent(
      deps.db,
      app.serviceId,
      { agentServiceId: agent.id, repository: slug, gitTokenHash: hashGitToken(token) },
      now,
    );
    recordIsolation(deps, record.projectName, actorEmail, target);
    return { project: record.projectName, service: record.name };
  }

  const own = await createOwnProject(deps, {
    model,
    folder: posix.basename(app.workspaceDir),
    hostDir,
    workspaceDir: app.workspaceDir,
    slug,
    origin,
    preview: folder.vite ? { kind: "vite", uid: folder.uid, gid: folder.gid } : { kind: "copy", record },
    access,
    actorEmail,
    isAdmin,
  });
  const shared = repo
    .listConversations(deps.db, app.serviceId)
    .filter((conversation) => conversation.sharedAgent)
    .slice(0, 20);
  deps.db.transaction((tx) =>
    repo.moveApp(tx, app.serviceId, {
      serviceId: own.preview.id,
      workspaceDir: app.workspaceDir,
      agentServiceId: own.agent.id,
      repository: own.repository,
      gitTokenHash: own.gitTokenHash,
      createdAt: app.createdAt,
      updatedAt: now,
    }),
  );
  if (settings.previewSignIn) {
    await rewriteRoutes(deps, { projectName: own.project, serviceName: OWN_PREVIEW });
    await rewriteRoutes(deps, target);
  }
  await pauseShared(deps, model, shared);
  await stopOldPreview(deps, target, actorEmail);
  recordIsolation(deps, own.project, actorEmail, target);
  return { project: own.project, service: OWN_PREVIEW };
}

/** The shared agent server, which holds the GitHub token, stops working on the project's folder. */
async function pauseShared(
  deps: AppDeps,
  model: Model,
  conversations: readonly repo.StudioConversationRow[],
): Promise<void> {
  if (conversations.length === 0) {
    return;
  }
  try {
    await callAgent(
      deps,
      model.agent,
      conversations.map((conversation) => ({
        method: "POST" as const,
        path: `/api/conversations/${conversation.id}/pause`,
      })),
    );
  } catch (error) {
    deps.logger.warn(
      { err: error },
      "Could not pause a Studio project's conversations on the shared agent server",
    );
  }
}

/** The project's preview so far, out of the Studio now, is stopped: it would show the folder to anyone. */
async function stopOldPreview(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<void> {
  const record = findService(deps.db, target.projectName, target.serviceName);
  if (
    record === undefined ||
    record.deployed === null ||
    record.spec.stopped ||
    indexActiveActions(deps).has(`${target.projectName}/${target.serviceName}`)
  ) {
    return;
  }
  try {
    await enqueueStop(deps, target, actorEmail);
  } catch (error) {
    deps.logger.warn({ err: error, ...target }, "Could not stop a Studio project's preview so far");
  }
}

function recordIsolation(
  deps: AppDeps,
  project: string,
  actorEmail: string | undefined,
  from: ServiceTarget,
): void {
  deps.actions.record({
    type: "studio.isolate",
    title: `Give ${from.projectName}/${from.serviceName} an agent server of its own, in ${project}`,
    projectName: project,
    serviceName: OWN_PREVIEW,
    actorEmail,
  });
}

/** Every Studio project still on the shared agent server gets its own, one after the other. */
export async function isolateAllStudioApps(
  deps: AppDeps,
  access: Access,
  actorEmail: string | undefined,
  isAdmin: boolean,
): Promise<StudioIsolateAll> {
  const result: StudioIsolateAll = { isolated: [], failed: [] };
  for (const app of repo.listLinkedApps(deps.db)) {
    if (hasOwnAgent(deps, app)) {
      continue;
    }
    const from = { project: app.projectName, service: app.serviceName };
    try {
      const to = await isolateStudioApp(
        deps,
        { projectName: app.projectName, serviceName: app.serviceName },
        access,
        actorEmail,
        isAdmin,
      );
      result.isolated.push({ from, to });
    } catch (error) {
      if (!(error instanceof AppError)) {
        deps.logger.warn({ err: error, ...from }, "Could not give a Studio project its own agent server");
      }
      result.failed.push({ ...from, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
