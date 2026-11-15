import type { StudioEvent } from "@opsifier/contract";

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
