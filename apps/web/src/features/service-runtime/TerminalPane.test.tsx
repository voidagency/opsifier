// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const written: string[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    write(data: string | Uint8Array) {
      if (typeof data === "string") {
        written.push(data);
      }
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

const { default: TerminalPane } = await import("./TerminalPane");

class FakeSocket {
  static latest: FakeSocket;
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = "blob";
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.latest = this;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  close() {}
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

beforeEach(() => {
  written.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(onStatus = vi.fn()) {
  render(
    <TerminalPane
      project="shop"
      service="web"
      task="t1"
      target={{ program: "bash" }}
      onStatus={onStatus}
      messages={{
        ended: () => "ended",
        lost: "lost",
        refused: "refused",
        fallback: (opened) => `Bash isn't here, so ${opened} was opened.`,
      }}
    />,
  );
  return onStatus;
}

const frame = (payload: unknown) =>
  act(() => FakeSocket.latest.emit("message", { data: JSON.stringify(payload) }));

describe("a console that asked for a shell the container doesn't have", () => {
  it("says which shell it opened instead", () => {
    const onStatus = open();

    frame({ t: "ready", fallback: "sh" });

    expect(onStatus).toHaveBeenCalledWith("connected");
    expect(written.join("")).toContain("Bash isn't here, so sh was opened.");
  });

  it("says nothing when the shell it asked for is the one that opened", () => {
    open();

    frame({ t: "ready" });

    expect(written.join("")).not.toContain("was opened");
  });
});
