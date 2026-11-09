import { describe, expect, it } from "vitest";
import { filterLogView, type LogEntry, LogStore, MAX_LOG_ENTRIES } from "./logStore";

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

    expect(store.getView()).toMatchObject({ entries: [], state: "connecting", paused: false });
    expect(subscriptions()).toBe(2);
    expect(listening()).toBe(1);
  });

  it("shows where the feed skipped output, in place", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit(snapshot("f1", "streaming", [line(0)]));
    emit({
      kind: "lines",
      feed: "f1",
      lines: [{ seq: 1, stream: "stdout", line: "", at: "2026-01-01T00:00:00Z", gap: true }, line(2)],
    });

    expect(store.getView().entries.map((entry) => entry.kind)).toEqual(["line", "gap", "line"]);
  });

  describe("pausing", () => {
    it("holds what is on screen while the stream carries on", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming", [line(0)]));

      store.pause();
      emit({ kind: "lines", feed: "f1", lines: [line(1), line(2)] });

      expect(texts(store.getView().entries)).toEqual(["line 0"]);
      expect(store.getView()).toMatchObject({ paused: true, held: 2 });
    });

    it("shows everything that waited, in order, on resuming", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming", [line(0)]));
      store.pause();
      emit({ kind: "lines", feed: "f1", lines: [line(1)] });

      store.resume();
      emit({ kind: "lines", feed: "f1", lines: [line(2)] });

      expect(texts(store.getView().entries)).toEqual(["line 0", "line 1", "line 2"]);
      expect(store.getView()).toMatchObject({ paused: false, held: 0 });
    });

    it("never holds more than it could show, and marks where lines were lost", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming", [line(0)]));
      store.pause();

      emit({
        kind: "lines",
        feed: "f1",
        lines: Array.from({ length: MAX_LOG_ENTRIES + 500 }, (_, index) => line(index + 1)),
      });

      expect(store.getView().held).toBeLessThanOrEqual(MAX_LOG_ENTRIES);
      store.resume();
      const { entries } = store.getView();
      expect(entries).toHaveLength(MAX_LOG_ENTRIES);
      expect(entries[0]?.kind).toBe("gap");
      expect(entries.at(-1)?.key).toBe(`f1:${MAX_LOG_ENTRIES + 500}`);
    });

    it("keeps following the feed's state during a pause", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming"));
      store.pause();

      emit({ kind: "state", feed: "f1", state: "waiting" });

      expect(store.getView().state).toBe("waiting");
    });

    it("starts over from a feed that replaced the old one during the pause", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming", [line(0, "old feed")]));
      store.pause();

      emit(snapshot("f2", "streaming", [line(0, "new feed")]));
      expect(texts(store.getView().entries)).toEqual(["old feed"]);

      store.resume();
      expect(texts(store.getView().entries)).toEqual(["new feed"]);
    });

    it("ends the pause on a reload", () => {
      const { store, emit } = storeWithFakeHub();
      store.retain();
      emit(snapshot("f1", "streaming", [line(0)]));
      store.pause();
      emit({ kind: "lines", feed: "f1", lines: [line(1)] });

      store.refresh();
      emit(snapshot("f2", "streaming", [line(0, "fresh")]));

      expect(store.getView().paused).toBe(false);
      expect(texts(store.getView().entries)).toEqual(["fresh"]);
    });
  });

  describe("filtering", () => {
    const view = {
      state: "streaming" as const,
      paused: false,
      held: 0,
      limits: null,
      entries: [
        {
          kind: "line" as const,
          key: "1",
          seq: 1,
          stream: "stdout" as const,
          text: "GET /health 200",
          at: null,
        },
        { kind: "separator" as const, key: "s", at: 0 },
        { kind: "line" as const, key: "2", seq: 2, stream: "stderr" as const, text: "error: nope", at: null },
      ],
    };

    it("matches any case and keeps separators in place", () => {
      expect(filterLogView(view, { text: "HEALTH", stream: "all" }).entries.map((e) => e.key)).toEqual([
        "1",
        "s",
      ]);
    });

    it("narrows to one stream", () => {
      expect(filterLogView(view, { text: "", stream: "stderr" }).entries.map((e) => e.key)).toEqual([
        "s",
        "2",
      ]);
    });

    it("hands back the same view when there is nothing to filter", () => {
      expect(filterLogView(view, { text: "  ", stream: "all" })).toBe(view);
    });
  });

  it("remembers what the feed says about its own reach", () => {
    const { store, emit } = storeWithFakeHub();
    store.retain();

    emit({ ...snapshot("f1", "streaming"), tailLines: 200, ringLines: 1000 });

    expect(store.getView().limits).toEqual({ tailLines: 200, ringLines: 1000 });
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
