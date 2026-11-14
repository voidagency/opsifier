import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";

let panel: LivePanel;
let key: string;
let scratch: string;

beforeAll(async () => {
  panel = await startLivePanel();
  key = (await panel.createKey({ name: "completion", level: "read" })).token;
  scratch = await mkdtemp(join(tmpdir(), "opsifier-completion-"));
});

afterAll(async () => {
  await panel.close();
  await rm(scratch, { recursive: true, force: true });
});

async function run(argv: string[], overrides: Partial<CliRuntime> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    signal: new AbortController().signal,
    cwd: scratch,
    credentialsFile: join(scratch, "no-credentials.json"),
    ...overrides,
  });
  return { code, stdout, stderr };
}

const has = (shell: string) => spawnSync(shell, ["-c", "true"]).error === undefined;

/** What bash offers after these words, with `opsifier` standing in for the real command line. */
function bashOffers(script: string, words: string[]): string[] {
  const program = [
    script,
    'opsifier() { [ "$1" = "__targets" ] && printf "shop/web\\nsecret/web\\n"; }',
    `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})`,
    `COMP_CWORD=${words.length - 1}`,
    "_opsifier",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash expansion, run by bash
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
  return result.stdout.split("\n").filter((line) => line !== "");
}

describe.skipIf(!has("bash"))("bash completion", () => {
  let script: string;

  beforeAll(async () => {
    script = (await run(["completion", "bash"], { env: {} })).stdout;
  });

  it("is a valid script, printed without a panel", async () => {
    const file = join(scratch, "opsifier.bash");
    await writeFile(file, script);

    expect(spawnSync("bash", ["-n", file]).status).toBe(0);
  });

  it("completes commands, their flags and their first words", () => {
    expect(bashOffers(script, ["opsifier", "con"])).toEqual(["config"]);
    expect(bashOffers(script, ["opsifier", "config", "--pro"])).toEqual(["--project"]);
    expect(bashOffers(script, ["opsifier", "config", "un"])).toEqual(["unset"]);
    // There, a service is as good as a first word: opsifier config secret/web lists its names.
    expect(bashOffers(script, ["opsifier", "config", "se"])).toEqual(["set", "secret/web"]);
    expect(bashOffers(script, ["opsifier", "deploy", "--"])).toContain("--wait");
  });

  it("completes services with what the panel lists", () => {
    expect(bashOffers(script, ["opsifier", "logs", "sh"])).toEqual(["shop/web"]);
    expect(bashOffers(script, ["opsifier", "config", "set", "se"])).toEqual(["secret/web"]);
  });

  it("never offers the command that only serves it", () => {
    expect(bashOffers(script, ["opsifier", "__"])).toEqual([]);
  });
});

describe.skipIf(!has("zsh"))("zsh completion", () => {
  it("is a valid script", async () => {
    const file = join(scratch, "opsifier.zsh");
    await writeFile(file, (await run(["completion", "zsh"], { env: {} })).stdout);

    expect(spawnSync("zsh", ["-n", file]).status).toBe(0);
  });
});

describe.skipIf(!has("fish"))("fish completion", () => {
  it("is a valid script", async () => {
    const file = join(scratch, "opsifier.fish");
    await writeFile(file, (await run(["completion", "fish"], { env: {} })).stdout);

    expect(spawnSync("fish", ["-n", file]).status).toBe(0);
  });
});

describe("completion", () => {
  it("lists every service, one per line, whatever stdout is", async () => {
    const result = await run(["__targets"]);

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean).sort()).toEqual(["secret/web", "shop/web"]);
  });

  it("refuses a shell it has no script for", async () => {
    expect((await run(["completion", "powershell"], { env: {} })).code).toBe(2);
  });

  it("stays out of the general help", async () => {
    const help = await run(["--help"], { env: {} });

    expect(help.stdout).toContain("completion");
    expect(help.stdout).not.toContain("__targets");
  });

  it("has a description in every language for each command it offers", async () => {
    const fish = await run(["completion", "fish"], { env: { LANG: "fr_FR.UTF-8" } });

    expect(fish.stdout).toContain("Afficher le script de complétion");
    expect(fish.stdout).not.toContain("{");
  });
});
