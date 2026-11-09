import { describe, expect, it } from "vitest";
import {
  countStates,
  overallState,
  problemCount,
  stateFromAction,
  stateFromLamp,
  stateFromOutcome,
  stateFromService,
  stateLanguage,
  visualStates,
} from "./state";
import { visualStrings } from "./strings";

const definitions = visualStates.map((state) => stateLanguage[state]);

describe("the state language", () => {
  it("covers the six states", () => {
    expect([...visualStates].sort()).toEqual(
      ["degraded", "failed", "progress", "running", "stopped", "unknown"].sort(),
    );
    expect(Object.keys(stateLanguage).sort()).toEqual([...visualStates].sort());
  });

  it("never lets colour carry a state alone: each state has its own shape", () => {
    expect(new Set(definitions.map((definition) => definition.shape)).size).toBe(visualStates.length);
  });

  it("gives each state its own colour and label", () => {
    expect(new Set(definitions.map((definition) => definition.color)).size).toBe(visualStates.length);
    expect(new Set(definitions.map((definition) => definition.labelKey)).size).toBe(visualStates.length);
  });

  it("names each state in both languages", () => {
    for (const state of visualStates) {
      expect(visualStrings.en.state[state]).toBeTruthy();
      expect(visualStrings.fr.state[state]).toBeTruthy();
    }
  });

  it("keeps every label short", () => {
    for (const language of [visualStrings.en, visualStrings.fr]) {
      for (const label of Object.values(language.state)) {
        expect(label.split(" ").length).toBeLessThanOrEqual(2);
      }
    }
  });

  it("reads problems first", () => {
    const flags = visualStates.map((state) => stateLanguage[state].problem);
    expect(flags).toEqual([true, true, true, false, false, false]);
    expect(visualStates[0]).toBe("failed");
  });

  it("only moves what needs attention, and only in progress runs on", () => {
    expect(stateLanguage.running.motion).toBe("none");
    expect(stateLanguage.stopped.motion).toBe("none");
    expect(stateLanguage.unknown.motion).toBe("none");
    expect(stateLanguage.progress.motion).toBe("turn");
    expect(stateLanguage.failed.motion).toBe("alarm");
    expect(stateLanguage.degraded.motion).toBe("breathe");
  });
});

describe("mapping domain statuses to states", () => {
  it("maps the existing lamp statuses", () => {
    expect(stateFromLamp("ok")).toBe("running");
    expect(stateFromLamp("busy")).toBe("progress");
    expect(stateFromLamp("off")).toBe("stopped");
    expect(stateFromLamp("bad")).toBe("failed");
  });

  it("maps service statuses", () => {
    expect(stateFromService({ status: "running" })).toBe("running");
    expect(stateFromService({ status: "starting" })).toBe("progress");
    expect(stateFromService({ status: "stopped" })).toBe("stopped");
    expect(stateFromService({ status: "undeployed" })).toBe("stopped");
    expect(stateFromService({ status: "unknown" })).toBe("unknown");
  });

  it("calls a failing service degraded while some of its tasks are still up", () => {
    expect(stateFromService({ status: "failing", replicas: { running: 1, desired: 3 } })).toBe("degraded");
    expect(stateFromService({ status: "failing", replicas: { running: 0, desired: 3 } })).toBe("failed");
    expect(stateFromService({ status: "failing" })).toBe("failed");
  });

  it("lets work in progress win over everything else, as the existing lamp does", () => {
    expect(stateFromService({ status: "running", activeAction: { id: "a", type: "deploy" } })).toBe(
      "progress",
    );
    expect(stateFromService({ status: "failing", activeAction: { id: "a", type: "deploy" } })).toBe(
      "progress",
    );
    expect(stateFromService({ status: "running", activeAction: null })).toBe("running");
  });

  it("says so when nobody can vouch for what a service is running", () => {
    expect(stateFromService({ status: "running", runtimeUncertain: "interrupted" })).toBe("unknown");
    expect(stateFromService({ status: "running", runtimeUncertain: null })).toBe("running");
    // A deployment settling it is what is happening.
    expect(
      stateFromService({ status: "running", runtimeUncertain: "interrupted", activeAction: { id: "a" } }),
    ).toBe("progress");
  });

  it("maps actions and deployment outcomes", () => {
    expect(stateFromAction("queued")).toBe("progress");
    expect(stateFromAction("running")).toBe("progress");
    expect(stateFromAction("succeeded")).toBe("running");
    expect(stateFromAction("failed")).toBe("failed");
    expect(stateFromAction("cancelled")).toBe("stopped");
    expect(stateFromOutcome("succeeded")).toBe("running");
    expect(stateFromOutcome("failed")).toBe("failed");
    expect(stateFromOutcome("running")).toBe("progress");
    expect(stateFromOutcome("cancelled")).toBe("stopped");
  });
});

describe("counting", () => {
  it("counts states and problems", () => {
    const counts = countStates(["running", "running", "failed", "unknown", "stopped"]);
    expect(counts).toEqual({ running: 2, failed: 1, unknown: 1, stopped: 1 });
    expect(problemCount(counts)).toBe(2);
  });

  it("takes the worst state as the overall state", () => {
    expect(overallState({ running: 3, failed: 1 })).toBe("failed");
    expect(overallState({ running: 3, stopped: 1 })).toBe("running");
    expect(overallState({ stopped: 4 })).toBe("stopped");
    expect(overallState({})).toBeNull();
    expect(overallState({ failed: 0, degraded: 0 })).toBeNull();
  });
});
