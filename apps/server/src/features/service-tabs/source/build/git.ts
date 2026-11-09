import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDeps } from "../../../../core/context";
import { Redactor, type ToolResult, ToolTimeoutError } from "../../../../core/tools";
import { SSH_KEY_CONTEXT } from "../stored";
import { exceedsTreeSize, MAX_UNPACKED_BYTES, watchTreeSize } from "./archive";
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
  /** The registry's `known_hosts` lines for this host. ssh refuses anything not in them. */
  knownHosts: string;
}

/** What is wrong, which decides what can be done about it. `unreachable` is everything not told apart. */
export type GitFailureKind = "access" | "ref-missing" | "network" | "size" | "unreachable";

export type ProbeResult = { ok: true } | { ok: false; reason: GitFailureKind; detail: string };

/** Git's phrasing of each kind of failure, from the transports the panel uses. */
const GIT_FAILURE_PATTERNS: ReadonlyArray<readonly [GitFailureKind, RegExp]> = [
  [
    "ref-missing",
    /couldn'?t find remote ref|not our ref|no such ref|bad object|upload-pack: not|unknown revision/i,
  ],
  [
    "access",
    /authentication failed|could not read (?:username|password)|permission denied|access denied|not found|does not appear to be a git repository|host key verification failed|\b40[134]\b|forbidden|unauthorized/i,
  ],
  ["size", /no space left|exceeds? (?:the )?(?:maximum|size|limit)|too large|file size limit|pack exceeds/i],
  [
    "network",
    /could not resolve|couldn'?t resolve|timed? ?out|connection refused|network is unreachable|no route to host|connection reset|ssl certificate|tls handshake|gnutls|early eof|unexpected disconnect|hung up|failed to connect|temporary failure/i,
  ],
];

export function gitFailureKind(tail: readonly string[]): GitFailureKind {
  const text = tail.join("\n");
  return GIT_FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unreachable";
}

/** A fetch that failed, said in a way a person can act on. `kind` says which way it failed. */
export class GitSourceError extends Error {
  override readonly name = "GitSourceError";

  constructor(
    readonly kind: GitFailureKind,
    message: string,
  ) {
    super(message);
  }
}

function failureMessage(kind: GitFailureKind, ref: string, detail: string): string {
  const because = detail === "" ? "" : ` (${detail})`;
  switch (kind) {
    case "access":
      return `The repository refused access to it, or isn't at that address${because}. Check the address and that the deploy key or GitHub token can still read it, then deploy again.`;
    case "ref-missing":
      return FULL_SHA.test(ref)
        ? `Commit ${ref.slice(0, 12)} can no longer be fetched: it was rewritten by a force push or removed from the repository${because}. Nothing was deployed. Point the source at a branch, a tag or a commit that still exists, then deploy again.`
        : `The repository has no branch, tag or commit named ${ref}${because}. Nothing was deployed. Point the source at one that exists, then deploy again.`;
    case "network":
      return `The repository could not be reached over the network${because}. Check that this server can reach it, then deploy again.`;
    case "size":
      return `The repository is too large to fetch${because}. Remove large files from it or free some disk space, then deploy again.`;
    case "unreachable":
      return `The repository could not be read${because}. Check the source, then deploy again.`;
  }
}

export interface GitOptions {
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  /** How much a checkout may take up on disk. Defaults to the limit on uploaded archives. */
  maxBytes?: number;
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
      // With the path in the entry and useHttpPath below, the token answers for this repository alone.
      const repository = new URL(remote.url);
      const entry = `https://x-access-token:${encodeURIComponent(remote.token)}@${repository.host}${repository.pathname}\n`;
      await writeFile(file, entry, { mode: 0o600, flag: "wx" });
      redact.addToken(remote.token);
      // The empty value clears any helper configured elsewhere. Git runs this one through a shell,
      // which is why the only variable part of it is a path this function chose.
      config.push(["credential.helper", ""], ["credential.helper", `store --file=${singleQuote(file)}`]);
      config.push(["credential.useHttpPath", "true"]);
    }
    // A redirect could carry a credential to a repository it was never given for.
    config.push(["http.followRedirects", "false"], ["http.sslVerify", "true"]);

    let identity: string[] = [];
    if (remote.sealedKey !== null) {
      const key = deps.secrets.unseal(remote.sealedKey, SSH_KEY_CONTEXT);
      const file = join(dir, "deploy_key");
      await writeFile(file, key, { mode: 0o600, flag: "wx" });
      redact.add(key);
      identity = ["-i", singleQuote(file), "-o", "IdentitiesOnly=yes"];
    }

    // Empty for a host the registry does not know, which makes ssh refuse it.
    const knownHosts = join(dir, "known_hosts");
    await writeFile(knownHosts, remote.knownHosts, { mode: 0o600, flag: "wx" });

    const env: Record<string, string> = {
      ...inheritedEnv(),
      HOME: dir,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: options.allowProtocols ?? ALLOWED_GIT_PROTOCOLS,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      // The server has to be one the registry knows, with the key the registry holds for it.
      GIT_SSH_COMMAND: [
        "ssh",
        "-F",
        "/dev/null",
        ...identity,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        singleQuote(`UserKnownHostsFile="${knownHosts}"`),
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

/** What git adds to any failure of ssh, which would otherwise crowd out the reason ssh gave. */
const GIT_BOILERPLATE = [
  /^Could not read from remote repository\.?$/i,
  /^Please make sure you have the correct access rights$/i,
  /^and the repository exists\.?$/i,
];

/** What actually went wrong, in git's words: the last lines of its output, without secrets. */
export function describeGitFailure(tail: readonly string[]): string {
  const lines = tail
    .map((line) => line.replace(/^(?:fatal|error|remote):\s*/i, "").trim())
    .filter((line) => line !== "");
  const meaningful = lines.filter((line) => !GIT_BOILERPLATE.some((pattern) => pattern.test(line)));
  return (meaningful.length > 0 ? meaningful : lines).slice(-2).join(" ").slice(0, 400);
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
        return { ok: false, reason: "network", detail: "The remote did not answer in time." };
      }
      throw error;
    }
    if (result.exitCode === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: result.exitCode === 2 ? "ref-missing" : gitFailureKind(result.tail),
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
    const maxBytes = options.maxBytes ?? MAX_UNPACKED_BYTES;

    // Everything from here on is bounded in time and in what it may put on the disk.
    const budget = new AbortController();
    let tooLarge = false;
    const stopWatching = watchTreeSize([gitDir, workTree], maxBytes, () => {
      tooLarge = true;
      budget.abort(new GitSourceError("size", failureMessage("size", ref, "")));
    });
    const signal =
      options.signal === undefined ? budget.signal : AbortSignal.any([budget.signal, options.signal]);
    const run = (args: readonly string[], timeoutMs?: number) =>
      runGit(deps, session, args, { ...options, signal, timeoutMs });

    try {
      // `--template=` keeps git's sample hooks out of a directory that holds untrusted data.
      assertGitSucceeded(
        "Preparing the checkout",
        await run(["init", "--quiet", "--bare", "--template=", "--", gitDir]),
      );
      const fetched = await run(
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
      ).catch((error: unknown) => {
        if (error instanceof ToolTimeoutError) {
          throw new GitSourceError("network", failureMessage("network", ref, "it took too long to answer"));
        }
        throw error;
      });
      if (fetched.exitCode !== 0) {
        const kind = gitFailureKind(fetched.tail);
        throw new GitSourceError(kind, failureMessage(kind, ref, describeGitFailure(fetched.tail)));
      }

      const revision = await runGit(
        deps,
        session,
        [`--git-dir=${gitDir}`, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        { signal },
      );
      assertGitSucceeded("Reading the commit", revision);
      const sha = revision.tail.at(-1)?.trim() ?? "";

      assertGitSucceeded(
        "Checking out the commit",
        await run(
          [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, "checkout", "--force", "--detach", "FETCH_HEAD"],
          FETCH_TIMEOUT_MS,
        ),
      );
      if (await exceedsTreeSize([gitDir, workTree], maxBytes)) {
        throw new GitSourceError("size", failureMessage("size", ref, ""));
      }
      return { sha };
    } catch (error) {
      throw tooLarge ? new GitSourceError("size", failureMessage("size", ref, "")) : error;
    } finally {
      stopWatching();
    }
  });
}
