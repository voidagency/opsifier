import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { ActionEntry, ConsoleInfo, ScriptList, ScriptRunPage } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { hashPassword, insertSession } from "../../core/auth";
import { projectMembers, users } from "../../core/db/schema";
import type { ComposeContainerInfo, ExecSession, TaskInfo } from "../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_EMAIL,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { consoleCommand } from "./console";

const SERVICE = "/api/v1/projects/shop/services/web";

let context: TestContext;
let server: ReturnType<typeof serve>;
let port: number;
let cookie: string;
const sockets: WebSocket[] = [];

type Frame = { t: string; code?: number | null; message?: string };

function api<T = unknown>(path: string, method = "GET", body?: unknown, as: string = cookie) {
  return call<T>(context.app, path, { method, body, cookie: as, origin: TEST_ORIGIN });
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error("Timed out");
}

async function run(path: string, method = "POST", body?: unknown): Promise<void> {
  const accepted = await api<ActionEntry>(path, method, body);
  await until(() => accepted.status === 202);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body: action } = await api<ActionEntry>(`/api/v1/actions/${accepted.body.id}`);
    if (action.status !== "queued" && action.status !== "running") {
      expect(action.status).toBe("succeeded");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

function origin(): string {
  return `http://127.0.0.1:${port}`;
}

function open(
  query: string,
  headers: Record<string, string> = {},
  path = "/api/v1/terminal/shop/web",
): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?${query}`, {
    headers: { Origin: origin(), Cookie: cookie, ...headers },
  });
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}

function outcome(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

/** Everything a terminal socket says, split into the program's output and the control frames. */
function collect(socket: WebSocket) {
  const output: string[] = [];
  const frames: Frame[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      output.push(data.toString());
    } else {
      frames.push(JSON.parse(data.toString()) as Frame);
    }
  });
  return { output, frames, text: () => output.join("") };
}

async function runningTask(): Promise<TaskInfo> {
  await until(() => {
    context.docker.advance(1);
    return true;
  });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const task = (await context.docker.listTasks({ service: "shop_web" })).find((t) => t.state === "running");
    if (task !== undefined) {
      return task;
    }
    context.docker.advance(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("No running task");
}

async function connect(query: string) {
  const socket = open(query);
  const received = collect(socket);
  expect(await outcome(socket)).toBe(101);
  await until(() => received.frames.some((frame) => frame.t === "ready"));
  return { socket, ...received };
}

async function addMember(): Promise<string> {
  const now = new Date();
  context.deps.db
    .insert(users)
    .values({
      id: "member-1",
      email: "member@example.com",
      passwordHash: await hashPassword("a password for the member"),
      role: "member",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const { token } = insertSession(context.deps.db, {
    userId: "member-1",
    persistent: false,
    secure: false,
    ip: null,
    userAgent: null,
    now: context.deps.now(),
  });
  return `opsifier_session=${token}`;
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  server = serve({ fetch: context.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
  context.deps.realtime.attach(server);

  await api("/api/v1/projects", "POST", { name: "shop" });
  await api("/api/v1/projects/shop/services", "POST", { name: "web" });
  await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
  await run(`${SERVICE}/deploy`);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  context.deps.realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await context.close();
});

describe("a saved script run from the console", () => {
  const RUNS = `${SERVICE}/script-runs`;

  async function runs() {
    return (await api<ScriptRunPage>(RUNS)).body.items;
  }

  /** The newest run, once it has stopped being one in progress. */
  async function settled() {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [latest] = await runs();
      if (latest !== undefined && latest.status !== "running") {
        return latest;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The run never settled");
  }

  async function startConsoleScript(extra: Record<string, unknown> = {}) {
    await api(`${SERVICE}/scripts`, "POST", { name: "job", script: "echo hi", ...extra });
    const task = await runningTask();
    return connect(`task=${task.id}&script=job`);
  }

  it("goes on the record with who ran it and how it exited", async () => {
    const { socket } = await startConsoleScript();
    const [running] = await runs();
    expect(running).toMatchObject({ scriptName: "job", origin: "console", status: "running" });

    const ended = closed(socket);
    socket.send(Buffer.from("exit\n"), { binary: true });
    await ended;

    const run = await settled();
    expect(run).toMatchObject({
      origin: "console",
      actorEmail: TEST_EMAIL,
      status: "succeeded",
      exitCode: 0,
      outputComplete: false,
      note: { code: "console_output" },
    });
  });

  it("refuses another run of the same script while one is open, from both sides", async () => {
    const { socket } = await startConsoleScript();
    const task = await runningTask();

    expect(await outcome(open(`task=${task.id}&script=job`))).toBe(409);
    const refused = await api(RUNS, "POST", { script: "job" });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("script_already_running");
    expect(context.docker.execs).toHaveLength(1);
    socket.close();
  });

  it("is held to its maximum duration, as any run of the script is", async () => {
    await startConsoleScript({ maxDurationSeconds: 1 });

    await until(() => context.docker.execs[0]?.terminated === true);

    expect(await settled()).toMatchObject({ status: "timed_out", note: { code: "time_limit" } });
  });

  it("says the session was closed while it ran", async () => {
    const { socket } = await startConsoleScript();

    socket.close();

    await until(() => context.docker.execs[0]?.terminated === true);
    expect(await settled()).toMatchObject({ status: "cancelled", note: { code: "console_closed" } });
  });

  it("ends up on record after a restart, without claiming to know how it went", async () => {
    await startConsoleScript();
    const exec = context.docker.execs[0];
    // The first process is gone: nothing it would have written about this session gets written.
    exec?.stream.removeAllListeners("close");
    exec?.stream.removeAllListeners("end");
    vi.spyOn(context.deps.actions, "conclude").mockImplementation(() => undefined as never);

    await context.restart();

    await until(() => exec?.terminated === true);
    expect(await settled()).toMatchObject({ status: "cancelled", note: { code: "console_closed" } });
  });
});

describe("authentication at upgrade", () => {
  it("refuses a connection with no session", async () => {
    const task = await runningTask();

    expect(await outcome(open(`task=${task.id}&program=sh`, { Cookie: "" }))).toBe(401);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("refuses a page from another origin, even with a valid session", async () => {
    const task = await runningTask();

    expect(await outcome(open(`task=${task.id}&program=sh`, { Origin: "https://evil.example" }))).toBe(403);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("refuses a request with no origin at all", async () => {
    const task = await runningTask();
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/terminal/shop/web?task=${task.id}&program=sh`,
      {
        headers: { Cookie: cookie },
      },
    );
    socket.on("error", () => {});
    sockets.push(socket);

    expect(await outcome(socket)).toBe(403);
  });

  it("refuses anyone who isn't an administrator", async () => {
    const task = await runningTask();

    expect(await outcome(open(`task=${task.id}&program=sh`, { Cookie: await addMember() }))).toBe(403);
    expect(context.docker.execs).toHaveLength(0);
  });

  it.each([
    ["no task", "program=sh"],
    ["no program", "task=abc"],
    ["both a program and a script", "task=abc&program=sh&script=x"],
    ["a program that isn't offered", "task=abc&program=python"],
    ["a task that isn't a name", "task=../../etc&program=sh"],
    ["an absurd terminal size", "task=abc&program=sh&cols=100000"],
  ])("refuses %s", async (_label, query) => {
    expect(await outcome(open(query))).toBe(400);
    expect(context.docker.execs).toHaveLength(0);
  });

  it("refuses a service or script that doesn't exist", async () => {
    const task = await runningTask();

    expect(await outcome(open(`task=${task.id}&program=sh`, {}, "/api/v1/terminal/shop/missing"))).toBe(404);
    expect(await outcome(open(`task=${task.id}&script=ghost`))).toBe(404);
  });
});

describe("a console session", () => {
  it("runs the program in the chosen task, as an argument vector", async () => {
    const task = await runningTask();

    const { socket, text } = await connect(`task=${task.id}&program=sh&cols=120&rows=40`);

    expect(context.docker.execs[0]?.options).toMatchObject({
      service: "shop_web",
      taskId: task.id,
      command: ["/bin/sh"],
      tty: true,
      consoleSize: { columns: 120, rows: 40 },
    });

    socket.send(Buffer.from("echo hi\n"), { binary: true });
    await until(() => text().includes("fake: echo hi"));
  });

  it("opens bash the same way", async () => {
    const task = await runningTask();

    const { frames } = await connect(`task=${task.id}&program=bash`);

    expect(context.docker.execs.at(-1)?.options.command).toEqual(["/bin/bash"]);
    expect(frames).toEqual([{ t: "ready" }]);
  });

  it("passes a script's text as one argument to the container's own shell", async () => {
    const body = 'echo "$HOME"; rm -rf /tmp/x && exit 3';
    await api<ScriptList>(`${SERVICE}/scripts`, "POST", { name: "tidy up", script: body });
    const task = await runningTask();

    await connect(`task=${task.id}&script=${encodeURIComponent("tidy up")}`);

    expect(context.docker.execs[0]?.options.command).toEqual(["/bin/sh", "-c", body]);
  });

  it("passes Ctrl+C on to the program as a keystroke, and stays open", async () => {
    const task = await runningTask();
    const { socket, frames, text } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];

    socket.send(Buffer.from([0x03]), { binary: true });

    await until(() => text().includes("^C"));
    expect(exec?.input).toContain(0x03);
    expect(exec?.terminated).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((frame) => frame.t === "exit")).toBe(false);

    // The shell is still there to take the next command.
    socket.send(Buffer.from("echo still here\n"), { binary: true });
    await until(() => text().includes("fake: echo still here"));
  });

  it("ends the session cleanly on Ctrl+D, the terminal's end of input", async () => {
    const task = await runningTask();
    const { socket, frames } = await connect(`task=${task.id}&program=sh`);
    const ended = closed(socket);

    socket.send(Buffer.from([0x04]), { binary: true });

    expect(await ended).toBe(1000);
    expect(frames.at(-1)).toEqual({ t: "exit", code: 0 });
  });

  it("resizes the terminal and ignores frames it doesn't understand", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);

    socket.send("not json");
    socket.send(JSON.stringify({ t: "resize", cols: 0, rows: 10 }));
    socket.send(JSON.stringify({ t: "resize", cols: 132, rows: 43 }));

    await until(() => (context.docker.execs[0]?.resizes.length ?? 0) > 0);
    expect(context.docker.execs[0]?.resizes).toEqual([{ columns: 132, rows: 43 }]);
  });

  it("reports the exit code when the program ends", async () => {
    const task = await runningTask();
    const { socket, frames } = await connect(`task=${task.id}&program=sh`);
    const ended = closed(socket);

    socket.send(Buffer.from("exit\n"), { binary: true });

    expect(await ended).toBe(1000);
    expect(frames.at(-1)).toEqual({ t: "exit", code: 0 });
  });

  it("shows Docker's own error in the terminal when a session can't start", async () => {
    const task = await runningTask();
    context.docker.failNext(
      "execAttach",
      new Error('OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh'),
    );

    const socket = open(`task=${task.id}&program=sh`);
    const { frames } = collect(socket);
    const ended = closed(socket);

    expect(await ended).toBe(1011);
    expect(frames).toEqual([
      { t: "error", message: 'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh' },
    ]);
  });

  it("reports a task that is no longer running", async () => {
    const socket = open("task=gone&program=sh");
    const { frames } = collect(socket);

    expect(await closed(socket)).toBe(1011);
    expect(frames[0]?.t).toBe("error");
    expect(frames[0]?.message).toContain("No running task");
  });
});

describe("cleaning up", () => {
  it("closes the exec session when the socket closes", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    expect(exec?.stream.destroyed).toBe(false);

    socket.close();

    await until(() => exec?.terminated === true);
    expect(exec?.stream.destroyed).toBe(true);
  });

  it("closes it when the connection dies without a goodbye", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];

    socket.terminate();

    await until(() => exec?.terminated === true);
  });

  it("closes it when the session is signed out", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    const ended = closed(socket);

    await api("/api/v1/auth/logout", "POST");

    expect(await ended).toBe(4401);
    await until(() => exec?.terminated === true);
  });

  it("closes it when the panel shuts down", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    const ended = closed(socket);

    context.deps.realtime.close();

    expect(await ended).toBe(1001);
    await until(() => exec?.terminated === true);
  });

  it("never starts a session that was abandoned while it was attaching", async () => {
    const task = await runningTask();
    const original = context.docker.execAttach.bind(context.docker);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.docker.execAttach = async (options) => {
      await gate;
      return original(options);
    };
    const socket = open(`task=${task.id}&program=sh`);
    expect(await outcome(socket)).toBe(101);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    await until(() => context.docker.execs.length === 1);
    await until(() => context.docker.execs[0]?.terminated === true);
  });

  it("closes a connection that sends an oversized frame, and its exec with it", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    const ended = closed(socket);

    socket.send(Buffer.alloc(64 * 1024 + 1), { binary: true });

    expect(await ended).toBe(1009);
    await until(() => exec?.terminated === true);
  });

  it("limits how many consoles one person can keep open", async () => {
    const task = await runningTask();
    for (let index = 0; index < 4; index += 1) {
      await connect(`task=${task.id}&program=sh`);
    }

    expect(await outcome(open(`task=${task.id}&program=sh`))).toBe(429);
  });

  it("frees the slot when a console closes", async () => {
    const task = await runningTask();
    const opened = [];
    for (let index = 0; index < 4; index += 1) {
      opened.push(await connect(`task=${task.id}&program=sh`));
    }

    opened[0]?.socket.close();
    await until(() => context.docker.execs[0]?.terminated === true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await outcome(open(`task=${task.id}&program=sh`))).toBe(101);
  });
});

describe("after a hard stop of the panel", () => {
  const CONSOLES = "/api/v1/actions?type=service.console";

  it("ends the console the dead panel left running", async () => {
    const task = await runningTask();
    await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    expect(exec?.terminated).toBe(false);

    await context.restart();

    await until(() => exec?.terminated === true);
  });

  it("touches nothing but what that console started", async () => {
    await api("/api/v1/projects/shop/services", "POST", { name: "api" });
    await api("/api/v1/projects/shop/services/api/source", "PUT", { image: "nginx:alpine" });
    await run("/api/v1/projects/shop/services/api/deploy");
    const task = await runningTask();
    await connect(`task=${task.id}&program=sh`);
    const orphan = context.docker.execs[0];

    // Someone else's session in the same container, and an unrelated one next door.
    await context.docker.execAttach({ service: "shop_web", taskId: task.id, command: ["/bin/sh"] });
    await context.docker.execAttach({ service: "shop_api", command: ["/bin/sh"] });
    const [, sameService, otherService] = context.docker.execs;

    await context.restart();

    await until(() => orphan?.terminated === true);
    expect(sameService?.terminated).toBe(false);
    expect(otherService?.terminated).toBe(false);
  });

  it("says on the activity log what became of the session", async () => {
    const task = await runningTask();
    await connect(`task=${task.id}&program=sh`);
    // The first process is gone: nothing it would have written about this session gets written.
    vi.spyOn(context.deps.actions, "conclude").mockImplementation(() => undefined as never);

    await context.restart();

    const [entry] = (await api<{ items: ActionEntry[] }>(CONSOLES)).body.items;
    expect(entry).toMatchObject({ status: "failed" });
    expect(entry?.error).toContain("panel stopped");
  });

  it("leaves a console that closed properly alone", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];
    socket.close();
    await until(() => exec?.terminated === true);
    await until(() => context.docker.endedMarkers.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await context.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(context.docker.endedMarkers).toEqual([]);
  });

  it("forgets a console whose program ended by itself", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);
    const ended = closed(socket);
    socket.send(Buffer.from("exit\n"), { binary: true });
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await context.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(context.docker.endedMarkers).toEqual([]);
  });

  it("tries again at the next boot if Docker couldn't be asked", async () => {
    const task = await runningTask();
    await connect(`task=${task.id}&program=sh`);
    const exec = context.docker.execs[0];

    context.docker.failNext("terminateExec");
    await context.restart();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exec?.terminated).toBe(false);

    await context.restart();

    await until(() => exec?.terminated === true);
  });

  it("removes a host console's helper that outlived the panel", async () => {
    const helper = await context.docker.openHelper({ image: "alpine", command: ["/bin/sh"] });

    await context.restart();

    await until(() => helper.stream.destroyed);
  });

  it("does not hold up a boot when Docker fails to answer about helpers", async () => {
    context.docker.failNext("removeLeftoverHelpers");

    await expect(context.restart()).resolves.toBeDefined();
  });
});

describe("backpressure", () => {
  it("stops reading the program while the browser can't take more", async () => {
    const task = await runningTask();
    const { socket, frames } = await connect(`task=${task.id}&program=sh`);
    await until(() => frames.some((frame) => frame.t === "ready"));
    const stream = context.docker.execs[0]?.stream;

    socket.send(JSON.stringify({ t: "pause" }));
    await until(() => stream?.isPaused() === true);

    socket.send(JSON.stringify({ t: "resume" }));
    await until(() => stream?.isPaused() === false);
  });
});

describe("the activity log", () => {
  const consoleActions = async () =>
    (await api<{ items: ActionEntry[] }>("/api/v1/actions?type=service.console")).body.items;

  it("records a session as soon as it opens, naming who and what", async () => {
    const task = await runningTask();

    await connect(`task=${task.id}&program=sh`);

    const [entry] = await consoleActions();
    expect(entry).toMatchObject({
      projectName: "shop",
      serviceName: "web",
      actorEmail: "admin@example.com",
      status: "succeeded",
    });
    expect(entry?.title).toContain("/bin/sh");
    expect(entry?.title).toContain(task.id.slice(0, 12));
  });

  it("never keeps a keystroke", async () => {
    const task = await runningTask();
    const { socket } = await connect(`task=${task.id}&program=sh`);

    socket.send(Buffer.from("echo a-secret-value\n"), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [entry] = await consoleActions();
    expect(JSON.stringify(entry)).not.toContain("a-secret-value");
    expect(entry?.hasLog).toBe(false);
  });

  it("marks the entry failed when the session couldn't start", async () => {
    const task = await runningTask();
    context.docker.failNext("execAttach", new Error("no such file"));

    const socket = open(`task=${task.id}&program=sh`);
    await closed(socket);
    await until(() => true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const [entry] = await consoleActions();
    expect(entry).toMatchObject({ status: "failed", error: "no such file" });
  });

  it("doesn't tie up the service while a console is open", async () => {
    const task = await runningTask();
    await connect(`task=${task.id}&program=sh`);

    const detail = await api<{ activeAction: unknown }>(SERVICE);

    expect(detail.body.activeAction).toBeNull();
  });
});

describe("the console's information", () => {
  it("lists the running tasks, the programs and the saved scripts", async () => {
    await api<ScriptList>(`${SERVICE}/scripts`, "POST", { name: "tidy up", script: "ls" });
    const task = await runningTask();

    const { body } = await api<ConsoleInfo>(`${SERVICE}/console`);

    expect(body).toEqual({
      tasks: [{ id: task.id, slot: 1, name: `shop_web.1.${task.id}`, programs: ["sh", "bash"] }],
      scripts: ["tidy up"],
    });
  });

  it("is for administrators only", async () => {
    const cookie = await addMember();
    // A member who can't see the project finds nothing at all.
    expect((await api(`${SERVICE}/console`, "GET", undefined, cookie)).status).toBe(404);

    const now = new Date();
    context.deps.db
      .insert(projectMembers)
      .values({ userId: "member-1", projectName: "shop", role: "operator", createdAt: now, updatedAt: now })
      .run();
    const result = await api(`${SERVICE}/console`, "GET", undefined, cookie);

    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("admin_required");
  });

  it("answers 404 for a service that doesn't exist", async () => {
    expect((await api("/api/v1/projects/shop/services/missing/console")).status).toBe(404);
  });
});

describe("a Compose stack's console", () => {
  const STACK_TERMINAL = "/api/v1/terminal/shop/stack";
  const composeContainer = (overrides: Partial<ComposeContainerInfo>): ComposeContainerInfo => ({
    id: "own-container",
    name: "stack-web-1",
    image: "traefik/whoami:v1.10",
    project: "shop_stack",
    child: "web",
    number: 1,
    state: "running",
    status: "Up 2 seconds",
    exitCode: null,
    health: null,
    ports: [],
    ...overrides,
  });

  beforeEach(async () => {
    await api("/api/v1/projects/shop/compose", "POST", { name: "stack" });
    context.docker.composeContainers.push(
      composeContainer({}),
      composeContainer({ id: "stopped-container", child: "worker", state: "exited" }),
      composeContainer({ id: "foreign-container", project: "shop_other", name: "shop_other-db-1" }),
    );
  });

  it("runs in a container of this stack, by its exact id", async () => {
    const socket = open("task=own-container&program=sh", {}, STACK_TERMINAL);
    const { frames } = collect(socket);
    expect(await outcome(socket)).toBe(101);
    await until(() => frames.some((frame) => frame.t === "ready"));

    expect(context.docker.execs[0]?.options).toMatchObject({
      service: "shop_stack",
      containerId: "own-container",
    });
  });

  it.each([
    ["a container of another stack", "foreign-container"],
    ["a container that is not running", "stopped-container"],
    ["a container's name instead of its id", "stack-web-1"],
    ["the start of an id", "own-cont"],
    ["an id Docker has never heard of", "nonsense"],
  ])("refuses %s", async (_label, id) => {
    const socket = open(`task=${id}&program=sh`, {}, STACK_TERMINAL);
    const { frames } = collect(socket);
    const ended = closed(socket);

    expect(await ended).toBe(1011);
    expect(frames).toEqual([{ t: "error", message: "This container is not a running part of this stack." }]);
    expect(context.docker.execs).toHaveLength(0);
  });
});

describe("the shells on offer", () => {
  /** Stands in for a container that has `/bin/sh` but no `/bin/bash`. */
  function withoutBash() {
    const real = context.docker.execAttach.bind(context.docker);
    return vi
      .spyOn(context.docker, "execAttach")
      .mockImplementation(async (options): Promise<ExecSession> => {
        if (options.command[0] === "/bin/bash") {
          return { ...(await real(options)), exited: async () => 127 };
        }
        return real(options);
      });
  }

  it("opens sh, and says so, when the bash asked for isn't there", async () => {
    const task = await runningTask();
    withoutBash();

    const { socket, frames, text } = await connect(`task=${task.id}&program=bash`);

    expect(context.docker.execs.at(-1)?.options.command).toEqual(["/bin/sh"]);
    expect(frames).toEqual([{ t: "ready", fallback: "sh" }]);
    socket.send(Buffer.from("echo hi\n"), { binary: true });
    await until(() => text().includes("fake: echo hi"));

    const { body } = await api<{ items: ActionEntry[] }>("/api/v1/actions?type=service.console");
    expect(body.items[0]?.title).toContain("/bin/sh");
    expect(body.items[0]?.title).not.toContain("/bin/bash");
  });

  it("are the ones that really start in the task", async () => {
    await runningTask();
    withoutBash();

    const { body } = await api<ConsoleInfo>(`${SERVICE}/console`);

    expect(body.tasks[0]?.programs).toEqual(["sh"]);
  });

  it("leave out a program Docker could not even start", async () => {
    await runningTask();
    const real = context.docker.execAttach.bind(context.docker);
    vi.spyOn(context.docker, "execAttach").mockImplementation(async (options) => {
      if (options.command[0] === "/bin/bash") {
        throw new Error('OCI runtime exec failed: exec: "/bin/bash": stat /bin/bash');
      }
      return real(options);
    });

    expect((await api<ConsoleInfo>(`${SERVICE}/console`)).body.tasks[0]?.programs).toEqual(["sh"]);
  });

  it("are empty for a container with no shell at all", async () => {
    await runningTask();
    vi.spyOn(context.docker, "execAttach").mockRejectedValue(new Error("no such file"));

    expect((await api<ConsoleInfo>(`${SERVICE}/console`)).body.tasks[0]?.programs).toEqual([]);
  });

  it("are asked for once per image, however many tasks run it", async () => {
    await api(`${SERVICE}/advanced/deploy`, "PUT", { replicas: 3 });
    await run(`${SERVICE}/deploy`);
    await runningTask();
    const before = context.docker.execs.length;

    await api<ConsoleInfo>(`${SERVICE}/console`);

    // One probe per shell for the single image, not per task.
    expect(context.docker.execs.length - before).toBe(2);
  });
});

describe("a program's own arguments", () => {
  it("are never joined into a command line", () => {
    const query = { task: "t", cols: 80, rows: 24 };

    expect(consoleCommand({ ...query, program: "sh" }, undefined)).toEqual({
      argv: ["/bin/sh"],
      label: "/bin/sh",
    });
    expect(consoleCommand({ ...query, script: "x" }, "a; b").argv).toEqual(["/bin/sh", "-c", "a; b"]);
  });
});
