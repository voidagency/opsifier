import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeed, SEED_READ_SCRIPT } from "./agents";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "opsifier-seed-"));
  mkdirSync(join(state, "agent-profiles"));
  mkdirSync(join(state, "agent-canvas"));
  writeFileSync(
    join(state, "settings.json"),
    JSON.stringify({
      llm: { model: "openai/Qwen", base_url: "http://100.89.0.1:8000/v1" },
      agent_settings: {
        agent_context: { system_message_suffix: "Previews are at http://<folder>-preview." },
      },
    }),
  );
  writeFileSync(
    join(state, "agent-profiles", "default.json"),
    JSON.stringify({
      name: "default",
      system_message_suffix: "Click « Démarrer » in the panel.",
      user_message_suffix: "x",
    }),
  );
  writeFileSync(join(state, "agent-canvas", "secret-key.txt"), "not json");
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

/** The files of a packed copy, read back from its tar archive. */
function filesOf(archive: string): Record<string, string> {
  const tar = gunzipSync(Buffer.from(archive, "base64"));
  const files: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/s, "");
    if (name === "") {
      break;
    }
    const size = Number.parseInt(
      tar
        .subarray(offset + 124, offset + 136)
        .toString()
        .trim(),
      8,
    );
    files[name] = tar.subarray(offset + 512, offset + 512 + size).toString();
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const pack = () =>
  spawnSync("python3", ["-c", SEED_READ_SCRIPT], {
    input: JSON.stringify({
      state,
      files: ["settings.json", "agent-profiles", "agent-canvas/secret-key.txt"],
    }),
    encoding: "utf8",
  });

describe.skipIf(!hasPython)("the copy of the model's settings for a project's agent server", () => {
  it("keeps the model's settings and key, and leaves its standing instructions out", () => {
    const run = pack();
    expect(run.status).toBe(0);
    const seed = readSeed(run.stdout);
    expect(seed).not.toBeNull();
    const files = filesOf(seed?.archive ?? "");

    const settings = JSON.parse(files["settings.json"] ?? "{}");
    expect(settings.llm).toEqual({ model: "openai/Qwen", base_url: "http://100.89.0.1:8000/v1" });
    expect(settings.agent_settings.agent_context).toEqual({});
    const profile = JSON.parse(files["agent-profiles/default.json"] ?? "{}");
    expect(profile).toEqual({ name: "default" });
    expect(files["agent-canvas/secret-key.txt"]).toBe("not json");
  });

  it("gives the same digest for the same settings, so a copy is only written again when they change", () => {
    const first = readSeed(pack().stdout)?.digest;
    expect(readSeed(pack().stdout)?.digest).toBe(first);
    writeFileSync(join(state, "settings.json"), JSON.stringify({ llm: { model: "another" } }));
    expect(readSeed(pack().stdout)?.digest).not.toBe(first);
  });
});
