import type {
  ActionDetail,
  CreatedApiKey,
  ScriptEntry,
  ScriptList,
  ScriptRun,
  ScriptRunDetail,
  ScriptRunPage,
  StartedScriptRun,
} from "@opsifier/contract";
import { SCRIPT_RUNS_KEPT, SCRIPT_SKIPS_KEPT } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptRuns } from "../../../core/db/schema";
import type { FakeExec } from "../../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_EMAIL,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { settleLeftoverRuns } from "./run";
import { nextRunOf, ScriptScheduler, scriptSchedulerFor } from "./schedule";

const SERVICE = "/api/v1/projects/shop/services/web";
const SCRIPTS = `${SERVICE}/scripts`;
const RUNS = `${SERVICE}/script-runs`;

let context: TestContext;
let cookie: string;

function api<T = unknown>(path: string, method = "GET", body?: unknown, as: string = cookie) {
  return call<T>(context.app, path, { method, body, cookie: as, origin: TEST_ORIGIN });
}

async function until(condition: () => boolean | Promise<boolean>, what = "the condition"): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function runOf(id: string, as: string = cookie): Promise<ScriptRunDetail> {
  const result = await api<ScriptRunDetail>(`${RUNS}/${id}`, "GET", undefined, as);
  expect(result.status).toBe(200);
  return result.body;
}

const isOver = (run: ScriptRun) => run.status !== "queued" && run.status !== "running";

async function finished(id: string): Promise<ScriptRunDetail> {
  await until(async () => isOver(await runOf(id)), "the run to finish");
  return runOf(id);
}

function saveScript(script: Record<string, unknown>) {
  return api<ScriptList>(SCRIPTS, "POST", script);
}

async function startScript(name: string, as: string = cookie): Promise<StartedScriptRun> {
  const started = await api<StartedScriptRun>(RUNS, "POST", { script: name }, as);
  expect(started.status).toBe(202);
  return started.body;
}

async function saveAndStart(body: string, name = "job", extra: Record<string, unknown> = {}) {
  expect((await saveScript({ name, script: body, ...extra })).status).toBe(201);
  return startScript(name);
}

async function history(as: string = cookie): Promise<ScriptRun[]> {
  return (await api<ScriptRunPage>(RUNS, "GET", undefined, as)).body.items;
}

const lastExec = (): FakeExec => context.docker.execs.at(-1) as FakeExec;

async function deploy(app: TestContext["app"] = context.app): Promise<void> {
  const send = <T>(path: string, method?: string) =>
    call<T>(app, path, { method, cookie, origin: TEST_ORIGIN });
  const accepted = await send<{ id: string }>(`${SERVICE}/deploy`, "POST");
  expect(accepted.status).toBe(202);
  await until(async () => {
    context.docker.advance(1);
    const { body } = await send<{ status: string }>(`/api/v1/actions/${accepted.body.id}`);
    return body.status === "succeeded";
  }, "the deployment");
}

/** The Action of a run settles a moment after the run's own row, once its `run` has returned. */
async function actionOf(id: string): Promise<ActionDetail> {
  await until(async () => {
    const { status } = (await api<ActionDetail>(`/api/v1/actions/${id}`)).body;
    return status !== "queued" && status !== "running";
  }, "the Action to finish");
  return (await api<ActionDetail>(`/api/v1/actions/${id}`)).body;
}

async function runningScriptExec(id: string): Promise<FakeExec> {
  await until(() => context.docker.execs.some((exec) => exec.options.marker === id), "the process to start");
  return context.docker.execs.find((exec) => exec.options.marker === id) as FakeExec;
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/api/v1/projects", "POST", { name: "shop" });
  await api("/api/v1/projects/shop/services", "POST", { name: "web" });
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
  await deploy();
});

afterEach(async () => {
  await context.close();
});

describe("a script's settings", () => {
  it("keeps a schedule, its time zone and a time limit, and says when it next runs", async () => {
    const saved = await saveScript({
      name: "Nightly",
      script: "echo hi",
      maxDurationSeconds: 120,
      schedule: { cron: "30 2 * * *", timeZone: "Asia/Tokyo" },
    });

    expect(saved.status).toBe(201);
    const entry = saved.body.scripts[0] as ScriptEntry;
    expect(entry).toMatchObject({
      name: "Nightly",
      maxDurationSeconds: 120,
      schedule: { cron: "30 2 * * *", timeZone: "Asia/Tokyo" },
    });
    expect(entry.nextRunAt).toBe(
      new Date(
        nextRunOf({ cron: "30 2 * * *", timeZone: "Asia/Tokyo" }, context.deps.now()) as number,
      ).toISOString(),
    );
    // 02:30 in Tokyo, whatever zone this process runs in.
    expect(new Date(entry.nextRunAt as string).getUTCHours()).toBe(17);
  });

  it("gives a script with no schedule no due time, and one hour of runtime by default", async () => {
    const saved = await saveScript({ name: "manual", script: "ls" });

    expect(saved.body.scripts[0]).toMatchObject({
      nextRunAt: null,
      schedule: null,
      maxDurationSeconds: 3600,
    });
  });

  it.each([
    [
      "an unknown time zone",
      { schedule: { cron: "* * * * *", timeZone: "Mars/Olympus" } },
      "schedule.timeZone",
    ],
    ["no time zone at all", { schedule: { cron: "* * * * *" } }, "schedule.timeZone"],
    ["a cron that never happens", { schedule: { cron: "0 0 31 2 *", timeZone: "UTC" } }, "schedule.cron"],
    ["a cron that is not one", { schedule: { cron: "soon", timeZone: "UTC" } }, "schedule.cron"],
    ["no time limit", { maxDurationSeconds: 0 }, "maxDurationSeconds"],
    ["more than a day", { maxDurationSeconds: 86_401 }, "maxDurationSeconds"],
    ["half a second", { maxDurationSeconds: 1.5 }, "maxDurationSeconds"],
  ])("refuses %s", async (_label, extra, field) => {
    const result = await saveScript({ name: "bad", script: "ls", ...extra });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeDefined();
  });

  it("stores a time zone under the name the runtime knows it by", async () => {
    const saved = await saveScript({
      name: "lower",
      script: "ls",
      schedule: { cron: "0 3 * * *", timeZone: "europe/paris" },
    });

    expect(saved.body.scripts[0]?.schedule?.timeZone).toBe("Europe/Paris");
  });

  it("recomputes the next time when the schedule changes, and leaves it when something else does", async () => {
    await saveScript({ name: "job", script: "a", schedule: { cron: "0 3 * * *", timeZone: "UTC" } });
    const before = (await api<ScriptList>(SCRIPTS)).body.scripts[0]?.nextRunAt;

    context.advance(3_600_000);
    const unchanged = await api<ScriptList>(`${SCRIPTS}/0`, "PUT", {
      name: "job",
      script: "b",
      schedule: { cron: "0 3 * * *", timeZone: "UTC" },
    });
    expect(unchanged.body.scripts[0]?.nextRunAt).toBe(before);

    const changed = await api<ScriptList>(`${SCRIPTS}/0`, "PUT", {
      name: "job",
      script: "b",
      schedule: { cron: "0 3 * * *", timeZone: "Asia/Tokyo" },
    });
    expect(changed.body.scripts[0]?.nextRunAt).not.toBe(before);
    expect(changed.body.scripts[0]?.nextRunAt).not.toBeNull();
  });

  it("forgets the due time when a schedule or the script itself goes", async () => {
    await saveScript({ name: "job", script: "a", schedule: { cron: "0 3 * * *", timeZone: "UTC" } });

    const cleared = await api<ScriptList>(`${SCRIPTS}/0`, "PUT", {
      name: "job",
      script: "a",
      schedule: null,
    });
    expect(cleared.body.scripts[0]?.nextRunAt).toBeNull();

    await api(`${SCRIPTS}/0`, "PUT", {
      name: "job",
      script: "a",
      schedule: { cron: "0 3 * * *", timeZone: "UTC" },
    });
    expect((await api<ScriptList>(`${SCRIPTS}/0`, "DELETE")).status).toBe(200);
    expect(scriptSchedulerFor(context.deps)?.tick()).toBe(0);
  });
});

describe("running a script", () => {
  it("runs it in the service's task, as an Action, and stores what happened", async () => {
    const started = await saveAndStart("echo one\necho two\nexit 3");

    expect(started.run).toMatchObject({
      scriptName: "job",
      origin: "manual",
      actorEmail: TEST_EMAIL,
      status: "queued",
    });
    expect(started.type).toBe("service.script");
    expect(started.id).toBe(started.run.id);

    const run = await finished(started.run.id);
    expect(run).toMatchObject({
      status: "failed",
      exitCode: 3,
      output: "one\ntwo\n",
      outputComplete: true,
      outputTruncated: false,
      origin: "manual",
      actorEmail: TEST_EMAIL,
      task: { slot: 1 },
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(lastExec().options).toMatchObject({
      service: "shop_web",
      taskId: run.task?.id,
      command: ["/bin/sh", "-c", "echo one\necho two\nexit 3"],
      tty: false,
      marker: run.id,
    });

    const action = await actionOf(run.id);
    expect(action).toMatchObject({
      status: "failed",
      error: "Exited with code 3.",
      origin: "session",
      actorEmail: TEST_EMAIL,
    });
    expect(action.log).toContain("one");
  });

  it("calls a clean exit a success", async () => {
    const started = await saveAndStart("echo fine");

    expect(await finished(started.run.id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      output: "fine\n",
    });
  });

  it("answers 404 for a script that does not exist, and starts nothing", async () => {
    const result = await api(RUNS, "POST", { script: "nothing" });

    expect(result.status).toBe(404);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("refuses to start a script that is already running", async () => {
    const started = await saveAndStart("sleep 1000");
    await runningScriptExec(started.run.id);

    const second = await api(RUNS, "POST", { script: "job" });

    expect(second.status).toBe(409);
    expect(apiErrorOf(second).code).toBe("script_already_running");
    expect(context.docker.execs).toHaveLength(1);
    await cancelAndConfirm(started.run.id);
  });

  it("fails with the reason when the service has no running task", async () => {
    await api(`${SERVICE}/stop`, "POST");
    await until(async () => {
      context.docker.advance(1);
      return (await context.docker.listTasks({ service: "shop_web" })).every(
        (task) => task.state !== "running" || task.desiredState !== "running",
      );
    }, "the service to stop");

    const started = await saveAndStart("echo hello");
    const run = await finished(started.run.id);

    expect(run).toMatchObject({ status: "failed", exitCode: null, note: { code: "no_running_task" } });
    expect(context.docker.execs).toHaveLength(0);
  });

  it("keeps only the end of a run's output, and says so", async () => {
    const started = await saveAndStart("sleep 1000");
    const exec = await runningScriptExec(started.run.id);
    const huge = "x".repeat(2000);
    const lines = 200;
    for (let index = 0; index < lines; index += 1) {
      exec.stream.push(`${index} ${huge}\n`);
    }
    exec.exit(0);

    const run = await finished(started.run.id);

    expect(run.status).toBe("succeeded");
    expect(run.outputTruncated).toBe(true);
    expect(run.output.length).toBeLessThanOrEqual(64 * 1024);
    expect(run.output.endsWith(`${lines - 1} ${huge}\n`)).toBe(true);
    expect(run.output.startsWith("0 ")).toBe(false);
  });

  it("sees the end of its input, so a script that reads never hangs", async () => {
    const started = await saveAndStart("echo done");
    await finished(started.run.id);

    expect(lastExec().stream.writableEnded).toBe(true);
  });

  it("records who asked through an API key, and what that key is called", async () => {
    await saveScript({ name: "job", script: "echo api" });
    const key = await api<CreatedApiKey>("/api/v1/me/api-keys", "POST", { name: "ci", level: "write" });
    expect(key.status).toBe(201);

    const started = await call<StartedScriptRun>(context.app, RUNS, {
      method: "POST",
      headers: { authorization: `Bearer ${key.body.token}` },
      body: { script: "job" },
    });

    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ origin: "api", actorEmail: TEST_EMAIL, originDetail: "ci" });
    expect(started.body).toMatchObject({ origin: "api_key", originDetail: "ci" });
    await finished(started.body.run.id);
  });

  it("gives runs the same rights as anything else", async () => {
    await saveScript({ name: "job", script: "echo x" });
    await api("/api/v1/projects", "POST", { name: "other" });
    const viewer = await signInMember(context.app, cookie, "viewer@example.com", [
      { project: "shop", role: "viewer" },
    ]);
    const stranger = await signInMember(context.app, cookie, "stranger@example.com", [
      { project: "other", role: "operator" },
    ]);
    const operator = await signInMember(context.app, cookie, "operator@example.com", [
      { project: "shop", role: "operator" },
    ]);
    const readKey = await api<CreatedApiKey>("/api/v1/me/api-keys", "POST", { name: "ro", level: "read" });
    const otherKey = await api<CreatedApiKey>("/api/v1/me/api-keys", "POST", {
      name: "narrow",
      level: "write",
      projects: ["other"],
    });

    expect((await api(RUNS, "POST", { script: "job" }, viewer)).status).toBe(403);
    expect((await api(RUNS, "GET", undefined, viewer)).status).toBe(403);
    expect((await api(RUNS, "POST", { script: "job" }, stranger)).status).toBe(404);
    expect(
      (
        await call(context.app, RUNS, {
          method: "POST",
          headers: { authorization: `Bearer ${readKey.body.token}` },
          body: { script: "job" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(context.app, RUNS, {
          method: "POST",
          headers: { authorization: `Bearer ${otherKey.body.token}` },
          body: { script: "job" },
        })
      ).status,
    ).toBe(404);

    const started = await api<StartedScriptRun>(RUNS, "POST", { script: "job" }, operator);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ origin: "manual", actorEmail: "operator@example.com" });
    await finished(started.body.run.id);
    expect(context.docker.execs).toHaveLength(1);
  });

  it("does not let one service reach another's run", async () => {
    await api("/api/v1/projects/shop/services", "POST", { name: "api" });
    const started = await saveAndStart("sleep 1000");

    const other = "/api/v1/projects/shop/services/api/script-runs";
    expect((await api(`${other}/${started.run.id}`)).status).toBe(404);
    expect((await api(`${other}/${started.run.id}/cancel`, "POST")).status).toBe(404);
    await cancelAndConfirm(started.run.id);
  });
});

async function cancelAndConfirm(id: string): Promise<ScriptRunDetail> {
  const cancelled = await api(`${RUNS}/${id}/cancel`, "POST");
  expect(cancelled.status).toBe(200);
  await until(async () => (await runOf(id)).status === "cancelled", "the run to be cancelled");
  return runOf(id);
}

describe("the time limit", () => {
  it("ends the process when the time is up and records why", async () => {
    const started = await saveAndStart("sleep 1000", "slow", { maxDurationSeconds: 1 });
    const exec = await runningScriptExec(started.run.id);

    const run = await finished(started.run.id);

    expect(exec.terminated).toBe(true);
    expect(run).toMatchObject({ status: "timed_out", exitCode: 137, note: { code: "time_limit" } });
    const action = await actionOf(run.id);
    expect(action.status).toBe("failed");
    expect(action.error).toContain("limit of 1 seconds");
  });
});

describe("cancelling", () => {
  it("really ends the process, and says so", async () => {
    const started = await saveAndStart("sleep 1000");
    const exec = await runningScriptExec(started.run.id);

    const run = await cancelAndConfirm(started.run.id);

    expect(exec.terminated).toBe(true);
    expect(run).toMatchObject({ status: "cancelled", exitCode: 137, note: null });
    expect((await actionOf(run.id)).status).toBe("cancelled");
  });

  it("keeps a queued run from ever starting", async () => {
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
    await api(`${SERVICE}/deploy`, "POST");
    const started = await saveAndStart("echo never");

    const cancelled = await api<ScriptRun>(`${RUNS}/${started.run.id}/cancel`, "POST");

    expect(cancelled.status).toBe(200);
    const run = await finished(started.run.id);
    expect(run.status).toBe("cancelled");
    expect(context.docker.execs).toHaveLength(0);
  });

  it("cancels through the Activity log just as well", async () => {
    const started = await saveAndStart("sleep 1000");
    const exec = await runningScriptExec(started.run.id);

    expect((await api(`/api/v1/actions/${started.run.id}/cancel`, "POST")).status).toBe(200);

    await until(async () => (await runOf(started.run.id)).status === "cancelled", "the run to end");
    expect(exec.terminated).toBe(true);
  });

  it("refuses a run that has already finished", async () => {
    const started = await saveAndStart("echo done");
    await finished(started.run.id);

    const result = await api(`${RUNS}/${started.run.id}/cancel`, "POST");

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("script_run_finished");
  });

  it("does not touch another run's process", async () => {
    await saveScript({ name: "other", script: "sleep 1000" });
    const other = await startScript("other");
    const otherExec = await runningScriptExec(other.run.id);
    const started = await saveAndStart("sleep 1000");

    await cancelAndConfirm(started.run.id);

    expect(otherExec.terminated).toBe(false);
    await cancelAndConfirm(other.run.id);
  });
});

describe("scheduled runs", () => {
  const scheduler = () => new ScriptScheduler(context.deps, { bootGraceMs: 0 });

  async function due(script: Record<string, unknown>): Promise<void> {
    const saved = await saveScript(script);
    expect(saved.status).toBe(201);
    context.advance(Date.parse(saved.body.scripts.at(-1)?.nextRunAt as string) - context.deps.now() + 1000);
  }

  it("runs on time, says it was the schedule, and moves on to the next one", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });

    expect(scheduler().tick()).toBe(1);

    const [entry] = await history();
    const run = await finished(entry?.id as string);
    expect(run).toMatchObject({
      origin: "schedule",
      actorEmail: null,
      status: "succeeded",
      output: "tick\n",
    });
    expect(run.dueAt).not.toBeNull();
    const list = (await api<ScriptList>(SCRIPTS)).body.scripts[0] as ScriptEntry;
    expect(Date.parse(list.nextRunAt as string)).toBeGreaterThan(context.deps.now());
    expect(list.lastRun?.id).toBe(run.id);
  });

  it("does not run again until its next occurrence", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    const clock = scheduler();

    expect(clock.tick()).toBe(1);
    expect(clock.tick()).toBe(0);
  });

  it("skips a due time that finds the script still running, and records it", async () => {
    await due({ name: "slow", script: "sleep 1000", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    const clock = scheduler();
    expect(clock.tick()).toBe(1);
    const [first] = await history();
    await runningScriptExec(first?.id as string);

    context.advance(61_000);
    expect(clock.tick()).toBe(0);

    expect(context.docker.execs).toHaveLength(1);
    const [newest, oldest] = await history();
    expect(oldest?.id).toBe(first?.id);
    expect(newest).toMatchObject({
      status: "skipped",
      origin: "schedule",
      exitCode: null,
      note: { code: "skipped_overlap" },
    });
    expect(newest?.dueAt).not.toBeNull();
    await cancelAndConfirm(first?.id as string);
  });

  it("holds the overlap policy across a restart, and once it is over runs again", async () => {
    await due({ name: "slow", script: "sleep 1000", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    expect(scheduler().tick()).toBe(1);
    const [first] = await history();
    const exec = await runningScriptExec(first?.id as string);
    hardStop(exec);

    const after = await context.restart();

    context.advance(61_000);
    const clock = new ScriptScheduler(after.deps, { bootGraceMs: 0 });
    expect(clock.tick()).toBe(0);
    expect(context.docker.execs).toHaveLength(1);
    const items = (await api<ScriptRunPage>(RUNS)).body.items;
    expect(items[0]).toMatchObject({ status: "skipped", note: { code: "skipped_overlap" } });

    exec.exit(0);
    await until(async () => {
      await settleLeftoverRuns(after.deps);
      return (await runOf(first?.id as string)).status === "succeeded";
    }, "the run to be settled");

    context.advance(61_000);
    expect(new ScriptScheduler(after.deps, { bootGraceMs: 0 }).tick()).toBe(1);
  });

  it("waits out the boot delay, then runs what fell due while the panel was down, once", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    // Far more occurrences than one, all while nothing was looking.
    context.advance(30 * 60_000);

    const justStarted = new ScriptScheduler(context.deps, { bootGraceMs: 60_000 });
    expect(justStarted.tick()).toBe(0);

    context.advance(61_000);
    expect(justStarted.tick()).toBe(1);
    expect(justStarted.tick()).toBe(0);
    const [entry] = await history();
    await finished(entry?.id as string);
    expect(await history()).toHaveLength(1);
  });

  it("keeps a schedule going after the panel restarts", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });

    const after = await context.restart();

    expect(new ScriptScheduler(after.deps, { bootGraceMs: 0 }).tick()).toBe(1);
  });

  it("drops the schedule of a script that no longer exists", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    await api(`${SCRIPTS}/0`, "DELETE");

    expect(scheduler().tick()).toBe(0);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("records a due time that could not start, with the reason", async () => {
    await due({ name: "every", script: "echo tick", schedule: { cron: "* * * * *", timeZone: "UTC" } });
    vi.spyOn(context.deps.actions, "enqueue").mockImplementation(() => {
      throw new Error("the panel is updating");
    });

    expect(scheduler().tick()).toBe(0);
    vi.restoreAllMocks();

    expect((await history())[0]).toMatchObject({
      status: "skipped",
      note: { code: "skipped_refused" },
    });
  });
});

/**
 * The panel dying in a test: its process is gone in real life, but here its objects linger on the
 * same stream. They can only be stopped from reacting, which is what a dead process does.
 */
function hardStop(exec: FakeExec): void {
  exec.stream.removeAllListeners("close");
  exec.stream.removeAllListeners("data");
}

describe("a run the panel lost sight of", () => {
  async function runThenDie(body = "echo before\nsleep 1000", extra: Record<string, unknown> = {}) {
    const started = await saveAndStart(body, "job", extra);
    const exec = await runningScriptExec(started.run.id);
    await until(() => (exec.state.running ? exec.input.length >= 0 : true));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    hardStop(exec);
    return { id: started.run.id, exec };
  }

  it("finds it still running after a restart, and says what it can and cannot know", async () => {
    const { id, exec } = await runThenDie();

    await context.restart();

    const run = await runOf(id);
    expect(run).toMatchObject({
      status: "running",
      exitCode: null,
      outputComplete: false,
      output: "before\n",
      note: { code: "panel_restarted_running" },
    });
    expect((await context.deps.docker.inspectExec(exec.id))?.running).toBe(true);
    expect(exec.terminated).toBe(false);
  });

  it("reports the exit code Docker has when a left-over run ends, and that the output stops short", async () => {
    const { id, exec } = await runThenDie();
    const after = await context.restart();

    exec.exit(4);
    await settleLeftoverRuns(after.deps);

    const run = await runOf(id);
    expect(run).toMatchObject({
      status: "failed",
      exitCode: 4,
      outputComplete: false,
      note: { code: "panel_restarted_finished" },
    });
    expect(await actionOf(id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("not watching"),
    });
  });

  it("calls an exit code of zero a success even when the end went unseen", async () => {
    const { id, exec } = await runThenDie();
    const after = await context.restart();

    exec.exit(0);
    await settleLeftoverRuns(after.deps);

    expect(await runOf(id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      outputComplete: false,
      note: { code: "panel_restarted_finished" },
    });
    expect((await actionOf(id)).status).toBe("succeeded");
  });

  it("says nothing it cannot back up when Docker has forgotten the process", async () => {
    const { id, exec } = await runThenDie();
    context.docker.execs.splice(context.docker.execs.indexOf(exec), 1);

    await context.restart();

    expect(await runOf(id)).toMatchObject({
      status: "unknown",
      exitCode: null,
      outputComplete: false,
      output: "before\n",
      note: { code: "panel_restarted_unknown" },
    });
    expect(context.docker.endedMarkers).toContain(id);
    expect((await actionOf(id)).status).toBe("uncertain");
  });

  it("still ends a run left running at its limit", async () => {
    const { id, exec } = await runThenDie("echo before\nsleep 1000", { maxDurationSeconds: 3600 });
    const after = await context.restart();

    context.advance(3600 * 1000 + 5000);
    await settleLeftoverRuns(after.deps);
    await until(async () => (await runOf(id)).status === "timed_out", "the limit");

    expect(exec.terminated).toBe(true);
    expect(await runOf(id)).toMatchObject({ exitCode: 137, note: { code: "time_limit" } });
  });

  it("still ends a run left running when someone cancels it", async () => {
    const { id, exec } = await runThenDie();
    const after = await context.restart();

    const cancelled = await call<ScriptRun>(after.app, `${RUNS}/${id}/cancel`, {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
    });

    expect(cancelled.status).toBe(200);
    expect(exec.terminated).toBe(true);
    expect(cancelled.body).toMatchObject({ status: "cancelled", exitCode: 137 });
  });

  it("leaves the run on record while Docker cannot be asked", async () => {
    const { id, exec } = await runThenDie();
    const inspect = vi.spyOn(context.docker, "inspectExec").mockRejectedValue(new Error("daemon away"));

    await context.restart();

    expect((await runOf(id)).status).toBe("running");
    expect(exec.terminated).toBe(false);
    inspect.mockRestore();
  });

  it("closes a run that never got to start, without inventing an outcome", async () => {
    const started = await saveAndStart("echo hello");
    // Queued, then the panel is gone: this row is what a stored queue entry would look like.
    await finished(started.run.id);
    context.deps.db
      .update(scriptRuns)
      .set({ status: "queued", startedAt: null })
      .where(eq(scriptRuns.id, started.run.id))
      .run();

    await context.restart();

    expect(await runOf(started.run.id)).toMatchObject({
      status: "failed",
      exitCode: null,
      note: { code: "not_started" },
    });
  });

  it("finishes a run that survived a graceful shutdown, too", async () => {
    const { id, exec } = await runThenDie();
    context.deps.actions.stop = context.deps.actions.stop.bind(context.deps.actions);
    await context.deps.actions.stop(50);
    expect((await runOf(id)).status).toBe("running");

    const after = await context.restart();
    exec.exit(0);
    await settleLeftoverRuns(after.deps);

    expect(await runOf(id)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      outputComplete: false,
      note: { code: "panel_restarted_finished" },
    });
  });
});

describe("a connection that drops during a run", () => {
  it("keeps watching a process that is still going, and says the output stops there", async () => {
    const started = await saveAndStart("sleep 1000");
    const exec = await runningScriptExec(started.run.id);
    const inspect = vi.spyOn(context.docker, "inspectExec");
    inspect.mockResolvedValue({ running: true, exitCode: null });

    exec.stream.destroy();

    await until(
      async () => (await runOf(started.run.id)).note?.code === "connection_lost",
      "the record to say so",
    );
    expect(await runOf(started.run.id)).toMatchObject({ status: "running", outputComplete: false });
    expect(exec.terminated).toBe(false);

    inspect.mockResolvedValue({ running: false, exitCode: 5 });

    expect(await finished(started.run.id)).toMatchObject({
      status: "failed",
      exitCode: 5,
      outputComplete: false,
      note: { code: "connection_lost" },
    });
    expect((await actionOf(started.run.id)).error).toBe("Exited with code 5.");
    inspect.mockRestore();
  });

  it("does not call a dropped connection an exit when Docker no longer knows the process", async () => {
    const started = await saveAndStart("sleep 1000");
    const exec = await runningScriptExec(started.run.id);
    vi.spyOn(context.docker, "inspectExec").mockResolvedValue(null);

    exec.stream.destroy();

    expect(await finished(started.run.id)).toMatchObject({
      status: "unknown",
      exitCode: null,
      note: { code: "connection_lost" },
    });
    expect((await actionOf(started.run.id)).status).toBe("failed");
    vi.restoreAllMocks();
  });
});

describe("after-deployment hooks", () => {
  it("runs a marked script once after a deployment that succeeded, and leaves the rest alone", async () => {
    await saveScript({ name: "hook", script: "echo hooked", runAfterDeploy: true });
    await saveScript({ name: "manual", script: "echo manual" });

    await deploy();

    await until(() => context.docker.execs.length > 0, "the hook to start");
    expect(context.docker.execs).toHaveLength(1);
    const [entry] = await history();
    const run = await finished(entry?.id as string);
    expect(run).toMatchObject({
      scriptName: "hook",
      origin: "hook",
      actorEmail: TEST_EMAIL,
      status: "succeeded",
      output: "hooked\n",
    });
  });

  it("leaves the deployment a success when its hook fails", async () => {
    await saveScript({ name: "hook", script: "exit 1", runAfterDeploy: true });
    const deployment = await api<{ id: string }>(`${SERVICE}/deploy`, "POST");
    await until(async () => {
      context.docker.advance(1);
      return context.docker.execs.length > 0;
    }, "the hook to start");

    const [entry] = await history();
    expect(await finished(entry?.id as string)).toMatchObject({ status: "failed", exitCode: 1 });
    expect((await api<ActionDetail>(`/api/v1/actions/${deployment.body.id}`)).body.status).toBe("succeeded");
  });

  it("does nothing after a deployment that failed", async () => {
    await saveScript({ name: "hook", script: "echo hooked", runAfterDeploy: true });
    context.docker.failNext("updateService");
    const failing = await api<{ id: string }>(`${SERVICE}/deploy`, "POST");
    await until(async () => {
      context.docker.advance(1);
      return (await api<{ status: string }>(`/api/v1/actions/${failing.body.id}`)).body.status === "failed";
    }, "the deployment to fail");

    expect(context.docker.execs).toHaveLength(0);
    expect(await history()).toHaveLength(0);
  });

  it("skips and records a hook whose script is still running from before a restart", async () => {
    const started = await saveAndStart("sleep 1000", "hook", { runAfterDeploy: true });
    const exec = await runningScriptExec(started.run.id);
    hardStop(exec);
    const after = await context.restart();

    await deploy(after.app);

    await until(async () => (await history()).some((run) => run.status === "skipped"), "the skip");
    expect((await history()).find((run) => run.status === "skipped")).toMatchObject({
      origin: "hook",
      note: { code: "skipped_overlap" },
    });
    expect(context.docker.execs).toHaveLength(1);
  });
});

describe("the record of runs", () => {
  it("is kept apart for each service, newest first, and pages", async () => {
    const first = await saveAndStart("echo one");
    await finished(first.run.id);
    const second = await startScript("job");
    await finished(second.run.id);

    const page = await api<ScriptRunPage>(`${RUNS}?limit=1`);
    expect(page.body.items.map((run) => run.id)).toEqual([second.run.id]);
    expect(page.body.nextCursor).not.toBeNull();

    const rest = await api<ScriptRunPage>(`${RUNS}?limit=1&cursor=${page.body.nextCursor}`);
    expect(rest.body.items.map((run) => run.id)).toEqual([first.run.id]);
    expect(rest.body.nextCursor).toBeNull();
  });

  it("can be asked for one script", async () => {
    await saveScript({ name: "other", script: "echo other" });
    const run = await saveAndStart("echo job", "job");
    await finished(run.run.id);
    await finished((await startScript("other")).run.id);

    const page = await api<ScriptRunPage>(`${RUNS}?script=job`);

    expect(page.body.items.map((item) => item.scriptName)).toEqual(["job"]);
  });

  it("follows a script that is renamed", async () => {
    const started = await saveAndStart("echo job", "old");
    await finished(started.run.id);

    await api(`${SCRIPTS}/0`, "PUT", { name: "new", script: "echo job" });

    expect((await api<ScriptRunPage>(`${RUNS}?script=new`)).body.items.map((run) => run.id)).toEqual([
      started.run.id,
    ]);
  });

  it("keeps a bounded history of runs, and fewer skips", async () => {
    const now = new Date(context.deps.now());
    context.deps.db
      .insert(scriptRuns)
      .values(
        Array.from({ length: SCRIPT_RUNS_KEPT + 5 }, (_, index) => ({
          id: `old-${index}`,
          projectName: "shop",
          serviceName: "web",
          scriptName: "job",
          origin: "schedule" as const,
          status: "succeeded" as const,
          maxDurationSeconds: 60,
          createdAt: now,
        })),
      )
      .run();
    context.deps.db
      .insert(scriptRuns)
      .values(
        Array.from({ length: SCRIPT_SKIPS_KEPT + 5 }, (_, index) => ({
          id: `skip-${index}`,
          projectName: "shop",
          serviceName: "web",
          scriptName: "job",
          origin: "schedule" as const,
          status: "skipped" as const,
          maxDurationSeconds: 60,
          createdAt: now,
        })),
      )
      .run();

    await finished((await saveAndStart("echo fresh")).run.id);

    const rows = context.deps.db.select().from(scriptRuns).all();
    expect(rows.filter((row) => row.status === "skipped")).toHaveLength(SCRIPT_SKIPS_KEPT);
    expect(rows.filter((row) => row.status !== "skipped")).toHaveLength(SCRIPT_RUNS_KEPT);
    expect(rows.some((row) => row.id === "old-0")).toBe(false);
  });

  it("moves with its service when that is renamed, and goes when it is deleted", async () => {
    await saveScript({ name: "job", script: "echo x", schedule: { cron: "0 3 * * *", timeZone: "UTC" } });
    const started = await startScript("job");
    await finished(started.run.id);
    await api(`${SERVICE}/stop`, "POST");
    await until(async () => {
      context.docker.advance(1);
      return (await api<{ items: Array<{ status: string }> }>("/api/v1/actions")).body.items.every(
        (action) => action.status !== "queued" && action.status !== "running",
      );
    }, "the service to stop");

    const renamed = await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });
    expect(renamed.status).toBe(200);

    const moved = "/api/v1/projects/shop/services/web2";
    expect((await api<ScriptRunPage>(`${moved}/script-runs`)).body.items.map((run) => run.id)).toEqual([
      started.run.id,
    ]);
    expect((await api<ScriptList>(`${moved}/scripts`)).body.scripts[0]?.nextRunAt).not.toBeNull();

    await api(`${moved}`, "DELETE", { confirm: "web2" });
    await until(
      async () => (await api("/api/v1/projects/shop/services/web2")).status === 404,
      "the service to be deleted",
    );
    expect(context.deps.db.select().from(scriptRuns).all()).toHaveLength(0);
  });
});
