import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectLeftovers } from "./e2e-inventory";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SANDBOX_SCRIPT = join(ROOT, "scripts", "sandbox.sh");

/** A `docker` for a test: what it prints is decided here, and nothing reaches a real daemon. */
function fakeDocker(directory: string, script: string): string {
  const file = join(directory, "docker");
  writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(file, 0o755);
  return directory;
}

describe("removing the sandbox", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "opsifier-cleanup-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const down = (dockerScript: string) =>
    spawnSync("bash", [SANDBOX_SCRIPT, "down"], {
      encoding: "utf8",
      env: {
        PATH: `${fakeDocker(join(directory), dockerScript)}:${process.env.PATH ?? ""}`,
        OPSIFIER_SANDBOX_NAME: "opsifier-test-sandbox",
        OPSIFIER_SANDBOX_DATA_DIR: join(directory, "data"),
      },
    });

  it("says so when everything is gone", () => {
    const result = down('[ "$1 $2" = "ps -aq" ] && exit 0; exit 0');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Sandbox removed.");
    expect(existsSync(join(directory, "data"))).toBe(false);
  });

  it("fails loudly when the container is still there afterwards", () => {
    const result = down('case "$1" in ps) echo abc123 ;; rm) exit 0 ;; esac');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still there");
    expect(result.stderr).not.toContain("Sandbox removed.");
  });
});

describe("what is left of a project on a daemon", () => {
  const daemon =
    (outputs: Record<string, string>) =>
    (...args: string[]) =>
      outputs[args.slice(0, 2).join(" ")] ?? "";

  it("finds what is named after it, of every kind", () => {
    const docker = daemon({
      "service ls": "shop_web\nother_web\n",
      "ps --all": "shop_web.1.abc\nshop_stack-cache-1\nother_web.1.def\n",
      "volume ls": "shop_web_data\nother_web_data\n",
      "network ls": "opsifier-shop\nopsifier-other\nbridge\n",
    });

    expect(projectLeftovers(docker, "shop")).toEqual([
      "service shop_web",
      "container shop_web.1.abc",
      "container shop_stack-cache-1",
      "volume shop_web_data",
      "network opsifier-shop",
    ]);
  });

  it("is empty when the project's cleanup worked", () => {
    expect(projectLeftovers(daemon({ "service ls": "other_web\n" }), "shop")).toEqual([]);
  });
});

describe("how the tests clean up", () => {
  function sources(directory: string, wanted: RegExp): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules") {
        return [];
      }
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sources(path, wanted) : wanted.test(entry.name) ? [path] : [];
    });
  }

  it("never prunes a whole daemon, in a script or in anything that talks to one", () => {
    const candidates = [
      ...sources(join(ROOT, "scripts"), /\.sh$/),
      ...sources(join(ROOT, "apps", "server", "src"), /\.e2e\.test\.ts$/),
      ...sources(join(ROOT, "apps", "server", "src", "testing"), /\.ts$/).filter(
        (file) => !file.endsWith("cleanup.test.ts"),
      ),
    ];

    const offenders = candidates.filter((file) =>
      /\b(?:system|image|volume|container|network|builder)["'\s,]+prune\b/.test(readFileSync(file, "utf8")),
    );

    expect(candidates.length).toBeGreaterThan(2);
    expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
  });
});
