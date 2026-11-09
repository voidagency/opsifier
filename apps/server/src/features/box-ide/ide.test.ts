import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxIdeFile, BoxIdeSession, BoxIdeStatus, IssuedBoxIdeToken } from "@opsifier/contract";
import { BOX_RUN_AS, MAX_BOX_IDE_FILE_BYTES } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { services } from "../../core/db/schema";
import {
  apiErrorOf,
  type CallResult,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { boxWorkspaceDir } from "../box/service";
import {
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  readWorkspaceFile,
  removeWorkspaceEntry,
  seedWorkspaceFiles,
  writeWorkspaceFile,
} from "./confined";

const HOUR = 3_600_000;

describe("the workspace itself, from the file system up", () => {
  let root = "";
  let outside = "";

  beforeEach(() => {
    const parent = mkdtempSync(join(tmpdir(), "opsifier-workspace-"));
    root = join(parent, "workspace");
    outside = join(parent, "secret.key");
    mkdirSync(root);
    writeFileSync(outside, "the panel's own secret");
  });

  afterEach(() => {
    rmSync(join(root, ".."), { recursive: true, force: true });
  });

  it("reads and writes files, and swaps content in all at once", async () => {
    const version = await writeWorkspaceFile(root, "a.txt", "hello", null);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");

    const file = await readWorkspaceFile(root, "a.txt", 1024);
    expect(file.content).toBe("hello");
    expect(file.version).toBe(version);

    await writeWorkspaceFile(root, "a.txt", "changed", file.version);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed");
  });

  it("refuses to overwrite a file that changed since it was read", async () => {
    await writeWorkspaceFile(root, "a.txt", "one", null);
    const { version } = await readWorkspaceFile(root, "a.txt", 1024);
    writeFileSync(join(root, "a.txt"), "changed by the app");

    await expect(writeWorkspaceFile(root, "a.txt", "two", version)).rejects.toMatchObject({
      reason: "conflict",
    });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed by the app");
  });

  it("refuses to create a file over one that exists", async () => {
    await writeWorkspaceFile(root, "a.txt", "one", null);
    await expect(writeWorkspaceFile(root, "a.txt", "two", null)).rejects.toMatchObject({
      reason: "exists",
    });
  });

  it.each([
    ["../secret.key"],
    ["a/../../secret.key"],
    ["/etc/passwd"],
    ["a//b"],
    ["./a"],
    ["a\\..\\b"],
    ["a\u0000b"],
  ])("refuses the path %j outright", async (path) => {
    await expect(readWorkspaceFile(root, path, 1024)).rejects.toMatchObject({ reason: "invalid_path" });
    await expect(writeWorkspaceFile(root, path, "x", null)).rejects.toMatchObject({ reason: "invalid_path" });
    await expect(listWorkspaceDirectory(root, path)).rejects.toMatchObject({ reason: "invalid_path" });
    await expect(removeWorkspaceEntry(root, path, true)).rejects.toMatchObject({ reason: "invalid_path" });
  });

  it("won't read, list or write through a link that leaves the workspace", async () => {
    symlinkSync(outside, join(root, "innocent.txt"));
    symlinkSync(join(root, ".."), join(root, "escape"));

    await expect(readWorkspaceFile(root, "innocent.txt", 1024)).rejects.toMatchObject({ reason: "symlink" });
    await expect(readWorkspaceFile(root, "escape/secret.key", 1024)).rejects.toMatchObject({
      reason: "symlink",
    });
    await expect(listWorkspaceDirectory(root, "escape")).rejects.toMatchObject({ reason: "symlink" });
    await expect(writeWorkspaceFile(root, "innocent.txt", "owned", "1-1-1")).rejects.toMatchObject({
      reason: "symlink",
    });
    await expect(writeWorkspaceFile(root, "escape/new.txt", "owned", null)).rejects.toMatchObject({
      reason: "symlink",
    });
    expect(readFileSync(outside, "utf8")).toBe("the panel's own secret");
    expect(existsSync(join(root, "..", "new.txt"))).toBe(false);
  });

  it("shows a link as a link and says nothing of where it points", async () => {
    symlinkSync(outside, join(root, "link"));
    const { entries } = await listWorkspaceDirectory(root, "");
    expect(entries).toEqual([{ name: "link", kind: "symlink" }]);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("deletes a link, not what it points at", async () => {
    symlinkSync(outside, join(root, "link"));
    await removeWorkspaceEntry(root, "link", false);
    expect(existsSync(join(root, "link"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("the panel's own secret");
  });

  it("removes a tree without following a link inside it", async () => {
    mkdirSync(join(root, "tree/deep"), { recursive: true });
    writeFileSync(join(root, "tree/deep/file"), "x");
    symlinkSync(outside, join(root, "tree/deep/link"));

    await removeWorkspaceEntry(root, "tree", true);

    expect(existsSync(join(root, "tree"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("the panel's own secret");
  });

  it("keeps a folder that is not empty unless told otherwise", async () => {
    mkdirSync(join(root, "tree"));
    writeFileSync(join(root, "tree/file"), "x");
    await expect(removeWorkspaceEntry(root, "tree", false)).rejects.toMatchObject({ reason: "not_empty" });
    expect(existsSync(join(root, "tree/file"))).toBe(true);
  });

  it("does not hang on a named pipe left in the workspace", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    await expect(readWorkspaceFile(root, "pipe", 1024)).rejects.toMatchObject({ reason: "not_a_file" });
  });

  it("reports what it won't show as text, without sending it", async () => {
    writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));

    expect(await readWorkspaceFile(root, "image.bin", 1024)).toMatchObject({
      content: null,
      unreadable: "binary",
    });
    expect(await readWorkspaceFile(root, "big.txt", 1024)).toMatchObject({
      content: null,
      unreadable: "too_large",
    });
  });

  it("moves an entry within the workspace, never over one that exists", async () => {
    writeFileSync(join(root, "a"), "1");
    writeFileSync(join(root, "b"), "2");
    await expect(moveWorkspaceEntry(root, "a", "b")).rejects.toMatchObject({ reason: "exists" });

    await moveWorkspaceEntry(root, "a", "c");
    expect(readFileSync(join(root, "c"), "utf8")).toBe("1");
  });

  it("adds starter files only where nothing has that name", async () => {
    writeFileSync(join(root, "kept"), "mine");
    symlinkSync(outside, join(root, "linked"));
    mkdirSync(join(root, "dir"));

    const added = await seedWorkspaceFiles(root, {
      kept: "from the preset",
      linked: "from the preset",
      dir: "from the preset",
      "new/nested/file": "from the preset",
    });

    expect(added).toBe(1);
    expect(readFileSync(join(root, "kept"), "utf8")).toBe("mine");
    expect(readFileSync(outside, "utf8")).toBe("the panel's own secret");
    expect(readFileSync(join(root, "new/nested/file"), "utf8")).toBe("from the preset");
  });

  it("refuses starter files through a link, by not writing them at all", async () => {
    symlinkSync(join(root, ".."), join(root, "public"));
    expect(await seedWorkspaceFiles(root, { "public/index.html": "<h1>" })).toBe(0);
    expect(existsSync(join(root, "..", "index.html"))).toBe(false);
  });

  it("leaves permissions and mode of a file it replaces as they were", async () => {
    await writeWorkspaceFile(root, "a.sh", "one", null);
    chmodSync(join(root, "a.sh"), 0o755);
    const { version } = await readWorkspaceFile(root, "a.sh", 1024);
    await writeWorkspaceFile(root, "a.sh", "two", version);
    expect(readFileSync(join(root, "a.sh"), "utf8")).toBe("two");
    const mode = execFileSync(
      "stat",
      process.platform === "linux" ? ["-c", "%a", join(root, "a.sh")] : ["-f", "%Lp", join(root, "a.sh")],
      {
        encoding: "utf8",
      },
    ).trim();
    expect(mode).toBe("755");
  });

  /**
   * The race a check-then-open would lose: the directory is checked, then swapped for a link, then used.
   * Directory descriptors make the swap irrelevant. Only Linux has them, which is where the panel runs.
   */
  it.runIf(process.platform === "linux")(
    "keeps working on the directory it opened, even if a link replaces it mid-walk",
    async () => {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "dir", "file"), "inside");

      const descriptorFs = await import("node:fs/promises");
      const handle = await descriptorFs.open(root, "r");
      try {
        renameSync(join(root, "dir"), join(root, "moved"));
        symlinkSync(join(root, ".."), join(root, "dir"));

        await expect(readWorkspaceFile(root, "dir/secret.key", 1024)).rejects.toMatchObject({
          reason: "symlink",
        });
        await expect(writeWorkspaceFile(root, "dir/secret.key", "x", null)).rejects.toMatchObject({
          reason: "symlink",
        });
      } finally {
        await handle.close();
      }
    },
  );
});

describe("the IDE as a security boundary", () => {
  let context: TestContext;
  let cookie: string;
  const BOX = "/projects/shop/services/dev";
  const IDE = "/ide/shop/dev";

  const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
    call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

  const withToken = <T = unknown>(token: string | undefined, path: string, method = "GET", body?: unknown) =>
    call<T>(context.app, `/api/v1${path}`, {
      method,
      body,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  const issue = async (hours = 24): Promise<string> => {
    const { body } = await api<IssuedBoxIdeToken>(`${BOX}/box/ide/token`, "POST", { expiresInHours: hours });
    return body.token;
  };

  const workspace = () => boxWorkspaceDir(context.deps, { projectName: "shop", serviceName: "dev" });

  const expectRefused = (result: CallResult<unknown>, code = "ide_unauthorized") => {
    expect(result.status).toBe(401);
    expect(apiErrorOf(result).code).toBe(code);
  };

  beforeEach(async () => {
    context = await createTestContext();
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/box", "POST", { name: "dev", preset: "static-site" });
    await api("/projects/shop/box", "POST", { name: "other", preset: "static-site" });
    writeFileSync(join(workspace(), "notes.txt"), "secret notes");
    await api(`${BOX}/box/ide`, "PUT", { enabled: true });
  });

  afterEach(async () => {
    await context.close();
  });

  describe("who gets in", () => {
    it.each([["session"], ["tree"], ["file?path=notes.txt"]])(
      "gives a request with no token nothing at /%s",
      async (route) => {
        expectRefused(await withToken(undefined, `${IDE}/${route}`));
      },
    );

    it("refuses a wrong token", async () => {
      await issue();
      expectRefused(await withToken("0".repeat(64), `${IDE}/tree`));
    });

    it("answers a malformed Authorization header the same way", async () => {
      await issue();
      const result = await call(context.app, `/api/v1${IDE}/tree`, {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      expectRefused(result);
    });

    it("does not say whether a service exists or has the IDE turned on", async () => {
      const token = await issue();
      const missing = await withToken(token, "/ide/shop/no-such-box/session");
      const disabled = await withToken("x".repeat(64), "/ide/shop/other/session");
      const wrongProject = await withToken(token, "/ide/no-such-project/dev/session");
      expect(missing.body).toEqual(disabled.body);
      expect(missing.body).toEqual(wrongProject.body);
      expectRefused(missing);
    });

    it("is reached with the token alone, and shows the workspace's files", async () => {
      const token = await issue();

      const session = await withToken<BoxIdeSession>(token, `${IDE}/session`);
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({ project: "shop", service: "dev" });

      const file = await withToken<BoxIdeFile>(token, `${IDE}/file?path=notes.txt`);
      expect(file.body.content).toBe("secret notes");
    });

    it("ignores a signed-in panel session: it has its own authentication", async () => {
      await issue();
      expectRefused(
        await call(context.app, `/api/v1${IDE}/file?path=notes.txt`, { cookie, origin: TEST_ORIGIN }),
      );
    });

    it("refuses an API key of the panel, even the owner's", async () => {
      await issue();
      const created = await api<{ token: string }>("/me/api-keys", "POST", {
        name: "x",
        level: "write",
      });
      expect(created.status).toBe(201);
      expectRefused(await withToken(created.body.token, `${IDE}/tree`));
    });

    it("gives the token no way into the rest of the panel", async () => {
      const token = await issue();
      for (const path of ["/projects", `${BOX}/box`, `${BOX}/environment`, "/users"]) {
        const result = await withToken(token, path);
        expect(result.status).toBe(401);
      }
    });

    it("is not offered to any account or key as something it may call", async () => {
      const identity = await api<{ operations: Array<{ path: string }> }>("/auth/identity");
      expect(identity.body.operations.some(({ path }) => path.startsWith("/api/v1/ide/"))).toBe(false);
    });

    it("opens only the box it was issued for", async () => {
      const token = await issue();
      expectRefused(await withToken(token, "/ide/shop/other/tree"));
    });

    it("writes who opened it to the activity log", async () => {
      const token = await issue();
      await withToken(token, `${IDE}/session`);
      const { body } = await api<{ items: Array<{ type: string; title: string }> }>(
        "/actions?serviceName=dev",
      );
      expect(body.items.some((item) => item.type === "box.ide-open")).toBe(true);
    });
  });

  describe("the token's life", () => {
    it("works until it expires, and then says that and nothing more", async () => {
      const token = await issue(1);
      expect((await withToken(token, `${IDE}/session`)).status).toBe(200);

      context.advance(HOUR + 1);

      expectRefused(await withToken(token, `${IDE}/session`), "ide_token_expired");
      expectRefused(await withToken(token, `${IDE}/file?path=notes.txt`), "ide_token_expired");
    });

    it("reports an expired token on the IDE tab", async () => {
      await issue(1);
      context.advance(HOUR + 1);
      const { body } = await api<BoxIdeStatus>(`${BOX}/box/ide`);
      expect(body.access).toBe("expired");
    });

    it("rotating it ends the old token at once and opens with the new one", async () => {
      const first = await issue();
      const second = await issue();

      expectRefused(await withToken(first, `${IDE}/tree`));
      expect((await withToken(second, `${IDE}/tree`)).status).toBe(200);
    });

    it("revoking it refuses the token and leaves nothing to open with", async () => {
      const token = await issue();
      expect((await api(`${BOX}/box/ide/token`, "DELETE")).status).toBe(200);

      expectRefused(await withToken(token, `${IDE}/tree`));
      const { body } = await api<BoxIdeStatus>(`${BOX}/box/ide`);
      expect(body.access).toBe("no_token");
    });

    it("turning the IDE off refuses the token, and turning it back on doesn't revive it", async () => {
      const token = await issue();

      await api(`${BOX}/box/ide`, "PUT", { enabled: false });
      expectRefused(await withToken(token, `${IDE}/tree`));
      expect((await api<BoxIdeStatus>(`${BOX}/box/ide`)).body.access).toBe("off");

      await api(`${BOX}/box/ide`, "PUT", { enabled: true });
      expectRefused(await withToken(token, `${IDE}/tree`));
      expect((await api<BoxIdeStatus>(`${BOX}/box/ide`)).body.access).toBe("no_token");
    });

    it("is stored hashed, and shown only when it is issued", async () => {
      const token = await issue();
      const { body } = await api<BoxIdeStatus>(`${BOX}/box/ide`);
      expect(JSON.stringify(body)).not.toContain(token);
      const stored = JSON.stringify(context.deps.db.select().from(services).all());
      expect(stored).not.toContain(token);
    });

    it("can't be issued to last for ever", async () => {
      const refused = await api(`${BOX}/box/ide/token`, "POST", { expiresInHours: 24 * 365 });
      expect(refused.status).toBe(400);
    });

    it("goes when the account that issued it loses its rights", async () => {
      const operator = await signInMember(context.app, cookie, "op@example.com", [
        { project: "shop", role: "operator" },
      ]);
      const issued = await call<IssuedBoxIdeToken>(context.app, `/api/v1${BOX}/box/ide/token`, {
        method: "POST",
        body: { expiresInHours: 24 },
        cookie: operator,
        origin: TEST_ORIGIN,
      });
      expect(issued.status).toBe(200);
      expect((await withToken(issued.body.token, `${IDE}/tree`)).status).toBe(200);

      const members = await api<{ users: Array<{ id: string; email: string }> }>("/users");
      const id = members.body.users.find((user) => user.email === "op@example.com")?.id;
      expect((await api(`/users/${id}/active`, "POST", { active: false })).status).toBe(200);

      expectRefused(await withToken(issued.body.token, `${IDE}/tree`));
    });

    it("can't be issued by a viewer or an API key", async () => {
      const viewer = await signInMember(context.app, cookie, "v@example.com", [
        { project: "shop", role: "viewer" },
      ]);
      const denied = await call(context.app, `/api/v1${BOX}/box/ide/token`, {
        method: "POST",
        body: { expiresInHours: 24 },
        cookie: viewer,
        origin: TEST_ORIGIN,
      });
      expect(denied.status).toBe(403);

      const created = await api<{ token: string }>("/me/api-keys", "POST", { name: "k", level: "write" });
      const byKey = await call(context.app, `/api/v1${BOX}/box/ide/token`, {
        method: "POST",
        body: { expiresInHours: 24 },
        headers: { authorization: `Bearer ${created.body.token}` },
      });
      expect(byKey.status).toBe(403);
    });

    it("stops an address that keeps guessing", async () => {
      await issue();
      let last = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        last = (await withToken("f".repeat(64), `${IDE}/session`)).status;
      }
      expect(last).toBe(429);
    });
  });

  describe("what it can reach", () => {
    let token = "";

    beforeEach(async () => {
      token = await issue();
    });

    it.each([
      ["file?path=../../../../secret.key"],
      ["file?path=..%2f..%2f..%2fsecret.key"],
      ["file?path=%2Fetc%2Fpasswd"],
      ["file?path=public/../../other"],
      ["tree?path=.."],
      ["tree?path=public/.."],
    ])("refuses the out-of-project path in /%s", async (route) => {
      const result = await withToken(token, `${IDE}/${route}`);
      expect(result.status).toBe(400);
    });

    it("refuses to write outside the workspace through the API", async () => {
      const escaped = await withToken(token, `${IDE}/file`, "PUT", {
        path: "../escaped.txt",
        content: "x",
        version: null,
      });
      expect(escaped.status).toBe(400);
      const moved = await withToken(token, `${IDE}/move`, "POST", { from: "notes.txt", to: "../notes.txt" });
      expect(moved.status).toBe(400);
      expect(existsSync(join(workspace(), "..", "escaped.txt"))).toBe(false);
      expect(readFileSync(join(workspace(), "notes.txt"), "utf8")).toBe("secret notes");
    });

    it("follows no link, even one the service itself planted", async () => {
      const secret = join(context.dataDir, "secret.key");
      expect(existsSync(secret)).toBe(true);
      const before = readFileSync(secret);
      symlinkSync(secret, join(workspace(), "planted"));
      symlinkSync(context.dataDir, join(workspace(), "data"));

      const direct = await withToken(token, `${IDE}/file?path=planted`);
      expect(direct.status).toBe(403);
      expect(apiErrorOf(direct).code).toBe("ide_symlink");

      const through = await withToken(token, `${IDE}/file?path=data/secret.key`);
      expect(through.status).toBe(403);
      expect(JSON.stringify(through.body)).not.toContain(before.toString("hex").slice(0, 8));

      const overwrite = await withToken(token, `${IDE}/file`, "PUT", {
        path: "data/secret.key",
        content: "owned",
        version: null,
      });
      expect(overwrite.status).toBe(403);
      expect(readFileSync(secret).equals(before)).toBe(true);
    });

    it("has no shell, and no route that runs anything", async () => {
      const { body } = await api<{ paths: Record<string, Record<string, unknown>> }>("/openapi.json");
      const routes = Object.keys(body.paths).filter((path) => path.startsWith("/api/v1/ide/"));

      expect(routes.sort()).toEqual([
        "/api/v1/ide/{project}/{service}/directory",
        "/api/v1/ide/{project}/{service}/entry",
        "/api/v1/ide/{project}/{service}/file",
        "/api/v1/ide/{project}/{service}/move",
        "/api/v1/ide/{project}/{service}/session",
        "/api/v1/ide/{project}/{service}/tree",
      ]);
    });

    it("hands what it writes to the box's own user", async () => {
      if (process.getuid?.() !== 0) {
        return;
      }
      await withToken(token, `${IDE}/file`, "PUT", { path: "new.txt", content: "x", version: null });
      const owner = execFileSync("stat", ["-c", "%u", join(workspace(), "new.txt")], { encoding: "utf8" });
      expect(Number(owner)).toBe(BOX_RUN_AS.uid);
    });

    it("refuses a file too large to save", async () => {
      const refused = await withToken(token, `${IDE}/file`, "PUT", {
        path: "big.txt",
        content: "x".repeat(MAX_BOX_IDE_FILE_BYTES + 1),
        version: null,
      });
      expect(refused.status).toBe(413);
    });

    it("edits, creates, moves and deletes inside the workspace", async () => {
      const file = await withToken<BoxIdeFile>(token, `${IDE}/file?path=notes.txt`);
      const saved = await withToken<{ version: string }>(token, `${IDE}/file`, "PUT", {
        path: "notes.txt",
        content: "edited",
        version: file.body.version,
      });
      expect(saved.status).toBe(200);
      expect(readFileSync(join(workspace(), "notes.txt"), "utf8")).toBe("edited");

      expect((await withToken(token, `${IDE}/directory`, "POST", { path: "src" })).status).toBe(200);
      expect(
        (await withToken(token, `${IDE}/move`, "POST", { from: "notes.txt", to: "src/notes.txt" })).status,
      ).toBe(200);
      expect(existsSync(join(workspace(), "src/notes.txt"))).toBe(true);

      expect(
        (await withToken(token, `${IDE}/entry`, "DELETE", { path: "src", recursive: true })).status,
      ).toBe(200);
      expect(existsSync(join(workspace(), "src"))).toBe(false);
    });

    it("says when a file changed under it, instead of overwriting it", async () => {
      const file = await withToken<BoxIdeFile>(token, `${IDE}/file?path=notes.txt`);
      writeFileSync(join(workspace(), "notes.txt"), "the app got there first");

      const refused = await withToken(token, `${IDE}/file`, "PUT", {
        path: "notes.txt",
        content: "mine",
        version: file.body.version,
      });
      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("ide_conflict");
      expect(readFileSync(join(workspace(), "notes.txt"), "utf8")).toBe("the app got there first");
    });
  });
});
