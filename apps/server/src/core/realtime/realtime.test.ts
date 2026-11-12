import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { authPost, createTestContext, setupAdmin, type TestContext } from "../../testing/harness";
import { insertSession, SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_TTL_MS } from "../auth";
import { users } from "../db/schema";
import { CLOSE_SESSION_ENDED, REALTIME_PATH, RealtimeHub } from "./index";

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

function origin(): string {
  return `http://127.0.0.1:${port}`;
}

function open(headers: Record<string, string>, path: string = REALTIME_PATH): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  // Terminating a socket whose upgrade was refused reports an error we do not care about.
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}

/** Resolves with the HTTP status of a refused upgrade, or 101 when it succeeded. */
function outcome(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
}

async function connect(extra: Record<string, string> = {}): Promise<WebSocket> {
  const socket = open({ Origin: origin(), Cookie: cookie, ...extra });
  expect(await outcome(socket)).toBe(101);
  return socket;
}

function nextFrame(socket: WebSocket): Promise<Frame> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Frame));
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
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

describe("authentication at upgrade", () => {
  it("connects with a valid session cookie and a matching Origin", async () => {
    await connect();
  });

  it("refuses a connection with no cookie", async () => {
    expect(await outcome(open({ Origin: origin() }))).toBe(401);
  });

  it("refuses an invalid session token", async () => {
    expect(await outcome(open({ Origin: origin(), Cookie: `opsifier_session=${"x".repeat(43)}` }))).toBe(401);
  });

  it("refuses an expired session", async () => {
    const [user] = context.deps.db.select().from(users).all();
    const { token } = insertSession(context.deps.db, {
      userId: user?.id as string,
      persistent: false,
      secure: false,
      ip: null,
      userAgent: null,
      now: context.deps.now() - 48 * 60 * 60 * 1000,
    });
    expect(await outcome(open({ Origin: origin(), Cookie: `opsifier_session=${token}` }))).toBe(401);
  });

  it("refuses another origin even with a valid cookie", async () => {
    expect(await outcome(open({ Origin: "https://evil.example", Cookie: cookie }))).toBe(403);
  });

  it("refuses an HTTPS origin on a plain connection, however the header claims otherwise", async () => {
    expect(
      await outcome(
        open({
          Origin: `https://127.0.0.1:${port}`,
          Cookie: cookie,
          "X-Forwarded-Proto": "https",
        }),
      ),
    ).toBe(403);
  });

  describe("behind a trusted proxy", () => {
    let proxied: TestContext;
    let proxiedServer: ReturnType<typeof serve>;
    const secureHost = "panel.example.com";
    let secureCookie: string;

    const openProxied = (headers: Record<string, string>) => {
      const address = proxiedServer.address() as AddressInfo;
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${REALTIME_PATH}`, {
        headers: { Host: secureHost, "X-Forwarded-Proto": "https", ...headers },
      });
      socket.on("error", () => {});
      sockets.push(socket);
      return socket;
    };

    beforeEach(async () => {
      proxied = await createTestContext({ env: { OPSIFIER_TRUSTED_PROXIES: "127.0.0.1" } });
      const plain = await setupAdmin(proxied.app);
      secureCookie = plain.replace(`${SESSION_COOKIE}=`, `${SECURE_SESSION_COOKIE}=`);
      proxiedServer = serve({ fetch: proxied.app.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => proxiedServer.once("listening", () => resolve()));
      proxied.deps.realtime.attach(proxiedServer);
    });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) {
        socket.terminate();
      }
      proxied.deps.realtime.close();
      await new Promise<void>((resolve) => proxiedServer.close(() => resolve()));
      await proxied.close();
    });

    it("connects with the __Host- cookie and an HTTPS origin", async () => {
      expect(await outcome(openProxied({ Origin: `https://${secureHost}`, Cookie: secureCookie }))).toBe(101);
    });

    it("connects when the proxy says wss, as Traefik does on an upgrade", async () => {
      const headers = { Origin: `https://${secureHost}`, Cookie: secureCookie, "X-Forwarded-Proto": "wss" };
      expect(await outcome(openProxied(headers))).toBe(101);
    });

    it("refuses a plain-HTTP origin", async () => {
      expect(await outcome(openProxied({ Origin: `http://${secureHost}`, Cookie: secureCookie }))).toBe(403);
    });

    it("refuses the unprefixed cookie", async () => {
      const unprefixed = secureCookie.replace(`${SECURE_SESSION_COOKIE}=`, `${SESSION_COOKIE}=`);
      expect(await outcome(openProxied({ Origin: `https://${secureHost}`, Cookie: unprefixed }))).toBe(401);
    });
  });

  it("refuses a missing Origin", async () => {
    expect(await outcome(open({ Cookie: cookie }))).toBe(403);
  });

  it("answers refusals with the API error shape", async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      open({ Origin: origin() }).once("unexpected-response", (_request, res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });
  });

  it("refuses other paths", async () => {
    expect(await outcome(open({ Origin: origin(), Cookie: cookie }, "/api/v1/other"))).toBe(404);
  });

  it("closes the socket once the session has expired", async () => {
    const hub = new RealtimeHub({
      db: context.deps.db,
      config: context.deps.config,
      logger: context.deps.logger,
      now: context.deps.now,
      heartbeatIntervalMs: 5,
    });
    const other = serve({ fetch: context.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => other.once("listening", () => resolve()));
    hub.attach(other);
    const otherPort = (other.address() as AddressInfo).port;

    const socket = new WebSocket(`ws://127.0.0.1:${otherPort}${REALTIME_PATH}`, {
      headers: { Origin: `http://127.0.0.1:${otherPort}`, Cookie: cookie },
    });
    sockets.push(socket);
    expect(await outcome(socket)).toBe(101);

    const code = closed(socket);
    context.advance(SESSION_TTL_MS + 1);
    expect(await code).toBe(CLOSE_SESSION_ENDED);

    hub.close();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  it("closes the socket when the session signs out", async () => {
    const socket = await connect();
    const code = closed(socket);

    const logout = await authPost(context.app, "logout", undefined, cookie);
    expect(logout.status).toBe(200);
    expect(await code).toBe(CLOSE_SESSION_ENDED);
  });
});

describe("topics", () => {
  it("delivers data frames to subscribers only", async () => {
    const subscriber = await connect();
    const other = await connect();
    subscriber.send(JSON.stringify({ t: "sub", topic: "action:abc" }));
    other.send(JSON.stringify({ t: "sub", topic: "action:other" }));
    await waitUntil(() => context.deps.realtime.subscriberCount("action:abc") === 1);
    await waitUntil(() => context.deps.realtime.subscriberCount("action:other") === 1);

    const frame = nextFrame(subscriber);
    let leaked = false;
    other.once("message", () => {
      leaked = true;
    });
    context.deps.realtime.publish("action:abc", { line: "hello" });

    expect(await frame).toEqual({ t: "data", topic: "action:abc", payload: { line: "hello" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leaked).toBe(false);
  });

  it("stops delivering after unsub", async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ t: "sub", topic: "metrics:system" }));
    await waitUntil(() => context.deps.realtime.subscriberCount("metrics:system") === 1);
    socket.send(JSON.stringify({ t: "unsub", topic: "metrics:system" }));
    await waitUntil(() => context.deps.realtime.subscriberCount("metrics:system") === 0);
  });

  it("forgets a client that disconnects", async () => {
    const socket = await connect();
    socket.send(JSON.stringify({ t: "sub", topic: "actions" }));
    await waitUntil(() => context.deps.realtime.subscriberCount("actions") === 1);
    socket.close();
    await waitUntil(() => context.deps.realtime.subscriberCount("actions") === 0);
  });

  it("answers malformed frames with an error and keeps the connection", async () => {
    const socket = await connect();
    for (const bad of [
      "not json",
      "[]",
      '{"t":"sub"}',
      '{"t":"sub","topic":"../../etc"}',
      '{"t":"nope","topic":"a"}',
    ]) {
      const reply = nextFrame(socket);
      socket.send(bad);
      expect(await reply).toMatchObject({ t: "error", code: "invalid_frame" });
    }
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("disconnects a client that keeps sending garbage", async () => {
    const socket = await connect();
    const code = closed(socket);
    for (let index = 0; index < 20; index += 1) {
      socket.send("garbage");
    }
    expect(await code).toBe(1008);
  });

  it("closes a connection that sends an oversized frame", async () => {
    const socket = await connect();
    const code = closed(socket);
    socket.send("x".repeat(64 * 1024));
    expect(await code).toBe(1009);
  });

  it("streams an action's output end to end", async () => {
    const socket = await connect();
    const row = context.deps.actions.enqueue({
      type: "deploy",
      title: "Deploy",
      run: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        ctx.log("from the action");
      },
    });
    socket.send(JSON.stringify({ t: "sub", topic: `action:${row.id}` }));

    const received: Frame[] = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString()) as Frame));
    await waitUntil(() =>
      received.some((frame) => JSON.stringify(frame.payload).includes("from the action")),
    );
  });
});
