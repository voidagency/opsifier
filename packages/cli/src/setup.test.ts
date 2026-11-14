import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionDetail, ProjectSummary, ServiceDetail, SourceSettings } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";
import { LINK_FILE } from "./link";

let panel: LivePanel;
let other: LivePanel;
let key: string;
let otherKey: string;
let scratch: string;

beforeAll(async () => {
  [panel, other] = await Promise.all([startLivePanel(), startLivePanel()]);
  key = (await panel.createKey({ name: "setup", level: "write" })).token;
  otherKey = (await other.createKey({ name: "other", level: "write" })).token;
  scratch = await mkdtemp(join(tmpdir(), "opsifier-setup-"));
});

afterAll(async () => {
  await Promise.all([panel.close(), other.close()]);
  await rm(scratch, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function folder(name: string): Promise<string> {
  const path = join(scratch, name);
  await mkdir(path, { recursive: true });
  return path;
}

async function run(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    signal: new AbortController().signal,
    cwd: await folder("nowhere"),
    credentialsFile: join(scratch, "unused-credentials.json"),
    ...overrides,
  });
  return { code, stdout, stderr };
}

const jsonOf = <T = unknown>(result: CliResult): T => JSON.parse(result.stdout) as T;
const errorOf = (result: CliResult) =>
  (JSON.parse(result.stderr) as { error: { code: string; message: string; hint?: string } }).error;
const originOf = (live: LivePanel) => new URL(live.url).origin;

describe("logging in", () => {
  const file = () => join(scratch, "login", "credentials.json");
  const asked: string[] = [];
  const secret = (value: string) => async (prompt: string) => {
    asked.push(prompt);
    return value;
  };

  it("keeps a key the panel accepted, in a file only its owner can read", async () => {
    const result = await run(["login", panel.url], {
      env: {},
      credentialsFile: file(),
      readSecret: secret(key),
    });

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toMatchObject({ panel: originOf(panel), user: "admin@example.com", file: file() });
    expect(asked.at(-1)).toContain(originOf(panel));
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain(key);
    expect(result.stderr).not.toContain(key);
  });

  it("then needs no environment variables at all", async () => {
    const result = await run(["projects"], { env: {}, credentialsFile: file() });

    expect(result.code).toBe(0);
    expect(jsonOf<{ projects: ProjectSummary[] }>(result).projects.map((project) => project.name)).toContain(
      "shop",
    );
  });

  it("keeps nothing when the panel refuses the key", async () => {
    const before = await readFile(file(), "utf8");

    const result = await run(["login", other.url], {
      env: {},
      credentialsFile: file(),
      readSecret: secret("nope"),
    });

    expect(result.code).toBe(3);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  it("refuses a key from the environment without the panel it belongs to", async () => {
    const result = await run(["projects"], { env: { OPSIFIER_API_KEY: key }, credentialsFile: file() });

    expect(result.code).toBe(3);
    expect(errorOf(result).message).toContain("OPSIFIER_URL");
  });

  it("uses the key kept for the panel OPSIFIER_URL names", async () => {
    const result = await run(["whoami"], { env: { OPSIFIER_URL: panel.url }, credentialsFile: file() });

    expect(result.code).toBe(0);
  });

  it("talks to the panel a folder is linked to, whichever panel was logged in to last", async () => {
    await panel.direct(key, "POST", "/api/v1/projects", { name: "only-on-first" });
    const linked = await folder("linked-to-first");
    await run(["link", "shop/web"], { cwd: linked });
    await run(["login", other.url], { env: {}, credentialsFile: file(), readSecret: secret(otherKey) });
    const names = (result: CliResult) =>
      jsonOf<{ projects: ProjectSummary[] }>(result).projects.map((project) => project.name);

    const inLinked = await run(["projects"], { env: {}, credentialsFile: file(), cwd: linked });
    expect(inLinked.code).toBe(0);
    expect(names(inLinked)).toContain("only-on-first");

    const elsewhere = await run(["projects"], { env: {}, credentialsFile: file() });
    expect(elsewhere.code).toBe(0);
    expect(names(elsewhere)).not.toContain("only-on-first");
  });

  it("says when the key file can be read by others", async () => {
    await chmod(file(), 0o644);

    const result = await run(["whoami"], { env: {}, credentialsFile: file(), isTTY: true });

    expect(result.stderr).toContain("chmod 600");
    await chmod(file(), 0o600);
  });

  it("forgets a panel's key on logout, never leaving another panel current in its place", async () => {
    const first = await run(["logout"], { env: {}, credentialsFile: file() });
    expect(jsonOf(first)).toEqual({ panel: originOf(other), removed: true, current: null });
    const nowhere = await run(["projects"], { env: {}, credentialsFile: file() });
    expect(nowhere.code).toBe(3);

    const second = await run(["logout", panel.url], { env: {}, credentialsFile: file() });
    expect(jsonOf(second)).toMatchObject({ removed: true, current: null });
    await expect(stat(file())).rejects.toThrow();

    const nothing = await run(["projects"], { env: {}, credentialsFile: file() });
    expect(nothing.code).toBe(3);
    expect(errorOf(nothing).hint).toContain("opsifier login");
  });

  it("never sends the environment's key to another panel than OPSIFIER_URL's", async () => {
    const kept = join(scratch, "env-key", "credentials.json");
    const sent: Array<{ origin: string; authorization: string | null }> = [];
    const watching: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      sent.push({ origin: new URL(String(input)).origin, authorization: headers.get("authorization") });
      return fetch(input, init);
    };

    const result = await run(["login", other.url], {
      env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key },
      credentialsFile: kept,
      readSecret: secret(otherKey),
      fetch: watching,
    });

    expect(result.code).toBe(0);
    expect(asked.at(-1)).toContain(originOf(other));
    expect(
      sent.filter((request) => request.origin === originOf(other)).map((request) => request.authorization),
    ).toEqual([`Bearer ${otherKey}`]);
  });

  it("uses the key it keeps for a panel when logging in to it again, with nothing to paste", async () => {
    const kept = join(scratch, "again", "credentials.json");
    await run(["login", panel.url], { env: {}, credentialsFile: kept, readSecret: secret(key) });
    const before = asked.length;

    const again = await run(["login", panel.url], {
      env: {},
      credentialsFile: kept,
      readSecret: secret("unused"),
    });

    expect(again.code).toBe(0);
    expect(jsonOf(again)).toMatchObject({ reused: true });
    expect(asked.length).toBe(before);
  });

  it("never repeats what was typed where the address goes, nor a key typed after it", async () => {
    const pasted = "opsifier_not_an_address_0123456789";

    const asAddress = await run(["login", pasted], { env: {}, credentialsFile: file() });
    const afterIt = await run(["login", panel.url, pasted], { env: {}, credentialsFile: file() });

    for (const result of [asAddress, afterIt]) {
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain(pasted);
    }
  });
});

describe("creating", () => {
  it("creates a project", async () => {
    const result = await run(["create", "blog"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ProjectSummary>(result).name).toBe("blog");
  });

  it("creates a service with its image, the project with it, and deploys it", async () => {
    const result = await run(["create", "shopfront/web", "--image", "nginx:1.27", "--deploy", "--wait"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ActionDetail>(result)).toMatchObject({ type: "service.deploy", status: "succeeded" });
    const source = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shopfront/services/web/source",
    );
    expect(source.body.source).toMatchObject({ type: "image", image: "nginx:1.27" });
  }, 20_000);

  it("creates a database, its credentials generated by the panel", async () => {
    const result = await run(["create", "shop/cache", "--database", "redis"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ServiceDetail>(result)).toMatchObject({ projectName: "shop", name: "cache" });
  });

  it("links the folder to the new service when asked", async () => {
    const here = await folder("created-and-linked");

    const result = await run(["create", "shop/docs", "--git", "https://example.com/docs.git", "--link"], {
      cwd: here,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(here, LINK_FILE), "utf8"))).toMatchObject({ service: "shop/docs" });
    const source = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/docs/source",
    );
    expect(source.body.source).toMatchObject({
      type: "git",
      url: "https://example.com/docs.git",
      ref: "main",
    });
  });

  it.each([
    [["create", "shop/two", "--image", "a:1.0", "--git", "https://example.com/a.git"]],
    [["create", "shop/odd", "--database", "oracle"]],
    [["create", "shop/norepo", "--ref", "main"]],
    [["create", "shop/nothing", "--deploy"]],
    [["create", "lonely", "--image", "a:1.0"]],
  ])("refuses %j before creating anything", async (argv) => {
    // Names only: a database created earlier may still be starting, and its state moves.
    const inventory = async () =>
      (await panel.direct<{ projects: ProjectSummary[] }>(key, "GET", "/api/v1/projects")).body.projects.map(
        (project) => [project.name, project.services.map((service) => service.name)],
      );
    const before = await inventory();

    const result = await run(argv);

    expect(result.code).toBe(2);
    expect(await inventory()).toEqual(before);
  });

  it("leaves nothing behind when the panel refuses the source, the project it made included", async () => {
    const result = await run(["create", "fresh/web", "--image", "Not An Image!"]);

    expect(result.code).toBe(2);
    expect((await panel.direct(key, "GET", "/api/v1/projects/fresh")).status).toBe(404);
  });

  it("is refused to a key that only reads, as the API refuses it", async () => {
    const reader = (await panel.createKey({ name: "reader", level: "read" })).token;

    const result = await run(["create", "shop/denied"], {
      env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: reader },
    });

    expect(result.code).toBe(4);
  });
});

const hasBsdtar = spawnSync("bsdtar", ["--version"]).error === undefined;

describe.skipIf(!hasBsdtar)("pushing a folder", () => {
  async function site(name: string): Promise<string> {
    const here = await folder(name);
    await writeFile(join(here, "Dockerfile"), "FROM nginx:1.27\nCOPY index.html /usr/share/nginx/html/\n");
    await writeFile(join(here, "index.html"), "<h1>pushed</h1>\n");
    return here;
  }

  it("sends the folder and deploys it", async () => {
    await run(["create", "shop/site"]);
    const here = await site("my-site");

    const result = await run(["push", "shop/site", "--wait"], { cwd: here });

    expect(result.code).toBe(0);
    expect(jsonOf<ActionDetail>(result)).toMatchObject({ type: "service.deploy", status: "succeeded" });
    const source = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/site/source",
    );
    expect(source.body.source).toMatchObject({ type: "upload", fileName: "my-site.tar.gz" });
  }, 30_000);

  it("sends the linked folder as a whole, from anywhere inside it", async () => {
    const here = await site("linked-site");
    await run(["link", "shop/site"], { cwd: here });
    const inside = join(here, "assets");
    await mkdir(inside, { recursive: true });

    const result = await run(["push", "--upload-only"], { cwd: inside });

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toMatchObject({ type: "upload", fileName: "linked-site.tar.gz" });
  });

  it("asks before replacing a source that is not an upload", async () => {
    const here = await site("over-an-image");

    const result = await run(["push", "shop/web"], { cwd: here });

    expect(result.code).toBe(2);
    expect(errorOf(result).code).toBe("confirmation_required");
    expect(errorOf(result).message).toContain("image nginx:1.27");
    const source = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/web/source",
    );
    expect(source.body.source).toMatchObject({ type: "image" });
  });

  it("refuses files that may hold secrets unless asked to send them", async () => {
    const here = await site("with-secrets");
    await writeFile(join(here, ".env"), "TOKEN=1\n");
    await writeFile(join(here, ".env.example"), "TOKEN=\n");
    const before = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/site/source",
    );

    const refused = await run(["push", "shop/site", "--upload-only"], { cwd: here });
    expect(refused.code).toBe(2);
    expect(errorOf(refused).message).toContain(".env");
    expect(errorOf(refused).message).not.toContain(".env.example");
    const after = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/site/source",
    );
    expect(after.body.source).toEqual(before.body.source);

    const sent = await run(["push", "shop/site", "--upload-only", "--include-secrets"], { cwd: here });
    expect(sent.code).toBe(0);
    expect(sent.stderr).toContain(".env");
  });

  it("sends the folder linked to the named service, from anywhere inside it", async () => {
    const here = await site("named-and-linked");
    await run(["link", "shop/site"], { cwd: here });
    const inside = join(here, "src");
    await mkdir(inside, { recursive: true });

    const result = await run(["push", "shop/site", "--upload-only"], { cwd: inside });

    expect(jsonOf(result)).toMatchObject({ fileName: "named-and-linked.tar.gz" });
  });

  it("keeps building from the folder chosen at the last push", async () => {
    const here = await site("monorepo");
    await mkdir(join(here, "apps", "web"), { recursive: true });
    await writeFile(join(here, "apps", "web", "Dockerfile"), "FROM nginx:1.27\n");

    await run(["push", "shop/site", "--upload-only", "--path", "/apps/web"], { cwd: here });
    const again = await run(["push", "shop/site", "--upload-only"], { cwd: here });

    expect(jsonOf(again)).toMatchObject({ path: "/apps/web" });
  });

  it("never sends a folder above its own key file, such as a home folder", async () => {
    const home = await folder("a-home");
    await writeFile(join(home, "notes.txt"), "private\n");

    const result = await run(["push", "shop/site", "--upload-only"], {
      cwd: home,
      credentialsFile: join(home, ".config", "opsifier", "credentials.json"),
    });

    expect(result.code).toBe(2);
  });

  it("sends nothing and deploys nothing once interrupted", async () => {
    const here = await site("interrupted");
    const before = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/site/source",
    );
    const stop = new AbortController();
    stop.abort();

    const result = await run(["push", "shop/site"], { cwd: here, signal: stop.signal });

    expect(result.code).toBe(130);
    const after = await panel.direct<SourceSettings>(
      key,
      "GET",
      "/api/v1/projects/shop/services/site/source",
    );
    expect(after.body.source).toEqual(before.body.source);
  });

  it("refuses to send an empty folder", async () => {
    const empty = await folder("empty");

    const result = await run(["push", "shop/site", "--upload-only"], { cwd: empty });

    expect(result.code).toBe(2);
  });
});
