import type { StudioAgent, StudioVersions, StudioViewing } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest, conflict } from "../../core/errors";
import { findServiceById } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { agentModeOf, awakeOwnAgent, ownAgentOf, probeOwnAgent, startOwnAgent } from "./agents";
import * as repo from "./repo";
import { requireAgent, requireLinked } from "./service";
import { readStudioSettings } from "./settings";
import {
  atWork,
  MAX_VERSIONS,
  noVerdict,
  refused,
  runVersions,
  type ScriptAnswer,
  toVersion,
} from "./version-script";
import { holdForVersion, publicViewing, readViewing, type StoredViewing, versionChanging } from "./viewing";

/**
 * A Studio project's versions are the commits of its folder's branch: the agent saves each change it
 * makes as one. An earlier version is shown by checking its commit out in the folder, which the
 * preview's development server shows at once, and the current one comes back by checking the branch
 * out again. Only while nothing is at work and nothing is left unsaved, so that no one's work is lost;
 * and no message reaches the agent meanwhile. Bringing an earlier version back for good is the agent's
 * to do, at a message's request: it saves it as a new version, so that the history keeps everything.
 *
 * The folder says what it shows: the branch to come back to is kept in a file of its own under `.git`
 * while an earlier version is shown, and the project's row follows what the folder says each time the
 * versions are listed.
 */

/** The agent server that holds the folder, when it runs: a read never starts one. */
function agentToRead(deps: AppDeps, app: repo.StudioAppRow): StudioAgent | null {
  const shared = requireAgent(deps);
  const mode = agentModeOf(deps, readStudioSettings(deps), app);
  if (mode === "shared") {
    return shared;
  }
  const record = app.agentServiceId === null ? undefined : findServiceById(deps.db, app.agentServiceId);
  if (mode === "missing" || record === undefined) {
    return null;
  }
  try {
    return awakeOwnAgent(deps, shared, record);
  } catch (error) {
    if (error instanceof AppError && error.code === "studio_agent_asleep") {
      return null;
    }
    throw error;
  }
}

/** The agent server that holds the folder, started when it sleeps, as a message to it would. */
async function agentToChange(
  deps: AppDeps,
  app: repo.StudioAppRow,
  actorEmail: string | undefined,
): Promise<{ agent: StudioAgent; own: boolean }> {
  const shared = requireAgent(deps);
  const mode = agentModeOf(deps, readStudioSettings(deps), app);
  if (mode === "shared") {
    return { agent: shared, own: false };
  }
  const record = app.agentServiceId === null ? undefined : findServiceById(deps.db, app.agentServiceId);
  if (mode === "missing" || record === undefined) {
    throw conflict(
      "studio_project_agent_missing",
      "This project waits for an agent server of its own: an administrator gives it one from the Studio's settings.",
    );
  }
  if (await startOwnAgent(deps, record, actorEmail)) {
    throw conflict(
      "studio_agent_starting",
      "The project's agent server is starting: try again in a few seconds.",
    );
  }
  const agent = ownAgentOf(shared, record);
  await probeOwnAgent(deps, agent);
  return { agent, own: true };
}

/** Keeps in the project's row what its folder says it shows: the folder is the one that knows. */
function followFolder(
  deps: AppDeps,
  app: repo.StudioAppRow,
  viewing: StoredViewing | null,
  answer: ScriptAnswer,
): StoredViewing | null {
  // A change under way says where the folder goes once it is done.
  if (versionChanging(app.serviceId)) {
    return viewing;
  }
  const shown = toVersion(answer.shown);
  const branch =
    answer.shown !== null && typeof answer.shown === "object"
      ? (answer.shown as { branch?: unknown }).branch
      : undefined;
  if (shown !== null && typeof branch === "string") {
    if (
      viewing !== null &&
      viewing.sha === shown.sha &&
      viewing.pending !== true &&
      viewing.branch === branch
    ) {
      return viewing;
    }
    const followed: StoredViewing = {
      ...shown,
      since: viewing?.since ?? new Date(deps.now()).toISOString(),
      by: viewing?.by ?? null,
      branch,
    };
    repo.setViewing(deps.db, app.serviceId, JSON.stringify(followed));
    return followed;
  }
  // On a branch, the folder shows the current version, whatever the row said.
  if (typeof answer.branch === "string" && viewing !== null) {
    repo.setViewing(deps.db, app.serviceId, null);
    return null;
  }
  return viewing;
}

/** The folder's versions, the newest first, and the earlier one shown, if any. */
export async function listStudioVersions(deps: AppDeps, target: ServiceTarget): Promise<StudioVersions> {
  const { app } = requireLinked(deps, target);
  const viewing = readViewing(app.viewing);
  const agent = agentToRead(deps, app);
  if (agent === null) {
    return { versions: [], asleep: true, viewing: publicViewing(viewing) };
  }
  const answer = await runVersions(deps, agent, {
    action: "list",
    dir: app.workspaceDir,
    branch: viewing?.branch || null,
    limit: MAX_VERSIONS,
  });
  if (answer === null) {
    throw noVerdict();
  }
  if (answer.ok !== true) {
    throw refused(answer);
  }
  const versions = Array.isArray(answer.versions)
    ? answer.versions.map(toVersion).filter((version) => version !== null)
    : [];
  return { versions, asleep: false, viewing: publicViewing(followFolder(deps, app, viewing, answer)) };
}

/**
 * Shows an earlier version of the project in its preview, in place of the current one: refused while
 * the agent is at work, or while changes are not saved yet. The row says a version is being shown
 * before the folder moves, so that no message slips in, and keeps saying so when the script gives no
 * verdict, until the folder is read again.
 */
export async function viewStudioVersion(
  deps: AppDeps,
  target: ServiceTarget,
  sha: string,
  actorEmail: string | undefined,
): Promise<StudioViewing> {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw badRequest("studio_version_unknown", "No such version of the project.");
  }
  const { app } = requireLinked(deps, target);
  const release = holdForVersion(app.serviceId);
  try {
    const viewing = readViewing(app.viewing);
    const { agent, own } = await agentToChange(deps, app, actorEmail);
    if (await atWork(deps, agent, app.serviceId, own)) {
      throw conflict(
        "studio_agent_working",
        "The agent is at work on this project: show an earlier version once it has answered.",
      );
    }
    const since = new Date(deps.now()).toISOString();
    const pending: StoredViewing = {
      sha,
      at: viewing?.sha === sha ? viewing.at : since,
      subject: viewing?.sha === sha ? viewing.subject : "",
      since,
      by: actorEmail ?? null,
      branch: viewing?.branch ?? "",
      pending: true,
    };
    repo.setViewing(deps.db, app.serviceId, JSON.stringify(pending));
    const answer = await runVersions(deps, agent, {
      action: "view",
      dir: app.workspaceDir,
      sha,
      branch: viewing?.branch || null,
    });
    if (answer === null) {
      // The folder may have moved or not: the row waits for it to be read again.
      throw noVerdict();
    }
    const shown = toVersion(answer);
    if (answer.ok !== true || shown === null || typeof answer.branch !== "string") {
      // Refused before the folder moved: it shows what it showed.
      repo.setViewing(deps.db, app.serviceId, app.viewing);
      throw answer.ok === true ? noVerdict() : refused(answer);
    }
    const stored: StoredViewing = { ...shown, since, by: actorEmail ?? null, branch: answer.branch };
    repo.setViewing(deps.db, app.serviceId, JSON.stringify(stored));
    record(deps, target, actorEmail, `Show the version of ${shown.at} of`, answer.stashed === true);
    return publicViewing(stored) as StudioViewing;
  } finally {
    release();
  }
}

/** Brings the project's current version back in its preview. */
export async function showCurrentVersion(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<{ viewing: null }> {
  const { app } = requireLinked(deps, target);
  const viewing = readViewing(app.viewing);
  if (viewing === null) {
    return { viewing: null };
  }
  const release = holdForVersion(app.serviceId);
  try {
    const { agent } = await agentToChange(deps, app, actorEmail);
    const answer = await runVersions(deps, agent, {
      action: "return",
      dir: app.workspaceDir,
      branch: viewing.branch || null,
    });
    if (answer === null) {
      throw noVerdict();
    }
    // A folder that is no git copy shows no version: there is nothing to come back to.
    if (answer.ok !== true && answer.code !== "not_a_copy") {
      throw refused(answer);
    }
    repo.setViewing(deps.db, app.serviceId, null);
    record(deps, target, actorEmail, "Show the current version of", answer.stashed === true);
    return { viewing: null };
  } finally {
    release();
  }
}

function record(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
  what: string,
  stashed: boolean,
): void {
  deps.actions.record({
    type: "studio.version",
    title: `${what} ${target.projectName}/${target.serviceName} in the Studio's preview${
      stashed ? ", with the changes made meanwhile set aside in git's stash" : ""
    }`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
}
