import { describe, expect, it } from "vitest";
import { sshPaths } from "./ssh";

describe("the SSH keys a build forwards", () => {
  it.each([
    ["an agent", "default", []],
    ["agents in a list", ["default", "other"], []],
    ["a key", ["deploy=./keys/id"], ["./keys/id"]],
    ["keys split at commas, and whole", "deploy=./a,./b", ["./a,./b", "./a", "./b"]],
    ["a mapping, an agent in it", { deploy: "./keys/id", agent: null }, ["./keys/id"]],
    ["a key as Compose writes it back", ["deploy: /keys/id"], ["/keys/id"]],
    ["an id and a path, both", [{ id: "deploy", path: "/keys/id" }], ["deploy", "/keys/id"]],
    ["a variable, which could become any of them", ["$SPEC"], ["$SPEC"]],
    ["a variable after the id", ["deploy=$KEY"], ["deploy=$KEY", "$KEY"]],
  ])("reads %s", (_label, value, paths) => {
    expect(sshPaths(value)).toEqual(paths);
  });

  it.each([
    ["a number", [1]],
    ["a list inside a mapping", { deploy: ["./keys/id"] }],
    ["a boolean", true],
  ])("can't read %s, which is refused", (_label, value) => {
    expect(sshPaths(value)).toBeNull();
  });
});
