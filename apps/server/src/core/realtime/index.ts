import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import type { Duplex } from "node:stream";
import { realtimeClientFrame } from "@opsifier/contract";
import { parse as parseCookies } from "hono/utils/cookie";
import type { Logger } from "pino";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
  findSessionPrincipal,
  isOriginAllowed,
  isSessionActive,
  type Principal,
  resolveRequestScheme,
  sessionCookieName,
} from "../auth";
import type { Config } from "../config";
import type { Db } from "../db";
import { errorBody } from "../errors";

export const REALTIME_PATH = "/api/v1/ws";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_FRAME_BYTES = 8 * 1024;
const MAX_TOPICS_PER_CLIENT = 256;
const MAX_VIOLATIONS = 16;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Sent when the session behind a connection ends, so the client knows to sign in again. */
export const CLOSE_SESSION_ENDED = 4401;

interface Client {
  socket: WebSocket;
  sessionId: string;
  topics: Set<string>;
  alive: boolean;
  violations: number;
}

/** The answer of a {@link SocketRoute} to one connection, before the upgrade completes. */
export type SocketAdmission =
  | { allowed: true; connect: (socket: WebSocket) => void }
  | { allowed: false; status: number; code: string; message: string };

/**
 * A WebSocket endpoint with its own protocol. It sits behind the same Origin and session checks as
 * the hub's own socket, and a connection ends with its session like any other.
 */
export interface SocketRoute {
  matches(path: string): boolean;
  /** A frame larger than this closes the connection. */
  maxPayload: number;
  admit(context: { url: URL; principal: Extract<Principal, { kind: "session" }> }): SocketAdmission;
}

/** What a provider publishes through. */
export interface TopicChannel {
  publish(payload: unknown): void;
  /** Bytes still queued for the slowest subscriber. Slow down while this is high. */
  pressure(): number;
}

export interface TopicFeed {
  /** Stops all work. Called when the last subscriber leaves. */
  close(): void;
  /** Frames for one new subscriber, so it can catch up with what the others already received. */
  replay?(): readonly unknown[];
}

/** Produces a topic's frames on demand: started by the first subscriber, stopped by the last. */
export interface TopicProvider {
  matches(topic: string): boolean;
  open(topic: string, channel: TopicChannel): TopicFeed;
}

export interface RealtimeHubOptions {
  db: Db;
  config: Pick<Config, "allowedOrigins" | "trustedProxies">;
  logger: Logger;
  now?: () => number;
  heartbeatIntervalMs?: number;
}

/** The single JSON WebSocket. Clients subscribe to topics; features publish to them. */
export class RealtimeHub {
  private readonly db: Db;
  private readonly config: Pick<Config, "allowedOrigins" | "trustedProxies">;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  private readonly clients = new Set<Client>();
  private readonly topics = new Map<string, Set<Client>>();
  private readonly routes: Array<{ route: SocketRoute; server: WebSocketServer }> = [];
  private readonly providers: TopicProvider[] = [];
  private readonly feeds = new Map<string, TopicFeed>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(options: RealtimeHubOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  /** Takes over WebSocket upgrades on the HTTP server. */
  attach(server: Server | Http2Server | Http2SecureServer): void {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  publish(topic: string, payload: unknown): void {
    const subscribers = this.topics.get(topic);
    if (subscribers === undefined || subscribers.size === 0) {
      return;
    }
    const frame = JSON.stringify({ t: "data", topic, payload });
    for (const client of subscribers) {
      this.send(client, frame);
    }
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  /** Serves another WebSocket endpoint behind the same authentication. */
  route(route: SocketRoute): void {
    this.routes.push({
      route,
      server: new WebSocketServer({
        noServer: true,
        maxPayload: route.maxPayload,
        perMessageDeflate: false,
      }),
    });
  }

  /** Lets a feature produce the frames of some topics, only while someone is listening. */
  provide(provider: TopicProvider): void {
    this.providers.push(provider);
  }

  /** Disconnects these sessions right away, for sign-out and revocation. */
  disconnectSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) {
      return;
    }
    const ended = new Set(sessionIds);
    for (const client of this.clients) {
      if (ended.has(client.sessionId)) {
        client.socket.close(CLOSE_SESSION_ENDED, "Session ended");
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const feed of this.feeds.values()) {
      feed.close();
    }
    this.feeds.clear();
    for (const client of this.clients) {
      client.socket.close(1001, "Server shutting down");
    }
    this.server.close();
    for (const { server } of this.routes) {
      server.close();
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // The connection is ours until the upgrade completes. A client hanging up must not crash us.
    socket.on("error", () => socket.destroy());

    const path = request.url?.split("?", 1)[0] ?? "";
    const custom = this.routes.find(({ route }) => route.matches(path));
    if (path !== REALTIME_PATH && custom === undefined) {
      rejectUpgrade(socket, 404, "not_found", "Not found.");
      return;
    }
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      rejectUpgrade(socket, 400, "bad_request", "Expected a WebSocket upgrade.");
      return;
    }
    const forwardedProto = request.headers["x-forwarded-proto"];
    const scheme = resolveRequestScheme(
      {
        encrypted: (request.socket as { encrypted?: boolean }).encrypted === true,
        peer: request.socket.remoteAddress,
        forwardedProto: Array.isArray(forwardedProto) ? forwardedProto.join(",") : forwardedProto,
      },
      this.config.trustedProxies,
    );
    if (
      !isOriginAllowed(
        request.headers.origin,
        { host: request.headers.host, scheme },
        this.config.allowedOrigins,
      )
    ) {
      rejectUpgrade(socket, 403, "origin_rejected", "This page is not allowed to connect.");
      return;
    }

    const cookie = sessionCookieName(scheme);
    const token = parseCookies(request.headers.cookie ?? "", cookie)[cookie];
    const principal = token === undefined ? null : findSessionPrincipal(this.db, token, this.now());
    if (principal === null || principal.kind !== "session") {
      rejectUpgrade(socket, 401, "unauthenticated", "Sign in to continue.");
      return;
    }

    const { sessionId } = principal;
    if (custom !== undefined) {
      const admission = custom.route.admit({
        url: new URL(request.url ?? path, "http://panel.invalid"),
        principal,
      });
      if (!admission.allowed) {
        rejectUpgrade(socket, admission.status, admission.code, admission.message);
        return;
      }
      custom.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.track(webSocket, sessionId);
        admission.connect(webSocket);
      });
      return;
    }

    this.server.handleUpgrade(request, socket, head, (webSocket) => {
      const client = this.track(webSocket, sessionId);
      webSocket.on("message", (data, isBinary) => this.receive(client, data, isBinary));
    });
  }

  /** Puts a connection under the heartbeat and the session checks. */
  private track(socket: WebSocket, sessionId: string): Client {
    const client: Client = { socket, sessionId, topics: new Set(), alive: true, violations: 0 };
    this.clients.add(client);

    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("close", () => this.unregister(client));
    socket.on("error", (error) => {
      this.logger.debug({ err: error }, "WebSocket error");
      socket.terminate();
    });
    return client;
  }

  private unregister(client: Client): void {
    this.clients.delete(client);
    for (const topic of client.topics) {
      this.removeFromTopic(topic, client);
    }
    client.topics.clear();
  }

  private receive(client: Client, data: RawData, isBinary: boolean): void {
    let value: unknown;
    try {
      value = isBinary ? undefined : JSON.parse(data.toString());
    } catch {
      value = undefined;
    }

    const frame = realtimeClientFrame.safeParse(value);
    if (!frame.success) {
      this.reject(client, "invalid_frame", "Expected { t: 'sub' | 'unsub', topic }.");
      return;
    }

    const { t, topic } = frame.data;
    if (t === "sub") {
      if (client.topics.size >= MAX_TOPICS_PER_CLIENT && !client.topics.has(topic)) {
        this.reject(client, "too_many_topics", "Unsubscribe from something first.");
        return;
      }
      const subscribers = this.topics.get(topic) ?? new Set<Client>();
      const isNew = !subscribers.has(client);
      client.topics.add(topic);
      subscribers.add(client);
      this.topics.set(topic, subscribers);
      if (isNew) {
        this.feedTopic(topic, client);
      }
    } else {
      client.topics.delete(topic);
      this.removeFromTopic(topic, client);
    }
  }

  /** Starts the topic's provider for its first subscriber, and catches up any later one. */
  private feedTopic(topic: string, client: Client): void {
    const provider = this.providers.find((candidate) => candidate.matches(topic));
    if (provider === undefined) {
      return;
    }
    try {
      let feed = this.feeds.get(topic);
      if (feed === undefined) {
        feed = provider.open(topic, {
          publish: (payload) => this.publish(topic, payload),
          pressure: () => this.pressure(topic),
        });
        this.feeds.set(topic, feed);
      }
      for (const payload of feed.replay?.() ?? []) {
        this.send(client, JSON.stringify({ t: "data", topic, payload }));
      }
    } catch (error) {
      this.logger.warn({ err: error, topic }, "Could not open a topic feed");
      this.send(client, JSON.stringify({ t: "error", code: "topic_unavailable", message: "Not available." }));
    }
  }

  private pressure(topic: string): number {
    let highest = 0;
    for (const client of this.topics.get(topic) ?? []) {
      highest = Math.max(highest, client.socket.bufferedAmount);
    }
    return highest;
  }

  private removeFromTopic(topic: string, client: Client): void {
    const subscribers = this.topics.get(topic);
    subscribers?.delete(client);
    if (subscribers?.size === 0) {
      this.topics.delete(topic);
      this.feeds.get(topic)?.close();
      this.feeds.delete(topic);
    }
  }

  private reject(client: Client, code: string, message: string): void {
    client.violations += 1;
    if (client.violations > MAX_VIOLATIONS) {
      client.socket.close(1008, "Too many invalid frames");
      return;
    }
    this.send(client, JSON.stringify({ t: "error", code, message }));
  }

  private send(client: Client, frame: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // It cannot keep up. Dropping frames would leave silent gaps in its logs; reconnecting will not.
      client.socket.close(1013, "Too slow");
      return;
    }
    client.socket.send(frame, (error) => {
      if (error) {
        this.logger.debug({ err: error }, "WebSocket send failed");
      }
    });
  }

  /** Reaps dead connections and any whose session expired or was revoked since the upgrade. */
  private beat(): void {
    for (const client of this.clients) {
      try {
        if (!isSessionActive(this.db, client.sessionId, this.now())) {
          client.socket.close(CLOSE_SESSION_ENDED, "Session ended");
          continue;
        }
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      } catch (error) {
        // Runs on a timer: a transient database error must not take the process down.
        this.logger.error({ err: error }, "WebSocket heartbeat failed");
      }
    }
  }
}

function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify(errorBody(code, message));
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
