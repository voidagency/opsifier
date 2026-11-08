import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ActionEntry, ServiceSource, SourceSettings } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services } from "../../../core/db/schema";
import { type FakeTools, type ToolRequest, ToolTimeoutError } from "../../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { receiveUpload } from "./service";

const hasBsdtar = spawnSync("bsdtar", ["--version"]).error === undefined;

const SERVICE = "/projects/shop/services/web";
const SOURCE = `${SERVICE}/source`;
const GIT_SOURCE = { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" };

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

const tools = () => context.deps.tools as FakeTools;
const calls = (command: string) => tools().callsTo(command);
const lastBuild = () => calls("docker").at(-1) as ToolRequest;

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

const swarm = () => context.docker.inspectService("shop_web");
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
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/octet-stream" },
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
    expect(apiErrorOf(result).code).toBe("repository_unreachable");
    expect(apiErrorOf(result).fields?.reason).toContain("could not read Username");
    expect((await api<SourceSettings>(SOURCE)).body.source).toBeNull();
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

    await saveGit({ ...GIT_SOURCE, url: "git@git.example.com:acme/shop.git" });
    expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).toContain("deploy_key");

    await saveGit(GIT_SOURCE);
    expect(calls("git").at(-1)?.env.GIT_SSH_COMMAND).not.toContain("deploy_key");
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
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe("opsifier/shop/web:latest");
    expect(calls("git")).toHaveLength(0);
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
        cookie,
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

    await expect(
      receiveUpload(
        context.deps,
        { projectName: "shop", serviceName: "web" },
        { fileName: "app.tar", path: "/" },
        stream,
        undefined,
        undefined,
        10 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(join(context.dataDir, "projects", "shop", "web", "upload"))).toEqual([]);
  });

  it("refuses a name it will not unpack", async () => {
    const response = await context.app.request(`/api/v1${SOURCE}/upload?fileName=app.exe`, {
      method: "PUT",
      headers: { cookie, origin: TEST_ORIGIN },
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

    const result = await api(`${SOURCE}/env-file`, "PUT", { path: ".env" });

    expect(result.status).toBe(400);
  });

  it("is written into the build path before the build", async () => {
    await saveGit({ ...GIT_SOURCE, path: "/apps/web" });
    tools().checkoutFiles = { "apps/web/Dockerfile": "FROM scratch\n" };
    await api(`${SERVICE}/environment`, "PUT", { env: 'GREETING="hello world"\nPLAIN=1\n' });
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(readFileSync(code("apps/web/.env"), "utf8")).toContain('GREETING="hello world"');
    expect(readFileSync(code("apps/web/.env"), "utf8")).toContain("PLAIN=1");
  });

  it("can be turned off again", async () => {
    await saveGit();
    await api(`${SOURCE}/env-file`, "PUT", { path: ".env" });
    await api(`${SOURCE}/env-file`, "PUT", { path: null });

    expect((await api<{ path: string | null }>(`${SOURCE}/env-file`)).body.path).toBeNull();
  });

  it("refuses a path that climbs out", async () => {
    await saveGit();

    const result = await api(`${SOURCE}/env-file`, "PUT", { path: "../.env" });

    expect(result.status).toBe(400);
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
    expect(lastBuild().args).not.toContain("--no-cache");
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe("opsifier/shop/web:latest");
    expect(deployed.log).toContain("Fetching https://git.example.com/acme/shop.git at main");
    expect(deployed.log).toContain("docker buildx build Dockerfile");
  });

  it("skips the cache on a force rebuild", async () => {
    const deployed = await deploy({ force: true });

    expect(deployed.status).toBe("succeeded");
    expect(lastBuild().args).toContain("--no-cache");
  });

  it("falls back to Nixpacks when there is no Dockerfile and no settings", async () => {
    tools().checkoutFiles = { "package.json": "{}" };

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(calls("docker")).toHaveLength(0);
    expect(calls("nixpacks").at(0)?.args).toEqual(
      expect.arrayContaining(["build", code(""), "--name=opsifier/shop/web:latest"]),
    );
    expect(deployed.log).toContain("No Dockerfile found");
  });

  it("uses the configured builder", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "buildpacks" } });

    await deploy();

    expect(calls("pack").at(0)?.args).toEqual(
      expect.arrayContaining(["build", "opsifier/shop/web:latest", "--builder=heroku/builder:24"]),
    );
  });

  it("runs Railpack in its two steps", async () => {
    await api(`${SOURCE}/build`, "PUT", { build: { type: "railpack" } });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(calls("railpack").at(0)?.args[0]).toBe("prepare");
    expect(lastBuild().args).toContain("BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.17.1");
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

  it("passes variables to the build by name and the commit at build and run time", async () => {
    await api(`${SERVICE}/environment`, "PUT", {
      env: "API_KEY=hunter2\nPATH=/bad\nDOCKER_HOST=tcp://evil\n",
    });

    const deployed = await deploy();

    expect(deployed.log).toContain("Not passing to the build");
    const args = lastBuild().args;
    expect(args).toEqual(expect.arrayContaining(["--build-arg", "API_KEY", "GIT_SHA"]));
    expect(args).not.toContain("DOCKER_HOST");
    expect(args).not.toContain("PATH");
    expect(args.join(" ")).not.toContain("hunter2");
    expect(lastBuild().env.API_KEY).toBe("hunter2");
    expect(lastBuild().env.GIT_SHA).toBe(tools().gitSha);
    expect(lastBuild().env.DOCKER_HOST).not.toBe("tcp://evil");
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

describe("restarting after a rename", () => {
  it("rebuilds the image under its new name", async () => {
    await saveGit();
    await deploy();
    await waitForAction((await api<ActionEntry>(`${SERVICE}/stop`, "POST")).body.id);
    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });
    tools().calls.length = 0;

    const accepted = await api<ActionEntry>("/projects/shop/services/web2/start", "POST");
    const started = await waitForAction(accepted.body.id);

    expect(started.status).toBe("succeeded");
    expect(lastBuild().args).toContain("--tag=opsifier/shop/web2:latest");
    expect((await context.docker.inspectService("shop_web2"))?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      "opsifier/shop/web2:latest",
    );
  });
});

describe("an image source", () => {
  it("still pulls and has no build", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.28" });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toContain("Pulling image nginx:1.28");
    expect(calls("docker")).toHaveLength(0);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe("nginx:1.28");
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
