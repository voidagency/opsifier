import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config";
import { lockDataDirectory } from "./data-lock";

let dataDir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-lock-"));
});

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Another real process holding the real lock, until it is told otherwise or killed. */
async function holdFromAnotherProcess(): Promise<ChildProcess> {
  const script = `
    import { lockDataDirectory } from ${JSON.stringify(join(import.meta.dirname, "data-lock.ts"))};
    lockDataDirectory(${JSON.stringify(dataDir)});
    process.stdout.write("held\\n");
    setInterval(() => {}, 1000);
  `;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: join(import.meta.dirname, "../../.."),
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = holder;
  await new Promise<void>((resolve, reject) => {
    holder.stdout?.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`The holder exited early with ${code}`)));
  });
  return holder;
}

describe("the lock on the data directory", () => {
  it("creates its own folder when the directory is new", () => {
    const nested = join(dataDir, "not", "yet");
    const release = lockDataDirectory(nested);

    expect(existsSync(join(nested, "panel.lock"))).toBe(true);
    release();
  });

  it("refuses a second panel, and says which directory and what to do", () => {
    const release = lockDataDirectory(dataDir);

    expect(() => lockDataDirectory(dataDir)).toThrow(ConfigError);
    expect(() => lockDataDirectory(dataDir)).toThrow(dataDir);
    expect(() => lockDataDirectory(dataDir)).toThrow(/stop the other|OPSIFIER_DATA_DIR/);
    release();
  });

  it("is free again once released, so a restart in the same process works", () => {
    lockDataDirectory(dataDir)();

    expect(() => lockDataDirectory(dataDir)()).not.toThrow();
  });

  it("stops a panel in another process, and the kernel frees it if that process is killed", async () => {
    const holder = await holdFromAnotherProcess();

    expect(() => lockDataDirectory(dataDir)).toThrow(ConfigError);

    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));

    const release = lockDataDirectory(dataDir);
    release();
  }, 30_000);
});
