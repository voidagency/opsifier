import { describe, expect, it } from "vitest";
import { type LogEntry, LogStore, MAX_LOG_ENTRIES } from "./logStore";

function storeWithFakeHub() {
  const handlers = new Set<(payload: unknown) => void>();
  let subscriptions = 0;
  const store = new LogStore("service-logs:shop/web", (_topic, handler) => {
    subscriptions += 1;
    handlers.add(handler);
    return () => handlers.delete(handler);
  });
  return {
    store,
    emit: (payload: unknown) => {
      for (const handler of handlers) {
        handler(payload);
      }
    },
    subscriptions: () => subscriptions,
    listening: () => handlers.size,
  };
}

const line = (seq: number, text = `line ${seq}`) => ({ seq, stream: "stdout", line: text, at: null });
const snapshot = (feed: string, state: string, lines: unknown[] = []) => ({
  kind: "snapshot",
  feed,
  state,
  lines,
});
const texts = (entries: readonly LogEntry[]) =>
  entries.map((entry) => (entry.kind === "line" ? entry.text : "---"));

describe("the log store", () => {
  it("connects while someone is looking, and only then", () => {
    const { store, listening, subscriptions } = storeWithFakeHub();
    expect(listening()).toBe(0);

    const first = store.retain();
    const second = store.retain();
    expect(subscriptions()).toBe(1);

    first();
    expect(listening()).toBe(1);
    second();
    expect(listening()).toBe(0);
  });

  it("starts from a snapshot and adds what follows", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit(snapshot("f1", "streaming", [line(0), line(1)]));
    emit({ kind: "lines", feed: "f1", lines: [line(2)] });

    expect(store.getView()).toMatchObject({ state: "streaming" });
    expect(texts(store.getView().entries)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("follows the waiting state", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit(snapshot("f1", "connecting"));
    emit({ kind: "state", feed: "f1", state: "waiting" });

    expect(store.getView().state).toBe("waiting");
  });

  it("replaces everything when the feed is a new one", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit(snapshot("f1", "streaming", [line(0)]));
    emit(snapshot("f2", "streaming", [line(0, "fresh")]));

    expect(texts(store.getView().entries)).toEqual(["fresh"]);
  });

  it("only adds what was missed after reconnecting to the same feed, and keeps separators", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();
    emit(snapshot("f1", "streaming", [line(0), line(1)]));
    store.addSeparator();

    emit(snapshot("f1", "streaming", [line(0), line(1), line(2)]));

    expect(texts(store.getView().entries)).toEqual(["line 0", "line 1", "---", "line 2"]);
  });

  it("ignores lines from a feed it has moved on from", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();
    emit(snapshot("f2", "streaming", []));

    emit({ kind: "lines", feed: "f1", lines: [line(0, "stale")] });

    expect(store.getView().entries).toEqual([]);
  });

  it("ignores anything that isn't a log event", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit({ kind: "something else" });
    emit("text");

    expect(store.getView()).toMatchObject({ state: "connecting", entries: [] });
  });

  it("never keeps more than its limit, in entries", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();
    emit(snapshot("f1", "streaming"));

    emit({
      kind: "lines",
      feed: "f1",
      lines: Array.from({ length: MAX_LOG_ENTRIES + 500 }, (_, seq) => line(seq)),
    });

    const { entries } = store.getView();
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries.at(-1)?.key).toBe(`f1:${MAX_LOG_ENTRIES + 499}`);
  });

  it("clears and asks the server again on refresh", () => {
    const { store, emit, subscriptions, listening } = storeWithFakeHub();
    store.retain();
    emit(snapshot("f1", "streaming", [line(0)]));

    store.refresh();

    expect(store.getView()).toEqual({ entries: [], state: "connecting" });
    expect(subscriptions()).toBe(2);
    expect(listening()).toBe(1);
  });

  it("notifies only when something changed", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    emit(snapshot("f1", "streaming", [line(0)]));

    expect(calls).toBe(1);
  });
});
