import { rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ActionRow } from "../../core/actions/engine";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { findAction } from "../actions/repo";
import { removeProjectNetwork } from "../projects/network";
import { deleteProject } from "../projects/repo";
import { enqueueDestroy } from "../services/lifecycle";
import { findServiceById, listServiceRecords, type ServiceRecord } from "../services/repo";
import { assertRuntimeCertain } from "../services/runtime-state";
import type { ServiceTarget } from "../services/service";
import { indexActiveActions } from "../services/status";
import { isStudioProjectName, requireModel } from "./agents";
import { pauseShared } from "./isolate";
import { isPanelMadePreview } from "./preview";
import * as repo from "./repo";
import { requireLinked, unlinkStudioApp } from "./service";

/** What taking a project out of the Studio deletes with it: only what the Studio made for it. */
export interface StudioRemoval {
  /** The project's own agent server, when it has one. */
  agent: ServiceTarget | null;
  /** Its preview, when the Studio made it: a site linked to the Studio is someone else's. */
  preview: ServiceTarget | null;
  /** The Opsifier project the Studio made for it, when nothing else lives there. */
  project: string | null;
}

const targetOf = (record: ServiceRecord): ServiceTarget => ({
  projectName: record.projectName,
  serviceName: record.name,
});

export function studioRemoval(
  deps: Pick<AppDeps, "db">,
  preview: ServiceRecord,
  agentServiceId: string | null,
): StudioRemoval {
  const agentRecord = agentServiceId === null ? undefined : findServiceById(deps.db, agentServiceId);
  const agent = agentRecord === undefined ? null : targetOf(agentRecord);
  const source = preview.spec.source;
  const made = source?.type === "dockerfile" && isPanelMadePreview(source.dockerfile);
  const going = (record: ServiceRecord) =>
    (made && record.projectName === preview.projectName && record.name === preview.name) ||
    (agent !== null && record.projectName === agent.projectName && record.name === agent.serviceName);
  const own =
    made &&
    isStudioProjectName(preview.projectName) &&
    listServiceRecords(deps.db, preview.projectName).every(going);
  return { agent, preview: made ? targetOf(preview) : null, project: own ? preview.projectName : null };
}

const POLL_MS = 500;

/** Waits for Actions of other services to end, and says whether they all succeeded. */
async function settled(
  deps: Pick<AppDeps, "db">,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  for (;;) {
    const states = ids.map((id) => findAction(deps.db, id)?.status);
    if (states.every((status) => status !== "queued" && status !== "running")) {
      return states.every((status) => status === "succeeded");
    }
    if (signal.aborted) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Takes a project out of the Studio, with its conversations and shares, and deletes what the Studio
 * made for it: its own agent server, its preview, and the Opsifier project that held them. Each
 * service goes through its own destruction, which nothing else can run alongside. A preview that goes
 * never comes out from behind the Studio's sign-in: it leaves the Studio with its routes as they are,
 * which then let nobody in. Its folder stays, with any work not pushed yet: adding the same repository
 * again reuses it. Confirmed by the project's name, its folder's.
 */
export async function removeStudioProject(
  deps: AppDeps,
  target: ServiceTarget,
  confirm: string,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const { record, app } = requireLinked(deps, target);
  const name = basename(app.workspaceDir) || record.name;
  if (confirm !== name) {
    throw conflict("confirmation_mismatch", "Type the project's exact name to confirm.", {
      confirm: "Does not match the project's name",
    });
  }
  const removal = studioRemoval(deps, record, app.agentServiceId);
  const going = [removal.agent, removal.preview].filter((one): one is ServiceTarget => one !== null);
  // Everything is checked before anything changes, so a refusal leaves the project as it was.
  const active = indexActiveActions(deps);
  if (going.some((one) => active.has(`${one.projectName}/${one.serviceName}`))) {
    throw conflict("studio_project_busy", "Work is still running on this project. Wait for it to finish.");
  }
  for (const one of going) {
    assertRuntimeCertain(deps, one);
  }

  // On the shared agent server, its conversations would go on editing the folder out of sight.
  if (app.agentServiceId === null) {
    try {
      await pauseShared(deps, requireModel(deps), repo.listConversations(deps.db, app.serviceId));
    } catch (error) {
      deps.logger.warn({ err: error }, "Could not pause a Studio project's conversations before removing it");
    }
  }
  if (removal.preview === null) {
    // The site stays: its routes go back to what they were before the Studio's sign-in.
    await unlinkStudioApp(deps, target);
  } else {
    repo.deleteApp(deps.db, app.serviceId);
  }

  const destroys = going.map((one) => enqueueDestroy(deps, one, one.serviceName, actorEmail).id);
  return deps.actions.enqueue({
    type: "studio.remove",
    title: `Take ${name} out of the Studio`,
    projectName: target.projectName,
    actorEmail,
    run: async (ctx) => {
      ctx.log(`${name} is out of the Studio, with its conversations and shares`);
      if (!(await settled(deps, destroys, ctx.signal))) {
        throw new Error("A service of the project could not be deleted: see its own Action.");
      }
      const project = removal.project;
      if (project !== null && listServiceRecords(deps.db, project).length === 0) {
        ctx.log(`Removing the project ${project} and its network`);
        await removeProjectNetwork(deps, project, ctx.log, ctx.signal);
        // Nothing awaits between this check and the delete, so a service made meanwhile can't go with it.
        if (listServiceRecords(deps.db, project).length === 0) {
          deleteProject(deps.db, project);
          await rmdir(join(deps.config.dataDir, "projects", project)).catch(() => undefined);
        }
      }
      ctx.log(`Its folder, ${app.workspaceDir}, stays: adding the same repository again reuses it`);
    },
  });
}
