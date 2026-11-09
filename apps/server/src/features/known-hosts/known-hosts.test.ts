import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnownHost, KnownHostList, PanelUser, ServiceSource, SourceSettings } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitKnownHosts } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { sshFingerprint } from "../service-tabs/source/build/ssh-key";
import { importLearnedHosts, knownHostLines } from "./service";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJ9hGF8c6Qkq3t8k4tJb2oZr5g2mH0yV3uN1vE5x7w8Z";
const OTHER_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAK3vQ0H1p5yq2Xn6m8RbC4tUiLw7sZkVdF9eGhJ2yTp";
const BASE = "/settings/known-hosts";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });
}

const add = (publicKey = `ssh-ed25519 ${KEY}`, host = "git.example.com", port?: number) =>
  api<KnownHost>(BASE, "POST", { host, port, publicKey });

describe("the known hosts registry", () => {
  it("starts empty", async () => {
    expect((await api<KnownHostList>(BASE)).body).toEqual({ items: [] });
  });

  it("holds a key with its fingerprint, and shows who confirmed it", async () => {
    const created = await add();

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      host: "git.example.com",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: KEY,
      fingerprint: sshFingerprint(`ssh-ed25519 ${KEY}`),
    });
    expect(created.body.fingerprint).toMatch(/^SHA256:/);
    expect(created.body.addedBy).toBe("admin@example.com");
    expect((await api<KnownHostList>(BASE)).body.items).toHaveLength(1);
  });

  it("accepts a line copied from a known_hosts file", async () => {
    const created = await add(`git.example.com ssh-ed25519 ${KEY} comment`);

    expect(created.body.publicKey).toBe(KEY);
  });

  it("gives ssh the line for that host and port, and only that", async () => {
    await add();
    await add(`ssh-ed25519 ${OTHER_KEY}`, "git.example.com", 2222);
    await add(`ssh-ed25519 ${OTHER_KEY}`, "other.example.com");

    expect(knownHostLines(context.deps, "git.example.com", 22)).toBe(`git.example.com ssh-ed25519 ${KEY}\n`);
    expect(knownHostLines(context.deps, "git.example.com", 2222)).toBe(
      `[git.example.com]:2222 ssh-ed25519 ${OTHER_KEY}\n`,
    );
    expect(knownHostLines(context.deps, "nowhere.example.com", 22)).toBe("");
  });

  it("is not fooled by a key whose type doesn't match its bytes", async () => {
    const result = await add(`ssh-rsa ${KEY}`);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.publicKey).toBeDefined();
  });

  it("refuses what is not a host or not a key", async () => {
    expect((await add(`ssh-ed25519 ${KEY}`, "not a host!")).status).toBe(400);
    expect((await add("hello there")).status).toBe(400);
    expect((await add(`ssh-ed25519 ${KEY}`, "git.example.com", 70000)).status).toBe(400);
  });

  it("does not add the same key twice", async () => {
    await add();
    const again = await add();

    expect(again.status).toBe(201);
    expect((await api<KnownHostList>(BASE)).body.items).toHaveLength(1);
  });

  it("removes a key, and that server stops being trusted", async () => {
    const created = await add();

    const removed = await api<KnownHostList>(`${BASE}/${created.body.id}`, "DELETE");

    expect(removed.body.items).toEqual([]);
    expect(knownHostLines(context.deps, "git.example.com", 22)).toBe("");
    expect((await api(`${BASE}/${created.body.id}`, "DELETE")).status).toBe(404);
  });

  it("is for administrators, at a browser", async () => {
    const created = await api<PanelUser>("/users", "POST", {
      email: "member@example.com",
      password: TEST_PASSWORD,
      role: "member",
      projects: [],
    });
    const login = await authPost(context.app, "login", {
      email: created.body.email,
      password: TEST_PASSWORD,
    });

    expect((await api(BASE, "GET", undefined, login.cookie as string)).status).toBe(403);
    expect((await call(context.app, `/api/v1${BASE}`, {})).status).toBe(401);
  });

  it("reads a host's keys for someone to compare, saving nothing", async () => {
    const result = await api<{ items: Array<{ keyType: string; fingerprint: string }> }>(
      `${BASE}/scan`,
      "POST",
      {
        host: "git.example.com",
      },
    );

    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({ keyType: "ssh-ed25519" });
    expect(result.body.items[0]?.fingerprint).toMatch(/^SHA256:/);
    expect((await api<KnownHostList>(BASE)).body.items).toEqual([]);
    const scan = (context.deps.tools as FakeTools).callsTo("ssh-keyscan").at(-1);
    expect(scan?.args).toEqual(["-T", "10", "-p", "22", "--", "git.example.com"]);
  });

  it("says so when a host gives nothing away", async () => {
    (context.deps.tools as FakeTools).handler = (request) =>
      request.command === "ssh-keyscan" ? { exitCode: 1, tail: [] } : undefined;

    const result = await api(`${BASE}/scan`, "POST", { host: "git.example.com" });

    expect(result.status).toBe(502);
    expect(apiErrorOf(result).code).toBe("ssh_host_unreachable");
  });
});

describe("saving a source with an SSH address", () => {
  const SSH = { type: "git", url: "git@git.example.com:acme/shop.git", ref: "main", path: "/" };

  beforeEach(async () => {
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/services", "POST", { name: "web" });
  });

  it("is refused until the server's identity is on the list", async () => {
    const refused = await api("/projects/shop/services/web/source", "PUT", SSH);
    expect(apiErrorOf(refused).code).toBe("ssh_host_unknown");
    await add();

    const saved = await api<ServiceSource>("/projects/shop/services/web/source", "PUT", SSH);

    expect(saved.status).toBe(200);
  });

  it("uses only the keys on the list when it connects", async () => {
    await add();

    await api("/projects/shop/services/web/source", "PUT", SSH);

    const probe = (context.deps.tools as FakeTools).callsTo("git").at(-1);
    expect(probe?.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
  });

  it("keeps the key of a server that moves, so that a change is a conscious one", async () => {
    await add();
    await api("/projects/shop/services/web/source", "PUT", SSH);
    (context.deps.tools as FakeTools).handler = (request) =>
      request.args[0] === "ls-remote"
        ? { exitCode: 128, tail: ["Host key verification failed."] }
        : undefined;

    const result = await api("/projects/shop/services/web/source", "PUT", SSH);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("repository_access_denied");
    expect(apiErrorOf(result).fields?.reason).toContain("Host key verification failed");
    expect((await api<SourceSettings>("/projects/shop/services/web/source")).body.source?.type).toBe("git");
  });
});

describe("hosts remembered by earlier versions", () => {
  const dir = () => join(context.dataDir, "projects", "shop", "web");

  it("are moved into the registry once, and the service's file goes away", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(
      join(dir(), "known_hosts"),
      `git.example.com ssh-ed25519 ${KEY}\n[git.example.com]:2222 ssh-ed25519 ${OTHER_KEY}\n|1|hashed|entry ssh-ed25519 ${KEY}\nnonsense\n`,
    );

    await importLearnedHosts(context.deps);
    await importLearnedHosts(context.deps);

    const rows = context.deps.db.select().from(gitKnownHosts).orderBy(gitKnownHosts.port).all();
    expect(rows.map((row) => [row.host, row.port, row.addedBy])).toEqual([
      ["git.example.com", 22, null],
      ["git.example.com", 2222, null],
    ]);
    expect(readdirSync(dir())).toEqual([]);
    expect(
      context.deps.db.select().from(gitKnownHosts).where(eq(gitKnownHosts.port, 22)).get()?.fingerprint,
    ).toBe(sshFingerprint(`ssh-ed25519 ${KEY}`));
  });
});
