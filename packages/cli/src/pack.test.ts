import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_UPLOAD_BYTES as PANEL_LIMIT } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "./commands";
import { compileIgnoreLine, isIgnored, looksSecret, packFolder } from "./pack";

const rulesOf = (lines: string[], base = "") =>
  lines.map((line) => compileIgnoreLine(line, base)).filter((rule) => rule !== undefined);

describe("ignore files, read as git reads them", () => {
  it.each([
    [["node_modules/"], "node_modules", true, true],
    [["node_modules/"], "app/node_modules", true, true],
    [["node_modules/"], "node_modules", false, false],
    [["*.log"], "server.log", false, true],
    [["*.log"], "logs/deep/server.log", false, true],
    [["/build"], "build", true, true],
    [["/build"], "app/build", true, false],
    [["docs/*.md"], "docs/a.md", false, true],
    [["docs/*.md"], "docs/deep/a.md", false, false],
    [["docs/**/*.md"], "docs/deep/er/a.md", false, true],
    [["docs/**/*.md"], "docs/a.md", false, true],
    [["**/tmp"], "a/b/tmp", true, true],
    [["cache/**"], "cache/x/y", false, true],
    [["*.log", "!keep.log"], "keep.log", false, false],
    [["*.log", "!keep.log"], "other.log", false, true],
    [["# comment", "", "  "], "anything", false, false],
    [["file?.txt"], "file1.txt", false, true],
    [["[ab].txt"], "b.txt", false, true],
    [["[!ab].txt"], "b.txt", false, false],
    [["\\#hash"], "#hash", false, true],
  ])("%j on %s (folder: %s) ignores it: %s", (lines, path, isDirectory, expected) => {
    expect(isIgnored(rulesOf(lines), path, isDirectory)).toBe(expected);
  });

  it("applies the rules of a nested file to that folder only", () => {
    const rules = rulesOf(["secret.txt"], "app");

    expect(isIgnored(rules, "app/secret.txt", false)).toBe(true);
    expect(isIgnored(rules, "app/deep/secret.txt", false)).toBe(true);
    expect(isIgnored(rules, "secret.txt", false)).toBe(false);
  });
});

const hasTar = spawnSync("tar", ["--version"]).error === undefined;

describe.skipIf(!hasTar)("a packed folder", () => {
  let root: string;
  let unpacked: string;
  const longName = `${"a-rather-long-folder-name/".repeat(5)}file-with-a-long-name.txt`;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "opsifier-pack-"));
    root = join(base, "app");
    unpacked = join(base, "unpacked");
    const files: Record<string, string> = {
      Dockerfile: "FROM nginx:1.27\nCOPY . /usr/share/nginx/html\n",
      "index.html": "<h1>hello</h1>\n",
      "src/main.ts": "console.log('hi')\n",
      "src/server.log": "noise\n",
      "src/keep.log": "kept\n",
      "node_modules/dep/index.js": "module.exports = 1\n",
      ".gitignore": "node_modules/\n*.log\n.env\n",
      ".opsifierignore": "!keep.log\n",
      ".env.production": "SECRET=1\n",
      ".env": "SECRET=2\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".opsifier.json": '{"service":"a/b","panel":"https://x"}\n',
      "sub/.gitignore": "local-only.txt\n",
      "sub/local-only.txt": "no\n",
      "sub/shared.txt": "yes\n",
      "café/menu.txt": "crème\n",
      [longName]: "deep\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(root, "run.sh"), 0o755);
    await symlink("index.html", join(root, "home.html"));
    await symlink("../../outside", join(root, "escape"));

    const packed = await packFolder(root, { env: { HOME: base, XDG_CONFIG_HOME: join(base, "xdg") } });
    await writeFile(join(base, "app.tar.gz"), packed.archive);
    await mkdir(unpacked);
    const result = spawnSync("tar", ["-xzf", join(base, "app.tar.gz"), "-C", unpacked]);
    expect(result.status, result.stderr.toString()).toBe(0);
    Object.assign(globalThis, { packed });
  });

  afterAll(async () => {
    await rm(dirname(root), { recursive: true, force: true });
  });

  const packedOf = () => (globalThis as unknown as { packed: Awaited<ReturnType<typeof packFolder>> }).packed;
  const read = (path: string) => readFile(join(unpacked, path), "utf8");
  const exists = (path: string) =>
    stat(join(unpacked, path)).then(
      () => true,
      () => false,
    );

  it("holds the files as they are, long and accented names included", async () => {
    expect(await read("Dockerfile")).toContain("FROM nginx");
    expect(await read("src/main.ts")).toBe("console.log('hi')\n");
    expect(await read("café/menu.txt")).toBe("crème\n");
    expect(await read(longName)).toBe("deep\n");
  });

  it("leaves out what the ignore files leave out, and lets .opsifierignore take something back", async () => {
    expect(await exists("node_modules")).toBe(false);
    expect(await exists("src/server.log")).toBe(false);
    expect(await read("src/keep.log")).toBe("kept\n");
    expect(await exists(".env")).toBe(false);
    expect(await exists("sub/local-only.txt")).toBe(false);
    expect(await read("sub/shared.txt")).toBe("yes\n");
  });

  it("never holds the repository's history or the folder's link", async () => {
    expect(await exists(".git")).toBe(false);
    expect(await exists(".opsifier.json")).toBe(false);
  });

  it("keeps a script runnable, and a link that stays inside", async () => {
    expect((await stat(join(unpacked, "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await readlink(join(unpacked, "home.html"))).toBe("index.html");
  });

  it("leaves out a link that leads outside, and says so", () => {
    expect(packedOf().skipped).toEqual(["escape"]);
  });

  it("names the files that may hold secrets, when nothing ignores them", () => {
    expect(packedOf().secrets).toEqual([".env.production"]);
  });
});

it("refuses archives above the panel's own limit", () => {
  expect(MAX_UPLOAD_BYTES).toBe(PANEL_LIMIT);
});

describe.skipIf(!hasTar)("ignore rules from the whole repository", () => {
  let base: string;
  let listed: string[];
  let packed: Awaited<ReturnType<typeof packFolder>>;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "opsifier-repo-"));
    const repo = join(base, "repo");
    const files: Record<string, string> = {
      ".gitignore": "\uFEFF.env\ndist/\n[z-a]\n",
      ".git/info/exclude": "local-notes.txt\n",
      "apps/api/.gitignore": "tmp/\n",
      "apps/api/index.js": "console.log(1)\n",
      "apps/api/.env": "SECRET=1\n",
      "apps/api/.npmrc": "//registry/:_authToken=x\n",
      "apps/api/dist/bundle.js": "built\n",
      "apps/api/tmp/cache": "x\n",
      "apps/api/local-notes.txt": "mine\n",
      "apps/api/globally-ignored.bak": "old\n",
      "apps/api/conf/v2/app.conf": "on\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    await mkdir(join(base, "xdg", "git"), { recursive: true });
    await writeFile(join(base, "xdg", "git", "ignore"), "*.bak\n");
    await symlink(join(repo, "apps", "api", "conf", "v2"), join(repo, "apps", "api", "conf", "current"));

    packed = await packFolder(join(repo, "apps", "api"), {
      env: { HOME: base, XDG_CONFIG_HOME: join(base, "xdg") },
    });
    await writeFile(join(base, "api.tar.gz"), packed.archive);
    listed = spawnSync("tar", ["-tvzf", join(base, "api.tar.gz")], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const has = (path: string) =>
    listed.some((line) => line.endsWith(` ${path}`) || line.includes(` ${path} -> `));

  it("leaves out what the repository's root ignores, even with a byte-order mark in front", () => {
    expect(has("index.js")).toBe(true);
    expect(has(".env")).toBe(false);
    expect(has("dist/bundle.js")).toBe(false);
  });

  it("applies .git/info/exclude, the global excludes file and the folder's own rules", () => {
    expect(has("local-notes.txt")).toBe(false);
    expect(has("globally-ignored.bak")).toBe(false);
    expect(has("tmp/cache")).toBe(false);
  });

  it("names what may hold secrets, an .npmrc included", () => {
    expect(packed.secrets).toEqual([".npmrc"]);
  });

  it("writes a link given as an absolute path from the link itself", () => {
    const line = listed.find((entry) => entry.includes(" conf/current -> "));
    expect(line?.endsWith(" conf/current -> v2")).toBe(true);
  });
});

describe("files that may hold secrets", () => {
  it.each([
    [".env", true],
    [".env.production", true],
    [".env.example", false],
    [".env.sample", false],
    ["config/.npmrc", true],
    ["deploy/id_ed25519", true],
    ["certs/site.pem", true],
    ["home/.ssh/config", true],
    ["home/.docker/config.json", true],
    ["credentials-prod.json", true],
    ["src/environment.ts", false],
    ["README.md", false],
  ])("%s: %s", (path, expected) => {
    expect(looksSecret(path)).toBe(expected);
  });
});
