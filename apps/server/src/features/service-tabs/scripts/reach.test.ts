import type {
  ActionPage,
  PanelUser,
  ScriptList,
  ScriptRun,
  ScriptRunDetail,
  ScriptRunPage,
  StartedScriptRun,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authPost,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../../testing/harness";
import { ScriptScheduler } from "./schedule";

/**
 * In a service that reaches the server, a run is held to who stands behind it twice: whoever asked,
 * at the request, and the task it would run in, when it starts. A schedule or a hook has nobody's
 * request behind it, so it stands on whoever saved the script last.
 */

const SERVICE = "/api/v1/projects/shop/services/web";
const SCRIPTS = `${SERVICE}/scripts`;
const RUNS = `${SERVICE}/script-runs`;
const SHARED = { type: "bind", hostPath: "/srv/shared", mountPath: "/shared" };
const EVERY_MINUTE = { cron: "* * * * *", timeZone: "UTC" };

let context: TestContext;
let admin: string;
let operator: string;

function api<T = unknown>(path: string, method = "GET", body?: unknown, as: string = admin) {
  return call<T>(context.app, path, { method, body, cookie: as, origin: TEST_ORIGIN });
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function deploy(): Promise<void> {
  const accepted = await api<{ id: string }>(`${SERVICE}/deploy`, "POST");
  expect(accepted.status).toBe(202);
  await until(async () => {
    context.docker.advance(1);
    return (await api<{ status: string }>(`/api/v1/actions/${accepted.body.id}`)).body.status === "succeeded";
  }, "the deployment");
}

const history = async (): Promise<ScriptRun[]> => (await api<ScriptRunPage>(RUNS)).body.items;

const isOver = (run: ScriptRun) => run.status !== "queued" && run.status !== "running";

async function finished(id: string): Promise<ScriptRunDetail> {
  await until(async () => isOver((await api<ScriptRunDetail>(`${RUNS}/${id}`)).body), "the run to end");
  return (await api<ScriptRunDetail>(`${RUNS}/${id}`)).body;
}

async function scriptActions(): Promise<number> {
  const page = await api<ActionPage>("/api/v1/actions?type=service.script");
  return page.body.items.length;
}

/** The task keeps a path on the host the settings no longer have, until the next deploy. */
async function leaveTaskReaching(): Promise<void> {
  expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
  await deploy();
  expect((await api(`${SERVICE}/storage/mounts/0`, "DELETE")).status).toBe(200);
}

async function dueNow(): Promise<void> {
  const { body } = await api<ScriptList>(SCRIPTS);
  const next = Math.min(...body.scripts.map((script) => Date.parse(script.nextRunAt ?? "")));
  context.advance(next - context.deps.now() + 1000);
}

const scheduler = () => new ScriptScheduler(context.deps, { bootGraceMs: 0 });

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  await api("/api/v1/projects", "POST", { name: "shop" });
  await api("/api/v1/projects/shop/services", "POST", { name: "web" });
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
  await deploy();
  operator = await signInMember(context.app, admin, "operator@example.com", [
    { project: "shop", role: "operator" },
  ]);
});

afterEach(async () => {
  await context.close();
});

describe("a schedule in a service that came to reach the server", () => {
  it("is skipped while nobody who could give that access saved the script last, with no Action", async () => {
    const saved = await api(
      SCRIPTS,
      "POST",
      { name: "tick", script: "echo tick", schedule: EVERY_MINUTE },
      operator,
    );
    expect(saved.status).toBe(201);
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);

    await dueNow();
    expect(scheduler().tick()).toBe(0);
    context.advance(61_000);
    expect(scheduler().tick()).toBe(0);

    const skipped = await history();
    expect(skipped).toHaveLength(2);
    for (const run of skipped) {
      expect(run).toMatchObject({ status: "skipped", origin: "schedule", note: { code: "skipped_refused" } });
      expect(run.note?.message).toContain("An administrator has to save it again");
    }
    expect(await scriptActions()).toBe(0);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("runs again once an administrator has saved it", async () => {
    await api(SCRIPTS, "POST", { name: "tick", script: "echo tick", schedule: EVERY_MINUTE }, operator);
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    await deploy();
    const resaved = await api(`${SCRIPTS}/0`, "PUT", {
      name: "tick",
      script: "echo tick",
      schedule: EVERY_MINUTE,
    });
    expect(resaved.status).toBe(200);
    expect(JSON.stringify(resaved.body)).not.toContain("savedBy");

    await dueNow();
    expect(scheduler().tick()).toBe(1);

    const [run] = await history();
    expect(await finished(run?.id as string)).toMatchObject({ status: "succeeded", output: "tick\n" });
  });

  it("stops running by itself when the administrator who saved it is no longer one", async () => {
    const created = await api<PanelUser>("/api/v1/users", "POST", {
      email: "second@example.com",
      password: TEST_PASSWORD,
      role: "admin",
    });
    expect(created.status).toBe(201);
    const login = await authPost(context.app, "login", {
      email: "second@example.com",
      password: TEST_PASSWORD,
    });
    const otherAdmin = login.cookie as string;
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    const saved = await api(
      SCRIPTS,
      "POST",
      { name: "tick", script: "echo tick", schedule: EVERY_MINUTE },
      otherAdmin,
    );
    expect(saved.status).toBe(201);

    const demoted = await api(`/api/v1/users/${created.body.id}`, "PUT", {
      email: "second@example.com",
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
    });
    expect(demoted.status).toBe(200);

    await dueNow();
    expect(scheduler().tick()).toBe(0);
    expect((await history())[0]).toMatchObject({ status: "skipped", note: { code: "skipped_refused" } });
  });

  it("fails at its start when only the task still reaches the server", async () => {
    await api(SCRIPTS, "POST", { name: "tick", script: "echo tick", schedule: EVERY_MINUTE }, operator);
    await leaveTaskReaching();

    await dueNow();
    expect(scheduler().tick()).toBe(1);

    const [run] = await history();
    expect(await finished(run?.id as string)).toMatchObject({
      status: "failed",
      exitCode: null,
      note: { code: "reaches_server" },
    });
    expect(context.docker.execs).toHaveLength(0);
  });
});

describe("a hook in a service that came to reach the server", () => {
  it("is skipped after a deployment until an administrator saves it again", async () => {
    const hook = { name: "migrate", script: "echo migrated", runAfterDeploy: true };
    expect((await api(SCRIPTS, "POST", hook, operator)).status).toBe(201);
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);

    await deploy();
    await until(async () => (await history()).length > 0, "the hook's record");

    expect((await history())[0]).toMatchObject({
      status: "skipped",
      origin: "hook",
      note: { code: "skipped_refused" },
    });
    expect(context.docker.execs).toHaveLength(0);
    expect(await scriptActions()).toBe(0);

    expect((await api(`${SCRIPTS}/0`, "PUT", hook)).status).toBe(200);
    await deploy();
    await until(async () => (await history()).some((run) => run.status === "succeeded"), "the hook to run");
    expect(context.docker.execs).toHaveLength(1);
  });
});

describe("a run asked for by hand", () => {
  it("fails at its start in a task that still reaches the server, unless an administrator asked", async () => {
    expect((await api(SCRIPTS, "POST", { name: "job", script: "echo job" }, operator)).status).toBe(201);
    await leaveTaskReaching();

    const asked = await api<StartedScriptRun>(RUNS, "POST", { script: "job" }, operator);
    expect(asked.status).toBe(202);
    const refused = await finished(asked.body.run.id);
    expect(refused).toMatchObject({ status: "failed", exitCode: null, note: { code: "reaches_server" } });
    // The Action settles a moment after the run's own row, once its work has returned.
    const actionOf = () =>
      api<{ status: string; error: string | null }>(`/api/v1/actions/${asked.body.run.id}`);
    await until(async () => (await actionOf()).body.status !== "running", "the Action to settle");
    expect((await actionOf()).body).toMatchObject({ status: "failed", error: refused.note?.message });
    expect(context.docker.execs).toHaveLength(0);

    const started = await api<StartedScriptRun>(RUNS, "POST", { script: "job" });
    expect(started.status).toBe(202);
    expect(await finished(started.body.run.id)).toMatchObject({ status: "succeeded", output: "job\n" });
  });

  it("runs as before in a task that reaches nothing of the server", async () => {
    expect((await api(SCRIPTS, "POST", { name: "job", script: "echo job" }, operator)).status).toBe(201);

    const asked = await api<StartedScriptRun>(RUNS, "POST", { script: "job" }, operator);
    expect(asked.status).toBe(202);
    expect(await finished(asked.body.run.id)).toMatchObject({ status: "succeeded", output: "job\n" });
  });
});

describe("a run an administrator asked for, behind other work on the service", () => {
  it("runs only the words the administrator asked for, in a task that reaches the server", async () => {
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    expect((await api(SCRIPTS, "POST", { name: "job", script: "echo reviewed" })).status).toBe(201);
    await deploy();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.deps.actions.enqueue({
      type: "test.hold",
      title: "Hold the queue",
      projectName: "shop",
      serviceName: "web",
      actorEmail: undefined,
      run: () => gate,
    });
    const asked = await api<{ run: { id: string } }>(RUNS, "POST", { script: "job" });
    expect(asked.status).toBe(202);

    // Out of the settings, the path opens the scripts to the operator; the task still has it.
    expect((await api(`${SERVICE}/storage/mounts/0`, "DELETE", undefined, operator)).status).toBe(200);
    const rewritten = await api(`${SCRIPTS}/0`, "PUT", { name: "job", script: "echo operator" }, operator);
    expect(rewritten.status).toBe(200);
    release();

    const run = await finished(asked.body.run.id);
    expect(run).toMatchObject({ status: "failed", note: { code: "reaches_server" } });
    expect(context.docker.execs).toHaveLength(0);
  });
});

describe("an administrator's script an operator edits", () => {
  it("no longer runs by itself once the service reaches the server", async () => {
    const saved = await api(SCRIPTS, "POST", { name: "tick", script: "echo tick", schedule: EVERY_MINUTE });
    expect(saved.status).toBe(201);
    const edited = await api(
      `${SCRIPTS}/0`,
      "PUT",
      { name: "tick", script: "echo edited", schedule: EVERY_MINUTE },
      operator,
    );
    expect(edited.status).toBe(200);
    expect((await api(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);

    await dueNow();
    expect(scheduler().tick()).toBe(0);
    expect((await history())[0]).toMatchObject({ status: "skipped", note: { code: "skipped_refused" } });
  });
});
