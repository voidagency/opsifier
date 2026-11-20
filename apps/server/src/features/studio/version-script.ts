import type { StudioAgent, StudioVersion } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { type AppError, conflict, notFound, serviceUnavailable } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { qualifiedName } from "../services/compile";
import { callAgent } from "./agent";
import { toStudioStatus } from "./events";
import * as repo from "./repo";

/**
 * The script that reads and moves a Studio project's folder between its versions, and what the panel
 * makes of its answers. Nothing here imports the Studio's service, which asks it before a message that
 * brings an earlier version back.
 */

const VERSIONS_PREFIX = "opsifier-studio-versions ";
const VERSIONS_TIMEOUT_MS = 90_000;
/** The versions listed at most, the newest first. */
export const MAX_VERSIONS = 50;
/** Room for that many versions with their lines escaped, past an exec's usual limit. */
const VERSIONS_OUTPUT_CHARS = 256 * 1024;

/**
 * Runs in the agent server's container, with its request on standard input. It never asks GitHub
 * anything, never sees the agent server's keys, and never loses a change: one not saved yet stops an
 * earlier version from being shown, and what changed while one was shown, which is no one's work since
 * no message reaches the agent meanwhile, is set aside in git's stash before the folder moves again.
 * Files git does not keep, such as a site's settings, are never written over. A folder whose own git
 * settings run commands as files are read or written is left as it is.
 */
export const VERSIONS_SCRIPT = `
import json, os, re, secrets, subprocess, sys
request = json.load(sys.stdin)
def done(result):
    print(${JSON.stringify(VERSIONS_PREFIX)} + json.dumps(result))
    sys.exit(0)
target = request["dir"]
action = request.get("action")
GENERATED = ("src/routeTree.gen.ts",)
MARKER = "opsifier-studio-version"
SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "advice.detachedHead=false", "-c", "log.showSignature=false", "-c", "core.pager=cat", "-c", "submodule.recurse=false"]
IDENTITY = ["-c", "user.name=Opsifier Studio", "-c", "user.email=studio@opsifier.invalid"]
# Only what git needs from the container: none of the agent server's keys or tokens.
env = {name: os.environ[name] for name in ("PATH", "HOME", "USER", "LOGNAME") if name in os.environ}
env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
def git(*args, check=True, extra=()):
    try:
        run = subprocess.run(["git", *SAFE, *extra, "-C", target, *args], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        done({"ok": False, "code": "git", "message": str(error)[:300]})
    if check and run.returncode != 0:
        done({"ok": False, "code": "git", "message": (run.stderr or run.stdout).strip()[-300:]})
    return run
gitdir = os.path.join(target, ".git")
if os.path.islink(gitdir) or not os.path.isdir(gitdir):
    done({"ok": False, "code": "not_a_copy"})
marker = os.path.join(gitdir, MARKER)
head = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
detached = head == "HEAD"
def is_branch(name):
    return isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name) is not None and ".." not in name and git("show-ref", "--verify", "--quiet", "refs/heads/" + name, check=False).returncode == 0
def marked_branch():
    try:
        handle = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        with os.fdopen(handle) as stream:
            value = json.loads(stream.read(4096))
    except (OSError, ValueError):
        return None
    branch = value.get("branch") if isinstance(value, dict) else None
    return branch if is_branch(branch) else None
def mark(branch):
    temporary = marker + "." + secrets.token_hex(8)
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(handle, "w") as stream:
        stream.write(json.dumps({"branch": branch}))
    os.replace(temporary, marker)
def unmark():
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
def entry(line):
    parts = line.split("\\x1f")
    try:
        at = int(parts[1])
    except (IndexError, ValueError):
        return None
    if not re.fullmatch(r"[0-9a-f]{40}", parts[0]) or not 0 <= at <= 253402300799:
        return None
    return {"sha": parts[0], "at": at, "subject": (parts[2] if len(parts) > 2 else "")[:200]}
def version_of(ref):
    return entry(git("log", "-1", "--format=%H%x1f%ct%x1f%s", ref, "--", check=False).stdout.strip())
def runs_commands():
    # A filter of the folder's own runs a command for each file git reads or writes.
    found = git("config", "--show-scope", "--get-regexp", r"^filter\\..+\\.(smudge|clean|process)$", check=False)
    if found.returncode not in (0, 1):
        done({"ok": False, "code": "git", "message": (found.stderr or found.stdout).strip()[-300:]})
    if any(line.split("\\t", 1)[0] in ("local", "worktree") for line in found.stdout.splitlines()):
        done({"ok": False, "code": "unsafe"})
def changes():
    paths, items, at = [], git("status", "--porcelain", "-z", "--untracked-files=no", "--ignore-submodules=all").stdout.split("\\0"), 0
    while at < len(items):
        item = items[at]
        at += 1
        if len(item) > 3:
            paths.append(item[3:])
            if item[0] in "RC":
                at += 1
    return paths
def set_aside(untracked=False):
    git("stash", "push", *(["--include-untracked"] if untracked else []), "-m", "Opsifier Studio: changes made while an earlier version was shown", extra=IDENTITY)
def clear_generated(changed):
    regenerated = [path for path in changed if path in GENERATED]
    if regenerated:
        git("checkout", "--", *regenerated)
def collided(run):
    return "would be overwritten" in run.stderr or "would be removed" in run.stderr
def in_the_way(run):
    return [line.strip() for line in run.stderr.splitlines() if line.startswith("\\t")][:5]
if action == "list":
    shown_branch = marked_branch() if detached else None
    asked = request.get("branch")
    ref = "refs/heads/" + shown_branch if shown_branch else ("refs/heads/" + asked if detached and is_branch(asked) else "HEAD")
    limit = max(1, min(int(request.get("limit") or 50), 200))
    out = git("log", "--first-parent", "-n", str(limit), "--format=%H%x1f%ct%x1f%s", ref, "--").stdout
    versions = [one for one in (entry(line) for line in out.splitlines() if line.strip()) if one is not None]
    shown = None
    if shown_branch:
        shown = version_of("HEAD") or {"sha": git("rev-parse", "HEAD").stdout.strip(), "at": 0, "subject": ""}
        shown["branch"] = shown_branch
    done({"ok": True, "versions": versions, "branch": None if detached else head, "detached": detached, "shown": shown})
if action == "status":
    runs_commands()
    left = [path for path in changes() if path not in GENERATED]
    if left:
        done({"ok": False, "code": "changed", "files": left[:5]})
    if detached:
        done({"ok": False, "code": "detached"})
    done({"ok": True})
if action == "view":
    sha = request.get("sha") or ""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        done({"ok": False, "code": "unknown"})
    asked = request.get("branch")
    branch = (marked_branch() or (asked if is_branch(asked) else None)) if detached else head
    if not is_branch(branch):
        done({"ok": False, "code": "detached"})
    if git("merge-base", "--is-ancestor", sha, "refs/heads/" + branch, check=False).returncode != 0:
        done({"ok": False, "code": "unknown"})
    shown = version_of(sha)
    if shown is None:
        done({"ok": False, "code": "unknown"})
    runs_commands()
    changed = changes()
    left = [path for path in changed if path not in GENERATED]
    if left and not detached:
        done({"ok": False, "code": "changed", "files": left[:5]})
    stashed = bool(left)
    if left:
        set_aside()
    clear_generated(changed)
    mark(branch)
    moved = git("checkout", "--no-overwrite-ignore", "--detach", sha, check=False)
    if moved.returncode != 0:
        if not detached:
            unmark()
        if collided(moved):
            done({"ok": False, "code": "overwrite", "files": in_the_way(moved)})
        done({"ok": False, "code": "git", "message": moved.stderr.strip()[-300:]})
    done({"ok": True, "branch": branch, "stashed": stashed, **shown})
if action == "return":
    if not detached:
        unmark()
        done({"ok": True, "branch": head, "stashed": False})
    asked = request.get("branch")
    branch = marked_branch() or (asked if is_branch(asked) else None)
    if branch is None:
        done({"ok": False, "code": "no_branch"})
    runs_commands()
    changed = changes()
    left = [path for path in changed if path not in GENERATED]
    stashed = bool(left)
    if left:
        set_aside()
    clear_generated(changed)
    moved = git("checkout", branch, "--", check=False)
    if moved.returncode != 0 and collided(moved):
        set_aside(untracked=True)
        stashed = True
        moved = git("checkout", branch, "--", check=False)
    if moved.returncode != 0:
        done({"ok": False, "code": "git", "message": moved.stderr.strip()[-300:]})
    unmark()
    done({"ok": True, "branch": branch, "stashed": stashed})
done({"ok": False, "code": "bad_request"})
`;

export interface ScriptAnswer {
  ok?: unknown;
  code?: unknown;
  message?: unknown;
  files?: unknown;
  versions?: unknown;
  branch?: unknown;
  detached?: unknown;
  shown?: unknown;
  stashed?: unknown;
  sha?: unknown;
  at?: unknown;
  subject?: unknown;
}

/**
 * Runs the script, and reads its verdict: null when it gave none, timed out or stopped, so that what
 * it did to the folder is not known.
 */
export async function runVersions(
  deps: Pick<AppDeps, "docker">,
  agent: StudioAgent,
  request: Record<string, unknown>,
): Promise<ScriptAnswer | null> {
  let output: string;
  try {
    const outcome = await runInDatabase(
      deps,
      qualifiedName(agent.project, agent.service),
      { command: ["python3", "-c", VERSIONS_SCRIPT], stdin: JSON.stringify(request) },
      { timeoutMs: VERSIONS_TIMEOUT_MS, maxOutputChars: VERSIONS_OUTPUT_CHARS },
    );
    output = outcome.output;
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${agent.project}/${agent.service} is not running.`,
      );
    }
    throw error;
  }
  const line = output.split("\n").find((one) => one.startsWith(VERSIONS_PREFIX));
  try {
    const answer = line === undefined ? null : (JSON.parse(line.slice(VERSIONS_PREFIX.length)) as unknown);
    if (answer !== null && typeof answer === "object") {
      return answer as ScriptAnswer;
    }
  } catch {
    // Read as no answer below.
  }
  return null;
}

export const noVerdict = () =>
  serviceUnavailable("studio_version_failed", "The project's folder could not be read or changed.");

/** What a refusal says, for the person who asked. */
export function refused(answer: ScriptAnswer): AppError {
  switch (answer.code) {
    case "changed":
      return conflict(
        "studio_version_unsaved",
        "Changes in the project's folder are not saved yet: the agent saves them as it works, so try again once it has answered.",
      );
    case "overwrite":
      return conflict(
        "studio_version_overwrite",
        "That version would write over files the folder keeps outside git, such as the site's settings: it is not shown.",
      );
    case "unsafe":
      return conflict(
        "studio_version_unsafe",
        "The project's own git settings run commands as files are read or written: the panel leaves its folder as it is.",
      );
    case "detached":
      return conflict("studio_version_detached", "The project's folder is on no branch.");
    case "unknown":
      return notFound("No such version of the project.");
    case "no_branch":
      return conflict("studio_version_no_branch", "The project's branch is gone from its folder.");
    case "not_a_copy":
      return conflict("studio_version_not_a_copy", "The project's folder is not a git repository.");
    default:
      return noVerdict();
  }
}

export const toVersion = (value: unknown): StudioVersion | null => {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const { sha, at, subject } = value as Record<string, unknown>;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || typeof at !== "number") {
    return null;
  }
  const date = new Date(at * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { sha, at: date.toISOString(), subject: typeof subject === "string" ? subject.slice(0, 300) : "" };
};

/** Whether one of the project's recent conversations with that agent server is at work. */
export async function atWork(
  deps: AppDeps,
  agent: StudioAgent,
  appId: string,
  own: boolean,
): Promise<boolean> {
  const recent = repo
    .listConversations(deps.db, appId)
    .filter((conversation) => conversation.sharedAgent === !own)
    .slice(0, 5);
  if (recent.length === 0) {
    return false;
  }
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
      const status = toStudioStatus(
        (JSON.parse(reply.text) as { execution_status?: unknown }).execution_status,
      );
      return status === "running" || status === "waiting";
    } catch {
      return false;
    }
  });
}

/**
 * Before a message asks the agent to bring an earlier version back, which writes the whole folder:
 * refused while one of the project's conversations is at work, or while changes are not saved yet.
 */
export async function refuseRestoreWhileBusy(
  deps: AppDeps,
  app: repo.StudioAppRow,
  agent: StudioAgent,
  own: boolean,
): Promise<void> {
  if (await atWork(deps, agent, app.serviceId, own)) {
    throw conflict(
      "studio_agent_working",
      "The agent is at work on this project: bring an earlier version back once it has answered.",
    );
  }
  const answer = await runVersions(deps, agent, { action: "status", dir: app.workspaceDir });
  if (answer === null) {
    throw noVerdict();
  }
  if (answer.ok !== true) {
    throw refused(answer);
  }
}
