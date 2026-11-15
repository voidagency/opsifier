import type { StudioConversationStatus, StudioEvent } from "@opsifier/contract";

/** Long enough for a command or a path, short enough for one line. */
const MAX_DETAIL_CHARS = 300;

type Raw = Record<string, unknown>;
type Verb = Extract<StudioEvent, { kind: "action" }>["verb"];

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS - 1)}…` : oneLine;
}

/** The block the agent ends its answers with, as the Studio asks it to. */
const SUGGESTIONS = /<suggestions>([\s\S]*?)(?:<\/suggestions>|$)/i;
const MAX_SUGGESTIONS = 4;

/** An agent's message without its suggestions block, and the suggestions, one per line. */
export function splitSuggestions(message: string): { text: string; suggestions: string[] } {
  const match = SUGGESTIONS.exec(message);
  if (match === null) {
    return { text: message, suggestions: [] };
  }
  const suggestions = (match[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "")
    .slice(0, MAX_SUGGESTIONS)
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}\u2026` : line));
  const text = `${message.slice(0, match.index)}${message.slice(match.index + match[0].length)}`.trim();
  return { text, suggestions };
}

/** The text and the images of an LLM message, whichever way its content is given. */
function readContent(message: unknown): { text: string; images: string[] } {
  if (!isRecord(message)) {
    return { text: "", images: [] };
  }
  const { content } = message;
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  const parts = Array.isArray(content) ? content.filter(isRecord) : [];
  const texts = parts.filter((part) => part.type === "text").map((part) => text(part.text) ?? "");
  const images = parts
    .filter((part) => part.type === "image")
    .flatMap((part) => (Array.isArray(part.image_urls) ? part.image_urls : []))
    .filter((url): url is string => typeof url === "string");
  return { text: texts.join("\n\n").trim(), images };
}

/** What kind of thing a tool call does, from its tool and, for the file editor, its command. */
function verbOf(tool: string, action: Raw): Verb {
  if (tool === "terminal" || tool === "execute_bash" || tool === "bash") {
    return "command";
  }
  if (tool === "file_editor" || tool === "str_replace_editor") {
    const command = text(action.command);
    return command === "view" ? "read" : command === "create" ? "create" : "edit";
  }
  if (tool === "browser_navigate") {
    return "browse";
  }
  if (tool.startsWith("browser")) {
    return "look";
  }
  if (tool === "grep" || tool === "glob" || tool === "find") {
    return "search";
  }
  if (tool === "task_tracker") {
    return "plan";
  }
  return "other";
}

const PLAIN: Record<Verb, string> = {
  command: "Ran a command",
  read: "Read a file",
  edit: "Edited a file",
  create: "Created a file",
  browse: "Opened a page",
  look: "Looked at the page",
  search: "Searched the code",
  plan: "Updated its plan",
  other: "Used a tool",
};

/**
 * The agent's own words for an action. A model that gives none gets the tool call written out in their
 * place, `terminal: {"command": …}`, which is no description.
 */
function ownSummary(tool: string, summary: unknown): string | null {
  const value = text(summary)?.trim() ?? "";
  if (value === "" || value.startsWith(`${tool}:`) || value.startsWith("{") || value.includes('{"')) {
    return null;
  }
  return value;
}

const TASK_STATUSES = new Set(["todo", "in_progress", "done"]);

/** The agent's plan, as the task tracker gives it. */
function readTasks(action: Raw): Extract<StudioEvent, { kind: "action" }>["tasks"] {
  if (!Array.isArray(action.task_list)) {
    return null;
  }
  return action.task_list.filter(isRecord).flatMap((task) => {
    const title = text(task.title)?.trim();
    const status = text(task.status);
    return title === undefined || title === "" || status === null || !TASK_STATUSES.has(status)
      ? []
      : [{ title, status: status as "todo" | "in_progress" | "done" }];
  });
}

/** What the agent wrote alongside a tool call, whether as text parts or as one string. */
function readThought(value: unknown): string | null {
  const words = Array.isArray(value)
    ? value
        .filter(isRecord)
        .filter((part) => part.type === undefined || part.type === "text")
        .map((part) => text(part.text) ?? "")
        .join(" ")
    : (text(value) ?? "");
  const trimmed = words.trim();
  return trimmed === "" ? null : trimmed;
}

function actionDetail(action: Raw, workspaceDir: string | undefined): string | null {
  const path = text(action.path);
  if (path !== null) {
    const inside = workspaceDir !== undefined && path.startsWith(`${workspaceDir.replace(/\/+$/, "")}/`);
    return shorten(inside ? path.slice(workspaceDir.replace(/\/+$/, "").length + 1) : path);
  }
  const value = text(action.command) ?? text(action.url);
  return value === null ? null : shorten(value);
}

function toEvent(raw: Raw, workspaceDir: string | undefined): StudioEvent | null {
  const id = text(raw.id);
  const timestamp = text(raw.timestamp);
  if (id === null || timestamp === null) {
    return null;
  }
  switch (raw.kind) {
    case "MessageEvent": {
      if (raw.source !== "user" && raw.source !== "agent") {
        return null;
      }
      const content = readContent(raw.llm_message);
      if (content.text === "" && content.images.length === 0) {
        return null;
      }
      if (raw.source === "agent") {
        const split = splitSuggestions(content.text);
        return { kind: "message", id, timestamp, role: "agent", ...split, images: content.images };
      }
      return { kind: "message", id, timestamp, role: "user", ...content, suggestions: [] };
    }
    case "ActionEvent": {
      const tool = text(raw.tool_name) ?? "tool";
      const action = isRecord(raw.action) ? raw.action : {};
      // The agent's last word comes as a tool call: it is a message, not an action.
      if (tool === "finish") {
        const message = text(action.message);
        return message === null || message.trim() === ""
          ? null
          : {
              kind: "message",
              id,
              timestamp,
              role: "agent",
              ...splitSuggestions(message.trim()),
              images: [],
            };
      }
      if (tool === "think") {
        return null;
      }
      const verb = verbOf(tool, action);
      const own = ownSummary(tool, raw.summary);
      return {
        kind: "action",
        id,
        timestamp,
        tool,
        verb,
        summary: shorten(own ?? PLAIN[verb]),
        described: own !== null,
        detail: actionDetail(action, workspaceDir),
        thought: readThought(raw.thought),
        tasks: verb === "plan" ? readTasks(action) : null,
      };
    }
    case "AgentErrorEvent":
    case "ConversationErrorEvent": {
      const message = text(raw.error) ?? text(raw.detail) ?? "The agent stopped on an error.";
      return { kind: "error", id, timestamp, text: shorten(message) };
    }
    default:
      return null;
  }
}

/** The events a person reads, in the order the agent server gave them. */
export function toStudioEvents(raws: readonly unknown[], workspaceDir?: string): StudioEvent[] {
  return raws.filter(isRecord).flatMap((raw) => {
    const event = toEvent(raw, workspaceDir);
    return event === null ? [] : [event];
  });
}

const STATUSES: Record<string, StudioConversationStatus> = {
  idle: "idle",
  running: "running",
  paused: "paused",
  waiting_for_confirmation: "waiting",
  finished: "finished",
  error: "error",
  stuck: "stuck",
};

export function toStudioStatus(value: unknown): StudioConversationStatus {
  return (typeof value === "string" && STATUSES[value]) || "unknown";
}
