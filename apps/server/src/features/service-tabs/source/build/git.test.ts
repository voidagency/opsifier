import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppDeps } from "../../../../core/context";
import { Secrets } from "../../../../core/secrets";
import {
  REDACTED,
  realTools,
  type ToolRequest,
  type ToolResult,
  type ToolRunner,
  ToolTimeoutError,
} from "../../../../core/tools";
import { SSH_KEY_CONTEXT } from "../stored";
import { checkoutRemote, type GitRemote, probeRemote, withGitSession } from "./git";

let root: string;
let secrets: Secrets;
let deps: Pick<AppDeps, "config" | "secrets" | "tools">;

const FILE = { allowProtocols: "file" };

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      HOME: "/nonexistent",
    },
  }).trim();

function createRepository(): { path: string; url: string } {
  const path = join(root, "origin");
  mkdirSync(path);
  gitIn(path, "init", "--quiet", "--initial-branch=main", ".");
  gitIn(path, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(path, "Dockerfile"), "FROM scratch\n");
  gitIn(path, "add", ".");
  gitIn(path, "commit", "--quiet", "-m", "one");
  return { path, url: `file://${path}` };
}

const remoteFor = (url: string, overrides: Partial<GitRemote> = {}): GitRemote => ({
  url,
  sealedKey: null,
  token: null,
  knownHostsFile: join(root, "known_hosts"),
  ...overrides,
});

const paths = (name: string) => ({ gitDir: join(root, name, "git"), workTree: join(root, name, "tree") });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opsifier-git-"));
  secrets = new Secrets(randomBytes(32));
  deps = {
    config: { dataDir: join(root, "data") } as AppDeps["config"],
    secrets,
    tools: realTools,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkoutRemote against a real repository", () => {
  it("leaves the files of one commit and no .git", async () => {
    const origin = createRepository();

    const { sha } = await checkoutRemote(deps, remoteFor(origin.url), "main", paths("a"), FILE);

    expect(sha).toBe(gitIn(origin.path, "rev-parse", "HEAD"));
    expect(readdirSync(paths("a").workTree)).toEqual(["Dockerfile"]);
  });

  it("checks out a tag and a full commit hash", async () => {
    const origin = createRepository();
    const first = gitIn(origin.path, "rev-parse", "HEAD");
    gitIn(origin.path, "tag", "-a", "v1", "-m", "v1");
    writeFileSync(join(origin.path, "later.txt"), "later\n");
    gitIn(origin.path, "add", ".");
    gitIn(origin.path, "commit", "--quiet", "-m", "two");

    const tag = await checkoutRemote(deps, remoteFor(origin.url), "v1", paths("tag"), FILE);
    expect(tag.sha).toBe(first);
    expect(existsSync(join(paths("tag").workTree, "later.txt"))).toBe(false);

    const commit = await checkoutRemote(deps, remoteFor(origin.url), first, paths("commit"), FILE);
    expect(commit.sha).toBe(first);
  });

  it("follows a force push, because every fetch starts clean", async () => {
    const origin = createRepository();
    const before = await checkoutRemote(deps, remoteFor(origin.url), "main", paths("one"), FILE);

    writeFileSync(join(origin.path, "Dockerfile"), "FROM scratch\nLABEL amended=1\n");
    gitIn(origin.path, "add", ".");
    gitIn(origin.path, "commit", "--quiet", "--amend", "-m", "rewritten");

    const after = await checkoutRemote(deps, remoteFor(origin.url), "main", paths("two"), FILE);

    expect(after.sha).not.toBe(before.sha);
    expect(readFileSync(join(paths("two").workTree, "Dockerfile"), "utf8")).toContain("amended");
  });

  it("fails on a ref the repository does not have", async () => {
    const origin = createRepository();

    await expect(checkoutRemote(deps, remoteFor(origin.url), "nope", paths("x"), FILE)).rejects.toThrow(
      /Fetching nope failed/,
    );
  });

  it("lets git itself refuse a protocol outside the allowed list", async () => {
    const origin = createRepository();

    const result = await probeRemote(deps, remoteFor(origin.url), "main");

    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(result.ok ? "" : result.detail).toMatch(/not allowed|disallowed/i);
  });

  it("refuses ext:: at the level of git too", async () => {
    const marker = join(root, "pwned");
    const result = await probeRemote(deps, remoteFor(`ext::sh -c touch% ${marker}`), "main");

    expect(result.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("probeRemote", () => {
  it("is happy with a branch and a commit that exist", async () => {
    const origin = createRepository();

    expect(await probeRemote(deps, remoteFor(origin.url), "main", FILE)).toEqual({ ok: true });
    expect(
      await probeRemote(deps, remoteFor(origin.url), gitIn(origin.path, "rev-parse", "HEAD"), FILE),
    ).toEqual({
      ok: true,
    });
  });

  it("reports a branch that does not exist apart from a repository that cannot be read", async () => {
    const origin = createRepository();

    expect(await probeRemote(deps, remoteFor(origin.url), "nope", FILE)).toMatchObject({
      ok: false,
      reason: "ref-missing",
    });
    expect(await probeRemote(deps, remoteFor(`file://${join(root, "gone")}`), "main", FILE)).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("treats a remote that doesn't answer in time as unreachable", async () => {
    const stalled: ToolRunner = {
      kind: "fake",
      run: () => Promise.reject(new ToolTimeoutError("git", 30_000)),
    };

    expect(
      await probeRemote({ ...deps, tools: stalled }, remoteFor("https://example.com/a.git"), "main"),
    ).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("what git is run with", () => {
  let calls: ToolRequest[];

  const recordingTools = (
    handle?: (request: ToolRequest) => Partial<ToolResult> | undefined,
  ): ToolRunner => ({
    kind: "fake",
    run: async (request) => {
      calls.push(request);
      if (request.args.includes("checkout")) {
        mkdirSync(paths("r").workTree, { recursive: true });
      }
      if (request.args.includes("rev-parse")) {
        return { exitCode: 0, tail: ["abc123"] };
      }
      return { exitCode: 0, tail: [], ...handle?.(request) };
    },
  });

  beforeEach(() => {
    calls = [];
    deps = { ...deps, tools: recordingTools() };
  });

  it("never uses a shell, and puts -- before every value from the user", async () => {
    await probeRemote(deps, remoteFor("https://example.com/a.git"), "feature/x");
    await checkoutRemote(deps, remoteFor("https://example.com/a.git"), "feature/x", paths("r"));

    const probe = calls[0]?.args ?? [];
    expect(probe.slice(0, 3)).toEqual(["ls-remote", "--exit-code", "--"]);
    expect(probe.slice(3)).toEqual(["https://example.com/a.git", "feature/x"]);

    const fetch = calls.find((call) => call.args.includes("fetch"));
    const separator = fetch?.args.indexOf("--") ?? -1;
    expect(separator).toBeGreaterThan(0);
    expect(fetch?.args.slice(separator + 1)).toEqual(["https://example.com/a.git", "feature/x"]);
    expect(calls.every((call) => call.command === "git")).toBe(true);
  });

  it("disables prompts and limits protocols, with no inherited configuration", async () => {
    await probeRemote(deps, remoteFor("https://example.com/a.git"), "main");

    expect(calls[0]?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https:ssh",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });

  it("does not let the panel's own environment reach git", async () => {
    process.env.OPSIFIER_SECRET_TEST = "must-not-leak";
    try {
      await probeRemote(deps, remoteFor("https://example.com/a.git"), "main");
      expect(JSON.stringify(calls[0]?.env)).not.toContain("must-not-leak");
    } finally {
      delete process.env.OPSIFIER_SECRET_TEST;
    }
  });

  it("writes a token to a private file for the operation only, and never into an argument or the environment", async () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    let seen: { mode: number; content: string; file: string } | undefined;
    deps = {
      ...deps,
      tools: recordingTools((request) => {
        const helper = request.env.GIT_CONFIG_VALUE_1 ?? "";
        const file = /--file='([^']+)'/.exec(helper)?.[1] ?? "";
        seen = { mode: statSync(file).mode & 0o777, content: readFileSync(file, "utf8"), file };
        return undefined;
      }),
    };

    await probeRemote(deps, remoteFor("https://github.com/acme/shop.git", { token }), "main");

    expect(seen?.mode).toBe(0o600);
    expect(seen?.content).toContain(token);
    expect(existsSync(seen?.file ?? "")).toBe(false);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(token);
    expect(JSON.stringify(calls[0]?.env)).not.toContain(token);
    expect(calls[0]?.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(calls[0]?.env.GIT_CONFIG_VALUE_0).toBe("");
  });

  it("writes an SSH key to a private file for the operation only", async () => {
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH\n-----END OPENSSH PRIVATE KEY-----\n";
    let seen: { mode: number; content: string; file: string } | undefined;
    deps = {
      ...deps,
      tools: recordingTools((request) => {
        const file = /-i '([^']+)'/.exec(request.env.GIT_SSH_COMMAND ?? "")?.[1] ?? "";
        seen = { mode: statSync(file).mode & 0o777, content: readFileSync(file, "utf8"), file };
        return undefined;
      }),
    };

    await probeRemote(
      deps,
      remoteFor("git@example.com:acme/shop.git", { sealedKey: secrets.seal(privateKey, SSH_KEY_CONTEXT) }),
      "main",
    );

    expect(seen?.mode).toBe(0o600);
    expect(seen?.content).toBe(privateKey);
    expect(existsSync(seen?.file ?? "")).toBe(false);
    expect(JSON.stringify(calls[0]?.env)).not.toContain("AAAABBBB");
    expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=accept-new");
    expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
  });

  it("cleans up the private directory even when the operation throws", async () => {
    await expect(
      withGitSession(
        deps,
        remoteFor("https://example.com/a.git", { token: "ghp_abcdefghij0123456789" }),
        {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(readdirSync(join(root, "data", "tmp"))).toEqual([]);
  });

  it("redacts the token from what the failure reports", async () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    deps = {
      ...deps,
      tools: {
        kind: "fake",
        // The runner applies `redact` before anything reaches the caller, so the fake does too.
        run: async (request) => ({
          exitCode: 128,
          tail: [
            request.redact?.apply(`fatal: could not read from https://x-access-token:${token}@github.com/`) ??
              "",
          ],
        }),
      },
    };

    const result = await probeRemote(deps, remoteFor("https://github.com/acme/shop.git", { token }), "main");

    expect(result.ok ? "" : result.detail).toContain(REDACTED);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe("the temporary credentials directory", () => {
  it("is empty after a real checkout", async () => {
    const origin = createRepository();
    await checkoutRemote(
      deps,
      remoteFor(origin.url, { token: "ghp_abcdefghij0123456789" }),
      "main",
      paths("a"),
      FILE,
    );

    expect(readdirSync(join(root, "data", "tmp"))).toEqual([]);
  });
});
