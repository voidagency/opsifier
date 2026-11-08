import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectionStatus, RealtimeClient, type SocketLike } from "./realtime";

type Listener = (event: never) => void;

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: "open" | "close" | "error" | "message", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  /** Test controls: the server accepts, sends a frame, or the connection drops. */
  accept(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(data: unknown): void {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

describe("RealtimeClient", () => {
  let sockets: FakeSocket[];

  const makeClient = (extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) =>
    new RealtimeClient({
      url: "ws://test/api/v1/ws",
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      minDelayMs: 100,
      maxDelayMs: 1600,
      stableAfterMs: 1000,
      // No jitter, so delays are exact: half fixed plus half "random" at its maximum.
      random: () => 1,
      ...extra,
    });

  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) {
      throw new Error("no socket was created");
    }
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes once per topic however many handlers listen", () => {
    const client = makeClient();
    client.connect();
    last().accept();

    client.subscribe("metrics:system", vi.fn());
    client.subscribe("metrics:system", vi.fn());

    expect(last().sent).toEqual([{ t: "sub", topic: "metrics:system" }]);
  });

  it("subscribes topics registered before the socket opened, once it does", () => {
    const client = makeClient();
    client.subscribe("actions", vi.fn());
    client.connect();
    expect(last().sent).toEqual([]);

    last().accept();

    expect(last().sent).toEqual([{ t: "sub", topic: "actions" }]);
  });

  it("unsubscribes only when the last handler leaves", () => {
    const client = makeClient();
    client.connect();
    last().accept();
    const first = client.subscribe("actions", vi.fn());
    const second = client.subscribe("actions", vi.fn());

    first();
    expect(last().sent).toEqual([{ t: "sub", topic: "actions" }]);

    second();
    expect(last().sent).toEqual([
      { t: "sub", topic: "actions" },
      { t: "unsub", topic: "actions" },
    ]);
  });

  it("delivers payloads to the right topic and ignores anything else", () => {
    const client = makeClient();
    const onActions = vi.fn();
    const onMetrics = vi.fn();
    client.subscribe("actions", onActions);
    client.subscribe("metrics:system", onMetrics);
    client.connect();
    last().accept();

    last().receive({ t: "data", topic: "actions", payload: { id: "1" } });
    last().receive({ t: "data", topic: "nobody-listening", payload: {} });
    last().receive({ t: "error", code: "invalid_frame", message: "No." });
    last().receive("not json at all");

    expect(onActions).toHaveBeenCalledExactlyOnceWith({ id: "1" });
    expect(onMetrics).not.toHaveBeenCalled();
  });

  it("reconnects after a dropped connection and subscribes every live topic again", () => {
    const statuses: ConnectionStatus[] = [];
    const client = makeClient();
    client.onStatusChange((status) => statuses.push(status));
    const onActions = vi.fn();
    client.subscribe("actions", onActions);
    const gone = client.subscribe("metrics:system", vi.fn());
    client.connect();
    last().accept();
    gone();

    last().drop();
    expect(client.status).toBe("reconnecting");
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    last().accept();
    expect(last().sent).toEqual([{ t: "sub", topic: "actions" }]);
    expect(client.status).toBe("open");

    last().receive({ t: "data", topic: "actions", payload: "after reconnect" });
    expect(onActions).toHaveBeenCalledExactlyOnceWith("after reconnect");

    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("backs off exponentially up to the ceiling while the server stays away", () => {
    const client = makeClient();
    client.connect();

    const delays = [100, 200, 400, 800, 1600, 1600];
    for (const delay of delays) {
      const before = sockets.length;
      last().drop();
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
    }
  });

  it("forgives past failures once a connection has stayed up", () => {
    const client = makeClient();
    client.connect();
    last().drop();
    vi.advanceTimersByTime(100);
    last().drop();
    vi.advanceTimersByTime(200);

    last().accept();
    vi.advanceTimersByTime(1000);
    last().drop();

    const before = sockets.length;
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(before + 1);
  });

  it("does not reconnect after an intentional disconnect", () => {
    const client = makeClient();
    client.connect();
    last().accept();

    client.disconnect();
    vi.advanceTimersByTime(10_000);

    expect(sockets).toHaveLength(1);
    expect(client.status).toBe("idle");
  });

  it("stops and reports when the server ends the session", () => {
    const onEnded = vi.fn();
    const client = makeClient();
    client.setSessionEndedHandler(onEnded);
    client.connect();
    last().accept();

    last().drop(4401);
    vi.advanceTimersByTime(10_000);

    expect(onEnded).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe("idle");
  });
});
