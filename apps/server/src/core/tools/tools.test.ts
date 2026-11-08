import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, realTools, spawnTool, ToolNotFoundError, ToolTimeoutError } from ".";

const NODE = process.execPath;
const env = { PATH: process.env.PATH ?? "" };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("spawnTool", () => {
  it("passes the arguments as they are, with no shell to interpret them", async () => {
    const lines: string[] = [];
    const args = ["-e", "console.log(process.argv.slice(1).join('|'))", "$(id)", "; reboot", "a b"];
    const result = await spawnTool({ command: NODE, args, env, onLine: (line) => lines.push(line) });

    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["$(id)|; reboot|a b"]);
  });

  it("gives the process only the environment it was handed", async () => {
    const lines: string[] = [];
    await spawnTool({
      command: NODE,
      args: ["-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"],
      env: { ONLY_THIS: "1" },
      onLine: (line) => lines.push(line),
    });

    expect(lines[0]).toContain("ONLY_THIS");
    expect(lines[0]).not.toContain("HOME");
  });

  it("reports the exit code and keeps the last lines", async () => {
    const result = await spawnTool({
      command: NODE,
      args: ["-e", "console.log('out');console.error('err');process.exit(3)"],
      env,
    });

    expect(result.exitCode).toBe(3);
    expect(result.tail.sort()).toEqual(["err", "out"]);
  });

  it("splits output on newlines and carriage returns, across chunks", async () => {
    const lines: string[] = [];
    await spawnTool({
      command: NODE,
      args: [
        "-e",
        "process.stdout.write('first\\npart');setTimeout(()=>process.stdout.write('ial\\rlast'),20)",
      ],
      env,
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["first", "partial", "last"]);
  });

  it("removes secrets from what it reports", async () => {
    const lines: string[] = [];
    const redact = new Redactor().add("hunter2-secret");
    const result = await spawnTool({
      command: NODE,
      args: ["-e", "console.log('token=hunter2-secret end')"],
      env,
      redact,
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([`token=${REDACTED} end`]);
    expect(JSON.stringify(result)).not.toContain("hunter2-secret");
  });

  it("says when the program is not installed", async () => {
    await expect(spawnTool({ command: "opsifier-no-such-tool", args: [], env })).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
  });

  it("is not started at all once the signal has fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnTool({ command: NODE, args: ["-e", ""], env, signal: controller.signal }),
    ).rejects.toBeDefined();
  });

  /** A process that starts two children and stays alive, reporting their pids. */
  const TREE_SCRIPT = `
    const { spawn } = require("node:child_process");
    const a = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const b = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    console.log(process.pid, a.pid, b.pid);
    setInterval(() => {}, 1000);
  `;

  it("kills the whole process tree when the signal fires", async () => {
    const controller = new AbortController();
    let pids: number[] = [];
    const running = spawnTool({
      command: NODE,
      args: ["-e", TREE_SCRIPT],
      env,
      signal: controller.signal,
      onLine: (line) => {
        pids = line.split(" ").map(Number);
      },
    });
    await waitUntil(() => pids.length === 3);
    expect(pids.every(isAlive)).toBe(true);

    controller.abort(new DOMException("Cancelled.", "AbortError"));

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await waitUntil(() => !pids.some(isAlive));
  });

  it("kills the tree and reports a timeout when a tool runs too long", async () => {
    let pids: number[] = [];
    const running = spawnTool({
      command: NODE,
      args: ["-e", TREE_SCRIPT],
      env,
      timeoutMs: 400,
      onLine: (line) => {
        pids = line.split(" ").map(Number);
      },
    });

    await expect(running).rejects.toBeInstanceOf(ToolTimeoutError);
    await waitUntil(() => pids.length === 3 && !pids.some(isAlive));
  });

  it("kills a process that ignores the polite signal", async () => {
    const controller = new AbortController();
    let pid = 0;
    const started = Date.now();
    const running = spawnTool({
      command: NODE,
      args: ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],
      env,
      signal: controller.signal,
      onLine: (line) => {
        pid = Number(line);
      },
    });
    await waitUntil(() => pid !== 0);
    controller.abort();

    await expect(running).rejects.toBeDefined();
    await waitUntil(() => !isAlive(pid));
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("is what real tools run", () => {
    expect(realTools.run).toBe(spawnTool);
  });
});

describe("Redactor", () => {
  it("removes a registered secret wherever it appears", () => {
    const redactor = new Redactor().add("s3cr3t-value");
    expect(redactor.apply("a s3cr3t-value b s3cr3t-value")).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("registers a multi-line secret line by line", () => {
    const key =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAABBBBCCCCDDDDEEEEFFFF\nGGGGHHHHIIIIJJJJKKKK\n-----END OPENSSH PRIVATE KEY-----\n";
    const redactor = new Redactor().add(key);
    const output = redactor.apply(`leak: ${key}`);

    expect(output).not.toContain("AAAABBBB");
    expect(output).not.toContain("GGGGHHHH");
    expect(output).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("ignores values too short to be secrets, which would shred the log", () => {
    const redactor = new Redactor().add("ab");
    expect(redactor.apply("abc")).toBe("abc");
  });

  it("removes every spelling of a GitHub token", () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    const redactor = new Redactor().addToken(token);
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");

    expect(redactor.apply(`Authorization: basic ${encoded}`)).not.toContain(encoded);
    expect(redactor.apply(`https://x-access-token:${token}@github.com/`)).not.toContain(token);
  });

  it("catches tokens and credentials nobody registered", () => {
    const redactor = new Redactor();

    expect(redactor.apply("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(REDACTED);
    expect(redactor.apply("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz")).toBe(REDACTED);
    expect(redactor.apply("https://user:pass@example.com/repo.git")).toBe(
      `https://${REDACTED}@example.com/repo.git`,
    );
    expect(redactor.apply("Authorization: Bearer abc.def")).toBe(`Authorization: ${REDACTED}`);
    expect(redactor.apply("-----BEGIN RSA PRIVATE KEY-----")).toBe(REDACTED);
  });

  it("leaves ordinary output alone", () => {
    const redactor = new Redactor();
    const line = "#5 [2/3] COPY . /app 0.1s, https://example.com/docs and git@github.com:acme/shop.git";
    expect(redactor.apply(line)).toBe(line);
  });
});

describe("build output", () => {
  it("loses its colour codes, which mean nothing in a log", async () => {
    const lines: string[] = [];
    await spawnTool({
      command: NODE,
      args: ["-e", "console.log('\\u001b[1m\\u001b[31mred\\u001b[0m plain')"],
      env,
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["red plain"]);
  });
});
