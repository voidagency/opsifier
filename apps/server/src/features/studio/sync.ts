import type { StudioSync, StudioSyncReason } from "@opsifier/contract";
import { z } from "zod";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { conflict } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { qualifiedName } from "../services/compile";
import { enqueueRestart } from "../services/lifecycle";
import { findService, findServiceById, type ServiceRecord } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import { indexActiveActions } from "../services/status";
import { isWorking, ownAgentOf, startOwnAgent } from "./agents";
import { scriptPrelude } from "./git-scripts";
import type * as repo from "./repo";
import { requireLinked } from "./service";
import { readStudioSettings } from "./settings";

/**
 * Opening a project brings its folder up to date with its branch on GitHub, so that the preview and
 * the agent start from what a hosted builder, another designer or anyone else pushed meanwhile. Only
 * a fast-forward, which never overwrites a file made here: the agent, which pulls before every
 * change, brings the two together when they have both moved.
 *
 * The folder is written by the project's agent and its preview, which runs the project's code, git
 * settings included, so its git runs only where that code can reach nothing more: in the project's
 * own agent server, which reaches its one repository through the panel and holds no key. A project
 * on the shared agent server is left to that agent, which pulls before its changes: the shared
 * server's container holds its GitHub token and every project's folder.
 */

const SYNC_PREFIX = "opsifier-studio-sync ";
/** Longer than the script's own limits put together, so that the panel waits for its verdict. */
const SYNC_TIMEOUT_MS = 240_000;
/** A project opened again this soon after an update gets that update's answer, when it was good news. */
const RECENT_MS = 15_000;
/** How long an update waits for the project's agent server to start, before saying it is starting. */
const AGENT_WAKE_MS = 20_000;
/** How long a preview's start waits for the project's update, so as to start from what is on GitHub. */
const START_WAITS_FOR_SYNC_MS = 8_000;
/** How long a restart for new packages waits for a start or deployment under way to end. */
const RESTART_WAITS_MS = 5 * 60_000;

/**
 * Fetches the folder's branch from the project's repository and fast-forwards the folder to it. Files
 * a development server writes again by itself, from the files they are made from, are set back when
 * they are all that stands in the way. It runs with the container's own git settings, which send
 * GitHub's address to the panel, and never with a token: a request not marked `relay` is refused.
 */
export const SYNC_SCRIPT = `${scriptPrelude(SYNC_PREFIX)}import re, time
target = request["dir"]
RELAY = bool(request.get("relay"))
GENERATED = ("src/routeTree.gen.ts",)
MANIFESTS = ("package.json", "bun.lock", "bun.lockb", "package-lock.json")
SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"]
if not RELAY:
    done({"ok": False, "code": "failed", "message": "The update runs only through a project's own agent server."})
quiet = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
quiet.pop("GITHUB_TOKEN", None)
def git(*args, timeout=60, fetching=False):
    try:
        return subprocess.run(["git", "-C", target, *SAFE, *args], env=env if fetching else quiet, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        done({"ok": False, "code": "failed", "message": "git " + args[0] + " took longer than " + str(timeout) + " seconds."})
gitdir = os.path.join(target, ".git")
if os.path.islink(gitdir) or not os.path.isdir(gitdir):
    done({"ok": False, "code": "not_a_copy"})
def stale_lock():
    # A lock older than ten minutes was left by a git that stopped: waiting will not clear it.
    for folder, folders, names in os.walk(gitdir):
        folders[:] = [name for name in folders if name != "objects"]
        for name in names:
            if name.endswith(".lock"):
                try:
                    if time.time() - os.path.getmtime(os.path.join(folder, name)) > 600:
                        return True
                except OSError:
                    pass
    return False
def check_idle():
    halfway = any(os.path.exists(os.path.join(gitdir, name)) for name in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"))
    if halfway or stale_lock():
        done({"ok": False, "code": "interrupted"})
    if os.path.exists(os.path.join(gitdir, "index.lock")):
        done({"ok": False, "code": "busy"})
check_idle()
named = git("symbolic-ref", "--quiet", "--short", "HEAD")
branch = named.stdout.strip()
if named.returncode != 0 or not branch:
    if named.stderr.strip():
        done({"ok": False, "code": "failed", "message": clean(named.stderr)})
    done({"ok": False, "code": "detached"})
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", branch) or ".." in branch or "//" in branch or branch.endswith((".", "/", ".lock")) or git("check-ref-format", "refs/heads/" + branch).returncode != 0:
    done({"ok": False, "code": "failed", "message": "The folder's branch has a name the Studio does not fetch."})
url = request.get("url") or ""
if not url:
    url = git("remote", "get-url", "origin").stdout.strip()
if not re.fullmatch(r"https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", url):
    done({"ok": False, "code": "failed", "branch": branch, "message": "The folder's repository is not on GitHub."})
# Fetched into the Studio's own name: what the agent knows of GitHub moves only once the folder holds it.
fetched_ref = "refs/opsifier/sync/" + branch
tracking = "refs/remotes/origin/" + branch
fetched = git("fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", url, "+refs/heads/" + branch + ":" + fetched_ref, timeout=90, fetching=True)
if fetched.returncode != 0:
    said = fetched.stderr.lower()
    if "couldn't find remote ref" in said:
        done({"ok": False, "code": "no_branch", "branch": branch})
    if ".lock" in said:
        done({"ok": False, "code": "interrupted" if stale_lock() else "busy", "branch": branch})
    if any(sign in said for sign in ("403", "404", "not found", "authentication failed", "could not read username", "access to repository not granted")):
        done({"ok": False, "code": "no_access", "branch": branch, "token": bool(token), "message": clean(fetched.stderr)})
    done({"ok": False, "code": "failed", "branch": branch, "message": clean(fetched.stderr)})
theirs = git("rev-parse", "--verify", "--quiet", fetched_ref + "^{commit}").stdout.strip()
git("update-ref", "-d", fetched_ref)
if not re.fullmatch(r"[0-9a-f]{40,64}", theirs):
    done({"ok": False, "code": "failed", "branch": branch, "message": "The fetched branch could not be read."})
def count(spec):
    out = git("rev-list", "--count", spec).stdout.strip()
    return int(out) if out.isdigit() else 0
def changed():
    return len([line for line in git("status", "--porcelain", "--untracked-files=no").stdout.splitlines() if line.strip()])
def seen():
    # The folder holds GitHub's branch: the agent's view of it may say so, and its pushes stay safe.
    git("update-ref", tracking, theirs)
behind = count("HEAD.." + theirs)
ahead = count(theirs + "..HEAD")
found = {"ok": True, "branch": branch, "behind": behind, "ahead": ahead, "pulled": 0, "changed": changed(), "blocking": [], "dependencies": False}
if behind == 0:
    seen()
    done(dict(found, state="ahead" if ahead else "current"))
if ahead:
    done(dict(found, state="diverged"))
if request.get("fetchOnly"):
    done(dict(found, state="deferred"))
check_idle()
before = git("rev-parse", "HEAD").stdout.strip()
def forward():
    merged = git("merge", "--ff-only", "--quiet", "--no-overwrite-ignore", theirs, timeout=None)
    return merged, [line.strip() for line in merged.stderr.splitlines() if line.startswith("\\t")] if merged.returncode != 0 else []
def inside(path):
    real = os.path.realpath(os.path.join(target, path))
    return real.startswith(os.path.realpath(target) + os.sep)
merged, blocking = forward()
if blocking and all(path in GENERATED for path in blocking):
    # Written again by the development server, from the files they are made from: set back, or taken
    # away when git does not keep them here.
    for path in blocking:
        if git("ls-files", "--error-unmatch", "--", path).returncode == 0:
            git("checkout", "--", path)
        elif inside(path) and os.path.isfile(os.path.join(target, path)):
            os.remove(os.path.join(target, path))
    merged, blocking = forward()
if merged.returncode != 0:
    if blocking:
        done(dict(found, state="blocked", blocking=blocking[:5]))
    done({"ok": False, "code": "failed", "branch": branch, "message": clean(merged.stderr)})
seen()
files = git("diff", "--name-only", before, "HEAD").stdout.splitlines()
done(dict(found, state="updated", pulled=behind, behind=0, changed=changed(), dependencies=any(os.path.basename(path) in MANIFESTS for path in files)))
`;

const SYNC_CODES = [
  "refused",
  "unreachable",
  "not_a_copy",
  "detached",
  "busy",
  "interrupted",
  "no_branch",
  "no_access",
  "failed",
] as const;
type SyncCode = (typeof SYNC_CODES)[number];

const count = z.number().int().min(0).max(1_000_000);
/** As the script checks a branch's name before it fetches it. */
const branchName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

/**
 * What the script may answer. It runs in a container the project's agent controls, so its answer is
 * read as a claim: anything else is a failure, and nothing in it reaches a title or a page unchecked.
 */
const syncScriptResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    state: z.enum(["current", "updated", "blocked", "diverged", "ahead", "deferred"]),
    branch: branchName,
    pulled: count,
    behind: count,
    ahead: count,
    changed: count,
    blocking: z.array(z.string().max(500)).max(5),
    dependencies: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(SYNC_CODES),
    branch: branchName.optional(),
    token: z.boolean().optional(),
    message: z.string().max(500).optional(),
  }),
]);
export type SyncScriptResult = z.infer<typeof syncScriptResult>;

/** The script's verdict, from its output. Null when it printed none, or nothing it may answer. */
export function readSyncResult(output: string): SyncScriptResult | null {
  const line = output
    .split("\n")
    .reverse()
    .find((one) => one.startsWith(SYNC_PREFIX));
  if (line === undefined) {
    return null;
  }
  try {
    const parsed = syncScriptResult.safeParse(JSON.parse(line.slice(SYNC_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What the panel says when the script could not look at GitHub. */
const REASONS: Record<SyncCode, StudioSyncReason> = {
  refused: "agent_unavailable",
  unreachable: "agent_unavailable",
  not_a_copy: "not_a_copy",
  detached: "detached",
  busy: "busy",
  interrupted: "interrupted",
  no_branch: "no_branch",
  no_access: "no_access",
  failed: "failed",
};

const unavailable = (reason: StudioSyncReason, branch: string | null = null): StudioSync => ({
  state: "unavailable",
  branch,
  pulled: 0,
  behind: 0,
  ahead: 0,
  changed: 0,
  blocking: [],
  previewRestarted: false,
  reason,
});

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

async function runScript(
  deps: AppDeps,
  service: string,
  request: Record<string, unknown>,
): Promise<SyncScriptResult> {
  try {
    const outcome = await runInDatabase(
      deps,
      service,
      { command: ["python3", "-c", SYNC_SCRIPT], stdin: JSON.stringify(request) },
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    return readSyncResult(outcome.output) ?? { ok: false, code: "failed" };
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return { ok: false, code: "unreachable" };
    }
    throw error;
  }
}

const isUp = (deps: AppDeps, record: ServiceRecord): boolean =>
  record.deployed !== null &&
  !record.spec.stopped &&
  !indexActiveActions(deps).has(`${record.projectName}/${record.name}`);

/**
 * The project's agent server, running: opening a project wakes it, as a message would, and the update
 * waits for it a little. Null when it is not up in time.
 */
async function wakeAgent(
  deps: AppDeps,
  record: ServiceRecord,
  actorEmail: string | undefined,
): Promise<ServiceRecord | null> {
  await startOwnAgent(deps, record, actorEmail);
  const deadline = Date.now() + AGENT_WAKE_MS;
  for (let fresh = record; ; ) {
    if (isUp(deps, fresh)) {
      return fresh;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await pause(500);
    const now = findService(deps.db, record.projectName, record.name);
    if (now === undefined) {
      return null;
    }
    fresh = now;
  }
}

/** Starts the preview again once the start or deployment under way is over, when it still runs. */
async function restartOnceSettled(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<void> {
  const deadline = Date.now() + RESTART_WAITS_MS;
  while (Date.now() < deadline) {
    await pause(2_000);
    if (indexActiveActions(deps).has(`${target.projectName}/${target.serviceName}`)) {
      continue;
    }
    const record = findService(deps.db, target.projectName, target.serviceName);
    if (record !== undefined && record.deployed !== null && !record.spec.stopped) {
      await enqueueRestart(deps, target, actorEmail);
    }
    return;
  }
}

/**
 * Starts the preview again when the changes brought new packages, which it installs as it starts. One
 * that is stopped installs them at its next start. One on its way already may have installed from the
 * folder as it was before the update: it starts again once it is up.
 */
async function restartForPackages(
  deps: AppDeps,
  record: ServiceRecord,
  actorEmail: string | undefined,
): Promise<boolean> {
  const target = { projectName: record.projectName, serviceName: record.name };
  if (indexActiveActions(deps).has(`${record.projectName}/${record.name}`)) {
    void restartOnceSettled(deps, target, actorEmail).catch((error: unknown) => {
      deps.logger.warn({ err: error, ...target }, "Could not restart a Studio preview for its new packages");
    });
    return true;
  }
  if (record.deployed === null || record.spec.stopped) {
    return false;
  }
  try {
    await enqueueRestart(deps, target, actorEmail);
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, ...target }, "Could not restart a Studio preview for its new packages");
    return false;
  }
}

async function bringUpToDate(
  deps: AppDeps,
  record: ServiceRecord,
  app: repo.StudioAppRow,
  actorEmail: string | undefined,
  wake: boolean,
): Promise<StudioSync> {
  const settings = readStudioSettings(deps);
  const model = settings.agent;
  if (!settings.enabled || model === null) {
    throw conflict("studio_off", "Turn the Studio on and choose its agent server first.");
  }
  const url = app.repository === null ? {} : { url: `https://github.com/${app.repository}.git` };
  // Whoever writes the folder decides where its git runs: a project with an agent server of its own
  // keeps it, and its folder, whatever the setting says now.
  const agentRecord = app.agentServiceId === null ? undefined : findServiceById(deps.db, app.agentServiceId);
  let result: SyncScriptResult;
  if (agentRecord !== undefined) {
    let awake: ServiceRecord | null;
    try {
      awake = wake
        ? await wakeAgent(deps, agentRecord, actorEmail)
        : isUp(deps, agentRecord)
          ? agentRecord
          : null;
    } catch (error) {
      deps.logger.warn({ err: error }, "Could not start a Studio project's agent server for its update");
      return unavailable("agent_unavailable");
    }
    if (awake === null) {
      return unavailable("agent_starting");
    }
    // While the agent is at work, the folder does not move under it: it pulls before its next change.
    const working = await isWorking(deps, ownAgentOf(model, awake), app.serviceId);
    result = await runScript(deps, qualifiedName(awake.projectName, awake.name), {
      relay: true,
      dir: app.workspaceDir,
      ...url,
      ...(working ? { fetchOnly: true } : {}),
    });
  } else {
    // A project on the shared agent server is left to that agent, which pulls before its changes.
    return unavailable("no_agent");
  }
  if (!result.ok) {
    if (result.code === "failed" && result.message !== undefined) {
      deps.logger.warn(
        { project: record.projectName, service: record.name, message: result.message },
        "Could not bring a Studio project up to date with GitHub",
      );
    }
    return unavailable(REASONS[result.code] ?? "failed", result.branch ?? null);
  }
  // As the preview is now, not as it was before the update: a start may have begun meanwhile.
  const preview = findService(deps.db, record.projectName, record.name) ?? record;
  const previewRestarted =
    result.state === "updated" &&
    result.dependencies &&
    (await restartForPackages(deps, preview, actorEmail));
  if (result.state === "updated") {
    const changes = `${result.pulled} change${result.pulled === 1 ? "" : "s"}`;
    deps.actions.record({
      type: "studio.sync",
      title: `Bring ${app.repository ?? app.workspaceDir} up to date with GitHub: ${changes} on ${result.branch}`,
      projectName: record.projectName,
      serviceName: record.name,
      actorEmail,
    });
  }
  return {
    state: result.state,
    branch: result.branch,
    pulled: result.pulled,
    behind: result.behind,
    ahead: result.ahead,
    changed: result.changed,
    blocking: result.blocking,
    previewRestarted,
    reason: null,
  };
}

interface Update {
  answer: Promise<StudioSync>;
  /** When it ended, and whether its answer may be given again: good news only. */
  endedAt: number | null;
  reusable: boolean;
}

/** Per project: the update under way, or the last one. */
const updates = new Map<string, Update>();

/**
 * Brings a Studio project's folder up to date with GitHub, for whoever may work on it. Two openings
 * at once share one update, and an opening just after one that found good news gets its answer: git
 * works in one folder one command at a time. `force`, for someone who asks again, only shares one
 * under way.
 */
export function syncStudioProject(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
  force = false,
  wake = true,
): Promise<StudioSync> {
  const { record, app } = requireLinked(deps, target);
  const key = `${record.projectName}/${record.name}/${app.serviceId}`;
  const known = updates.get(key);
  if (
    known !== undefined &&
    (known.endedAt === null || (!force && known.reusable && deps.now() - known.endedAt < RECENT_MS))
  ) {
    return known.answer;
  }
  const update: Update = {
    answer: bringUpToDate(deps, record, app, actorEmail, wake),
    endedAt: null,
    reusable: false,
  };
  updates.set(key, update);
  update.answer.then(
    (answer) => {
      update.endedAt = deps.now();
      update.reusable = answer.state === "current" || answer.state === "updated";
    },
    () => {
      // A failure is not kept: the next opening asks again.
      if (updates.get(key) === update) {
        updates.delete(key);
      }
    },
  );
  return update.answer;
}

/**
 * Brings the project up to date before its preview starts, which installs its packages from the
 * folder as it is then. GitHub may be slow: the start never waits more than a few seconds, and goes
 * on whatever the update found. A project's agent server that sleeps is left to the start, which
 * wakes it with the preview: the Studio's own update, as the project opens, follows once it is up.
 */
export async function syncBeforeStart(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, START_WAITS_FOR_SYNC_MS);
  });
  const update = Promise.resolve()
    .then(() => syncStudioProject(deps, target, actorEmail, false, false))
    .then(
      () => undefined,
      () => undefined,
    );
  try {
    await Promise.race([update, waited]);
  } finally {
    clearTimeout(timer);
  }
}
