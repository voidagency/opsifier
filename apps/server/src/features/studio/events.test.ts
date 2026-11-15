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

  it("gives each action one line: what it does, the agent's own words when it gave some, and what it acted on", () => {
    const long = `bun run build && ${"x".repeat(400)}`;
    const [own, raw, read, browse, search] = toStudioEvents(
      [
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
          tool_name: "terminal",
          summary: 'terminal: {"command": "ls src"}',
          action: { command: "ls src" },
        },
        {
          ...base("3"),
          kind: "ActionEvent",
          tool_name: "file_editor",
          action: { command: "view", path: "/projects/cd-studio/src/components/Header.tsx" },
        },
        {
          ...base("4"),
          kind: "ActionEvent",
          tool_name: "browser_navigate",
          action: { url: "http://cd-studio-preview" },
        },
        { ...base("5"), kind: "ActionEvent", tool_name: "glob", action: {} },
      ],
      "/projects/cd-studio",
    );

    expect(own).toMatchObject({ verb: "command", summary: "Builds the project", described: true });
    expect(own?.kind === "action" ? own.detail?.length : 0).toBe(300);
    // A model that gives no summary gets the tool call written out instead: that is no description.
    expect(raw).toMatchObject({
      verb: "command",
      summary: "Ran a command",
      described: false,
      detail: "ls src",
    });
    expect(read).toMatchObject({ verb: "read", described: false, detail: "src/components/Header.tsx" });
    expect(browse).toMatchObject({ verb: "browse", detail: "http://cd-studio-preview" });
    expect(search).toMatchObject({ verb: "search", summary: "Searched the code", detail: null });
  });

  it("keeps what the agent wrote as it took a step, and its plan", () => {
    const [step] = toStudioEvents([
      {
        ...base("1"),
        kind: "ActionEvent",
        tool_name: "task_tracker",
        thought: [
          { type: "text", text: "Je planifie." },
          { type: "text", text: " Ensuite je modifie." },
        ],
        action: {
          command: "plan",
          task_list: [
            { title: "Trouver le menu", status: "done" },
            { title: "Arrondir", status: "in_progress" },
            { title: "", status: "todo" },
            { title: "Inconnu", status: "later" },
          ],
        },
      },
    ]);

    expect(step).toMatchObject({
      verb: "plan",
      thought: "Je planifie.  Ensuite je modifie.",
      tasks: [
        { title: "Trouver le menu", status: "done" },
        { title: "Arrondir", status: "in_progress" },
      ],
    });
  });

  it("tells a file the agent creates from one it edits", () => {
    const [created, edited] = toStudioEvents([
      {
        ...base("1"),
        kind: "ActionEvent",
        tool_name: "file_editor",
        action: { command: "create", path: "/tmp/a" },
      },
      {
        ...base("2"),
        kind: "ActionEvent",
        tool_name: "file_editor",
        action: { command: "str_replace", path: "/tmp/a" },
      },
    ]);

    expect(created).toMatchObject({ verb: "create", detail: "/tmp/a" });
    expect(edited).toMatchObject({ verb: "edit" });
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
