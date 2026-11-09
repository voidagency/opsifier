import {
  type LogFeedState,
  type LogStreamFilter,
  type ServiceLogLine,
  serviceLogEvent,
  serviceLogsTopic,
} from "@opsifier/contract";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { realtime } from "../../lib/realtime";

export type LogEntry =
  | { kind: "line"; key: string; seq: number; stream: "stdout" | "stderr"; text: string; at: string | null }
  | { kind: "separator"; key: string; at: number }
  | { kind: "gap"; key: string; at: string | null };

export interface LogView {
  entries: readonly LogEntry[];
  state: LogFeedState;
  paused: boolean;
  /** Lines that came in during a pause and are waiting to be shown. */
  held: number;
  /** How far back the feed reads and how much it keeps. Null until it has said. */
  limits: { tailLines: number; ringLines: number } | null;
}

const INITIAL_VIEW: LogView = { entries: [], state: "connecting", paused: false, held: 0, limits: null };

export interface LogFilter {
  text: string;
  stream: LogStreamFilter;
}

/** Only the lines a filter lets through. Separators and gaps keep their place, so the times still read. */
export function filterLogView(view: LogView, { text, stream }: LogFilter): LogView {
  const needle = text.trim().toLowerCase();
  if (needle === "" && stream === "all") {
    return view;
  }
  return {
    ...view,
    entries: view.entries.filter(
      (entry) =>
        entry.kind !== "line" ||
        ((stream === "all" || entry.stream === stream) && entry.text.toLowerCase().includes(needle)),
    ),
  };
}

/** More than this and the browser would pay for lines nobody can scroll back to anyway. */
export const MAX_LOG_ENTRIES = 2000;

type Subscribe = (topic: string, handler: (payload: unknown) => void) => () => void;

/**
 * The logs of one service for everything on screen that shows them. The Overview pane and the
 * fullscreen view are two windows onto this one store, so opening one never disturbs the other.
 */
export class LogStore {
  private view: LogView = INITIAL_VIEW;
  private readonly listeners = new Set<() => void>();
  private consumers = 0;
  private release: (() => void) | null = null;
  private feed: string | null = null;
  private lastSeq = -1;
  private separators = 0;
  private held: LogEntry[] = [];
  /** A new feed arrived during a pause, or the hold overflowed: resuming starts from what is held. */
  private replaceOnResume = false;

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
    this.held = [];
    this.replaceOnResume = false;
    this.publish(INITIAL_VIEW);
    this.connect();
  }

  addSeparator(): void {
    this.separators += 1;
    this.append([{ kind: "separator", key: `separator-${this.separators}`, at: Date.now() }]);
  }

  /** Holds what is on screen still. The stream carries on, up to the same limit as what is shown. */
  pause(): void {
    if (!this.view.paused) {
      this.publish({ ...this.view, paused: true });
    }
  }

  resume(): void {
    if (!this.view.paused) {
      return;
    }
    const entries = this.replaceOnResume ? this.held : [...this.view.entries, ...this.held];
    this.held = [];
    this.replaceOnResume = false;
    this.publish({ ...this.view, entries: this.trimmed(entries), paused: false, held: 0 });
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
        this.append(this.toEntries(event.lines));
      }
    }
  }

  /** Adds to the end of what is shown, or, during a pause, to what is waiting. */
  private append(entries: readonly LogEntry[], state: LogFeedState = this.view.state): void {
    if (!this.view.paused) {
      this.publish({ ...this.view, state, entries: this.trimmed([...this.view.entries, ...entries]) });
      return;
    }
    this.held.push(...entries);
    if (this.held.length > MAX_LOG_ENTRIES) {
      const kept = this.held.slice(this.held.length - MAX_LOG_ENTRIES + 1);
      this.held = [{ kind: "gap", key: `held-${kept[0]?.key ?? "end"}`, at: heldTime(kept[0]) }, ...kept];
      this.replaceOnResume = true;
    }
    this.publish({ ...this.view, state, held: this.held.length });
  }

  private applySnapshot(
    event: Extract<ReturnType<typeof serviceLogEvent.parse>, { kind: "snapshot" }>,
  ): void {
    if (event.tailLines !== undefined && event.ringLines !== undefined) {
      // Goes out with whichever update comes next, just below.
      this.view = { ...this.view, limits: { tailLines: event.tailLines, ringLines: event.ringLines } };
    }
    if (event.feed === this.feed) {
      // Connected again to a stream that never stopped: only what was missed is new.
      this.append(this.toEntries(event.lines), event.state);
      return;
    }
    this.feed = event.feed;
    this.lastSeq = -1;
    const fresh = this.toEntries(event.lines);
    if (this.view.paused) {
      this.held = [];
      this.replaceOnResume = true;
      this.append(fresh, event.state);
    } else {
      this.publish({ ...this.view, state: event.state, entries: this.trimmed(fresh) });
    }
  }

  private toEntries(lines: readonly ServiceLogLine[]) {
    const entries: LogEntry[] = [];
    for (const line of lines) {
      if (line.seq > this.lastSeq) {
        this.lastSeq = line.seq;
        const key = `${this.feed}:${line.seq}`;
        entries.push(
          line.gap === true
            ? { kind: "gap", key, at: line.at }
            : { kind: "line", key, seq: line.seq, stream: line.stream, text: line.line, at: line.at },
        );
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

function heldTime(entry: LogEntry | undefined): string | null {
  return entry === undefined || entry.kind === "separator" ? null : entry.at;
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
