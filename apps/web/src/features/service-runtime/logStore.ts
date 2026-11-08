import { type LogFeedState, serviceLogEvent, serviceLogsTopic } from "@opsifier/contract";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { realtime } from "../../lib/realtime";

export type LogEntry =
  | { kind: "line"; key: string; seq: number; stream: "stdout" | "stderr"; text: string; at: string | null }
  | { kind: "separator"; key: string; at: number };

export interface LogView {
  entries: readonly LogEntry[];
  state: LogFeedState;
}

/** More than this and the browser would pay for lines nobody can scroll back to anyway. */
export const MAX_LOG_ENTRIES = 2000;

type Subscribe = (topic: string, handler: (payload: unknown) => void) => () => void;

/**
 * The logs of one service for everything on screen that shows them. The Overview pane and the
 * fullscreen view are two windows onto this one store, so opening one never disturbs the other.
 */
export class LogStore {
  private view: LogView = { entries: [], state: "connecting" };
  private readonly listeners = new Set<() => void>();
  private consumers = 0;
  private release: (() => void) | null = null;
  private feed: string | null = null;
  private lastSeq = -1;
  private separators = 0;

  constructor(
    private readonly topic: string,
    private readonly subscribeTopic: Subscribe = (topic, handler) => realtime.subscribe(topic, handler),
  ) {}

  /** Keeps the stream open until the function it returns is called. */
  retain(): () => void {
    this.consumers += 1;
    if (this.consumers === 1) {
      this.connect();
    }
    return () => {
      this.consumers -= 1;
      if (this.consumers === 0) {
        this.disconnect();
      }
    };
  }

  /** Drops what is on screen and asks the server for the stream again. */
  refresh(): void {
    this.disconnect();
    this.feed = null;
    this.lastSeq = -1;
    this.publish({ entries: [], state: "connecting" });
    this.connect();
  }

  addSeparator(): void {
    this.separators += 1;
    const separator: LogEntry = { kind: "separator", key: `separator-${this.separators}`, at: Date.now() };
    this.publish({ ...this.view, entries: [...this.view.entries, separator] });
  }

  getView = (): LogView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private connect(): void {
    this.release = this.subscribeTopic(this.topic, (payload) => this.receive(payload));
  }

  private disconnect(): void {
    this.release?.();
    this.release = null;
  }

  private receive(payload: unknown): void {
    const event = serviceLogEvent.safeParse(payload).data;
    if (event === undefined) {
      return;
    }
    if (event.kind === "snapshot") {
      this.applySnapshot(event);
    } else if (event.feed === this.feed) {
      if (event.kind === "state") {
        this.publish({ ...this.view, state: event.state });
      } else {
        this.publish({
          ...this.view,
          entries: this.trimmed([...this.view.entries, ...this.toEntries(event.lines)]),
        });
      }
    }
  }

  private applySnapshot(
    event: Extract<ReturnType<typeof serviceLogEvent.parse>, { kind: "snapshot" }>,
  ): void {
    if (event.feed === this.feed) {
      // Connected again to a stream that never stopped: only what was missed is new.
      this.publish({
        state: event.state,
        entries: this.trimmed([...this.view.entries, ...this.toEntries(event.lines)]),
      });
      return;
    }
    this.feed = event.feed;
    this.lastSeq = -1;
    this.publish({ state: event.state, entries: this.trimmed(this.toEntries(event.lines)) });
  }

  private toEntries(
    lines: ReadonlyArray<{ seq: number; stream: "stdout" | "stderr"; line: string; at: string | null }>,
  ) {
    const entries: LogEntry[] = [];
    for (const line of lines) {
      if (line.seq > this.lastSeq) {
        this.lastSeq = line.seq;
        entries.push({
          kind: "line",
          key: `${this.feed}:${line.seq}`,
          seq: line.seq,
          stream: line.stream,
          text: line.line,
          at: line.at,
        });
      }
    }
    return entries;
  }

  private trimmed(entries: LogEntry[]): LogEntry[] {
    return entries.length > MAX_LOG_ENTRIES ? entries.slice(entries.length - MAX_LOG_ENTRIES) : entries;
  }

  private publish(view: LogView): void {
    this.view = view;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const stores = new Map<string, { store: LogStore; uses: number }>();

/** Shares one store per service among everything that shows its logs. */
function acquireStore(topic: string): LogStore {
  const existing = stores.get(topic);
  if (existing !== undefined) {
    existing.uses += 1;
    return existing.store;
  }
  const store = new LogStore(topic);
  stores.set(topic, { store, uses: 1 });
  return store;
}

function releaseStore(topic: string): void {
  const entry = stores.get(topic);
  if (entry !== undefined) {
    entry.uses -= 1;
    if (entry.uses === 0) {
      stores.delete(topic);
    }
  }
}

/** The live logs of a service, of any type, for as long as the component is mounted. */
export function useServiceLogs(project: string, service: string): { store: LogStore; view: LogView } {
  const topic = serviceLogsTopic(project, service);
  const store = useMemo(() => acquireStore(topic), [topic]);

  useEffect(() => {
    const release = store.retain();
    return () => {
      release();
      releaseStore(topic);
    };
  }, [store, topic]);

  const view = useSyncExternalStore(store.subscribe, store.getView);
  return { store, view };
}
