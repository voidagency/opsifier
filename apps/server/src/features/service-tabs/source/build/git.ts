import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDeps } from "../../../../core/context";
import { Redactor, type ToolResult, ToolTimeoutError } from "../../../../core/tools";
import { SSH_KEY_CONTEXT } from "../stored";
import { inheritedEnv } from "./environment";

/** Every protocol git may use, for the clone itself and for anything a repository redirects to. */
const ALLOWED_GIT_PROTOCOLS = "https:ssh";
const PROBE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 15 * 60_000;
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface GitRemote {
  url: string;
  /** Sealed deploy key, for a remote reached over SSH. */
  sealedKey: string | null;
  /** The GitHub token, in the clear for as long as this operation holds it. */
  token: string | null;
  /** Host keys seen so far for this service. Unknown hosts are added, changed ones are refused. */
  knownHostsFile: string;
}

export type ProbeResult = { ok: true } | { ok: false; reason: "unreachable" | "ref-missing"; detail: string };

export interface GitOptions {
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  /** Tests point this at `file:` to read a local repository. Nothing else ever sets it. */
  allowProtocols?: string;
}

interface GitSession {
  env: Record<string, string>;
  redact: Redactor;
}

const singleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Sets up everything git needs for one operation in a private directory, and removes it afterwards.
 * Secrets exist on disk only here, in 0600 files, and never in an argument or a URL.
 */
export async function withGitSession<T>(
  deps: Pick<AppDeps, "config" | "secrets">,
  remote: GitRemote,
  options: Pick<GitOptions, "allowProtocols">,
  run: (session: GitSession) => Promise<T>,
): Promise<T> {
  const parent = join(deps.config.dataDir, "tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, "git-"));
  const redact = new Redactor();

  try {
    const config: Array<[string, string]> = [];
    if (remote.token !== null) {
      const file = join(dir, "credentials");
      await writeFile(file, `https://x-access-token:${encodeURIComponent(remote.token)}@github.com\n`, {
        mode: 0o600,
        flag: "wx",
      });
      redact.addToken(remote.token);
      // The empty value clears any helper configured elsewhere. Git runs this one through a shell,
      // which is why the only variable part of it is a path this function chose.
      config.push(["credential.helper", ""], ["credential.helper", `store --file=${singleQuote(file)}`]);
    }

    let identity: string[] = [];
    if (remote.sealedKey !== null) {
      const key = deps.secrets.unseal(remote.sealedKey, SSH_KEY_CONTEXT);
      const file = join(dir, "deploy_key");
      await writeFile(file, key, { mode: 0o600, flag: "wx" });
      redact.add(key);
      identity = ["-i", singleQuote(file), "-o", "IdentitiesOnly=yes"];
    }

    const env: Record<string, string> = {
      ...inheritedEnv(),
      HOME: dir,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: options.allowProtocols ?? ALLOWED_GIT_PROTOCOLS,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      // Unknown hosts are remembered on first contact, and a host that changes its key is refused.
      GIT_SSH_COMMAND: [
        "ssh",
        "-F",
        "/dev/null",
        ...identity,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        singleQuote(`UserKnownHostsFile="${remote.knownHostsFile}"`),
        "-o",
        "ConnectTimeout=20",
      ].join(" "),
      GIT_CONFIG_COUNT: String(config.length),
    };
    for (const [index, [key, value]] of config.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    }

    return await run({ env, redact });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What actually went wrong, in git's words: the last lines of its output, without secrets. */
export function describeGitFailure(tail: readonly string[]): string {
  const lines = tail
    .map((line) => line.replace(/^(?:fatal|error|remote):\s*/i, "").trim())
    .filter((line) => line !== "");
  return lines.slice(-2).join(" ").slice(0, 400);
}

async function runGit(
  deps: Pick<AppDeps, "tools">,
  session: GitSession,
  args: readonly string[],
  options: GitOptions & { timeoutMs?: number },
): Promise<ToolResult> {
  return deps.tools.run({
    command: "git",
    args,
    env: session.env,
    redact: session.redact,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    onLine: options.onLine,
  });
}

function assertGitSucceeded(what: string, result: ToolResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed: ${describeGitFailure(result.tail) || `git exited with ${result.exitCode}`}`,
    );
  }
}

/** `git ls-remote`, the check made before a source is saved. A commit can only be checked at fetch time. */
export function probeRemote(
  deps: Pick<AppDeps, "config" | "secrets" | "tools">,
  remote: GitRemote,
  ref: string,
  options: GitOptions = {},
): Promise<ProbeResult> {
  return withGitSession(deps, remote, options, async (session) => {
    const pattern = FULL_SHA.test(ref) ? "HEAD" : ref;
    let result: ToolResult;
    try {
      result = await runGit(deps, session, ["ls-remote", "--exit-code", "--", remote.url, pattern], {
        ...options,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return { ok: false, reason: "unreachable", detail: "The remote did not answer in time." };
      }
      throw error;
    }
    if (result.exitCode === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: result.exitCode === 2 ? "ref-missing" : "unreachable",
      detail: describeGitFailure(result.tail),
    };
  });
}

/**
 * Fetches exactly one commit into a fresh directory and checks it out, leaving `workTree` with the
 * repository's files and no `.git`. Nothing carries over between deploys, so a force push, a local
 * change or an interrupted fetch cannot get in the way of the next one.
 */
export function checkoutRemote(
  deps: Pick<AppDeps, "config" | "secrets" | "tools">,
  remote: GitRemote,
  ref: string,
  paths: { gitDir: string; workTree: string },
  options: GitOptions = {},
): Promise<{ sha: string }> {
  return withGitSession(deps, remote, options, async (session) => {
    const { gitDir, workTree } = paths;
    await mkdir(workTree, { recursive: true });
    const run = (args: readonly string[], timeoutMs?: number) =>
      runGit(deps, session, args, { ...options, timeoutMs });

    // `--template=` keeps git's sample hooks out of a directory that holds untrusted data.
    assertGitSucceeded(
      "Preparing the checkout",
      await run(["init", "--quiet", "--bare", "--template=", "--", gitDir]),
    );
    assertGitSucceeded(
      `Fetching ${ref}`,
      await run(
        [
          `--git-dir=${gitDir}`,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          remote.url,
          ref,
        ],
        FETCH_TIMEOUT_MS,
      ),
    );

    const revision = await runGit(
      deps,
      session,
      [`--git-dir=${gitDir}`, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      { signal: options.signal },
    );
    assertGitSucceeded("Reading the commit", revision);
    const sha = revision.tail.at(-1)?.trim() ?? "";

    assertGitSucceeded(
      "Checking out the commit",
      await run([
        `--git-dir=${gitDir}`,
        `--work-tree=${workTree}`,
        "checkout",
        "--force",
        "--detach",
        "FETCH_HEAD",
      ]),
    );
    return { sha };
  });
}
