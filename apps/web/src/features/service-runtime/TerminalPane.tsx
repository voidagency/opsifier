import "@xterm/xterm/css/xterm.css";
import { type TerminalClientFrame, terminalPath, terminalServerFrame } from "@opsifier/contract";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useResolvedTheme } from "../../lib/theme";

/** Terminals carry more than one screenful. Past this much, xterm's memory is the thing at stake. */
const SCROLLBACK_LINES = 2000;
/** The server closes the connection for a frame of more than 64 KiB, so a paste goes in pieces. */
const MAX_INPUT_CHUNK_BYTES = 32 * 1024;
/** How much output may be queued in xterm before the server is asked to hold the rest back. */
const HIGH_WATER_BYTES = 512 * 1024;
const LOW_WATER_BYTES = 64 * 1024;

export type TerminalStatus = "connecting" | "connected" | "ended";

export interface TerminalPaneProps {
  project: string;
  service: string;
  task: string;
  /** What to run: a program, or a saved script by name. */
  target: { program: "sh" | "bash" } | { script: string };
  /** Text for what the terminal itself says, in the interface's language. */
  messages: {
    ended: (code: number | null) => string;
    lost: string;
    refused: string;
  };
  onStatus: (status: TerminalStatus) => void;
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Our palette, read from the CSS tokens so the terminal follows the theme. */
function terminalTheme(dark: boolean) {
  const ink = cssToken("--ink");
  const background = cssToken("--raised");
  return {
    background,
    foreground: ink,
    cursor: cssToken("--accent"),
    cursorAccent: background,
    selectionBackground: dark ? "rgba(227, 163, 58, 0.35)" : "rgba(22, 38, 74, 0.25)",
    black: dark ? "#2b3c63" : "#16264a",
    red: dark ? "#ff7a9c" : "#be2453",
    green: dark ? "#3dbfae" : "#1f7a6e",
    yellow: dark ? "#e3a33a" : "#8a5a12",
    blue: dark ? "#8fb3ff" : "#2a5bd7",
    magenta: dark ? "#d7a6ff" : "#8240b8",
    cyan: dark ? "#6fd3d8" : "#0f7c84",
    white: dark ? "#ffffff" : "#5b6781",
  };
}

function socketUrl(
  props: Pick<TerminalPaneProps, "project" | "service" | "task" | "target">,
  cols: number,
  rows: number,
) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ task: props.task, cols: String(cols), rows: String(rows) });
  if ("program" in props.target) {
    query.set("program", props.target.program);
  } else {
    query.set("script", props.target.script);
  }
  return `${scheme}//${location.host}${terminalPath(props.project, props.service)}?${query}`;
}

function* inputChunks(data: string) {
  const bytes = new TextEncoder().encode(data);
  for (let start = 0; start < bytes.length; start += MAX_INPUT_CHUNK_BYTES) {
    yield bytes.slice(start, start + MAX_INPUT_CHUNK_BYTES);
  }
}

/** One xterm joined to one console session, from mounting to unmounting. */
export default function TerminalPane(props: TerminalPaneProps) {
  const { project, service, task, target, messages, onStatus } = props;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const theme = useResolvedTheme();
  const latest = useRef({ messages, onStatus });
  latest.current = { messages, onStatus };
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    const element = host.current;
    if (element === null) {
      return;
    }

    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: false,
      theme: terminalTheme(document.documentElement.dataset.theme === "dark"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    fit.fit();

    const socket = new WebSocket(
      socketUrl({ project, service, task, target: JSON.parse(targetKey) }, term.cols, term.rows),
    );
    socket.binaryType = "arraybuffer";
    let ended = false;
    let opened = false;
    let disposed = false;

    const sendControl = (frame: TerminalClientFrame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    };

    let pending = 0;
    let paused = false;
    const showOutput = (data: Uint8Array) => {
      pending += data.length;
      if (!paused && pending > HIGH_WATER_BYTES) {
        paused = true;
        sendControl({ t: "pause" });
      }
      term.write(data, () => {
        pending -= data.length;
        if (paused && pending < LOW_WATER_BYTES) {
          paused = false;
          sendControl({ t: "resume" });
        }
      });
    };

    const say = (text: string) => term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);

    socket.addEventListener("open", () => {
      opened = true;
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        showOutput(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const frame = terminalServerFrame.safeParse(value).data;
      if (frame === undefined) {
        return;
      }
      switch (frame.t) {
        case "ready":
          latest.current.onStatus("connected");
          term.focus();
          break;
        case "exit":
          ended = true;
          say(latest.current.messages.ended(frame.code));
          break;
        case "error":
          ended = true;
          term.write(`\r\n\x1b[31m${frame.message}\x1b[0m\r\n`);
          break;
      }
    });

    socket.addEventListener("close", () => {
      if (disposed) {
        return;
      }
      latest.current.onStatus("ended");
      if (!ended) {
        say(opened ? latest.current.messages.lost : latest.current.messages.refused);
      }
    });

    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        for (const chunk of inputChunks(data)) {
          socket.send(chunk);
        }
      }
    });
    const resize = term.onResize(({ cols, rows }) => sendControl({ t: "resize", cols, rows }));

    const observer = new ResizeObserver(() => {
      // The element is measured while it may be mid-transition: a failed fit only means "not yet".
      try {
        fit.fit();
      } catch {
        // Measured again on the next change.
      }
    });
    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.close();
      term.dispose();
      terminal.current = null;
    };
  }, [project, service, task, targetKey]);

  useEffect(() => {
    if (terminal.current !== null) {
      terminal.current.options.theme = terminalTheme(theme === "dark");
    }
  }, [theme]);

  return <div ref={host} className="h-full w-full" data-testid="terminal" />;
}
