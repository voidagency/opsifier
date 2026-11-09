import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOX_CONTROL_SCRIPT, BOX_HOOK_FAILED_EXIT, BOX_SUPERVISOR_SCRIPT } from "./supervisor";

/**
 * The real scripts under a real shell: this is what runs as the main process of every box, and what
 * a mock could not tell us is whether a crashed process actually comes back or a signal actually lands.
 */
let root = "";
let running: ChildProcessWithoutNullStreams | null = null;
let output = "";

const WORKSPACE = () => join(root, "workspace");
const STATE = () => join(root, "state");

const env = () => ({
  ...process.env,
  OPSIFIER_BOX_ROOT: root,
  OPSIFIER_BOX_STATE: STATE(),
  OPSIFIER_BOX_WORKSPACE: WORKSPACE(),
  OPSIFIER_BOX_RESTART_DELAY: "1",
});

function writeScript(path: string, content: string): void {
  writeFileSync(join(root, path), content);
  chmodSync(join(root, path), 0o755);
}

function addProcess(name: string, body: string): void {
  writeScript(`processes/${name}`, `#!/bin/sh\n${body}\n`);
}

function startHook(body: string): void {
  writeScript("hooks/start", `#!/bin/sh\nset -e\n${body}\n`);
}

function supervise(): ChildProcessWithoutNullStreams {
  const child = spawn("/bin/sh", [join(root, "supervise")], { env: env(), detached: true });
  running = child;
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  return child;
}

async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}. Output so far:\n${output}`);
    }
    await sleep(25);
  }
}

const exited = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

const control = (...args: string[]): string =>
  execFileSync("/bin/sh", [join(root, "boxctl"), ...args], { env: env(), encoding: "utf8" });

interface Row {
  state: string;
  pid: number;
  restarts: number;
  last: string;
}

function rowOf(name: string): Row | undefined {
  const line = control("status")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}\t`));
  if (line === undefined) {
    return undefined;
  }
  const [, state = "", pid = "0", restarts = "0", last = ""] = line.split("\t");
  return { state, pid: Number(pid), restarts: Number(restarts), last };
}

const lines = (file: string): string[] =>
  existsSync(join(WORKSPACE(), file))
    ? readFileSync(join(WORKSPACE(), file), "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opsifier-box-"));
  for (const folder of ["processes", "hooks", "state", "workspace"]) {
    mkdirSync(join(root, folder));
  }
  writeScript("supervise", BOX_SUPERVISOR_SCRIPT);
  writeScript("boxctl", BOX_CONTROL_SCRIPT);
  output = "";
  running = null;
});

afterEach(async () => {
  if (running !== null && running.exitCode === null && running.pid !== undefined) {
    const finished = exited(running);
    try {
      process.kill(-running.pid, "SIGKILL");
    } catch {
      running.kill("SIGKILL");
    }
    await finished;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("the supervisor", () => {
  it("starts a process that crashes again, with its name on what it prints", async () => {
    addProcess("web", `echo "started" >>"${WORKSPACE()}/runs"; echo hello; exit 3`);
    supervise();

    await until(() => lines("runs").length >= 2, "a second start");
    await until(() => (rowOf("web")?.restarts ?? 0) >= 1, "the crash to be counted");

    expect(rowOf("web")?.last).toBe("3");
    expect(output).toContain("[web] hello");
    expect(output).toContain("web exited with status 3");
  });

  it("runs the start hook first, in the workspace, before any process", async () => {
    startHook(`pwd >hook-dir\necho from-hook >order`);
    addProcess("web", `cat "${WORKSPACE()}/order" >"${WORKSPACE()}/seen"; sleep 30`);
    supervise();

    await until(() => lines("seen").length === 1, "the process to run after the hook");
    expect(lines("seen")).toEqual(["from-hook"]);
    expect(lines("hook-dir")[0]).toContain("workspace");
    expect(control("ready")).toBe("");
  });

  it("starts nothing and fails when the start hook does", async () => {
    startHook(`echo before-it-fails\nexit 7`);
    addProcess("web", `echo "started" >>"${WORKSPACE()}/runs"; sleep 30`);
    const child = supervise();
    const code = await exited(child);

    expect(code).toBe(BOX_HOOK_FAILED_EXIT);
    expect(output).toContain("[start] before-it-fails");
    expect(output).toContain("The start hook failed with exit code 7");
    expect(lines("runs")).toEqual([]);
    expect(() => control("ready")).toThrow();
  });

  it("stops when any line of a hook fails, not just its last", async () => {
    startHook(`false\necho kept-going >"${WORKSPACE()}/after"`);
    const child = supervise();

    expect(await exited(child)).toBe(BOX_HOOK_FAILED_EXIT);
    expect(lines("after")).toEqual([]);
  });

  it("stops its processes on the signal Docker sends, and exits cleanly", async () => {
    addProcess("web", `echo $$ >"${WORKSPACE()}/pid"; sleep 300`);
    addProcess("worker", `echo $$ >"${WORKSPACE()}/worker"; sleep 300`);
    const child = supervise();
    await until(() => lines("pid").length === 1 && lines("worker").length === 1, "both processes");
    await until(
      () => rowOf("web")?.state === "running" && rowOf("worker")?.state === "running",
      "their state",
    );
    const pids = [Number(lines("pid")[0]), Number(lines("worker")[0])];

    const finished = exited(child);
    child.kill("SIGTERM");
    expect(await finished).toBe(0);
    await until(() => pids.every((pid) => !alive(pid)), "the processes to end");
    await until(() => rowOf("web")?.state === "stopped", "the state to say so");
  });

  it("restarts one process on request, straight away, without calling it a crash", async () => {
    addProcess("web", `echo $$ >>"${WORKSPACE()}/pids"; exec sleep 300`);
    supervise();
    await until(() => rowOf("web")?.state === "running", "the process");
    await until(() => lines("pids").length === 1, "its first pid");
    const first = rowOf("web")?.pid ?? 0;

    expect(control("restart", "web")).toContain("opsifier-ok");

    await until(() => {
      const row = rowOf("web");
      return row !== undefined && row.state === "running" && row.pid !== first;
    }, "a new process");
    expect(lines("pids")).toHaveLength(2);
    expect(rowOf("web")?.restarts).toBe(0);
  });

  it("refuses to restart what it does not supervise", () => {
    addProcess("web", "sleep 30");
    supervise();
    expect(() => control("restart", "no-such-process")).toThrow();
  });

  it("stays up with no processes, for a box that is only a workspace", async () => {
    const child = supervise();
    await until(() => existsSync(join(STATE(), ".ready")), "readiness");
    expect(child.exitCode).toBeNull();
    expect(control("status")).toContain("opsifier-ok");
  });
});
