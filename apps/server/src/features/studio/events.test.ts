import { describe, expect, it } from "vitest";
import { toStudioEvents, toStudioStatus } from "./events";

const base = (id: string) => ({ id, timestamp: "2026-11-15T12:00:00Z" });

describe("toStudioEvents", () => {
  it("keeps messages with their images, and the agent's last word given as a tool call", () => {
    expect(
      toStudioEvents([
        {
          ...base("1"),
          kind: "MessageEvent",
          source: "user",
          llm_message: {
            content: [
              { type: "text", text: "Et ça ?" },
              { type: "image", image_urls: ["data:image/png;base64,AAAA"] },
            ],
          },
        },
        { ...base("2"), kind: "MessageEvent", source: "agent", llm_message: { content: "Voilà." } },
        { ...base("3"), kind: "ActionEvent", tool_name: "finish", action: { message: " Terminé. " } },
      ]),
    ).toEqual([
      {
        ...base("1"),
        kind: "message",
        role: "user",
        text: "Et ça ?",
        images: ["data:image/png;base64,AAAA"],
      },
      { ...base("2"), kind: "message", role: "agent", text: "Voilà.", images: [] },
      { ...base("3"), kind: "message", role: "agent", text: "Terminé.", images: [] },
    ]);
  });

  it("gives each action one line: its summary, or what its tool does, and what it acted on", () => {
    const long = `bun run build && ${"x".repeat(400)}`;
    const [summarized, plain, unknown] = toStudioEvents([
      {
        ...base("1"),
        kind: "ActionEvent",
        tool_name: "terminal",
        summary: "Builds the project",
        action: { command: long },
      },
      {
        ...base("2"),
        kind: "ActionEvent",
        tool_name: "browser_navigate",
        action: { url: "http://cd-studio-preview" },
      },
      { ...base("3"), kind: "ActionEvent", tool_name: "glob", action: {} },
    ]);

    expect(summarized).toMatchObject({ kind: "action", summary: "Builds the project", tool: "terminal" });
    expect(summarized?.kind === "action" ? summarized.detail?.length : 0).toBe(300);
    expect(plain).toMatchObject({ summary: "Opened a page", detail: "http://cd-studio-preview" });
    expect(unknown).toMatchObject({ summary: "Used glob", detail: null });
  });

  it("leaves out what a person does not read, and keeps errors", () => {
    expect(
      toStudioEvents([
        { ...base("1"), kind: "SystemPromptEvent", system_prompt: "…" },
        { ...base("2"), kind: "ObservationEvent", observation: { content: "ok" } },
        { ...base("3"), kind: "ActionEvent", tool_name: "think", action: { thought: "Hmm" } },
        { ...base("4"), kind: "MessageEvent", source: "environment", llm_message: { content: "x" } },
        { ...base("5"), kind: "ConversationStateUpdateEvent", key: "execution_status", value: "running" },
        { ...base("6"), kind: "AgentErrorEvent", error: "The model did not answer." },
        { kind: "MessageEvent", source: "user" },
        "not an event",
      ]),
    ).toEqual([{ ...base("6"), kind: "error", text: "The model did not answer." }]);
  });
});

describe("toStudioStatus", () => {
  it("names the agent server's statuses, and anything else unknown", () => {
    expect(toStudioStatus("waiting_for_confirmation")).toBe("waiting");
    expect(toStudioStatus("running")).toBe("running");
    expect(toStudioStatus("deleting")).toBe("unknown");
    expect(toStudioStatus(undefined)).toBe("unknown");
  });
});
