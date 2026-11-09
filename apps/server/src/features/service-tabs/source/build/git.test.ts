import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
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
import { generateSshKeyPair } from "./ssh-key";

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
  knownHosts: "",
  ...overrides,
});

const paths = (name: string) => ({ gitDir: join(root, name, "git"), workTree: join(root, name, "tree") });

/** Resolves as soon as the signal has fired, including if it already had. */
const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
    } else {
      signal?.addEventListener("abort", () => resolve());
    }
  });

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

  it("fails on a ref the repository does not have, saying so and what to do about it", async () => {
    const origin = createRepository();

    await expect(checkoutRemote(deps, remoteFor(origin.url), "nope", paths("x"), FILE)).rejects.toMatchObject(
      {
        name: "GitSourceError",
        kind: "ref-missing",
        message: expect.stringMatching(
          /no branch, tag or commit named nope.*Point the source at one that exists/,
        ),
      },
    );
  });

  describe("a commit the source is pinned to, once it has been rewritten", () => {
    function rewriteHistory(path: string): void {
      writeFileSync(join(path, "Dockerfile"), "FROM scratch\nLABEL rewritten=1\n");
      gitIn(path, "add", ".");
      gitIn(path, "commit", "--quiet", "--amend", "-m", "rewritten");
      gitIn(path, "reflog", "expire", "--expire=now", "--all");
      gitIn(path, "gc", "--quiet", "--prune=now");
    }

    it("is refused with what happened and how to carry on, and nothing is deployed", async () => {
      const origin = createRepository();
      const pinned = gitIn(origin.path, "rev-parse", "HEAD");
      rewriteHistory(origin.path);

      await expect(
        checkoutRemote(deps, remoteFor(origin.url), pinned, paths("x"), FILE),
      ).rejects.toMatchObject({
        name: "GitSourceError",
        kind: "ref-missing",
        message: expect.stringMatching(
          /Commit [0-9a-f]{12} can no longer be fetched: it was rewritten by a force push.*Nothing was deployed.*Point the source at a branch, a tag or a commit that still exists/,
        ),
      });
    });

    it("still deploys for as long as the host keeps it and serves it", async () => {
      const origin = createRepository();
      const pinned = gitIn(origin.path, "rev-parse", "HEAD");
      writeFileSync(join(origin.path, "Dockerfile"), "FROM scratch\nLABEL rewritten=1\n");
      gitIn(origin.path, "add", ".");
      gitIn(origin.path, "commit", "--quiet", "--amend", "-m", "rewritten");

      const { sha } = await checkoutRemote(deps, remoteFor(origin.url), pinned, paths("x"), FILE);

      expect(sha).toBe(pinned);
      expect(readFileSync(join(paths("x").workTree, "Dockerfile"), "utf8")).not.toContain("rewritten");
    });
  });

  describe("a large repository", () => {
    function largeRepository(megabytes: number): { path: string; url: string } {
      const origin = createRepository();
      execFileSync(
        "dd",
        ["if=/dev/urandom", `of=${join(origin.path, "big.bin")}`, "bs=1048576", `count=${megabytes}`],
        {
          stdio: "ignore",
        },
      );
      gitIn(origin.path, "add", ".");
      gitIn(origin.path, "commit", "--quiet", "-m", "big");
      return origin;
    }

    const staged = () => readdirSync(join(root, "data", "tmp"));

    it("is fetched without the panel holding it in memory", async () => {
      const origin = largeRepository(64);
      const before = process.memoryUsage();

      const { sha } = await checkoutRemote(deps, remoteFor(origin.url), "main", paths("big"), FILE);

      const after = process.memoryUsage();
      const grown = after.heapUsed - before.heapUsed + (after.arrayBuffers - before.arrayBuffers);
      expect(sha).toBe(gitIn(origin.path, "rev-parse", "HEAD"));
      expect(statSync(join(paths("big").workTree, "big.bin")).size).toBe(64 * 1024 * 1024);
      expect(grown).toBeLessThan(32 * 1024 * 1024);
    }, 60_000);

    it("is refused when it comes to more than the budget, and leaves no secrets behind", async () => {
      const origin = largeRepository(8);

      await expect(
        checkoutRemote(deps, remoteFor(origin.url), "main", paths("big"), { ...FILE, maxBytes: 1024 * 1024 }),
      ).rejects.toMatchObject({
        kind: "size",
        message: expect.stringMatching(/too large to fetch.*Remove large files.*deploy again/),
      });
      expect(staged()).toEqual([]);
    }, 60_000);

    it("is stopped as it goes over the budget, without waiting for git to finish", async () => {
      const big = 2 * 1024 * 1024;
      let stoppedBySignal = false;
      const tools: ToolRunner = {
        kind: "fake",
        run: async (request) => {
          if (request.args.includes("fetch")) {
            const gitDir = (request.args[0] as string).slice("--git-dir=".length);
            mkdirSync(gitDir, { recursive: true });
            writeFileSync(join(gitDir, "objects.pack"), Buffer.alloc(big));
            await untilAborted(request.signal);
            stoppedBySignal = true;
            throw new DOMException("Aborted", "AbortError");
          }
          return { exitCode: 0, tail: [] };
        },
      };

      await expect(
        checkoutRemote({ ...deps, tools }, remoteFor("https://example.com/a.git"), "main", paths("x"), {
          maxBytes: big / 2,
        }),
      ).rejects.toMatchObject({ kind: "size" });
      expect(stoppedBySignal).toBe(true);
      expect(staged()).toEqual([]);
    }, 30_000);

    it("stops at once when cancelled, and cleans up after itself", async () => {
      const tools: ToolRunner = {
        kind: "fake",
        run: async (request) => {
          if (request.args.includes("fetch")) {
            await untilAborted(request.signal);
            throw request.signal?.reason;
          }
          return { exitCode: 0, tail: [] };
        },
      };
      const controller = new AbortController();
      const cancelled = new DOMException("The action was cancelled.", "AbortError");

      const fetching = checkoutRemote(
        { ...deps, tools },
        remoteFor("https://example.com/a.git"),
        "main",
        paths("x"),
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(cancelled), 5);

      await expect(fetching).rejects.toBe(cancelled);
      expect(staged()).toEqual([]);
    });

    it("runs out of time when it takes too long, said as a problem of reaching it", async () => {
      const tools: ToolRunner = {
        kind: "fake",
        run: async (request) => {
          if (request.args.includes("fetch")) {
            expect(request.timeoutMs).toBeGreaterThan(0);
            throw new ToolTimeoutError("git", request.timeoutMs ?? 0);
          }
          return { exitCode: 0, tail: [] };
        },
      };

      await expect(
        checkoutRemote({ ...deps, tools }, remoteFor("https://example.com/a.git"), "main", paths("x")),
      ).rejects.toMatchObject({
        kind: "network",
        message: expect.stringMatching(/could not be reached.*deploy again/),
      });
    });
  });

  describe.each([
    [
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://x'",
      "access",
      /refused access/,
    ],
    [
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "access",
      /deploy key/,
    ],
    [
      "remote: Repository not found.\nfatal: repository 'https://x/' not found",
      "access",
      /isn't at that address/,
    ],
    [
      "fatal: unable to access 'https://x/': The requested URL returned error: 403",
      "access",
      /refused access/,
    ],
    ["fatal: couldn't find remote ref refs/heads/nope", "ref-missing", /no branch, tag or commit/],
    ["fatal: Could not resolve host: example.com", "network", /could not be reached/],
    ["ssh: connect to host x port 22: Connection timed out", "network", /could not be reached/],
    ["fatal: early EOF\nfatal: fetch-pack: invalid index-pack output", "network", /could not be reached/],
    [
      "error: unable to write sha1 file\nfatal: write error: No space left on device",
      "size",
      /too large to fetch/,
    ],
    ["fatal: pack exceeds maximum allowed size", "size", /too large to fetch/],
    ["fatal: something nobody has seen before", "unreachable", /could not be read/],
  ])("the failure %j", (output, kind, advice) => {
    const failingFetch: ToolRunner = {
      kind: "fake",
      run: async (request) =>
        request.args.includes("fetch")
          ? { exitCode: 128, tail: output.split("\n") }
          : { exitCode: 0, tail: [] },
    };

    it("is told apart, with git's own words and what to do next", async () => {
      await expect(
        checkoutRemote(
          { ...deps, tools: failingFetch },
          remoteFor("https://example.com/a.git"),
          "main",
          paths("x"),
        ),
      ).rejects.toMatchObject({
        name: "GitSourceError",
        kind,
        message: expect.stringMatching(advice),
      });
    });
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
      reason: "access",
    });
  });

  it.each([
    ["fatal: Authentication failed for 'https://x'", "access"],
    ["fatal: Could not resolve host: example.com", "network"],
    ["fatal: something nobody has seen before", "unreachable"],
  ])("tells %j apart", async (output, reason) => {
    const failing: ToolRunner = {
      kind: "fake",
      run: async () => ({ exitCode: 128, tail: [output] }),
    };

    expect(
      await probeRemote({ ...deps, tools: failing }, remoteFor("https://example.com/a.git"), "main"),
    ).toMatchObject({ ok: false, reason });
  });

  it("treats a remote that doesn't answer in time as a network problem", async () => {
    const stalled: ToolRunner = {
      kind: "fake",
      run: () => Promise.reject(new ToolTimeoutError("git", 30_000)),
    };

    expect(
      await probeRemote({ ...deps, tools: stalled }, remoteFor("https://example.com/a.git"), "main"),
    ).toMatchObject({
      ok: false,
      reason: "network",
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
    expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(calls[0]?.env.GIT_SSH_COMMAND).not.toContain("accept-new");
    expect(calls[0]?.env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
  });

  /** The `git -c` pairs of one run, as git reads them. */
  const gitConfigOf = (env: Readonly<Record<string, string>> | undefined) => {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < Number(env?.GIT_CONFIG_COUNT ?? 0); index += 1) {
      pairs.push([env?.[`GIT_CONFIG_KEY_${index}`] ?? "", env?.[`GIT_CONFIG_VALUE_${index}`] ?? ""]);
    }
    return pairs;
  };

  it("verifies TLS and follows no redirect, for any remote", async () => {
    await probeRemote(deps, remoteFor("https://example.com/a.git"), "main");

    expect(gitConfigOf(calls[0]?.env)).toEqual(
      expect.arrayContaining([
        ["http.followRedirects", "false"],
        ["http.sslVerify", "true"],
      ]),
    );
  });

  it("scopes a token to the path of the repository, not just its host", async () => {
    await probeRemote(
      deps,
      remoteFor("https://github.com/acme/shop.git", { token: "ghp_0123456789abcdefghij" }),
      "main",
    );

    expect(gitConfigOf(calls[0]?.env)).toEqual(expect.arrayContaining([["credential.useHttpPath", "true"]]));
  });

  it("will not verify an SSH host any way but against the registry's lines", async () => {
    await probeRemote(deps, remoteFor("git@example.com:acme/shop.git"), "main");

    const ssh = calls[0]?.env.GIT_SSH_COMMAND ?? "";
    expect(ssh).toContain("StrictHostKeyChecking=yes");
    expect(ssh).toContain("GlobalKnownHostsFile=/dev/null");
    expect(ssh).toMatch(/UserKnownHostsFile="[^"]*known_hosts"/);
    expect(ssh).not.toContain("accept-new");
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

describe("what a token is good for", () => {
  it("answers for the path it was written for, and for no other repository", async () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    await withGitSession(
      deps,
      remoteFor("https://github.com/acme/shop.git", { token }),
      {},
      async ({ env }) => {
        const ask = (path: string) =>
          execFileSync("git", ["credential", "fill"], {
            input: `protocol=https\nhost=github.com\npath=${path}\n\n`,
            env,
            encoding: "utf8",
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
          });

        expect(ask("acme/shop.git")).toContain(`password=${token}`);
        expect(() => ask("acme/other.git")).toThrow();
        expect(() => ask("evil/shop.git")).toThrow();
      },
    );
  });
});

describe("a repository that redirects", () => {
  it("is not followed, so a credential can't be carried to where it was never given", async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url?.startsWith("/acme/shop.git/")) {
        response.writeHead(301, { location: "/evil/other.git/info/refs?service=git-upload-pack" });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await probeRemote(deps, remoteFor(`http://127.0.0.1:${port}/acme/shop.git`), "main", {
        allowProtocols: "http",
      });

      expect(result).toMatchObject({ ok: false, reason: "unreachable" });
      expect(seen.some((path) => path.startsWith("/acme/shop.git/"))).toBe(true);
      expect(seen.some((path) => path.startsWith("/evil/"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const SSHD = ["/usr/sbin/sshd", "/usr/bin/sshd"].find((path) => existsSync(path));
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe.skipIf(SSHD === undefined || !hasSshKeygen)("git over a real SSH server", () => {
  let sshd: ChildProcess;
  let port: number;
  let url: string;
  let hostLine: string;
  let otherHostLine: string;
  let authorized: string;

  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = createTcpServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => resolve(free));
      });
    });

  const remoteWith = (privateKey: string, knownHosts: string) =>
    remoteFor(url, { sealedKey: secrets.seal(privateKey, SSH_KEY_CONTEXT), knownHosts });

  beforeEach(async () => {
    const dir = join(root, "ssh");
    mkdirSync(dir);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "other-host")]);
    port = await freePort();
    authorized = join(dir, "authorized_keys");
    writeFileSync(authorized, "");
    const hostKey = (name: string) => {
      const [keyType, key] = readFileSync(join(dir, `${name}.pub`), "utf8")
        .trim()
        .split(/\s+/);
      return `[127.0.0.1]:${port} ${keyType} ${key}\n`;
    };
    hostLine = hostKey("host");
    otherHostLine = hostKey("other-host");

    const origin = createRepository();
    url = `ssh://${userInfo().username}@127.0.0.1:${port}${origin.path}`;

    writeFileSync(
      join(dir, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(dir, "host")}`,
        `AuthorizedKeysFile ${authorized}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "StrictModes no",
        "UsePAM no",
        "PidFile none",
        "",
      ].join("\n"),
    );
    sshd = spawn(SSHD as string, ["-f", join(dir, "sshd_config"), "-D", "-e"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sshd did not start")), 10_000);
      sshd.stderr?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      sshd.once("exit", () => reject(new Error("sshd exited")));
    });
  });

  afterEach(() => {
    sshd.kill("SIGKILL");
  });

  it("reaches the repository with the key the Git host knows, and checks out what it holds", async () => {
    const key = generateSshKeyPair("opsifier-test");
    writeFileSync(authorized, `${key.publicKey}\n`);

    expect(await probeRemote(deps, remoteWith(key.privateKey, hostLine), "main")).toEqual({ ok: true });
    const { sha } = await checkoutRemote(deps, remoteWith(key.privateKey, hostLine), "main", paths("ssh"));
    expect(sha).toBe(gitIn(join(root, "origin"), "rev-parse", "HEAD"));
  });

  it("refuses a server the registry has never heard of", async () => {
    const key = generateSshKeyPair("opsifier-test");
    writeFileSync(authorized, `${key.publicKey}\n`);

    const result = await probeRemote(deps, remoteWith(key.privateKey, ""), "main");

    expect(result).toMatchObject({ ok: false, reason: "access" });
    expect(result.ok ? "" : result.detail).toMatch(/Host key verification failed/);
  });

  it("refuses a server whose key is not the one the registry holds, however close it looks", async () => {
    const key = generateSshKeyPair("opsifier-test");
    writeFileSync(authorized, `${key.publicKey}\n`);

    const result = await probeRemote(deps, remoteWith(key.privateKey, otherHostLine), "main");

    expect(result).toMatchObject({ ok: false, reason: "access" });
    expect(result.ok ? "" : result.detail).toMatch(/verification failed|Host key/i);
  });

  it("fails once the Git host stops accepting the key, so a revocation really is one", async () => {
    const key = generateSshKeyPair("opsifier-test");
    writeFileSync(authorized, `${key.publicKey}\n`);
    expect(await probeRemote(deps, remoteWith(key.privateKey, hostLine), "main")).toEqual({ ok: true });

    writeFileSync(authorized, "");

    const result = await probeRemote(deps, remoteWith(key.privateKey, hostLine), "main");
    expect(result).toMatchObject({ ok: false, reason: "access" });
    expect(result.ok ? "" : result.detail).toMatch(/Permission denied/);
  });

  it("makes the old key fail after a rotation, while the new one works", async () => {
    const old = generateSshKeyPair("opsifier-old");
    const fresh = generateSshKeyPair("opsifier-new");
    writeFileSync(authorized, `${fresh.publicKey}\n`);

    expect(await probeRemote(deps, remoteWith(fresh.privateKey, hostLine), "main")).toEqual({ ok: true });
    expect(await probeRemote(deps, remoteWith(old.privateKey, hostLine), "main")).toMatchObject({
      ok: false,
    });
  });

  it("offers no key at all when none is bound to this repository", async () => {
    const key = generateSshKeyPair("opsifier-test");
    writeFileSync(authorized, `${key.publicKey}\n`);

    const result = await probeRemote(deps, remoteFor(url, { sealedKey: null, knownHosts: hostLine }), "main");

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.detail).toMatch(/Permission denied/);
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
