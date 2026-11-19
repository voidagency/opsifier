import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ActionEntry,
  defaultBuildpacksBuilder,
  type ServiceSource,
  type SourceSettings,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitKnownHosts, projects, services, users } from "../../../core/db/schema";
import { DockerDriverError } from "../../../core/docker";
import {
  FAKE_NIXPACKS_BASE,
  FAKE_RAILPACK_BUILDER,
  FAKE_RAILPACK_RUNTIME,
  type FakeTools,
  type ToolRequest,
  ToolTimeoutError,
} from "../../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  credentialHeaders,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { accessOf } from "../../access/rules";
import { sealStoredVariables } from "../../services/env-store";
import { findService, type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { DOCKERFILE_FRONTEND } from "./build/builders";
import { receiveUpload } from "./service";

const hasBsdtar = spawnSync("bsdtar", ["--version"]).error === undefined;

const SERVICE = "/projects/shop/services/web";
const SOURCE = `${SERVICE}/source`;
const GIT_SOURCE = { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" };

/** The image the panel runs from, which Nixpacks and Railpack run in, as a real panel finds it by ID. */
const PANEL_IMAGE = `sha256:${"e".repeat(64)}`;

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext({ env: { OPSIFIER_HELPER_IMAGE: PANEL_IMAGE } });
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

const tools = () => context.deps.tools as FakeTools;
const calls = (command: string) => tools().callsTo(command);
/** The containers Nixpacks and Railpack run in. */
const containers = () => calls("docker").filter((call) => call.args[0] === "run");
/**
 * What builds the image, leaving out the containers tools run in, and the final step that writes the
 * commit into the image's labels.
 */
const builds = () =>
  calls("docker").filter(
    (call) =>
      call.args[0] !== "run" &&
      call.args[0] !== "rm" &&
      !call.args.some((arg) => arg.includes("revision.Dockerfile")),
  );
const lastBuild = () => builds().at(-1) as ToolRequest;
/** The image a built tag stands for: what the Swarm service is really given. */
const builtImageId = async () => (await context.docker.inspectImage("opsifier/shop/web:latest"))?.id;
/** A builder is run from its own versioned folder, and nothing else counts as that version. */
const builderTool = (name: string, version: string) =>
  join(context.deps.config.buildersDir, name, version, name);
const nixpacks = () => calls(builderTool("nixpacks", "1.41.0"));
const railpack = () => calls(builderTool("railpack", "0.17.1"));

async function waitForAction(id: string): Promise<ActionEntry & { log: string }> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { body } = await api<ActionEntry & { log: string }>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function deploy(body?: unknown): Promise<ActionEntry & { log: string }> {
  const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST", body);
  expect(accepted.status).toBe(202);
  return waitForAction(accepted.body.id);
}

/** Puts a host's key on the list of known hosts, as an administrator would. */
function trustHost(host: string): void {
  context.deps.db
    .insert(gitKnownHosts)
    .values({
      id: `key-${host}`,
      host,
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIJ9hGF8c6Qkq3t8k4tJb2oZr5g2mH0yV3uN1vE5x7w8Z",
      fingerprint: "SHA256:test",
      addedBy: null,
      createdAt: new Date(),
    })
    .run();
}

const swarm = () => context.docker.inspectService("shop_web");
const requireWeb = () => findService(context.deps.db, "shop", "web") as ServiceRecord;
const rawSpec = () => {
  const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
  return JSON.stringify(row?.spec);
};
/** Real path: the temporary folder is reached through a symlink on some systems. */
const code = (...parts: string[]) =>
  join(realpathSync(context.dataDir), "projects", "shop", "web", "code", ...parts);

async function saveGit(body: Record<string, unknown> = GIT_SOURCE) {
  const saved = await api<ServiceSource>(SOURCE, "PUT", body);
  expect(saved.status).toBe(200);
  return saved;
}

async function uploadArchive(file: Buffer, query = "fileName=app.tar") {
  const response = await context.app.request(`/api/v1${SOURCE}/upload?${query}`, {
    method: "PUT",
    headers: {
      ...credentialHeaders(cookie),
      origin: TEST_ORIGIN,
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(file),
  });
  return { status: response.status, body: (await response.json()) as ServiceSource };
}

/** A minimal tar: one regular file per entry. */
function tar(entries: Array<[string, string]>): Buffer {
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  const blocks: Buffer[] = [];
  for (const [name, content] of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(body.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("a Git source", () => {
  it("saves after checking the repository, without touching what runs", async () => {
    const saved = await saveGit();

    expect(saved.body).toEqual(GIT_SOURCE);
    expect(calls("git").at(0)?.args).toEqual([
      "ls-remote",
      "--exit-code",
      "--",
      "https://git.example.com/acme/shop.git",
      "main",
    ]);
    expect(await swarm()).toBeNull();
  });

  it("requires every field", async () => {
    const result = await api(SOURCE, "PUT", { type: "git", url: "", ref: "", path: "" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toMatchObject({ url: "Required", ref: "Required", path: "Required" });
  });

  it.each([
    ["file:///etc/passwd"],
    ["/srv/repo.git"],
    ["ext::sh -c touch% /tmp/pwned"],
    ["git://example.com/a.git"],
    ["http://example.com/a.git"],
    ["https://user:pass@example.com/a.git"],
  ])("refuses the remote %s and never runs git", async (url) => {
    const result = await api(SOURCE, "PUT", { ...GIT_SOURCE, url });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.url).toBeDefined();
    expect(calls("git")).toHaveLength(0);
  });

  it.each(["--upload-pack=x", "a..b", "main lock"])("refuses the ref %j", async (ref) => {
    const result = await api(SOURCE, "PUT", { ...GIT_SOURCE, ref });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.ref).toBeDefined();
    expect(calls("git")).toHaveLength(0);
  });

  it("refuses a build path that climbs out", async () => {
    const result = await api(SOURCE, "PUT", { ...GIT_SOURCE, path: "../../etc" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.path).toBeDefined();
  });

  it("stores the build path in its normal form", async () => {
    const saved = await saveGit({ ...GIT_SOURCE, path: "apps/web/" });

    expect(saved.body).toMatchObject({ path: "/apps/web" });
  });

  it("does not save a repository it cannot read, and says why", async () => {
    tools().handler = (request) =>
      request.args[0] === "ls-remote"
        ? { exitCode: 128, tail: ["fatal: could not read Username for 'https://git.example.com'"] }
        : undefined;

    const result = await api(SOURCE, "PUT", GIT_SOURCE);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("repository_access_denied");
    expect(apiErrorOf(result).message).toMatch(/deploy key or GitHub token/);
    expect(apiErrorOf(result).fields?.reason).toContain("could not read Username");
    expect((await api<SourceSettings>(SOURCE)).body.source).toBeNull();
  });

  it("tells a server it cannot reach from a repository that refuses it", async () => {
    tools().handler = (request) =>
      request.args[0] === "ls-remote"
        ? { exitCode: 128, tail: ["fatal: unable to access: Could not resolve host: git.example.com"] }
        : undefined;

    const result = await api(SOURCE, "PUT", GIT_SOURCE);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("repository_unreachable");
    expect(apiErrorOf(result).message).toMatch(/could not be reached/);
  });

  it("names a branch that does not exist", async () => {
    tools().handler = (request) => (request.args[0] === "ls-remote" ? { exitCode: 2, tail: [] } : undefined);

    const result = await api(SOURCE, "PUT", GIT_SOURCE);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("ref_not_found");
    expect(apiErrorOf(result).fields?.ref).toBeDefined();
  });

  it("uses the deploy key for an SSH remote, and not for an https one", async () => {
    await api(`${SOURCE}/ssh-key`, "POST");
    trustHost("git.example.com");

    await saveGit({ ...GIT_SOURCE, url: "git@git.example.com:acme/shop.git" });
    expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).toContain("deploy_key");

    await saveGit(GIT_SOURCE);
    expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).not.toContain("deploy_key");
  });

  it("refuses an SSH remote whose server the registry does not know, and never runs git", async () => {
    await api(`${SOURCE}/ssh-key`, "POST");

    const result = await api(SOURCE, "PUT", { ...GIT_SOURCE, url: "git@unknown.example.com:acme/shop.git" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("ssh_host_unknown");
    expect(apiErrorOf(result).fields?.url).toBeDefined();
    expect(calls("git")).toHaveLength(0);
  });

  it("gives ssh only the registry's keys for that server, and refuses anything else", async () => {
    trustHost("git.example.com");
    trustHost("other.example.com");

    await saveGit({ ...GIT_SOURCE, url: "ssh://git@git.example.com:22/acme/shop.git" });

    const ssh = calls("git").at(-1)?.env.GIT_SSH_COMMAND ?? "";
    expect(ssh).toContain("StrictHostKeyChecking=yes");
    expect(ssh).not.toContain("accept-new");
    expect(ssh).toContain("GlobalKnownHostsFile=/dev/null");
    const file = /UserKnownHostsFile="([^"]+)"/.exec(ssh)?.[1];
    expect(file).toBeDefined();
  });

  it("never looks at the per-service known_hosts file a previous version kept", async () => {
    trustHost("git.example.com");

    await saveGit({ ...GIT_SOURCE, url: "git@git.example.com:acme/shop.git" });

    expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).not.toContain(join(context.dataDir, "projects"));
  });
});

describe("a deploy key and the repository it belongs to", () => {
  const SSH = { ...GIT_SOURCE, url: "git@git.example.com:acme/shop.git" };

  beforeEach(() => {
    trustHost("git.example.com");
  });

  const generate = async () => (await api<{ publicKey: string }>(`${SOURCE}/ssh-key`, "POST")).body;
  const sshCommand = () => calls("git").at(-1)?.env.GIT_SSH_COMMAND ?? "";

  it("is tied to the first repository it is used for", async () => {
    await generate();

    await saveGit(SSH);

    expect((await api<SourceSettings>(SOURCE)).body.sshKey).toMatchObject({
      boundTo: "git.example.com/acme/shop",
    });
  });

  it("is never offered to another repository, even by accident", async () => {
    await generate();
    await saveGit(SSH);
    tools().calls.length = 0;

    const result = await api(SOURCE, "PUT", { ...SSH, url: "git@git.example.com:acme/other.git" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("ssh_key_bound");
    expect(apiErrorOf(result).fields?.url).toBeDefined();
    expect(calls("git")).toHaveLength(0);
  });

  it("treats two ways of writing the same address as the same repository", async () => {
    await generate();
    await saveGit(SSH);

    await saveGit({ ...SSH, url: "ssh://git@git.example.com/acme/shop.git" });

    expect(sshCommand()).toContain("deploy_key");
  });

  it("can't reach another repository through a source saved before it was tied", async () => {
    await saveGit(SSH);
    await generate();
    tools().calls.length = 0;

    await deploy();

    const fetch = calls("git").find((call) => call.args.includes("fetch"));
    expect(fetch?.env.GIT_SSH_COMMAND).toContain("deploy_key");
    expect((await api<SourceSettings>(SOURCE)).body.sshKey?.boundTo).toBe("git.example.com/acme/shop");
  });

  it("keeps its repository when it is replaced", async () => {
    await generate();
    await saveGit(SSH);

    const replaced = await generate();

    expect((await api<SourceSettings>(SOURCE)).body).toMatchObject({
      sshPublicKey: replaced.publicKey,
      sshKey: { boundTo: "git.example.com/acme/shop" },
    });
    const refused = await api(SOURCE, "PUT", { ...SSH, url: "git@git.example.com:acme/other.git" });
    expect(apiErrorOf(refused).code).toBe("ssh_key_bound");
  });

  it("can be moved on by deleting it and generating a new one", async () => {
    await generate();
    await saveGit(SSH);

    expect((await api(`${SOURCE}/ssh-key`, "DELETE")).status).toBe(200);
    await generate();
    await saveGit({ ...SSH, url: "git@git.example.com:acme/other.git" });

    expect((await api<SourceSettings>(SOURCE)).body.sshKey?.boundTo).toBe("git.example.com/acme/other");
    expect(sshCommand()).toContain("deploy_key");
  });

  it("has a status with no secret in it", async () => {
    const { publicKey } = await generate();

    const { body } = await api<SourceSettings>(SOURCE);

    expect(body.sshKey?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(body.sshKey?.boundTo).toBeNull();
    expect(body.sshPublicKey).toBe(publicKey);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  describe("deleted", () => {
    it("stops being used, at the next deployment too", async () => {
      await generate();
      await saveGit(SSH);
      const before = await deploy();
      expect(calls("git").find((call) => call.args.includes("fetch"))?.env.GIT_SSH_COMMAND).toContain(
        "deploy_key",
      );
      expect(before.status).toBe("succeeded");
      await api(`${SOURCE}/ssh-key`, "DELETE");
      tools().calls.length = 0;

      await deploy();

      expect(calls("git").find((call) => call.args.includes("fetch"))?.env.GIT_SSH_COMMAND).not.toContain(
        "deploy_key",
      );
    });

    it("is gone from storage, leaving no sealed copy", async () => {
      await generate();

      const deleted = await api<SourceSettings>(`${SOURCE}/ssh-key`, "DELETE");

      expect(deleted.body.sshPublicKey).toBeNull();
      expect(rawSpec()).not.toContain("sealedPrivateKey");
    });

    it("is recorded, and answers 404 the second time", async () => {
      await generate();
      await api(`${SOURCE}/ssh-key`, "DELETE");

      expect((await api(`${SOURCE}/ssh-key`, "DELETE")).status).toBe(404);
      const { items } = (await api<{ items: ActionEntry[] }>("/actions?type=service.source")).body;
      expect(items[0]?.title).toContain("Delete the deploy key");
    });

    it("fails a deployment that needed it, and says so", async () => {
      await generate();
      await saveGit(SSH);
      await api(`${SOURCE}/ssh-key`, "DELETE");
      tools().handler = (request) =>
        request.args.includes("fetch")
          ? { exitCode: 128, tail: ["git@git.example.com: Permission denied (publickey)."] }
          : undefined;

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toContain("Permission denied");
    });
  });

  describe("connection test", () => {
    it("connects to the exact repository the source names, with its key", async () => {
      await generate();
      await saveGit(SSH);
      tools().calls.length = 0;

      const result = await api<{ ok: boolean; detail: string }>(`${SOURCE}/ssh-key/test`, "POST");

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, detail: "" });
      expect(calls("git").at(-1)?.args).toEqual(["ls-remote", "--exit-code", "--", SSH.url, "main"]);
      expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).toContain("deploy_key");
    });

    it("reports what went wrong in git's words", async () => {
      await generate();
      await saveGit(SSH);
      tools().handler = (request) =>
        request.args[0] === "ls-remote"
          ? { exitCode: 128, tail: ["git@git.example.com: Permission denied (publickey)."] }
          : undefined;

      const result = await api<{ ok: boolean; detail: string }>(`${SOURCE}/ssh-key/test`, "POST");

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(false);
      expect(result.body.detail).toContain("Permission denied");
    });

    it("needs an SSH source to test", async () => {
      await generate();
      await saveGit();

      const result = await api(`${SOURCE}/ssh-key/test`, "POST");

      expect(result.status).toBe(400);
      expect(apiErrorOf(result).code).toBe("source_not_ssh");
    });
  });

  it("is free again once rotated, and the old key never comes back", async () => {
    await generate();
    await saveGit(SSH);
    tools().calls.length = 0;
    const firstKey = (await api<SourceSettings>(SOURCE)).body.sshPublicKey;

    await generate();

    expect((await api<SourceSettings>(SOURCE)).body.sshPublicKey).not.toBe(firstKey);
    await deploy();
    const fetch = calls("git").find((call) => call.args.includes("fetch"));
    expect(fetch?.env.GIT_SSH_COMMAND).toContain("deploy_key");
  });
});

describe("the deploy key", () => {
  it("can be generated before any source exists, and only the public half ever leaves", async () => {
    const generated = await api<{ publicKey: string }>(`${SOURCE}/ssh-key`, "POST");

    expect(generated.status).toBe(200);
    expect(generated.body.publicKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(generated.body)).not.toContain("PRIVATE");
    expect((await api<SourceSettings>(SOURCE)).body.sshPublicKey).toBe(generated.body.publicKey);
    expect(rawSpec()).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("is replaced by a new one on refresh", async () => {
    const first = await api<{ publicKey: string }>(`${SOURCE}/ssh-key`, "POST");
    const second = await api<{ publicKey: string }>(`${SOURCE}/ssh-key`, "POST");

    expect(second.body.publicKey).not.toBe(first.body.publicKey);
    expect((await api<SourceSettings>(SOURCE)).body.sshPublicKey).toBe(second.body.publicKey);
  });
});

describe("an inline Dockerfile", () => {
  it("requires content", async () => {
    const result = await api(SOURCE, "PUT", { type: "dockerfile", dockerfile: "" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.dockerfile).toBe("Required");
  });

  it("is written out and built", async () => {
    await api(SOURCE, "PUT", { type: "dockerfile", dockerfile: "FROM busybox\nRUN echo hi\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(readFileSync(code("Dockerfile"), "utf8")).toBe("FROM busybox\nRUN echo hi\n");
    expect(lastBuild().args).toEqual(expect.arrayContaining([`--file=${code("Dockerfile")}`]));
    expect(lastBuild().args).toContain("--tag=opsifier/shop/web:latest");
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await builtImageId());
    expect(calls("git")).toHaveLength(0);
  });

  it("gives every build tool an empty Docker configuration of its own, so none signs in to a registry", async () => {
    // The panel's own Docker configuration, which has nothing a build keeps.
    const home = mkdtempSync(join(tmpdir(), "opsifier-home-"));
    mkdirSync(join(home, ".docker"));
    writeFileSync(
      join(home, ".docker", "config.json"),
      JSON.stringify({ auths: { "ghcr.io": { auth: "c2VjcmV0" } } }),
    );
    vi.stubEnv("HOME", home);
    const seen: Array<{ command: string; entries: string[] | null }> = [];
    const policies = new Set<string | undefined>();
    tools().handler = (request) => {
      const config = request.env.DOCKER_CONFIG;
      seen.push({ command: request.command, entries: config === undefined ? null : readdirSync(config) });
      if (request.command !== "git") {
        policies.add(request.env.EXPERIMENTAL_BUILDKIT_SOURCE_POLICY);
      }
      return undefined;
    };
    for (const build of [
      { type: "dockerfile" },
      { type: "nixpacks" },
      { type: "railpack" },
      { type: "buildpacks" },
    ]) {
      await saveGit({ ...GIT_SOURCE, build });
      expect((await deploy()).status, build.type).toBe("succeeded");
    }

    const builders = seen.filter(({ command }) => command !== "git");
    // Nixpacks and Railpack run in containers, which the Docker CLI starts.
    expect(new Set(builders.map(({ command }) => command))).toEqual(new Set(["docker", "pack"]));
    for (const { command, entries } of builders) {
      expect(entries, command).toEqual([]);
    }
    // In there they have no Docker configuration at all, nor anything that leads to the daemon.
    expect([...nixpacks(), ...railpack()]).toHaveLength(2);
    for (const tool of [...nixpacks(), ...railpack()]) {
      expect(Object.keys(tool.env).filter((name) => name.startsWith("DOCKER_"))).toEqual([]);
    }
    // Nor any source policy, which could swap the frontend or an image for another.
    expect(policies).toEqual(new Set([""]));
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps the proxies of the panel's Docker configuration in a build's, and nothing else of it", async () => {
    const home = mkdtempSync(join(tmpdir(), "opsifier-home-"));
    try {
      mkdirSync(join(home, ".docker"));
      writeFileSync(
        join(home, ".docker", "config.json"),
        JSON.stringify({
          auths: { "ghcr.io": { auth: "c2VjcmV0" } },
          credsStore: "desktop",
          currentContext: "elsewhere",
          proxies: {
            default: { httpProxy: "http://proxy.example.test:3128", noProxy: "localhost", extra: 1 },
          },
        }),
      );
      vi.stubEnv("HOME", home);
      await api(SOURCE, "PUT", { type: "dockerfile", dockerfile: "FROM busybox:1.36\n" });
      const configs: unknown[] = [];
      tools().handler = (request) => {
        if (request.command === "docker") {
          configs.push(
            JSON.parse(readFileSync(join(request.env.DOCKER_CONFIG ?? "", "config.json"), "utf8")),
          );
        }
        return undefined;
      };

      expect((await deploy()).status).toBe("succeeded");

      expect(configs.length).toBeGreaterThan(0);
      for (const config of configs) {
        expect(config).toEqual({
          proxies: { default: { httpProxy: "http://proxy.example.test:3128", noProxy: "localhost" } },
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("pulls what it pins to a digest first, with no credentials, and stops when a registry won't give it", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const dockerfile = `FROM node:22@${digest}\nCOPY --from=alpine:3.20@${digest} /etc/os-release /\nFROM busybox:1.36\n`;
    await api(SOURCE, "PUT", { type: "dockerfile", dockerfile });
    const pull = vi.spyOn(context.docker, "pullImage");

    expect((await deploy()).status).toBe("succeeded");
    expect(pull.mock.calls.map(([image, options]) => [image, options?.registryAuth])).toEqual([
      [`node:22@${digest}`, undefined],
      [`alpine:3.20@${digest}`, undefined],
    ]);

    context.docker.failNext("pullImage", new Error("pull access denied"));
    const refused = await deploy();
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain(`Could not pull node:22@${digest} from its registry`);
    expect(builds()).toHaveLength(1);
  });

  it("is built with the panel's frontend, whatever its syntax line asks for", async () => {
    await api(SOURCE, "PUT", {
      type: "dockerfile",
      dockerfile: "# syntax=docker/dockerfile:1.4\nFROM busybox\n",
    });

    expect((await deploy()).status).toBe("succeeded");
    expect(lastBuild().args).toEqual(
      expect.arrayContaining(["--build-arg", `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`]),
    );
  });
});

describe("images of another project or of the server", () => {
  it.each([
    ["another project's build", "opsifier/other/web:latest", "Belongs to another project"],
    ["another project's stack", "other_web-app", "Belongs to another project"],
    ["a release", "docker.io/opsifier/releases/0c6a8f1e:2", "Belongs to this server"],
  ])("are refused as an image source: %s", async (_name, image, field) => {
    const refused = await api(SOURCE, "PUT", { image });

    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused)).toMatchObject({ code: "image_not_allowed", fields: { image: field } });
    expect((await api<SourceSettings>(SOURCE)).body.source).toBeNull();
  });

  it("lets the project name its own", async () => {
    expect((await api(SOURCE, "PUT", { image: "shop_api-worker:latest" })).status).toBe(200);
  });

  it.each([
    "FROM opsifier/other/web:latest\n",
    "FROM alpine\nCOPY --from=opsifier/other/web /app /app\n",
    "FROM alpine\nRUN --mount=type=bind,from=other_web-app,target=/x cat /x/secret\n",
    "# syntax=acme/frontend:1\nFROM alpine\n",
  ])("are refused in an inline Dockerfile: %j", async (dockerfile) => {
    const refused = await api(SOURCE, "PUT", { type: "dockerfile", dockerfile });

    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).code).toBe("image_not_allowed");
    expect(apiErrorOf(refused).fields).toHaveProperty("dockerfile");
  });

  it("stop a build that names an image the panel can't work out, which saving let through", async () => {
    const dockerfile = `ARG X=opsifierZother/web\nFROM \${X/Z//}\n`;
    expect((await api(SOURCE, "PUT", { type: "dockerfile", dockerfile })).status).toBe(200);

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("which the panel can't work out");
    expect(builds()).toHaveLength(0);
  });

  it("stop a build whose Dockerfile is larger than the panel reads", async () => {
    await saveGit();
    tools().checkoutFiles = { Dockerfile: `FROM node:22\n${"# padding\n".repeat(110_000)}` };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain(
      "Dockerfile is larger than the 1024 KiB the panel reads in a Dockerfile",
    );
    expect(builds()).toHaveLength(0);
  });

  it("stop a build that reaches one through the values it passes", async () => {
    const saved = await api(SOURCE, "PUT", {
      type: "dockerfile",
      dockerfile: "ARG BASE=alpine:3.20\nFROM $BASE\n",
    });
    expect(saved.status).toBe(200);
    await api(`${SERVICE}/environment/build`, "PUT", { env: "BASE=opsifier/other/web:latest\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    // The name is a build variable's value, which the log and the error never show.
    expect(deployed.error).toContain("[redacted] is an image of another project on this server");
    expect(builds()).toHaveLength(0);
    expect(await swarm()).toBeNull();
  });

  it("stop a build from a repository whose Dockerfile names one", async () => {
    await saveGit();
    tools().checkoutFiles = {
      Dockerfile: "FROM node:22 AS build\nFROM alpine\nCOPY --from=opsifier/releases/abc:3 / /\n",
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("opsifier/releases/abc:3 is one of this server's own images");
    expect(builds()).toHaveLength(0);
  });

  it("say why a build from an image of the project's own can't start", async () => {
    await saveGit();
    tools().checkoutFiles = { Dockerfile: "FROM opsifier/shop/base:latest\n" };

    const deployed = await deploy();

    expect(deployed.log).toContain(
      "This Dockerfile names opsifier/shop/base:latest, which only this server has: a build fetches every image it names from its registry",
    );
    expect(lastBuild().args).toContain("--pull");
  });

  it("stop a deployment of an image saved before the rule", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.27" });
    const record = requireWeb();
    saveServiceSpec(
      context.deps.db,
      "shop",
      "web",
      {
        ...record.spec,
        source: { type: "image", image: "opsifier/other/web:latest", username: null, sealedPassword: null },
      },
      new Date(),
    );
    const pull = vi.spyOn(context.docker, "pullImage");

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("is an image of another project on this server");
    expect(pull).not.toHaveBeenCalled();
    expect(await swarm()).toBeNull();
  });
});

describe.skipIf(!hasBsdtar)("an uploaded archive", () => {
  it("saves, reports the file and leaves init mode", async () => {
    const result = await uploadArchive(tar([["Dockerfile", "FROM scratch\n"]]));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ type: "upload", fileName: "app.tar", path: "/" });
    expect((await api<SourceSettings>(SOURCE)).body.source?.type).toBe("upload");
  });

  it("is unpacked and built on deploy, stepping into a single top-level folder", async () => {
    await uploadArchive(
      tar([
        ["shop-main/Dockerfile", "FROM scratch\n"],
        ["shop-main/app.js", "console.log(1)\n"],
      ]),
    );

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(readFileSync(code("app.js"), "utf8")).toBe("console.log(1)\n");
    expect(lastBuild().args).toContain("--tag=opsifier/shop/web:latest");
  });

  it("refuses a hostile archive at the door", async () => {
    const result = await uploadArchive(tar([["../evil.txt", "pwned\n"]]));

    expect(result.status).toBe(400);
    expect((result.body as unknown as { error: { code: string } }).error.code).toBe("upload_rejected");
    expect((await api<SourceSettings>(SOURCE)).body.source).toBeNull();
    expect(existsSync(join(context.dataDir, "projects", "shop", "evil.txt"))).toBe(false);
  });

  it("refuses something that is not an archive", async () => {
    const result = await uploadArchive(Buffer.from("definitely not a tar"));

    expect(result.status).toBe(400);
  });

  it("can have its build path changed without uploading again", async () => {
    await uploadArchive(tar([["Dockerfile", "FROM scratch\n"]]));

    const saved = await api<ServiceSource>(SOURCE, "PUT", { type: "upload", path: "/apps/web" });

    expect(saved.body).toMatchObject({ type: "upload", fileName: "app.tar", path: "/apps/web" });
  });

  it("refuses a build-path change with no archive", async () => {
    const result = await api(SOURCE, "PUT", { type: "upload", path: "/" });

    expect(result.status).toBe(400);
  });

  it("refuses a body larger than the limit by its declared size", async () => {
    const response = await context.app.request(`/api/v1${SOURCE}/upload?fileName=app.tar`, {
      method: "PUT",
      headers: {
        ...credentialHeaders(cookie),
        origin: TEST_ORIGIN,
        "content-type": "application/octet-stream",
        "content-length": String(2 * 1024 ** 3),
      },
      body: "x",
    });

    expect(response.status).toBe(413);
  });

  it("cuts off a body that turns out larger than the limit, and keeps nothing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });

    const owner = context.deps.db.select().from(users).get();
    if (owner === undefined) {
      throw new Error("No account was set up");
    }
    const access = accessOf(context.deps.db, { kind: "session", sessionId: "test", user: owner });

    await expect(
      receiveUpload(
        context.deps,
        { projectName: "shop", serviceName: "web" },
        { fileName: "app.tar", path: "/" },
        stream,
        undefined,
        undefined,
        access,
        10 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(join(context.dataDir, "projects", "shop", "web", "upload"))).toEqual([]);
  });

  it("refuses a name it will not unpack", async () => {
    const response = await context.app.request(`/api/v1${SOURCE}/upload?fileName=app.exe`, {
      method: "PUT",
      headers: { ...credentialHeaders(cookie), origin: TEST_ORIGIN },
      body: "x",
    });

    expect(response.status).toBe(400);
  });
});

describe("the build settings", () => {
  it("are absent from image and Dockerfile sources", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.28" });
    const result = await api(`${SOURCE}/build`, "PUT", { build: null });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("source_not_buildable");
  });

  it("can be saved and cleared on a Git source", async () => {
    await saveGit();

    const saved = await api<{ build: unknown }>(`${SOURCE}/build`, "PUT", {
      build: { type: "nixpacks", startCommand: "npm start" },
    });
    expect(saved.body.build).toMatchObject({
      type: "nixpacks",
      version: "1.41.0",
      startCommand: "npm start",
    });
    expect((await api<SourceSettings>(SOURCE)).body.build).toMatchObject({ type: "nixpacks" });

    await api(`${SOURCE}/build`, "PUT", { build: null });
    expect((await api<SourceSettings>(SOURCE)).body.build).toBeNull();
  });

  it("can be saved in the same request as the source", async () => {
    await saveGit({ ...GIT_SOURCE, build: { type: "dockerfile", file: "docker/Dockerfile.prod" } });

    expect((await api<SourceSettings>(SOURCE)).body.build).toEqual({
      type: "dockerfile",
      file: "docker/Dockerfile.prod",
    });
  });

  it("validates every field", async () => {
    await saveGit();

    const result = await api(`${SOURCE}/build`, "PUT", { build: { type: "dockerfile", file: "../evil" } });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.["build.file"]).toBeDefined();
  });
});

describe("the environment file", () => {
  it("is refused on a Docker image, which has no source tree", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.28" });

    const result = await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: true });

    expect(result.status).toBe(400);
  });

  it("has to say whether it may enter the image", async () => {
    await saveGit();

    const result = await api(`${SOURCE}/env-file`, "PUT", { path: ".env" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.inImage).toBeDefined();
  });

  it("when it may, is written into the build path, with what the build is given", async () => {
    await saveGit({ ...GIT_SOURCE, path: "/apps/web" });
    tools().checkoutFiles = { "apps/web/Dockerfile": "FROM scratch\n" };
    await api(`${SERVICE}/environment`, "PUT", { env: "ONLY_AT_RUNTIME=runtime-value\n" });
    await api(`${SERVICE}/environment/build`, "PUT", { env: 'GREETING="hello world"\nPLAIN=1\n' });
    await api(`${SERVICE}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: true });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const written = readFileSync(code("apps/web/.env"), "utf8");
    expect(written).toContain('GREETING="hello world"');
    expect(written).toContain("PLAIN=1");
    expect(written).not.toContain("runtime-value");
    expect(written).not.toContain("npm-secret-value");
  });

  it("when it may not, stays out of the build context and is mounted as a secret", async () => {
    await saveGit();
    await api(`${SERVICE}/environment/build`, "PUT", { env: "PLAIN=1\n" });
    await api(`${SERVICE}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: false });
    let mounted = "";
    tools().handler = (request) => {
      const file = /id=env-file,src=(.+)/.exec(request.args.join("\n"))?.[1]?.split("\n")[0];
      if (request.command === "docker" && file !== undefined) {
        mounted = readFileSync(file, "utf8");
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(existsSync(code(".env"))).toBe(false);
    expect(mounted).toContain("PLAIN=1");
    expect(mounted).toContain("NPM_TOKEN=npm-secret-value");
    // Nothing is left of it once the build is over.
    expect(readdirSync(join(context.dataDir, "tmp"))).toEqual([]);
  });

  it("reports its decision", async () => {
    await saveGit();
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: true });
    expect((await api(`${SOURCE}/env-file`)).body).toEqual({ path: ".env", inImage: true });

    await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: false });
    expect((await api(`${SOURCE}/env-file`)).body).toEqual({ path: ".env", inImage: false });
  });

  it("can be turned off again", async () => {
    await saveGit();
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: true });
    await api(`${SOURCE}/env-file`, "PUT", { path: null });

    expect((await api<{ path: string | null }>(`${SOURCE}/env-file`)).body).toEqual({
      path: null,
      inImage: false,
    });
  });

  it("refuses a path that climbs out", async () => {
    await saveGit();

    const result = await api(`${SOURCE}/env-file`, "PUT", { path: "../.env" });

    expect(result.status).toBe(400);
  });
});

describe("what a build is given", () => {
  const BUILD = `${SERVICE}/environment/build`;

  beforeEach(async () => {
    await saveGit();
    tools().calls.length = 0;
  });

  /** Saved the way the last version without build scopes saved it, then upgraded. */
  function upgradedFromBeforeScopes(env: string, projectEnv = ""): void {
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const { build, ...current } = (row?.spec ?? {}) as Record<string, unknown>;
    const newFields = [
      "sealedEnv",
      "sealedRetired",
      "sealedVariables",
      "secrets",
      "inheritsRuntime",
      "envFileInImage",
    ];
    const without = (fields: object) =>
      Object.fromEntries(Object.entries(fields).filter(([name]) => !newFields.includes(name)));
    context.deps.db
      .update(services)
      .set({ spec: { ...without(current), env, build: without(build as object) } })
      .where(eq(services.name, "web"))
      .run();
    context.deps.db.update(projects).set({ sealedEnv: projectEnv }).where(eq(projects.name, "shop")).run();
    sealStoredVariables(context.deps);
  }

  const dockerfileDeclares = (...names: string[]) => {
    tools().checkoutFiles = {
      Dockerfile: `FROM scratch\n${names.map((name) => `ARG ${name}`).join("\n")}\n`,
    };
  };

  it("is not the runtime environment", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    await api(`${SERVICE}/environment`, "PUT", { env: "ONLY_AT_RUNTIME=runtime-value\n" });
    await api("/projects/shop/env", "PUT", { env: "SHARED_AT_RUNTIME=project-value\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const build = nixpacks().at(-1) as ToolRequest;
    expect(build.args).not.toContain("ONLY_AT_RUNTIME");
    expect(build.args).not.toContain("SHARED_AT_RUNTIME");
    expect(build.env.ONLY_AT_RUNTIME).toBeUndefined();
    expect(build.env.SHARED_AT_RUNTIME).toBeUndefined();
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env).toEqual(
      expect.arrayContaining(["ONLY_AT_RUNTIME=runtime-value", "SHARED_AT_RUNTIME=project-value"]),
    );
  });

  it("does not include a runtime variable just because a Dockerfile asks for it, and says so", async () => {
    dockerfileDeclares("API_URL");
    await api(`${SERVICE}/environment`, "PUT", { env: "API_URL=https://runtime.example.test\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(lastBuild().args).not.toContain("API_URL");
    expect(deployed.log).toContain("This Dockerfile declares API_URL, which only the container gets");
  });

  it("hands a build secret over as a secret, by name, and not to the container", async () => {
    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const build = lastBuild();
    expect(build.args).toEqual(expect.arrayContaining(["--secret", "id=NPM_TOKEN,env=NPM_TOKEN"]));
    expect(build.args).not.toContain("NPM_TOKEN");
    expect(build.args.join(" ")).not.toContain("npm-secret-value");
    expect(build.env.NPM_TOKEN).toBe("npm-secret-value");
    expect(deployed.log).toContain("Build secrets: NPM_TOKEN");
    expect(deployed.log).not.toContain("npm-secret-value");
    expect(JSON.stringify((await swarm())?.spec)).not.toContain("npm-secret-value");
  });

  it("refuses a sealed reference even in the variables of a build", async () => {
    const result = await api(BUILD, "PUT", { env: "SECRET=$(secret.adminPassword)\n" });
    expect(result.status).toBe(400);
  });

  it("keeps a Nixpacks build from a secret it would bake into the image, and says so", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const build = nixpacks().at(-1) as ToolRequest;
    expect(build.args).not.toContain("NPM_TOKEN");
    expect(build.env.NPM_TOKEN).toBeUndefined();
    expect(deployed.log).toContain("Not passing the build secrets NPM_TOKEN");
  });

  it("gives Railpack names only, and changes its cache key when a value does", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack", buildCommand: "bun run build" } });
    await api(BUILD, "PUT", { env: "API_URL=build-variable-value\n" });
    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });

    await deploy();
    const prepare = railpack().at(-1) as ToolRequest;
    expect(prepare.args).toEqual(
      expect.arrayContaining(["--env", "API_URL", "NPM_TOKEN", "RAILPACK_BUILD_CMD"]),
    );
    expect(prepare.args.join(" ")).not.toContain("build-variable-value");
    expect(prepare.args.join(" ")).not.toContain("npm-secret-value");
    expect(prepare.args.join(" ")).not.toContain("bun run build");
    expect(prepare.env.RAILPACK_BUILD_CMD).toBe("bun run build");
    expect(prepare.env.NPM_TOKEN).toBe("npm-secret-value");
    const hashOf = () => lastBuild().args.find((arg) => arg.startsWith("secrets-hash="));
    const before = hashOf();
    expect(before).toMatch(/^secrets-hash=[0-9a-f]{64}$/);

    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "another-secret-value" });
    await deploy();

    expect(hashOf()).not.toBe(before);
  });

  describe("on a service that was building before build variables existed", () => {
    it("still includes what its Dockerfile declares, so that it goes on building", async () => {
      upgradedFromBeforeScopes(
        "DECLARED=service-value\nNOT_DECLARED=other-value\n",
        "SHARED=project-value\n",
      );
      dockerfileDeclares("DECLARED", "SHARED");

      const deployed = await deploy();

      expect(deployed.status).toBe("succeeded");
      const build = lastBuild();
      expect(build.args).toEqual(expect.arrayContaining(["--build-arg", "DECLARED", "SHARED"]));
      expect(build.env.DECLARED).toBe("service-value");
      expect(build.env.SHARED).toBe("project-value");
      expect(deployed.log).toContain("Still passing runtime variables to this build");
      expect(deployed.log).toContain("SHARED, DECLARED");
    });

    it("leaves out what the Dockerfile doesn't declare, which it could not have used", async () => {
      upgradedFromBeforeScopes("DECLARED=service-value\nNOT_DECLARED=other-value\n");
      dockerfileDeclares("DECLARED");

      await deploy();

      expect(lastBuild().args).not.toContain("NOT_DECLARED");
      expect(lastBuild().env.NOT_DECLARED).toBeUndefined();
    });

    it("gives the other builders everything it gave them, since nothing says what they read", async () => {
      await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
      upgradedFromBeforeScopes("ANY_NAME=service-value\n");

      await deploy();

      const build = nixpacks().at(-1) as ToolRequest;
      expect(build.args).toEqual(expect.arrayContaining(["--env", "ANY_NAME"]));
      expect(build.env.ANY_NAME).toBe("service-value");
    });

    it("has never passed on anything sealed, and says it stopped", async () => {
      const serviceRecord = requireWeb();
      saveServiceSpec(
        context.deps.db,
        "shop",
        "web",
        {
          ...serviceRecord.spec,
          references: {
            databases: {},
            secrets: {
              apiKey: { sealed: context.deps.secrets.seal("sealed-value", "template-secret"), label: null },
            },
          },
        },
        new Date(),
      );
      upgradedFromBeforeScopes("REFERENCED=$(secret.apiKey)\nPLAIN=value\n");
      dockerfileDeclares("REFERENCED", "PLAIN");

      const deployed = await deploy();

      const build = lastBuild();
      expect(build.args).toEqual(expect.arrayContaining(["--build-arg", "PLAIN"]));
      expect(build.args).not.toContain("REFERENCED");
      expect(build.env.REFERENCED).toBeUndefined();
      expect(JSON.stringify(build.env)).not.toContain("sealed-value");
      expect(deployed.log).toContain("Not passing to the build, these hold sealed values: REFERENCED");
    });

    it("keeps out names that steer the tools", async () => {
      upgradedFromBeforeScopes("API_KEY=hunter2\nPATH=/bad\nDOCKER_HOST=tcp://evil\n");
      dockerfileDeclares("API_KEY");

      const deployed = await deploy();

      expect(deployed.log).toContain("Not passing to the build");
      const args = lastBuild().args;
      expect(args).toEqual(expect.arrayContaining(["--build-arg", "API_KEY"]));
      expect(args).not.toContain("DOCKER_HOST");
      expect(args).not.toContain("PATH");
      expect(args.join(" ")).not.toContain("hunter2");
      expect(lastBuild().env.DOCKER_HOST).not.toBe("tcp://evil");
    });

    it("keeps what the loader, the C library, Git and SSH read out of every program the build runs", async () => {
      await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
      const steering = {
        LD_PRELOAD: "/var/lib/opsifier/projects/shop/web/code/x.so",
        LD_LIBRARY_PATH: "/var/lib/opsifier/projects/shop/web/code",
        GCONV_PATH: "/var/lib/opsifier/projects/shop/web/code",
        GLIBC_TUNABLES: "glibc.malloc.check=3",
        MALLOC_TRACE: "/etc/passwd",
        PACK_HOME: "/var/lib/opsifier/projects/shop/web/code",
        GIT_SSH_COMMAND: "sh -c id",
        SSH_AUTH_SOCK: "/var/run/docker.sock",
        BASH_ENV: "/var/lib/opsifier/projects/shop/web/code/x.sh",
        OPENSSL_CONF: "/var/lib/opsifier/projects/shop/web/code/x.cnf",
      };
      upgradedFromBeforeScopes(
        `APP_NAME=shop\n${Object.entries(steering)
          .map(([key, value]) => `${key}=${value}\n`)
          .join("")}`,
      );

      const deployed = await deploy();

      expect(deployed.status).toBe("succeeded");
      expect((nixpacks().at(-1) as ToolRequest).env.APP_NAME).toBe("shop");
      // The panel sets some of these names itself for its own Git, never to the service's values.
      for (const request of tools().calls) {
        for (const [name, value] of Object.entries(steering)) {
          expect(request.env[name]).not.toBe(value);
          expect(request.args).not.toContain(name);
        }
      }
      expect(deployed.log).toContain("Not passing to the build, these names steer the build tools");
    });

    it("stops the moment someone says so", async () => {
      upgradedFromBeforeScopes("DECLARED=service-value\n");
      dockerfileDeclares("DECLARED");

      await api(`${BUILD}/inherited`, "DELETE");
      const deployed = await deploy();

      expect(lastBuild().args).not.toContain("DECLARED");
      expect(deployed.log).toContain("This Dockerfile declares DECLARED");
    });

    it("keeps its generated file where it was, with what it had", async () => {
      await api(`${SOURCE}/env-file`, "PUT", { path: ".env", inImage: true });
      upgradedFromBeforeScopes("KEPT=service-value\n");

      const deployed = await deploy();

      expect(deployed.status).toBe("succeeded");
      expect(readFileSync(code(".env"), "utf8")).toContain("KEPT=service-value");
    });
  });

  describe("and what its log can show", () => {
    const leak = (...lines: string[]) => {
      tools().handler = (request) => {
        if (request.command === "docker") {
          for (const line of lines) {
            // Straight to the log, as a builder that printed it would.
            request.onLine?.(line);
          }
          return { exitCode: 0, tail: [] };
        }
        return undefined;
      };
    };

    it("removes any variable, build value and sealed reference from the output", async () => {
      await api(`${SERVICE}/environment`, "PUT", { env: "RUNTIME_VALUE=runtime-secret-value\n" });
      await api(BUILD, "PUT", { env: "BUILD_VALUE=build-secret-value\n" });
      await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });
      await api("/projects/shop/env", "PUT", { env: "SHARED_VALUE=shared-secret-value\n" });
      const record = requireWeb();
      saveServiceSpec(
        context.deps.db,
        "shop",
        "web",
        {
          ...record.spec,
          references: {
            databases: {},
            secrets: {
              apiKey: {
                sealed: context.deps.secrets.seal("template-secret-value", "template-secret"),
                label: null,
              },
            },
          },
        },
        new Date(),
      );
      leak(
        "step one runtime-secret-value",
        "step two build-secret-value",
        "step three npm-secret-value",
        "step four shared-secret-value",
        "step five template-secret-value",
      );

      const deployed = await deploy();

      expect(deployed.status).toBe("succeeded");
      for (const value of [
        "runtime-secret",
        "build-secret",
        "npm-secret",
        "shared-secret",
        "template-secret",
      ]) {
        expect(deployed.log).not.toContain(`${value}-value`);
      }
      expect(deployed.log).toContain("step five [redacted]");
    });

    it("goes on removing a value after it has been changed", async () => {
      // Nothing in common between each first value and its replacement, so only memory can catch it.
      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=AlphaBravoCharlie1\n" });
      await api("/projects/shop/env", "PUT", { env: "SHARED_TOKEN=DeltaEchoFoxtrot2\n" });
      await api(BUILD, "PUT", { env: "BUILD_TOKEN=GolfHotelIndiaJul3\n" });
      await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "KiloLimaMikeNove4" });

      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=9q8w7e6r5t4y3u2i\n" });
      await api("/projects/shop/env", "PUT", { env: "SHARED_TOKEN=1a2s3d4f5g6h7j8k\n" });
      await api(BUILD, "PUT", { env: "BUILD_TOKEN=0z9x8c7v6b5n4m3l\n" });
      await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "P0o9I8u7Y6t5R4e3" });
      leak("AlphaBravoCharlie1 DeltaEchoFoxtrot2 GolfHotelIndiaJul3 KiloLimaMikeNove4");

      const deployed = await deploy();

      expect(deployed.log).not.toContain("AlphaBravoCharlie1");
      expect(deployed.log).not.toContain("DeltaEchoFoxtrot2");
      expect(deployed.log).not.toContain("GolfHotelIndiaJul3");
      expect(deployed.log).not.toContain("KiloLimaMikeNove4");
    });

    it("removes a secret split over the lines of a step, whatever else runs beside it", async () => {
      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=correct-horse-battery-staple\n" });
      leak("#7 0.312 correct-horse-", "#8 0.313 another step talking", "#7 0.314 battery-staple");

      const deployed = await deploy();

      expect(deployed.log).not.toContain("correct-horse-");
      expect(deployed.log).not.toContain("battery-staple");
      expect(deployed.log).toContain("#8 0.313 another step talking");
    });

    it("removes the parts of a secret printed apart, even after it has changed", async () => {
      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=correct-horse-battery-staple\n" });
      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=something-else-entirely\n" });
      leak("first half: correct-horse-", "something unrelated", "second half: battery-staple");

      const deployed = await deploy();

      expect(deployed.log).not.toContain("correct-horse-");
      expect(deployed.log).not.toContain("battery-staple");
    });

    it("is true of what fails the build too", async () => {
      await api(`${SERVICE}/environment`, "PUT", { env: "API_TOKEN=hunter2-token-value\n" });
      tools().handler = (request) => {
        if (request.command === "docker") {
          throw new Error("could not build with hunter2-token-value");
        }
        return undefined;
      };

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).not.toContain("hunter2-token-value");
      expect(deployed.error).toContain("[redacted]");
      expect(deployed.log).not.toContain("hunter2-token-value");
    });

    it("also covers a log written before the value was known to be one", async () => {
      leak("printed-before-it-was-saved");
      const deployed = await deploy();
      expect(deployed.log).toContain("printed-before-it-was-saved");

      await api(`${SERVICE}/environment`, "PUT", { env: "NEW_VALUE=printed-before-it-was-saved\n" });

      const read = await api<{ log: string }>(`/actions/${deployed.id}`);
      expect(read.body.log).not.toContain("printed-before-it-was-saved");
    });
  });
});

describe("a deployment from Git", () => {
  beforeEach(async () => {
    await saveGit();
    tools().calls.length = 0;
  });

  it("fetches, builds with the Dockerfile and rolls out the built image", async () => {
    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const fetch = calls("git").find((call) => call.args.includes("fetch"));
    expect(fetch?.args.slice(-3)).toEqual(["--", "https://git.example.com/acme/shop.git", "main"]);
    expect(lastBuild().args.slice(0, 2)).toEqual(["buildx", "build"]);
    expect(lastBuild().args).toContain("--tag=opsifier/shop/web:latest");
    expect(lastBuild().args).toContain("--pull");
    expect(lastBuild().args).not.toContain("--no-cache");
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await builtImageId());
    expect(deployed.log).toContain("Fetching https://git.example.com/acme/shop.git at main");
    expect(deployed.log).toContain("docker buildx build Dockerfile --pull");
  });

  it("stamps the commit on the image just built, without asking a registry for it", async () => {
    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const stamp = calls("docker").find((call) =>
      call.args.some((arg) => arg.includes("revision.Dockerfile")),
    );
    expect(stamp?.args).toContain("--tag=opsifier/shop/web:latest");
    expect(stamp?.args).not.toContain("--pull");
  });

  it("skips the cache on a force rebuild, and says so", async () => {
    const deployed = await deploy({ force: true });

    expect(deployed.status).toBe("succeeded");
    expect(lastBuild().args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
    expect(deployed.log).toContain(
      "Forced rebuild: skipping the build cache. The base images are fetched from their registry, as on every build",
    );
    expect(deployed.log).toContain("replaced by the new image");
  });

  it("says plainly what a forced rebuild does not refresh under Nixpacks", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });

    const deployed = await deploy({ force: true });

    expect(deployed.status).toBe("succeeded");
    expect(lastBuild().args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
    expect(deployed.log).toContain("Nixpacks 1.41.0 fixes its own base image, so that stays the same");
  });

  it("falls back to Nixpacks when there is no Dockerfile and no settings", async () => {
    tools().checkoutFiles = { "package.json": "{}" };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(nixpacks().at(0)?.args).toEqual(
      // `--out` writes `.nixpacks/` alone, so into the build's copy of the code, which is the context.
      expect.arrayContaining(["build", code(""), `--out=${code("")}`]),
    );
    expect(lastBuild().args).toContain("--tag=opsifier/shop/web:latest");
    expect(deployed.log).toContain("No Dockerfile found");
  });

  it("refuses a builder that isn't pinned when it is saved", async () => {
    const saved = await api(`${SOURCE}/build`, "PUT", {
      build: { type: "buildpacks", builder: "paketobuildpacks/builder-jammy-full:latest" },
    });

    expect(saved.status).toBe(400);
    expect(apiErrorOf(saved).fields?.["build.builder"]).toMatch(/pinned/);
  });

  it("reads a builder saved by an earlier release as the pinned build of the same line", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });
    const record = requireWeb();
    context.deps.db
      .update(services)
      .set({
        spec: {
          ...record.spec,
          build: { ...record.spec.build, config: { type: "buildpacks", builder: "heroku/builder:24" } },
        },
      })
      .where(eq(services.name, "web"))
      .run();

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(calls("pack").at(-1)?.args).toContain(`--builder=${defaultBuildpacksBuilder}`);
    expect((await api<SourceSettings>(SOURCE)).body.build).toEqual({
      type: "buildpacks",
      builder: defaultBuildpacksBuilder,
    });
  });

  it("uses the configured builder", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });

    await deploy();

    expect(calls("pack").at(0)?.args).toEqual(
      expect.arrayContaining(["build", "opsifier/shop/web:latest", `--builder=${defaultBuildpacksBuilder}`]),
    );
  });

  it("pulls the builder and the run image it names, and gives pack that run image", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });
    const pull = vi.spyOn(context.docker, "pullImage");

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const runImage = "heroku/builder-run:latest";
    expect(pull.mock.calls.map(([image, options]) => [image, options?.registryAuth])).toEqual([
      [defaultBuildpacksBuilder, undefined],
      [runImage, undefined],
    ]);
    expect(calls("pack").at(-1)?.args).toContain(`--run-image=${runImage}`);
    expect(deployed.log).toContain(`${defaultBuildpacksBuilder} runs its builds on ${runImage}`);
  });

  it("pulls a buildpack project.toml names by image first, and refuses one from the Buildpack Registry", async () => {
    await saveGit({ ...GIT_SOURCE, build: { type: "buildpacks" } });
    tools().checkoutFiles = {
      "project.toml": [
        "[[io.buildpacks.group]]",
        'uri = "docker://acme/buildpack:1.2.3"',
        "[[io.buildpacks.group]]",
        'uri = "registry.example.com/acme/plain:2.0.0"',
        // One of the builder's own, by its id: nothing to pull.
        "[[io.buildpacks.group]]",
        'id = "simulated/procfile"',
      ].join("\n"),
    };
    const pull = vi.spyOn(context.docker, "pullImage");

    expect((await deploy()).status).toBe("succeeded");
    const pulled = pull.mock.calls.map(([image, options]) => [image, options?.registryAuth]);
    expect(pulled).toContainEqual(["acme/buildpack:1.2.3", undefined]);
    expect(pulled).toContainEqual(["registry.example.com/acme/plain:2.0.0", undefined]);
    expect(pulled.map(([image]) => image)).not.toContain("simulated/procfile");

    for (const registry of ['uri = "urn:cnb:registry:acme/bp@1.0.0"', 'id = "acme/bp"\nversion = "1.0.0"']) {
      tools().checkoutFiles = { "project.toml": `[[io.buildpacks.group]]\n${registry}\n` };
      const refused = await deploy();
      expect(refused.status, registry).toBe("failed");
      expect(refused.error).toContain("Buildpack Registry");
    }
    expect(calls("pack")).toHaveLength(1);
  });

  it("refuses a buildpack project.toml names on the panel's disk, outside the source", async () => {
    await saveGit({ ...GIT_SOURCE, build: { type: "buildpacks" } });
    tools().checkoutFiles = {
      "project.toml": `[[io.buildpacks.group]]\nuri = "${context.dataDir}"\n`,
    };

    const refused = await deploy();

    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("which is outside the source");
    expect(calls("pack")).toHaveLength(0);
  });

  it("builds nothing with a builder whose run image belongs to another project", async () => {
    const builder = "acme/builder:1.2.3";
    context.docker.publishImage(builder, {
      "io.buildpacks.builder.metadata": JSON.stringify({ images: [{ image: "other_web-app:latest" }] }),
    });
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks", builder } });

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("other_web-app:latest is an image of another project on this server");
    expect(calls("pack")).toHaveLength(0);
  });

  it("builds nothing with a builder no registry gives this server", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });
    context.docker.failNext("pullImage", new DockerDriverError("pull access denied", 404));

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain(`Could not pull ${defaultBuildpacksBuilder} from its registry`);
    expect(calls("pack")).toHaveLength(0);
  });

  it("runs Railpack in its two steps", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack" } });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(railpack().at(0)?.args[0]).toBe("prepare");
    expect(lastBuild().args).toContain("BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.17.1");
    expect(lastBuild().args).toContain("--pull");
  });

  it("pulls what Railpack's plan names before carrying it out, and refuses another project's", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack" } });
    const pull = vi.spyOn(context.docker, "pullImage");

    expect((await deploy()).status).toBe("succeeded");
    expect(pull.mock.calls.map(([image]) => image).sort()).toEqual([
      FAKE_RAILPACK_BUILDER,
      FAKE_RAILPACK_RUNTIME,
    ]);

    tools().railpackPlan = { deploy: { base: { image: "opsifier/other/web:latest" } } };
    const refused = await deploy();
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("opsifier/other/web:latest is an image of another project");
    expect(
      builds().filter((call) =>
        call.args.includes("BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.17.1"),
      ),
    ).toHaveLength(1);
  });

  it("lets Nixpacks write what it would build, and builds that itself, from registries only", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    await api(`${SERVICE}/environment/build`, "PUT", { env: "API_URL=https://api.example.test\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    // Nixpacks never builds: it only writes, and the panel builds what it wrote.
    expect(nixpacks()).toHaveLength(1);
    const out = nixpacks()[0]
      ?.args.find((arg) => arg.startsWith("--out="))
      ?.slice("--out=".length);
    const build = lastBuild();
    expect(build.args).toEqual(
      expect.arrayContaining([
        "--pull",
        "--build-arg",
        `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
        // Its caches are the project's own, never another project's builds'.
        "BUILDKIT_CACHE_MOUNT_NS=shop",
        `--file=${out}/.nixpacks/Dockerfile`,
        "--tag=opsifier/shop/web:latest",
        "NIXPACKS_METADATA",
        "NODE_ENV",
        "API_URL",
      ]),
    );
    expect(build.args.at(-1)).toBe(out);
    // Values reach the build through its environment, never its arguments.
    expect(build.args.join(" ")).not.toContain("production");
    expect(build.env).toMatchObject({
      NIXPACKS_METADATA: "node",
      NODE_ENV: "production",
      API_URL: "https://api.example.test",
    });
    // A tag goes to its registry through --pull; only a digest is pulled by the panel first.
    expect(deployed.log).not.toContain(`Pulling base image ${FAKE_NIXPACKS_BASE}`);
  });

  it("gives Nixpacks's build the values Nixpacks gives it, spaces, quotes and newlines included", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    await api(`${SERVICE}/environment/build`, "PUT", {
      env: "GREETING=it's here --build-arg NODE_ENV=dev\n",
    });
    tools().nixpacksVariables = {
      NIXPACKS_METADATA: "node",
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=4096 --enable-source-maps",
      BANNER: 'it\'s "two"\nlines',
    };

    expect((await deploy()).status).toBe("succeeded");

    const build = lastBuild();
    expect(build.args).toEqual(expect.arrayContaining(["BANNER", "GREETING", "NODE_ENV", "NODE_OPTIONS"]));
    expect(build.env).toMatchObject({
      BANNER: 'it\'s "two"\nlines',
      GREETING: "it's here --build-arg NODE_ENV=dev",
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size=4096 --enable-source-maps",
    });
  });

  it("runs Nixpacks in a container of the panel's image, given the code and nothing else of the server", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    await api(`${SERVICE}/environment/build`, "PUT", { env: "API_URL=https://api.example.test\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(containers()).toHaveLength(1);
    const run = containers()[0] as ToolRequest;
    const options = run.args.slice(1, run.args.indexOf(PANEL_IMAGE));
    expect(options).toEqual(
      expect.arrayContaining([
        "--rm",
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--entrypoint=${builderTool("nixpacks", "1.41.0")}`,
      ]),
    );
    expect(
      options.filter((option) => /^--(mount|volume|privileged|pid|ipc|userns|device)/.test(option)),
    ).toEqual([`--mount="type=bind","source=${code("")}","target=${code("")}"`]);
    expect(run.args.join(" ")).not.toContain("docker.sock");
    expect(run.args.join(" ")).not.toContain("https://api.example.test");
    // In there, it has the build's variables and nothing of the panel's environment.
    expect(Object.keys((nixpacks()[0] as ToolRequest).env).sort()).toEqual(["API_URL", "GIT_SHA", "PORT"]);
    expect(deployed.log).toContain(`$ nixpacks 1.41.0 build --out`);
  });

  it("runs Railpack's first step in a container given the code and the folder of its plan", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack" } });

    expect((await deploy()).status).toBe("succeeded");

    const run = containers()[0] as ToolRequest;
    const plan = railpack()[0]
      ?.args.find((arg) => arg.startsWith("--plan-out="))
      ?.slice("--plan-out=".length);
    const folder = dirname(plan ?? "");
    expect(folder).not.toBe(dirname(folder));
    expect(run.args.filter((arg) => arg.startsWith("--mount="))).toEqual([
      `--mount="type=bind","source=${code("")}","target=${code("")}"`,
      `--mount="type=bind","source=${folder}","target=${folder}"`,
    ]);
    expect(run.args).toEqual(
      expect.arrayContaining(["--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges"]),
    );
    expect(lastBuild().args).toContain(`--file=${plan}`);
  });

  it("runs neither Nixpacks nor Railpack when the panel can't tell which image it runs from", async () => {
    await context.close();
    context = await createTestContext();
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/services", "POST", { name: "web" });

    for (const type of ["nixpacks", "railpack"]) {
      await saveGit({ ...GIT_SOURCE, build: { type } });
      const deployed = await deploy();
      expect(deployed.status, type).toBe("failed");
      expect(deployed.error).toContain(
        "runs in a container of the panel's own image, and this panel can't tell which image that is",
      );
    }
    expect(containers()).toHaveLength(0);
    expect([...nixpacks(), ...railpack()]).toHaveLength(0);
  });

  it("removes the container a tool runs in when its run is cut short", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    tools().handler = (request) => {
      if (request.command === "docker" && request.args[0] === "run") {
        throw new ToolTimeoutError("docker", 3_600_000);
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("ran out of time");
    const name = containers()[0]
      ?.args.find((arg) => arg.startsWith("--name="))
      ?.slice("--name=".length);
    expect(name).toMatch(/^opsifier-build-/);
    expect(calls("docker").at(-1)?.args).toEqual(["rm", "--force", name]);
  });

  it("reads only a folder Nixpacks wrote, never a link its container left in its place", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    const elsewhere = mkdtempSync(join(tmpdir(), "opsifier-nixpacks-left-"));
    try {
      tools().handler = (request) => {
        if (request.command === "docker" && request.args[0] === "run") {
          symlinkSync(elsewhere, code(".nixpacks"));
          return { exitCode: 0, tail: [] };
        }
        return undefined;
      };

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toContain("Nixpacks wrote no .nixpacks folder");
      expect(builds()).toHaveLength(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reads only a plan Railpack wrote, never a link its container left in its place", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack" } });
    const elsewhere = mkdtempSync(join(tmpdir(), "opsifier-railpack-left-"));
    try {
      writeFileSync(join(elsewhere, "plan.json"), "{}");
      tools().handler = (request) => {
        const plan = request.args.find((arg) => arg.startsWith("--plan-out="))?.slice("--plan-out=".length);
        if (request.command === "docker" && plan !== undefined) {
          symlinkSync(join(elsewhere, "plan.json"), plan);
          return { exitCode: 0, tail: [] };
        }
        return undefined;
      };

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toContain("Railpack's plan can't be read, so nothing was built");
      expect(builds()).toHaveLength(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("removes a .nixpacks link the code holds, and never writes through it", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "opsifier-nixpacks-link-"));
    try {
      tools().checkoutFiles = { "package.json": "{}" };
      tools().checkoutLinks = { ".nixpacks": elsewhere };

      const deployed = await deploy();

      expect(deployed.status).toBe("succeeded");
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(lstatSync(join(code(""), ".nixpacks")).isDirectory()).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses what Nixpacks wrote when it names another project's image, before building it", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    tools().nixpacksDockerfile = `FROM ${FAKE_NIXPACKS_BASE}\nFROM opsifier/other/web:latest\nCOPY --from=0 /app /app\n`;

    const refused = await deploy();

    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("opsifier/other/web:latest is an image of another project");
    expect(builds()).toHaveLength(0);
  });

  it("refuses a phase command that hides a flag behind a line BuildKit reads as a comment", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    const nextLine = String.fromCharCode(0x85);
    // What Nixpacks writes, as it is, for a build command ending in a backslash and two more lines.
    tools().nixpacksDockerfile = `FROM ${FAKE_NIXPACKS_BASE}\nRUN \\\n${nextLine}# x\n--mount=type=bind,from=opsifier/other/web,target=/x cat /x/secret\n`;

    const refused = await deploy();

    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("opsifier/other/web is an image of another project");
    expect(builds()).toHaveLength(0);
  });

  it("gives Nixpacks's build a value of its own that would steer the tools only as an argument", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    tools().nixpacksVariables = {
      NIXPACKS_METADATA: "node",
      MALLOC_ARENA_MAX: "2",
      DOCKER_HOST: "tcp://203.0.113.9:2375",
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const build = lastBuild();
    expect(build.args).toEqual(
      expect.arrayContaining(["--build-arg", "MALLOC_ARENA_MAX=2", "DOCKER_HOST=tcp://203.0.113.9:2375"]),
    );
    // Not in the Docker CLI's environment, where these would act on the CLI itself.
    expect(build.env.MALLOC_ARENA_MAX).toBeUndefined();
    expect(build.env.DOCKER_HOST).not.toBe("tcp://203.0.113.9:2375");
    expect(deployed.log).not.toContain("Not passing to the build");
  });

  it("leaves out of Nixpacks's build a name of BuildKit's, and says so", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks" } });
    tools().nixpacksVariables = {
      NIXPACKS_METADATA: "node",
      BUILDKIT_SYNTAX: "registry.example.com/frontend:1",
      buildkit_cache_mount_ns: "other",
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const build = lastBuild();
    expect(build.args.filter((arg) => /^buildkit_/i.test(arg))).toEqual([
      `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
      "BUILDKIT_CACHE_MOUNT_NS=shop",
    ]);
    expect(build.env.BUILDKIT_SYNTAX).toBeUndefined();
    expect(deployed.log).toContain(
      "Not passing to the build, these names steer the build tools: BUILDKIT_SYNTAX, buildkit_cache_mount_ns",
    );
  });

  it("reads the Dockerfile path from the build path", async () => {
    await saveGit({
      ...GIT_SOURCE,
      path: "/apps/web",
      build: { type: "dockerfile", file: "docker/Dockerfile" },
    });
    tools().checkoutFiles = { "apps/web/docker/Dockerfile": "FROM scratch\n" };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(lastBuild().args).toContain(`--file=${code("apps/web/docker/Dockerfile")}`);
    expect(lastBuild().args.at(-1)).toBe(code("apps/web"));
  });

  it("passes build variables by name and the commit at build and run time", async () => {
    await api(`${SERVICE}/environment/build`, "PUT", { env: "API_URL=hunter2-build-variable\n" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const args = lastBuild().args;
    expect(args).toEqual(expect.arrayContaining(["--build-arg", "API_URL", "GIT_SHA"]));
    expect(args.join(" ")).not.toContain("hunter2");
    expect(lastBuild().env.API_URL).toBe("hunter2-build-variable");
    expect(lastBuild().env.GIT_SHA).toBe(tools().gitSha);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env).toContain(`GIT_SHA=${tools().gitSha}`);
  });

  it("fails the deployment when the build fails, and leaves what runs alone", async () => {
    tools().handler = (request) =>
      request.command === "docker" ? { exitCode: 1, tail: ["boom"] } : undefined;

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toMatch(/build failed/);
    expect(await swarm()).toBeNull();
  });

  it("fails the deployment when the fetch fails", async () => {
    tools().handler = (request) =>
      request.args.includes("fetch") ? { exitCode: 128, tail: ["fatal: repository not found"] } : undefined;

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("repository not found");
    expect(deployed.error).toMatch(/deploy key or GitHub token.*deploy again/);
    expect(await swarm()).toBeNull();
  });

  it("says when a pinned commit has been rewritten, and leaves what is running alone", async () => {
    await saveGit({ ...GIT_SOURCE, ref: "0123456789abcdef0123456789abcdef01234567" });
    const deployedBefore = await deploy();
    expect(deployedBefore.status).toBe("succeeded");
    const running = await swarm();
    tools().handler = (request) =>
      request.args.includes("fetch")
        ? {
            exitCode: 128,
            tail: ["fatal: remote error: upload-pack: not our ref 0123456789abcdef0123456789abcdef01234567"],
          }
        : undefined;

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toMatch(/can no longer be fetched: it was rewritten by a force push/);
    expect(await swarm()).toEqual(running);
  });

  it("reports a build that runs out of time", async () => {
    tools().handler = async (request) => {
      if (request.command === "docker") {
        throw new ToolTimeoutError("docker", 3_600_000);
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toMatch(/ran out of time/);
  });

  it("passes the build's time limit on to the tools", async () => {
    await deploy();

    expect(lastBuild().timeoutMs).toBe(context.deps.config.buildTimeoutMs);
  });

  it("is cancelled by cancelling the Action, and what was running gets the signal", async () => {
    tools().buildMs = 30_000;
    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    for (let attempt = 0; attempt < 500 && calls("docker").length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancelled = await api(`/actions/${accepted.body.id}/cancel`, "POST");

    expect(cancelled.status).toBe(200);
    expect((await waitForAction(accepted.body.id)).status).toBe("cancelled");
    expect(lastBuild().signal?.aborted).toBe(true);
    expect(await swarm()).toBeNull();
  });

  describe("when the builder can't do what it was asked", () => {
    /** What runs before the change under test, so that a failure has something to leave alone. */
    async function deployedOnce() {
      expect((await deploy()).status).toBe("succeeded");
      return swarm();
    }

    it("fails instead of building with some other version, and what runs stays", async () => {
      const before = await deployedOnce();
      await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks", version: "1.39.0" } });
      tools().notInstalled.add(builderTool("nixpacks", "1.39.0"));

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toContain("Nixpacks 1.39.0 is not installed");
      expect(deployed.error).toContain("what is running was left alone");
      expect(calls("nixpacks")).toHaveLength(0);
      expect(nixpacks()).toHaveLength(0);
      expect(await swarm()).toEqual(before);
    });

    it("runs only the binary of the version that was chosen", async () => {
      await api(`${SOURCE}/build`, "PUT", { build: { type: "nixpacks", version: "1.39.0" } });

      expect((await deploy()).status).toBe("succeeded");

      expect(calls(builderTool("nixpacks", "1.39.0")).length).toBeGreaterThan(0);
      expect(calls("nixpacks")).toHaveLength(0);
    });

    it("says what is wrong with an unreachable registry, and what runs stays", async () => {
      const before = await deployedOnce();
      tools().handler = (request) =>
        request.command === "docker"
          ? {
              exitCode: 1,
              tail: [
                "ERROR: failed to solve: DeadlineExceeded: dial tcp: lookup registry-1.docker.io: no such host",
              ],
            }
          : undefined;

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toMatch(/could not be resolved/);
      expect(deployed.error).toMatch(/DNS/);
      expect(await swarm()).toEqual(before);
    });

    it("refuses a builder that was saved unpinned before this release, before building", async () => {
      await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });
      const record = requireWeb();
      const spec = {
        ...record.spec,
        build: {
          ...record.spec.build,
          config: { type: "buildpacks" as const, builder: "myorg/builder:bookworm" },
        },
      };
      saveServiceSpec(context.deps.db, "shop", "web", spec, new Date());

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toMatch(/myorg\/builder:bookworm is not pinned/);
      expect(calls("pack")).toHaveLength(0);
    });

    it("refuses to build at all when buildx does not answer, and leaves what runs alone", async () => {
      const before = await deployedOnce();
      tools().missingPlugins.add("buildx");
      tools().calls.length = 0;

      const deployed = await deploy();

      expect(deployed.status).toBe("failed");
      expect(deployed.error).toMatch(/buildx plugin does not work/);
      expect(calls("docker")).toHaveLength(0);
      expect(await swarm()).toEqual(before);
    });

    it("still builds with Buildpacks when buildx is what is missing, since it does not use it", async () => {
      await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });
      tools().missingPlugins.add("buildx");

      expect((await deploy()).status).toBe("succeeded");
    });
  });

  it("keeps a symlinked build path that leads outside from being built", async () => {
    await saveGit({ ...GIT_SOURCE, path: "/app" });
    tools().calls.length = 0;
    tools().handler = async (request) => {
      if (request.args.includes("checkout")) {
        const workTree = request.args.find((arg) => arg.startsWith("--work-tree="))?.split("=")[1] ?? "";
        mkdirSync(workTree, { recursive: true });
        symlinkSync("/etc", join(workTree, "app"));
        return { exitCode: 0, tail: [] };
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("leaves the source");
    expect(calls("docker")).toHaveLength(0);
  });

  it("keeps a symlinked Dockerfile that leads outside from being used", async () => {
    tools().handler = async (request) => {
      if (request.args.includes("checkout")) {
        const workTree = request.args.find((arg) => arg.startsWith("--work-tree="))?.split("=")[1] ?? "";
        mkdirSync(workTree, { recursive: true });
        symlinkSync("/etc/passwd", join(workTree, "Dockerfile"));
        return { exitCode: 0, tail: [] };
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("leaves the source");
  });

  it("removes secrets from build output", async () => {
    await api(`${SOURCE}/ssh-key`, "POST");
    const privateKey = (): string => {
      const spec = JSON.parse(rawSpec()) as { build: { sshKey: { sealedPrivateKey: string } } };
      return context.deps.secrets.unseal(spec.build.sshKey.sealedPrivateKey, "git-ssh-key");
    };
    const leaked = privateKey().split("\n")[1] as string;
    tools().handler = (request) => {
      if (request.command === "docker") {
        request.onLine?.(request.redact?.apply(`oops ${leaked}`) ?? "");
        return { exitCode: 0, tail: [] };
      }
      return undefined;
    };

    const deployed = await deploy();

    expect(deployed.log).toContain("[redacted]");
    expect(deployed.log).not.toContain(leaked);
  });

  it("leaves nothing behind in the panel's temporary folder", async () => {
    await deploy();

    const tmp = join(context.dataDir, "tmp");
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
  });

  it("replaces the previous checkout completely", async () => {
    tools().checkoutFiles = { Dockerfile: "FROM scratch\n", "old.txt": "old" };
    await deploy();
    expect(existsSync(code("old.txt"))).toBe(true);

    tools().checkoutFiles = { Dockerfile: "FROM scratch\n" };
    await deploy();

    expect(existsSync(code("old.txt"))).toBe(false);
  });

  it("keeps the code directory private", async () => {
    await deploy();

    expect(statSync(join(context.dataDir, "projects", "shop", "web")).mode & 0o077).toBe(0);
  });
});

describe("starting after a rename", () => {
  async function renamedAndStopped() {
    await saveGit();
    await deploy();
    await waitForAction((await api<ActionEntry>(`${SERVICE}/stop`, "POST")).body.id);
    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });
    tools().calls.length = 0;
  }

  it("uses the image the service already has, with no clone and no build", async () => {
    await renamedAndStopped();

    const accepted = await api<ActionEntry>("/projects/shop/services/web2/start", "POST");
    const started = await waitForAction(accepted.body.id);

    expect(started.status).toBe("succeeded");
    expect(tools().calls).toEqual([]);
    expect((await context.docker.inspectService("shop_web2"))?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      "opsifier/shop/web2:latest",
    );
    expect(await context.docker.inspectImage("opsifier/shop/web:latest")).toBeNull();
  });

  it("says to deploy when the image is gone, instead of building one", async () => {
    await renamedAndStopped();
    await context.docker.removeImage("opsifier/shop/web2:latest");

    const accepted = await api<ActionEntry>("/projects/shop/services/web2/start", "POST");
    const started = await waitForAction(accepted.body.id);

    expect(started.status).toBe("failed");
    expect(started.error).toContain("Deploy it to build one");
    expect(tools().calls).toEqual([]);
  });
});

describe("an image source", () => {
  it("still pulls and has no build", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.28" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toContain("Pulling image nginx:1.28");
    expect(calls("docker")).toHaveLength(0);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      (await context.docker.inspectImage("nginx:1.28"))?.digests[0],
    );
  });
});

describe("what the API shows", () => {
  it("never includes a sealed value or a private key", async () => {
    await api(`${SOURCE}/ssh-key`, "POST");
    await saveGit();

    const settings = JSON.stringify((await api(SOURCE)).body);
    const detail = JSON.stringify((await api(SERVICE)).body);

    for (const text of [settings, detail]) {
      expect(text).not.toContain("sealed");
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("deployToken");
    }
  });
});
