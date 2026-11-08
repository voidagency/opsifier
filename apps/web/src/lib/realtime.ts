import type { RealtimeClientFrame, RealtimeServerFrame } from "@opsifier/contract";
import { useEffect, useRef, useSyncExternalStore } from "react";

/** The subset of the browser WebSocket this client relies on. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: never) => void): void;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting";

type Handler = (payload: unknown) => void;
type StatusListener = (status: ConnectionStatus) => void;

export interface RealtimeOptions {
  /** Defaults to `/api/v1/ws` on the current origin. */
  url?: string;
  /** Replaces the global WebSocket, mainly for tests. */
  createSocket?: (url: string) => SocketLike;
  /** Delay before the first reconnect attempt. */
  minDelayMs?: number;
  /** Upper bound for the exponential backoff. */
  maxDelayMs?: number;
  /** How long a connection must stay up before the backoff resets. */
  stableAfterMs?: number;
  /** Source of jitter, between 0 and 1. */
  random?: () => number;
}

const OPEN = 1;

/** The close code the server uses when the session behind a connection has ended. */
const sessionEndedCode = 4401;

function defaultUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/v1/ws`;
}

/**
 * One WebSocket carrying JSON frames for many topics.
 *
 * Handlers are counted per topic, so the server sees a single `sub` however many components listen,
 * and an `unsub` when the last one leaves. Lost connections are retried with backoff, and every topic
 * that still has a handler is subscribed again on the new socket.
 */
export class RealtimeClient {
  private readonly options: Required<Omit<RealtimeOptions, "url">> & { url?: string };
  private readonly topics = new Map<string, Set<Handler>>();
  private readonly statusListeners = new Set<StatusListener>();
  private sessionEndedHandler: (() => void) | undefined;
  private socket: SocketLike | undefined;
  private wanted = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private currentStatus: ConnectionStatus = "idle";

  constructor(options: RealtimeOptions = {}) {
    this.options = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      minDelayMs: 500,
      maxDelayMs: 15_000,
      stableAfterMs: 5_000,
      random: Math.random,
      ...options,
    };
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** Opens the connection and keeps it open until `disconnect` is called. Safe to call repeatedly. */
  connect(): void {
    if (this.wanted) {
      return;
    }
    this.wanted = true;
    this.attempts = 0;
    this.open();
  }

  /** Closes the connection and stops reconnecting. Subscriptions are kept for the next `connect`. */
  disconnect(): void {
    this.wanted = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setStatus("idle");
  }

  /** Listens to a topic. Returns the function that stops listening. */
  subscribe<T = unknown>(topic: string, handler: (payload: T) => void): () => void {
    const entry = handler as Handler;
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
      this.send({ t: "sub", topic });
    }
    handlers.add(entry);

    return () => {
      const current = this.topics.get(topic);
      if (!current?.delete(entry) || current.size > 0) {
        return;
      }
      this.topics.delete(topic);
      this.send({ t: "unsub", topic });
    };
  }

  /** Runs when the server closes the connection because the session ended. No reconnect follows. */
  setSessionEndedHandler(handler: (() => void) | undefined): void {
    this.sessionEndedHandler = handler;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private open(): void {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const socket = this.options.createSocket(this.options.url ?? defaultUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.socket) {
        return;
      }
      for (const topic of this.topics.keys()) {
        this.send({ t: "sub", topic });
      }
      this.setStatus("open");
      this.stableTimer = setTimeout(() => {
        this.attempts = 0;
      }, this.options.stableAfterMs);
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (socket === this.socket) {
        this.dispatch(event.data);
      }
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      if (socket !== this.socket) {
        return;
      }
      this.socket = undefined;
      if (event.code === sessionEndedCode) {
        this.disconnect();
        this.sessionEndedHandler?.();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (!this.wanted) {
      return;
    }
    const { minDelayMs, maxDelayMs, random } = this.options;
    const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** this.attempts);
    // Half fixed, half random, so a restart does not make every open tab reconnect in the same instant.
    const delay = ceiling / 2 + random() * (ceiling / 2);
    this.attempts += 1;
    this.setStatus("reconnecting");
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isDataFrame(frame)) {
      return;
    }
    for (const handler of this.topics.get(frame.topic) ?? []) {
      handler(frame.payload);
    }
  }

  private send(frame: RealtimeClientFrame): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private clearTimers(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.retryTimer = undefined;
    this.stableTimer = undefined;
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) {
      return;
    }
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

function isDataFrame(frame: unknown): frame is Extract<RealtimeServerFrame, { t: "data" }> {
  if (typeof frame !== "object" || frame === null) {
    return false;
  }
  const candidate = frame as { t?: unknown; topic?: unknown };
  return candidate.t === "data" && typeof candidate.topic === "string";
}

/** The connection the whole app shares. */
export const realtime = new RealtimeClient();

/** Listens to a topic for as long as the component is mounted. */
export function useTopic<T>(topic: string | null, handler: (payload: T) => void): void {
  const latest = useRef(handler);

  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    if (topic === null) {
      return;
    }
    return realtime.subscribe<T>(topic, (payload) => latest.current(payload));
  }, [topic]);
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    (listener) => realtime.onStatusChange(listener),
    () => realtime.status,
  );
}
