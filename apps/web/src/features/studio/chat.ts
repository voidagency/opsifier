import type { StudioEvent, StudioVersion } from "@opsifier/contract";

export type StudioMessageEvent = Extract<StudioEvent, { kind: "message" }>;
export type StudioActionEvent = Extract<StudioEvent, { kind: "action" }>;
export type StudioErrorEvent = Extract<StudioEvent, { kind: "error" }>;

/**
 * What a conversation shows, in order: the messages and errors, and between them the agent's steps,
 * gathered in one group for each stretch of work, so that an answer can fold the work behind it.
 */
export type ChatItem =
  | { kind: "message"; event: StudioMessageEvent }
  | { kind: "error"; event: StudioErrorEvent }
  | { kind: "work"; id: string; steps: StudioActionEvent[] };

export function toChatItems(events: readonly StudioEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let steps: StudioActionEvent[] | null = null;
  for (const event of events) {
    if (event.kind === "action") {
      if (steps === null) {
        steps = [];
        items.push({ kind: "work", id: event.id, steps });
      }
      steps.push(event);
      continue;
    }
    steps = null;
    items.push(event.kind === "message" ? { kind: "message", event } : { kind: "error", event });
  }
  return items;
}

/** The files a stretch of work changed or created, each once. */
export function changedFiles(steps: readonly StudioActionEvent[]): string[] {
  const files = new Set<string>();
  for (const step of steps) {
    if ((step.verb === "edit" || step.verb === "create") && step.detail !== null) {
      files.add(step.detail);
    }
  }
  return [...files];
}

/** How many messages the person sent, to tell when the one being sent has arrived. */
export function userMessageCount(events: readonly StudioEvent[]): number {
  return events.filter((event) => event.kind === "message" && event.role === "user").length;
}

/**
 * The time of an event, in milliseconds. The agent server writes it without a zone, in UTC, where it
 * keeps its clock, and to the microsecond, which a browser does not read.
 */
export function eventTime(timestamp: string): number {
  const trimmed = timestamp.trim().replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`);
}

/**
 * The version each of the agent's answers saved, by the answer's id: the last commit made between the
 * request it answers and the answer. An answer that saved nothing has none, and a commit goes with one
 * answer only.
 */
export function versionsByAnswer(
  items: readonly ChatItem[],
  versions: readonly StudioVersion[],
): Map<string, StudioVersion> {
  const commits = versions
    .map((version) => ({ version, at: Date.parse(version.at) }))
    .filter((commit) => !Number.isNaN(commit.at))
    .sort((a, b) => a.at - b.at);
  const byAnswer = new Map<string, StudioVersion>();
  let since: number | null = null;
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    const time = eventTime(item.event.timestamp);
    if (Number.isNaN(time)) {
      continue;
    }
    if (item.event.role === "user") {
      // A commit's time is to the second: one made in the second of the request answers it.
      since = Math.floor(time / 1000) * 1000;
      continue;
    }
    if (since === null) {
      continue;
    }
    let saved: StudioVersion | null = null;
    for (const commit of commits) {
      if (commit.at >= since && commit.at <= time) {
        saved = commit.version;
      }
    }
    if (saved !== null) {
      byAnswer.set(item.event.id, saved);
      // A later answer to the same request shows only what it saved itself.
      since = time + 1;
    }
  }
  return byAnswer;
}

/** Why the agent stopped, when a new conversation is the cure: what the conversation then advises. */
export type AgentStop = "timeout" | "context";

/**
 * Reads an error the agent stopped on for the stops a new conversation cures: a conversation longer
 * than the model can read, and the model answering too slowly, which a long conversation makes more
 * likely. Anything else is shown as it came.
 */
export function agentStopOf(text: string): AgentStop | null {
  if (/context ?window|context length|maximum context|too many tokens|prompt is too long/i.test(text)) {
    return "context";
  }
  if (/litellm\.Timeout|APITimeoutError|timed out|timeout after|hard timeout/i.test(text)) {
    return "timeout";
  }
  return null;
}
