import type { StudioEvent, StudioVersion } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { agentStopOf, eventTime, toChatItems, versionsByAnswer } from "./chat";

const said = (id: string, role: "user" | "agent", timestamp: string): StudioEvent => ({
  kind: "message",
  id,
  timestamp,
  role,
  text: id,
  images: [],
  suggestions: [],
});
const step = (id: string, timestamp: string): StudioEvent => ({
  kind: "action",
  id,
  timestamp,
  tool: "terminal",
  verb: "command",
  summary: "git commit",
  described: false,
  detail: null,
  thought: null,
  tasks: null,
});
const version = (sha: string, at: string): StudioVersion => ({ sha: sha.repeat(40), at, subject: sha });

describe("the time of an event", () => {
  it("is read in UTC when the agent server gives no zone, and to the millisecond", () => {
    expect(eventTime("2026-11-15T12:00:01.123456")).toBe(Date.UTC(2026, 10, 15, 12, 0, 1, 123));
    expect(eventTime("2026-11-15T12:00:01")).toBe(Date.UTC(2026, 10, 15, 12, 0, 1));
    expect(eventTime("2026-11-15T13:00:01+01:00")).toBe(Date.UTC(2026, 10, 15, 12, 0, 1));
    expect(eventTime("2026-11-15T12:00:01Z")).toBe(Date.UTC(2026, 10, 15, 12, 0, 1));
    expect(Number.isNaN(eventTime("hier"))).toBe(true);
  });
});

describe("the version an answer saved", () => {
  it("is the last one saved between the request and the answer", () => {
    const items = toChatItems([
      said("q1", "user", "2026-11-15T12:00:00.600"),
      said("a1", "agent", "2026-11-15T12:00:30"),
      said("q2", "user", "2026-11-15T12:01:00"),
      step("s1", "2026-11-15T12:01:10"),
      said("a2", "agent", "2026-11-15T12:02:00"),
      said("q3", "user", "2026-11-15T12:03:00"),
      said("a3", "agent", "2026-11-15T12:04:00"),
    ]);
    const saved = versionsByAnswer(items, [
      // Newest first, as listed.
      version("e", "2026-11-15T12:05:00.000Z"),
      version("d", "2026-11-15T12:01:50.000Z"),
      version("c", "2026-11-15T12:01:20.000Z"),
      // Saved in the second of the request, which a commit's time cannot tell apart.
      version("b", "2026-11-15T12:00:00.000Z"),
      version("a", "2026-11-15T11:00:00.000Z"),
    ]);
    expect(saved.get("a1")?.subject).toBe("b");
    expect(saved.get("a2")?.subject).toBe("d");
    // Nothing saved for the third, and what came after it is for a later answer.
    expect(saved.has("a3")).toBe(false);
    expect([...saved.values()].map((one) => one.subject)).not.toContain("a");
  });

  it("goes with one answer only, when a request has several", () => {
    const items = toChatItems([
      said("q1", "user", "2026-11-15T12:00:00Z"),
      said("a1", "agent", "2026-11-15T12:00:10Z"),
      said("a2", "agent", "2026-11-15T12:00:40Z"),
    ]);
    const saved = versionsByAnswer(items, [
      version("b", "2026-11-15T12:00:30.000Z"),
      version("a", "2026-11-15T12:00:05.000Z"),
    ]);
    expect(saved.get("a1")?.subject).toBe("a");
    expect(saved.get("a2")?.subject).toBe("b");

    const once = versionsByAnswer(items, [version("a", "2026-11-15T12:00:05.000Z")]);
    expect(once.get("a1")?.subject).toBe("a");
    expect(once.has("a2")).toBe(false);
  });
});

describe("an error the agent stopped on", () => {
  it("is read for the stops a new conversation cures", () => {
    expect(agentStopOf("litellm.Timeout: LLM hard timeout after 300 seconds")).toBe("timeout");
    expect(agentStopOf("litellm.APITimeoutError: Request timed out.")).toBe("timeout");
    expect(
      agentStopOf("litellm.ContextWindowExceededError: This model's maximum context length is 262144 tokens"),
    ).toBe("context");
    expect(agentStopOf("The prompt is too long for this model")).toBe("context");
    // Anything else shows as it came.
    expect(agentStopOf("litellm.APIConnectionError: Connection refused")).toBeNull();
    expect(agentStopOf("The agent stopped on an error.")).toBeNull();
  });
});
