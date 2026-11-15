import type { StudioConversationStatus, StudioEvent } from "@opsifier/contract";

/** Long enough for a command or a path, short enough for one line. */
const MAX_DETAIL_CHARS = 300;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_CHARS ? `${oneLine.slice(0, MAX_DETAIL_CHARS - 1)}…` : oneLine;
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

/** What a tool call is about, when its summary does not say. */
const TOOL_SUMMARIES: Record<string, string> = {
  terminal: "Ran a command",
  file_editor: "Edited a file",
  str_replace_editor: "Edited a file",
  browser_navigate: "Opened a page",
  task_tracker: "Updated its plan",
};

function actionDetail(action: unknown): string | null {
  if (!isRecord(action)) {
    return null;
  }
  const value = text(action.command) ?? text(action.path) ?? text(action.url);
  return value === null ? null : shorten(value);
}

function toEvent(raw: Raw): StudioEvent | null {
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
      return { kind: "message", id, timestamp, role: raw.source, ...content };
    }
    case "ActionEvent": {
      const tool = text(raw.tool_name) ?? "tool";
      const action = isRecord(raw.action) ? raw.action : {};
      // The agent's last word comes as a tool call: it is a message, not an action.
      if (tool === "finish") {
        const message = text(action.message);
        return message === null || message.trim() === ""
          ? null
          : { kind: "message", id, timestamp, role: "agent", text: message.trim(), images: [] };
      }
      if (tool === "think") {
        return null;
      }
      const summary = text(raw.summary)?.trim() || TOOL_SUMMARIES[tool] || `Used ${tool}`;
      return { kind: "action", id, timestamp, tool, summary: shorten(summary), detail: actionDetail(action) };
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
export function toStudioEvents(raws: readonly unknown[]): StudioEvent[] {
  return raws.filter(isRecord).flatMap((raw) => {
    const event = toEvent(raw);
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
