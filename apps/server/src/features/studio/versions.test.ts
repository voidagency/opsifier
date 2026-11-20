import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requirementFor } from "../access/policy";
import { VERSIONS_SCRIPT } from "./version-script";

describe("a project's versions", () => {
  it("are for whoever the project is shared with, as its conversations are", () => {
    const studio = requirementFor("POST", "/api/v1/projects/lovable/services/site/studio/conversations");
    expect(studio).toMatchObject({ kind: "studio", project: "lovable", service: "site" });
    const base = "/api/v1/projects/lovable/services/site/studio/versions";
    expect(requirementFor("GET", base)).toEqual(studio);
    expect(requirementFor("POST", `${base}/${"a".repeat(40)}/view`)).toEqual(studio);
    expect(requirementFor("POST", `${base}/current`)).toEqual(studio);
  });
});

const hasTools =
  spawnSync("python3", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasTools)("the script that shows a version in the agent server's container", () => {
  let dir: string;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
    GIT_COMMITTER_NAME: "Agent",
    GIT_COMMITTER_EMAIL: "agent@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  const git = (args: string[], at?: number) => {
    const run = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env:
        at === undefined
          ? env
          : { ...env, GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000` },
    });
    if (run.status !== 0) {
      throw new Error(run.stderr);
    }
    return run.stdout.trim();
  };
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const read = (file: string) => readFileSync(join(dir, file), "utf8");
  /** Saves the files as one version, at a given second. */
  const save = (files: Record<string, string>, subject: string, at: number) => {
    for (const [file, text] of Object.entries(files)) {
      write(file, text);
    }
    git(["add", "--", ...Object.keys(files)]);
    git(["commit", "-q", "-m", subject], at);
    return git(["rev-parse", "HEAD"]);
  };
  const run = (request: Record<string, unknown>, extraEnv: Record<string, string> = {}) => {
    const outcome = spawnSync("python3", ["-c", VERSIONS_SCRIPT], {
      input: JSON.stringify({ dir, ...request }),
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    });
    const line = outcome.stdout.split("\n").find((one) => one.startsWith("opsifier-studio-versions "));
    return line === undefined
      ? { stderr: outcome.stderr }
      : (JSON.parse(line.slice("opsifier-studio-versions ".length)) as Record<string, unknown>);
  };
  const branch = () => git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const MARKER = () => join(dir, ".git", "opsifier-studio-version");

  let first: string;
  let second: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opsifier-versions-"));
    git(["init", "-q", "-b", "main"]);
    first = save(
      { "src/App.tsx": "un", "src/routeTree.gen.ts": "routes 1" },
      "Premier jet de la page",
      1_795_000_000,
    );
    second = save(
      { "src/App.tsx": "deux", "src/Contact.tsx": "contact" },
      "Ajoute le formulaire de contact",
      1_795_100_000,
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the branch's versions, the newest first", () => {
    expect(run({ action: "list", limit: 50 })).toEqual({
      ok: true,
      branch: "main",
      detached: false,
      shown: null,
      versions: [
        { sha: second, at: 1_795_100_000, subject: "Ajoute le formulaire de contact" },
        { sha: first, at: 1_795_000_000, subject: "Premier jet de la page" },
      ],
    });
    expect(run({ action: "list", limit: 1 })).toMatchObject({ versions: [{ sha: second }] });
  });

  it("shows an earlier version, says so from the folder itself, and brings the current one back", () => {
    expect(run({ action: "view", sha: first, branch: null })).toEqual({
      ok: true,
      branch: "main",
      stashed: false,
      sha: first,
      at: 1_795_000_000,
      subject: "Premier jet de la page",
    });
    expect(read("src/App.tsx")).toBe("un");
    expect(existsSync(join(dir, "src/Contact.tsx"))).toBe(false);
    expect(branch()).toBe("HEAD");
    expect(JSON.parse(readFileSync(MARKER(), "utf8"))).toEqual({ branch: "main" });

    // Asked nothing, the folder says which version it shows and which branch to come back to.
    expect(run({ action: "list", limit: 50 })).toMatchObject({
      branch: null,
      detached: true,
      shown: { sha: first, at: 1_795_000_000, subject: "Premier jet de la page", branch: "main" },
      versions: [{ sha: second }, { sha: first }],
    });
    expect(run({ action: "view", sha: second })).toMatchObject({ ok: true, sha: second, branch: "main" });
    expect(run({ action: "view", sha: first })).toMatchObject({ ok: true, sha: first });

    expect(run({ action: "return" })).toEqual({ ok: true, branch: "main", stashed: false });
    expect(branch()).toBe("main");
    expect(read("src/App.tsx")).toBe("deux");
    expect(read("src/Contact.tsx")).toBe("contact");
    expect(existsSync(MARKER())).toBe(false);
    // Back already.
    expect(run({ action: "return", branch: "main" })).toEqual({ ok: true, branch: "main", stashed: false });
  });

  it("leaves changes not saved yet as they are, but for the file the preview writes again", () => {
    write("src/App.tsx", "trois");
    expect(run({ action: "view", sha: first, branch: null })).toEqual({
      ok: false,
      code: "changed",
      files: ["src/App.tsx"],
    });
    expect(run({ action: "status" })).toEqual({ ok: false, code: "changed", files: ["src/App.tsx"] });
    expect(read("src/App.tsx")).toBe("trois");
    expect(branch()).toBe("main");
    expect(existsSync(MARKER())).toBe(false);

    git(["checkout", "--", "src/App.tsx"]);
    expect(run({ action: "status" })).toEqual({ ok: true });
    // The router's file, written again by the development server, and a file git does not track.
    write("src/routeTree.gen.ts", "routes 2");
    write("notes.txt", "à garder");
    expect(run({ action: "view", sha: first, branch: null })).toMatchObject({ ok: true });
    expect(read("src/routeTree.gen.ts")).toBe("routes 1");
    expect(read("notes.txt")).toBe("à garder");
    expect(run({ action: "status" })).toEqual({ ok: false, code: "detached" });
  });

  it("sets aside what changed while a version was shown, and still comes back", () => {
    expect(run({ action: "view", sha: first })).toMatchObject({ ok: true });
    // A lockfile written again by an install, and a file the branch has, made again meanwhile.
    write("src/App.tsx", "écrit pendant l'aperçu");
    write("src/Contact.tsx", "refait pendant l'aperçu");
    expect(run({ action: "return" })).toEqual({ ok: true, branch: "main", stashed: true });
    expect(branch()).toBe("main");
    expect(read("src/App.tsx")).toBe("deux");
    expect(read("src/Contact.tsx")).toBe("contact");
    expect(git(["status", "--porcelain"])).toBe("");
    const stashes = git(["stash", "list"]).split("\n");
    expect(stashes).toHaveLength(2);
    expect(
      stashes.every((one) =>
        one.includes("Opsifier Studio: changes made while an earlier version was shown"),
      ),
    ).toBe(true);
    // Nothing is lost: both are in the stash.
    expect(git(["stash", "show", "-p", "--include-untracked", "stash@{0}"])).toContain(
      "refait pendant l'aperçu",
    );
    expect(git(["stash", "show", "-p", "stash@{1}"])).toContain("écrit pendant l'aperçu");
  });

  it("never writes over a file git does not keep, such as the site's settings", () => {
    save({ ".env": "SECRET=ancien" }, "Ajoute les réglages", 1_795_200_000);
    const tracked = git(["rev-parse", "HEAD"]);
    git(["rm", "-q", "--cached", ".env"]);
    save({ ".gitignore": ".env\n" }, "Ne suit plus les réglages", 1_795_300_000);
    write(".env", "SECRET=actuel");

    expect(run({ action: "view", sha: tracked })).toEqual({ ok: false, code: "overwrite", files: [".env"] });
    expect(read(".env")).toBe("SECRET=actuel");
    expect(branch()).toBe("main");
    expect(existsSync(MARKER())).toBe(false);
  });

  it("refuses what is not a version of the branch", () => {
    expect(run({ action: "view", sha: "f".repeat(40), branch: null })).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(run({ action: "view", sha: "HEAD~1", branch: null })).toEqual({ ok: false, code: "unknown" });
    git(["checkout", "-q", "-b", "essai"]);
    const aside = save({ "src/App.tsx": "essai" }, "Essai", 1_795_200_000);
    git(["checkout", "-q", "main"]);
    expect(run({ action: "view", sha: aside, branch: null })).toEqual({ ok: false, code: "unknown" });
    // The branch the folder is on is the one to come back to, whatever the request says.
    expect(run({ action: "view", sha: aside, branch: "essai" })).toEqual({ ok: false, code: "unknown" });
    expect(branch()).toBe("main");

    // A folder someone left on no branch, with nothing to say which to come back to.
    git(["checkout", "-q", "--detach", first]);
    expect(run({ action: "view", sha: first, branch: null })).toEqual({ ok: false, code: "detached" });
    expect(run({ action: "return", branch: "partie" })).toEqual({ ok: false, code: "no_branch" });
    expect(run({ action: "return", branch: "--orphan" })).toEqual({ ok: false, code: "no_branch" });
    // Told which, it comes back.
    expect(run({ action: "return", branch: "main" })).toMatchObject({ ok: true, branch: "main" });
    expect(run({ action: "remove" })).toEqual({ ok: false, code: "bad_request" });

    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(run({ action: "list", limit: 50 })).toEqual({ ok: false, code: "not_a_copy" });
  });

  it("leaves as it is a folder whose own git settings run commands", () => {
    const trap = join(dir, "..", `${dir.split("/").at(-1)}-trap`);
    git(["config", "--local", "filter.trap.smudge", `touch ${trap}`]);
    write(".gitattributes", "* filter=trap\n");
    expect(run({ action: "view", sha: first })).toEqual({ ok: false, code: "unsafe" });
    expect(run({ action: "status" })).toEqual({ ok: false, code: "unsafe" });
    expect(existsSync(trap)).toBe(false);
    expect(branch()).toBe("main");
    // Reading the versions runs no filter.
    expect(run({ action: "list", limit: 50 })).toMatchObject({ ok: true });
  });

  it("gives git none of the agent server's keys", () => {
    const bin = join(dir, "..", `${dir.split("/").at(-1)}-bin`);
    const dump = join(bin, "env.txt");
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\nenv >> "${dump}"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    try {
      expect(
        run(
          { action: "list", limit: 50 },
          {
            PATH: `${bin}:${process.env.PATH}`,
            SESSION_API_KEY: "clé-de-session",
            GITHUB_TOKEN: "ghp_secret",
          },
        ),
      ).toMatchObject({ ok: true });
      const seen = readFileSync(dump, "utf8");
      expect(seen).toContain("GIT_TERMINAL_PROMPT=0");
      expect(seen).not.toContain("clé-de-session");
      expect(seen).not.toContain("ghp_secret");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("keeps its answer short, whatever the agent wrote", () => {
    for (let index = 0; index < 60; index += 1) {
      git(
        ["commit", "-q", "--allow-empty", "-m", `${"Réécrit l'en-tête élégamment ".repeat(12)}${index}`],
        1_795_200_000 + index,
      );
    }
    const listed = run({ action: "list", limit: 50 }) as { versions: { subject: string }[] };
    expect(listed.versions).toHaveLength(50);
    expect(listed.versions.every((one) => one.subject.length <= 200)).toBe(true);
    const output = spawnSync("python3", ["-c", VERSIONS_SCRIPT], {
      input: JSON.stringify({ dir, action: "list", limit: 50 }),
      encoding: "utf8",
    }).stdout;
    expect(output.length).toBeLessThan(256 * 1024);
  });
});
