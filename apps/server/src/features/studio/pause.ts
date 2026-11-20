import type { StudioAgent, StudioAppDetail } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, conflict } from "../../core/errors";
import { enqueueStop } from "../services/lifecycle";
import { findServiceById, type ServiceRecord } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { indexActiveActions } from "../services/status";
import { agentModeOf, ownAgentOf } from "./agents";
import { catchUpCopies } from "./conversation-copy";
import * as repo from "./repo";
import { getStudioApp, requireLinked, startStudioPreview } from "./service";
import { readStudioSettings } from "./settings";
import { syncBeforeStart } from "./sync";
import { atWork } from "./version-script";
import { holdForPause, readPaused } from "./viewing";

/**
 * A project nobody works on for a while can be put on pause: its preview and its own agent server
 * stop, which frees what they take of the server, and nothing wakes them, opening the project
 * included, until someone resumes it. Its conversations stay readable from the panel's copy, and its
 * links for clients show the page of a site switched off meanwhile.
 */

const targetOf = (record: ServiceRecord): ServiceTarget => ({
  projectName: record.projectName,
  serviceName: record.name,
});

const runs = (record: ServiceRecord | undefined): record is ServiceRecord =>
  record !== undefined && record.deployed !== null && !record.spec.stopped;

/**
 * Puts a project on pause, for an administrator: refused while its agent is at work, which would stop
 * halfway. What happened in its conversations is copied first, so that they show while it sleeps.
 * Asked again, it stops what runs still.
 */
export async function pauseStudioProject(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<StudioAppDetail> {
  const { record, app } = requireLinked(deps, target);
  const release = holdForPause(app.serviceId);
  try {
    const settings = readStudioSettings(deps);
    const mode = agentModeOf(deps, settings, app);
    const own =
      mode === "own" && app.agentServiceId !== null
        ? findServiceById(deps.db, app.agentServiceId)
        : undefined;
    const agent: StudioAgent | null =
      settings.agent === null
        ? null
        : mode === "shared"
          ? settings.agent
          : runs(own)
            ? ownAgentOf(settings.agent, own)
            : null;
    if (agent !== null) {
      let working = false;
      try {
        working = await atWork(deps, agent, app.serviceId, mode === "own");
      } catch (error) {
        // An agent server that cannot say is stopped all the same: nothing of it is at work then.
        deps.logger.warn(
          { err: error, ...target },
          "Could not ask a Studio project's agent before its pause",
        );
      }
      if (working) {
        throw conflict(
          "studio_agent_working",
          "The agent is at work on this project: put it on pause once it has answered.",
        );
      }
      if (mode === "own") {
        await catchUpCopies(deps, agent, app.serviceId);
      }
    }
    if (readPaused(app.paused) === null) {
      repo.setPaused(
        deps.db,
        app.serviceId,
        JSON.stringify({ at: new Date(deps.now()).toISOString(), by: actorEmail ?? null }),
      );
    }
    const stopped: string[] = [];
    for (const one of [record, own]) {
      if (!runs(one) || indexActiveActions(deps).has(`${one.projectName}/${one.name}`)) {
        continue;
      }
      try {
        await enqueueStop(deps, targetOf(one), actorEmail);
        stopped.push(one === record ? "its preview" : "its agent server");
      } catch (error) {
        if (!(error instanceof AppError && error.code === "service_stopped")) {
          throw error;
        }
      }
    }
    deps.actions.record({
      type: "studio.pause",
      title: `Put ${target.projectName}/${target.serviceName} on pause in the Studio${
        stopped.length === 0 ? "" : `: stop ${stopped.join(" and ")}`
      }`,
      projectName: target.projectName,
      serviceName: target.serviceName,
      actorEmail,
    });
    return await getStudioApp(deps, target);
  } finally {
    release();
  }
}

/**
 * Resumes a project on pause, for whoever may work on it: its preview starts again, from what is on
 * GitHub, and its own agent server with it, as when it is opened.
 */
export async function resumeStudioProject(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<{ started: boolean; agentStarted: boolean }> {
  const { app } = requireLinked(deps, target);
  const release = holdForPause(app.serviceId);
  try {
    if (readPaused(app.paused) !== null) {
      repo.setPaused(deps.db, app.serviceId, null);
      deps.actions.record({
        type: "studio.resume",
        title: `Resume ${target.projectName}/${target.serviceName} in the Studio`,
        projectName: target.projectName,
        serviceName: target.serviceName,
        actorEmail,
      });
    }
  } finally {
    release();
  }
  await syncBeforeStart(deps, target, actorEmail);
  return startStudioPreview(deps, target, actorEmail);
}
