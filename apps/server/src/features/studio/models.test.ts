import { describe, expect, it } from "vitest";
import { conversationModel, isPrivateHost, toStudioModel, toStudioModels } from "./models";

const PROFILES = {
  active_profile: "qwen-rtx",
  profiles: [
    { name: "qwen-rtx", model: "openai/Qwen/Qwen3.6-27B", base_url: "http://100.89.0.1:8000/v1" },
    { name: "cloud", model: "anthropic/claude-sonnet-4-5", base_url: null },
    { name: "broken" },
  ],
};

describe("isPrivateHost", () => {
  it.each([
    ["100.89.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.5", true],
    ["192.168.1.10", true],
    ["127.0.0.1", true],
    ["localhost", true],
    ["vllm", true],
    ["models.internal", true],
    ["::1", true],
    ["fd12::1", true],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["8.8.8.8", false],
    ["api.openai.com", false],
    [null, false],
  ])("%s is private: %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe("the Studio's models", () => {
  it("names a model plainly and says where it runs", () => {
    expect(toStudioModel("qwen-rtx", "openai/Qwen/Qwen3.6-27B", "http://100.89.0.1:8000/v1")).toEqual({
      profile: "qwen-rtx",
      name: "Qwen3.6-27B",
      host: "100.89.0.1",
      private: true,
    });
    expect(toStudioModel(null, "gpt-5", "https://api.openai.com/v1")).toMatchObject({
      host: "api.openai.com",
      private: false,
    });
    expect(toStudioModel(null, "claude", null)).toMatchObject({ host: null, private: false });
  });

  it("lists the agent server's profiles, and leaves out one it cannot name", () => {
    expect(toStudioModels(PROFILES)).toEqual({
      active: "qwen-rtx",
      models: [
        { profile: "qwen-rtx", name: "Qwen3.6-27B", host: "100.89.0.1", private: true },
        { profile: "cloud", name: "claude-sonnet-4-5", host: null, private: false },
      ],
    });
    expect(toStudioModels("not an answer")).toEqual({ active: null, models: [] });
  });

  it("knows a conversation's model by the profile it matches", () => {
    expect(
      conversationModel(
        { model: "openai/Qwen/Qwen3.6-27B", base_url: "http://100.89.0.1:8000/v1" },
        PROFILES,
      ),
    ).toMatchObject({
      profile: "qwen-rtx",
      private: true,
    });
    expect(
      conversationModel({ model: "openai/other", base_url: "https://example.com/v1" }, PROFILES),
    ).toMatchObject({
      profile: null,
      name: "other",
      private: false,
    });
    expect(conversationModel(null, PROFILES)).toBeNull();
  });
});
