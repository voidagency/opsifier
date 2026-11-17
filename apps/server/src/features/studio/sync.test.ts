import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSyncResult, SYNC_SCRIPT, type SyncScriptResult } from "./sync";

const hasTools =
  spawnSync("python3", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;
const TOKEN = "studio-test-token";
const GITHUB = "https://github.com/acme/site.git";
// Git as a fresh server has it: no one's own settings, signing or hooks.
const base = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

let root: string;
let origin: string;
/** The project's folder, as the Studio holds it. */
let folder: string;
/** Someone else's copy, Lovable's say, that pushes to GitHub. */
let other: string;
/** Left by anything the folder's settings made git run. */
let marker: string;

function git(dir: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", dir, ...args], { env: base, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }
  return run.stdout.trim();
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

/** A change pushed to GitHub from elsewhere. */
function pushed(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    write(other, file, text);
  }
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "From elsewhere");
  git(other, "push", "-q", "origin", "main");
}

/**
 * Runs the script as a project's own agent server would: its container's git settings send GitHub's
 * address to the panel, played here by the repository on disk.
 */
function sync(request: Record<string, unknown> = {}): SyncScriptResult | null {
  const relay = request.relay !== false;
  const env = relay
    ? {
        ...base,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
        GIT_CONFIG_VALUE_0: GITHUB,
      }
    : base;
  const run = spawnSync("python3", ["-c", SYNC_SCRIPT], {
    input: JSON.stringify({
      dir: folder,
      url: GITHUB,
      ...(relay ? { relay: true } : { agentUrl: "http://127.0.0.1:9", secret: "GITHUB_TOKEN", token: TOKEN }),
      ...request,
    }),
    env,
    encoding: "utf8",
  });
  // The token never comes back, whatever happened.
  expect(`${run.stdout}${run.stderr}`).not.toContain(TOKEN);
  return readSyncResult(run.stdout);
}

/** A script the folder's settings name, which leaves a mark, and what it saw, if it ever runs. */
function trap(name: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\nenv >> ${marker}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opsifier-sync-"));
  marker = join(root, "ran");
  origin = join(root, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: base });
  const seed = join(root, "seed");
  spawnSync("git", ["init", "-q", "-b", "main", seed], { env: base });
  write(seed, "package.json", '{"devDependencies":{"vite":"7.0.0"}}\n');
  write(seed, "src/App.tsx", "export const App = () => 'one';\n");
  write(seed, "src/routeTree.gen.ts", "// routes, in one order\n");
  write(seed, "README.md", "A project\n");
  write(seed, ".gitignore", ".env.local\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "First");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  folder = join(root, "folder");
  other = join(root, "other");
  spawnSync("git", ["clone", "-q", origin, folder], { env: base });
  spawnSync("git", ["clone", "-q", origin, other], { env: base });
  // As the Studio's copy: its remote is the project's address on GitHub.
  git(folder, "remote", "set-url", "origin", GITHUB);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasTools)("bringing a project's folder up to date with GitHub", () => {
  it("says so when GitHub has nothing new", () => {
    expect(sync()).toMatchObject({ ok: true, state: "current", branch: "main", behind: 0, ahead: 0 });
  });

  it("brings in what GitHub has, and says when it brings new packages", () => {
    pushed({ "src/App.tsx": "export const App = () => 'two';\n" });

    expect(sync()).toMatchObject({ ok: true, state: "updated", pulled: 1, behind: 0, dependencies: false });
    expect(readFileSync(join(folder, "src/App.tsx"), "utf8")).toContain("two");
    // The agent's own view of GitHub follows: it has nothing to push.
    expect(git(folder, "rev-parse", "origin/main")).toBe(git(folder, "rev-parse", "HEAD"));

    pushed({ "package.json": '{"devDependencies":{"vite":"7.1.0"}}\n' });
    expect(sync()).toMatchObject({ state: "updated", pulled: 1, dependencies: true });
  });

  it("goes around changes made here that GitHub's do not touch, and keeps them", () => {
    write(folder, "README.md", "A project, changed here\n");
    pushed({ "src/App.tsx": "export const App = () => 'two';\n" });

    expect(sync()).toMatchObject({ state: "updated", pulled: 1, changed: 1 });
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe("A project, changed here\n");
  });

  it("leaves alone changes made here that GitHub's touch, and says which files are in the way", () => {
    write(folder, "src/App.tsx", "export const App = () => 'mine';\n");
    pushed({ "src/App.tsx": "export const App = () => 'theirs';\n" });

    expect(sync()).toMatchObject({ state: "blocked", behind: 1, changed: 1, blocking: ["src/App.tsx"] });
    expect(readFileSync(join(folder, "src/App.tsx"), "utf8")).toContain("mine");
  });

  it("never overwrites a file kept out of git here that GitHub starts to keep", () => {
    write(folder, ".env.local", "SECRET=made-here\n");
    write(other, ".gitignore", "");
    pushed({ ".env.local": "SECRET=from-github\n" });

    expect(sync()).toMatchObject({ state: "blocked", blocking: [".env.local"] });
    expect(readFileSync(join(folder, ".env.local"), "utf8")).toBe("SECRET=made-here\n");
  });

  it("sets back the route tree a development server writes, when it is all that is in the way", () => {
    write(folder, "src/routeTree.gen.ts", "// routes, in another order\n");
    pushed({ "src/routeTree.gen.ts": "// routes, with a new page\n" });

    expect(sync()).toMatchObject({ state: "updated", pulled: 1 });
    expect(readFileSync(join(folder, "src/routeTree.gen.ts"), "utf8")).toBe("// routes, with a new page\n");
  });

  it("leaves the folder as it is when changes saved here are not on GitHub", () => {
    write(folder, "src/App.tsx", "export const App = () => 'mine';\n");
    git(folder, "commit", "-q", "-am", "Here");
    const here = git(folder, "rev-parse", "HEAD");
    const known = git(folder, "rev-parse", "origin/main");

    expect(sync()).toMatchObject({ state: "ahead", ahead: 1, behind: 0 });

    pushed({ "README.md": "Changed elsewhere\n" });
    expect(sync()).toMatchObject({ state: "diverged", ahead: 1, behind: 1 });
    expect(git(folder, "rev-parse", "HEAD")).toBe(here);
    // What the agent knows of GitHub stays as it was: a push with a lease still sees the new change.
    expect(git(folder, "rev-parse", "origin/main")).toBe(known);
    expect(git(folder, "for-each-ref", "refs/opsifier")).toBe("");
  });

  it("only looks while the agent is at work", () => {
    const here = git(folder, "rev-parse", "HEAD");
    pushed({ "README.md": "Changed elsewhere\n" });

    expect(sync({ fetchOnly: true })).toMatchObject({ state: "deferred", behind: 1 });
    expect(git(folder, "rev-parse", "HEAD")).toBe(here);
    expect(git(folder, "rev-parse", "origin/main")).toBe(here);
  });

  it("takes away an ignored route tree that GitHub starts to keep, the development server writing it again", () => {
    // GitHub stops keeping the route tree, then keeps it again; the folder had one of its own meanwhile.
    git(other, "rm", "-q", "--cached", "src/routeTree.gen.ts");
    pushed({ ".gitignore": ".env.local\nsrc/routeTree.gen.ts\n" });
    expect(sync()).toMatchObject({ state: "updated" });
    write(folder, "src/routeTree.gen.ts", "// routes, written here\n");
    pushed({ ".gitignore": ".env.local\n", "src/routeTree.gen.ts": "// routes, from GitHub\n" });

    expect(sync()).toMatchObject({ state: "updated", pulled: 1 });
    expect(readFileSync(join(folder, "src/routeTree.gen.ts"), "utf8")).toBe("// routes, from GitHub\n");
  });

  it("waits for nothing while git is at work in the folder, and tells a stopped operation apart", () => {
    const lock = join(folder, ".git", "index.lock");
    writeFileSync(lock, "");
    expect(sync()).toEqual({ ok: false, code: "busy" });

    // A lock older than ten minutes was left behind by a git that stopped.
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(lock, old, old);
    expect(sync()).toEqual({ ok: false, code: "interrupted" });

    rmSync(lock);
    // Any lock git left behind, not only the index's.
    const refLock = join(folder, ".git", "refs", "remotes", "origin", "main.lock");
    writeFileSync(refLock, "");
    utimesSync(refLock, old, old);
    expect(sync()).toEqual({ ok: false, code: "interrupted" });

    rmSync(refLock);
    writeFileSync(join(folder, ".git", "MERGE_HEAD"), `${git(folder, "rev-parse", "HEAD")}\n`);
    expect(sync()).toEqual({ ok: false, code: "interrupted" });
  });

  it("says when the folder is not a copy, is on no branch, or its branch is not on GitHub", () => {
    git(folder, "checkout", "-q", "-b", "draft");
    expect(sync()).toEqual({ ok: false, code: "no_branch", branch: "draft" });

    git(folder, "checkout", "-q", "--detach");
    expect(sync()).toEqual({ ok: false, code: "detached" });

    rmSync(join(folder, ".git"), { recursive: true });
    expect(sync()).toEqual({ ok: false, code: "not_a_copy" });
  });

  it("does not follow a .git that leads to another folder's", () => {
    const elsewhere = join(root, "elsewhere");
    spawnSync("git", ["clone", "-q", origin, elsewhere], { env: base });
    rmSync(join(folder, ".git"), { recursive: true });
    symlinkSync(join(elsewhere, ".git"), join(folder, ".git"));

    expect(sync()).toEqual({ ok: false, code: "not_a_copy" });
  });

  it("runs nothing the folder's settings name, and fetches from nowhere they say", () => {
    git(folder, "config", "core.fsmonitor", trap("fsmonitor"));
    mkdirSync(join(folder, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-merge", "reference-transaction", "post-checkout"]) {
      writeFileSync(join(folder, ".git", "hooks", hook), `#!/bin/sh\nenv >> ${marker}\n`);
      chmodSync(join(folder, ".git", "hooks", hook), 0o755);
    }
    git(folder, "config", "branch.main.remote", `--upload-pack=${trap("upload-pack")}`);
    git(folder, "branch", "draft");
    const draft = git(folder, "rev-parse", "draft");
    git(folder, "config", "branch.main.merge", "+refs/heads/main:refs/heads/draft");
    pushed({ "src/App.tsx": "export const App = () => 'two';\n", "README.md": "Changed elsewhere\n" });
    // What setting the traps up ran itself is not the script's doing.
    rmSync(marker, { force: true });

    expect(sync()).toMatchObject({ state: "updated", pulled: 1 });
    expect(existsSync(marker)).toBe(false);
    expect(git(folder, "rev-parse", "draft")).toBe(draft);
    // The traps were live: git left to the folder's settings runs them.
    git(folder, "status");
    expect(existsSync(marker)).toBe(true);
  });

  it("never runs with a token: only a project's own agent server, through the panel", () => {
    git(folder, "config", "core.fsmonitor", trap("fsmonitor"));
    const here = git(folder, "rev-parse", "HEAD");
    pushed({ "README.md": "Changed elsewhere\n" });
    rmSync(marker, { force: true });

    expect(sync({ relay: false })).toMatchObject({ ok: false, code: "failed" });
    expect(existsSync(marker)).toBe(false);
    expect(git(folder, "rev-parse", "HEAD")).toBe(here);
  });
});
