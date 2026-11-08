import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { ActionEntry, ConsoleInfo, ScriptList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { hashPassword, insertSession } from "../../core/auth";
import { users } from "../../core/db/schema";
import type { TaskInfo } from "../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
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

    await connect(`task=${task.id}&program=bash`);

    expect(context.docker.execs[0]?.options.command).toEqual(["/bin/bash"]);
  });

  it("passes a script's text as one argument to the container's own shell", async () => {
    const body = 'echo "$HOME"; rm -rf /tmp/x && exit 3';
    await api<ScriptList>(`${SERVICE}/scripts`, "POST", { name: "tidy up", script: body });
    const task = await runningTask();

    await connect(`task=${task.id}&script=${encodeURIComponent("tidy up")}`);

    expect(context.docker.execs[0]?.options.command).toEqual(["/bin/sh", "-c", body]);
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
      new Error('OCI runtime exec failed: exec: "/bin/bash": stat /bin/bash'),
    );

    const socket = open(`task=${task.id}&program=bash`);
    const { frames } = collect(socket);
    const ended = closed(socket);

    expect(await ended).toBe(1011);
    expect(frames).toEqual([
      { t: "error", message: 'OCI runtime exec failed: exec: "/bin/bash": stat /bin/bash' },
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

    const socket = open(`task=${task.id}&program=bash`);
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
      tasks: [{ id: task.id, slot: 1, name: `shop_web.1.${task.id}` }],
      programs: ["sh", "bash"],
      scripts: ["tidy up"],
    });
  });

  it("is for administrators only", async () => {
    const result = await api(`${SERVICE}/console`, "GET", undefined, await addMember());

    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("admin_required");
  });

  it("answers 404 for a service that doesn't exist", async () => {
    expect((await api("/api/v1/projects/shop/services/missing/console")).status).toBe(404);
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
