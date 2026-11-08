import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestContext, setupAdmin, type TestContext } from "../../testing/harness";
import { sessions } from "../db/schema";
import type { TopicChannel, TopicFeed } from "./index";
import { REALTIME_PATH } from "./index";

let context: TestContext;
let server: ReturnType<typeof serve>;
let port: number;
let cookie: string;
const sockets: WebSocket[] = [];

interface Frame {
  t: string;
  topic?: string;
  payload?: unknown;
  code?: string;
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  server = serve({ fetch: context.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
  context.deps.realtime.attach(server);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  context.deps.realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await context.close();
});

function url(path: string): string {
  return `ws://127.0.0.1:${port}${path}`;
}

function open(path: string = REALTIME_PATH, headers?: Record<string, string>): WebSocket {
  const socket = new WebSocket(url(path), {
    headers: headers ?? { Origin: `http://127.0.0.1:${port}`, Cookie: cookie },
  });
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("open", () => resolve()));
}

function outcome(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
}

function collect(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
  return frames;
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

function testProvider(replay: readonly unknown[] = []) {
  const state = { opened: 0, closed: 0, channel: undefined as TopicChannel | undefined };
  context.deps.realtime.provide({
    matches: (topic) => topic.startsWith("demand:"),
    open(_topic, channel): TopicFeed {
      state.opened += 1;
      state.channel = channel;
      return {
        close: () => {
          state.closed += 1;
        },
        replay: () => replay,
      };
    },
  });
  return state;
}

describe("topics produced on demand", () => {
  it("starts with the first subscriber and stops with the last", async () => {
    const state = testProvider();
    const first = open();
    const second = open();
    await Promise.all([opened(first), opened(second)]);

    first.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => state.opened === 1);
    second.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => context.deps.realtime.subscriberCount("demand:a") === 2);
    expect(state.opened).toBe(1);

    first.send(JSON.stringify({ t: "unsub", topic: "demand:a" }));
    await until(() => context.deps.realtime.subscriberCount("demand:a") === 1);
    expect(state.closed).toBe(0);

    second.close();
    await until(() => state.closed === 1);
  });

  it("stops when the last subscriber disappears without a word", async () => {
    const state = testProvider();
    const socket = open();
    await opened(socket);
    socket.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => state.opened === 1);

    socket.terminate();

    await until(() => state.closed === 1);
  });

  it("gives each new subscriber the replay and nobody else", async () => {
    testProvider([{ kind: "snapshot" }]);
    const first = open();
    const firstFrames = collect(first);
    const second = open();
    const secondFrames = collect(second);
    await Promise.all([opened(first), opened(second)]);

    first.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => firstFrames.length === 1);
    second.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => secondFrames.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstFrames).toHaveLength(1);
    expect(secondFrames[0]).toEqual({ t: "data", topic: "demand:a", payload: { kind: "snapshot" } });
  });

  it("publishes to the subscribers and reports what is queued for them", async () => {
    const state = testProvider();
    const socket = open();
    const frames = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => state.opened === 1);

    state.channel?.publish({ n: 1 });

    await until(() => frames.length === 1);
    expect(frames[0]?.payload).toEqual({ n: 1 });
    expect(state.channel?.pressure()).toBe(0);
  });

  it("leaves topics without a provider alone", async () => {
    testProvider();
    const socket = open();
    const frames = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ t: "sub", topic: "actions" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([]);
  });

  it("tells the subscriber when a feed can't be opened, and keeps the connection", async () => {
    context.deps.realtime.provide({
      matches: (topic) => topic.startsWith("broken:"),
      open: () => {
        throw new Error("no");
      },
    });
    const socket = open();
    const frames = collect(socket);
    await opened(socket);

    socket.send(JSON.stringify({ t: "sub", topic: "broken:a" }));

    await until(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ t: "error", code: "topic_unavailable" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("stops every feed when the hub closes", async () => {
    const state = testProvider();
    const socket = open();
    await opened(socket);
    socket.send(JSON.stringify({ t: "sub", topic: "demand:a" }));
    await until(() => state.opened === 1);

    context.deps.realtime.close();

    expect(state.closed).toBe(1);
  });
});

describe("other socket endpoints", () => {
  function route(admission: "allow" | "deny") {
    const connected: WebSocket[] = [];
    context.deps.realtime.route({
      matches: (path) => path.startsWith("/api/v1/custom/"),
      maxPayload: 16,
      admit: () =>
        admission === "allow"
          ? {
              allowed: true,
              connect: (socket) => {
                connected.push(socket);
              },
            }
          : { allowed: false, status: 403, code: "nope", message: "No." },
    });
    return connected;
  }

  it("connects a socket that passes every check", async () => {
    const connected = route("allow");

    expect(await outcome(open("/api/v1/custom/x"))).toBe(101);
    await until(() => connected.length === 1);
  });

  it("still checks the session", async () => {
    route("allow");

    expect(await outcome(open("/api/v1/custom/x", { Origin: `http://127.0.0.1:${port}` }))).toBe(401);
  });

  it("still checks the origin", async () => {
    route("allow");

    expect(await outcome(open("/api/v1/custom/x", { Origin: "https://evil.example", Cookie: cookie }))).toBe(
      403,
    );
  });

  it("refuses what the route refuses", async () => {
    route("deny");

    expect(await outcome(open("/api/v1/custom/x"))).toBe(403);
  });

  it("still answers 404 for anything else", async () => {
    route("allow");

    expect(await outcome(open("/api/v1/other"))).toBe(404);
  });

  it("enforces the route's frame limit", async () => {
    const connected = route("allow");
    const socket = open("/api/v1/custom/x");
    await opened(socket);
    await until(() => connected.length === 1);
    connected[0]?.on("error", () => {});
    const ended = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    socket.send(Buffer.alloc(17), { binary: true });

    expect(await ended).toBe(1009);
  });

  it("closes these sockets along with their session", async () => {
    const connected = route("allow");
    const socket = open("/api/v1/custom/x");
    await opened(socket);
    await until(() => connected.length === 1);
    const ended = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    const [session] = context.deps.db.select({ id: sessions.id }).from(sessions).all();
    context.deps.realtime.disconnectSessions([session?.id as string]);

    expect(await ended).toBe(4401);
  });
});
