import { execFileSync } from "node:child_process";
import type { BoxDetail, BoxProcessesStatus } from "@opsifier/contract";
import { boxModuleIds } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boxModuleFixtures } from "./box.fixtures";

/**
 * Every declared module, built and run on a real daemon in a Docker-in-Docker sandbox, through the
 * panel's API. Run it against a panel using the sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3418 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23818 \
 *   OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/box/box.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3418"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "tcp://127.0.0.1:23818";

const POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 120_000;
const FIXTURE_TIMEOUT_MS = 600_000;

let cookie = "";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: new URL(BASE).origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) {
    cookie = setCookie.split(";", 1)[0] ?? "";
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

interface Finished {
  status: string;
  error: string | null;
  log: string;
}

async function waitForAction(id: string): Promise<Finished> {
  for (;;) {
    const action = await api<Finished>(`/actions/${id}`);
    if (action.status !== "queued" && action.status !== "running") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const docker = (...args: string[]) =>
  execFileSync("docker", ["-H", DOCKER_HOST, ...args], { encoding: "utf8" }).trim();

const project = `e2e-box-${Date.now().toString(36)}`;
const servicePath = (name: string) => `/projects/${project}/services/${name}`;

async function deploy(name: string, body: { force?: boolean } = {}): Promise<Finished> {
  const action = await api<{ id: string }>(`${servicePath(name)}/deploy`, "POST", body);
  return waitForAction(action.id);
}

/** Issues an IDE token, so files can be written and read through what the editor itself uses. */
async function ide(name: string): Promise<{
  read: (path: string) => Promise<string | null>;
  write: (path: string, content: string) => Promise<void>;
}> {
  await api(`${servicePath(name)}/box/ide`, "PUT", { enabled: true });
  const { token } = await api<{ token: string }>(`${servicePath(name)}/box/ide/token`, "POST", {
    expiresInHours: 1,
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `${BASE}/ide/${project}/${name}`;
  return {
    read: async (path) => {
      const response = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, { headers });
      return response.status === 200 ? ((await response.json()) as { content: string | null }).content : null;
    },
    write: async (path, content) => {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      if (parent !== null) {
        await fetch(`${base}/directory`, { method: "POST", headers, body: JSON.stringify({ path: parent }) });
      }
      const response = await fetch(`${base}/file`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ path, content, version: null }),
      });
      if (!response.ok) {
        throw new Error(`Writing ${path}: ${response.status} ${await response.text()}`);
      }
    },
  };
}

const statusOf = (name: string) => api<BoxProcessesStatus>(`${servicePath(name)}/box/processes/status`);

async function until<T>(check: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function runningContainer(name: string): string {
  return docker(
    "ps",
    "--filter",
    `label=com.docker.swarm.service.name=${project}_${name}`,
    "--filter",
    "status=running",
    "--format",
    "{{.ID}}",
  );
}

describe.skipIf(!enabled)("a box, on real Docker", () => {
  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    await api("/projects", "POST", { name: project });
  });

  afterAll(async () => {
    const { services } = await api<{ services: Array<{ name: string }> }>(`/projects/${project}`);
    for (const { name } of services) {
      const action = await api<{ id: string }>(servicePath(name), "DELETE", { confirm: name });
      await waitForAction(action.id);
    }
    await api(`/projects/${project}`, "DELETE", { confirm: project });
  });

  it.each(boxModuleIds.map((id) => [id]))(
    "%s: builds, runs its process, restarts it and keeps its workspace",
    async (id) => {
      const fixture = boxModuleFixtures[id];
      const name = `fixture-${id}`;
      await api(`/projects/${project}/box`, "POST", { name, preset: null });
      await api(`${servicePath(name)}/box/modules`, "PUT", fixture.modules);
      await api(`${servicePath(name)}/box/processes`, "PUT", { processes: fixture.processes });
      const files = await ide(name);
      await files.write("kept.txt", `written before the first build of ${id}`);
      if (id === "nginx") {
        await files.write("public/hello.txt", "served by nginx\n");
      }

      const finished = await deploy(name);
      expect(finished).toMatchObject({ status: "succeeded", error: null });

      // Process: the module's own program wrote the proof, in the workspace.
      const proof = await until(
        async () => (await files.read(fixture.proofFile)) ?? undefined,
        "the proof file",
      );
      expect(proof).toBe(fixture.proofContent);
      const running = await statusOf(name);
      expect(running.reachable).toBe(true);
      expect(running.processes.find((process) => process.name === "web")?.state).toBe("running");

      // Restart: kill it from inside, and the supervisor brings it back.
      const container = runningContainer(name);
      const before = docker("exec", container, "/opt/opsifier/boxctl", "status")
        .split("\n")
        .find((line) => line.startsWith("web\t"));
      const pid = before?.split("\t")[2];
      docker("exec", container, "sh", "-c", `kill -9 ${pid}`);
      await until(async () => {
        const current = (await statusOf(name)).processes.find((process) => process.name === "web");
        return current?.state === "running" && current.restarts >= 1 ? current : undefined;
      }, "the process to come back");

      // Workspace: a forced rebuild replaces the image and leaves the files.
      const rebuilt = await deploy(name, { force: true });
      expect(rebuilt).toMatchObject({ status: "succeeded", error: null });
      expect(await files.read("kept.txt")).toBe(`written before the first build of ${id}`);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "changes a runtime version and rebuilds, keeping files and configuration",
    async () => {
      const name = "upgrade";
      const fixture = boxModuleFixtures.node;
      await api(`/projects/${project}/box`, "POST", { name, preset: null });
      await api(`${servicePath(name)}/box/modules`, "PUT", { node: { version: "22" } });
      await api(`${servicePath(name)}/box/processes`, "PUT", { processes: fixture.processes });
      await api(`${servicePath(name)}/environment`, "PUT", { env: "KEEP_ME=yes" });
      const files = await ide(name);
      await files.write("notes.txt", "survive the upgrade");
      expect(await deploy(name)).toMatchObject({ status: "succeeded" });
      expect(await until(async () => (await files.read("node-proof")) ?? undefined, "the first proof")).toBe(
        "v22",
      );

      await api(`${servicePath(name)}/box/modules`, "PUT", { node: { version: "24" } });
      const pending = await api<BoxDetail>(`${servicePath(name)}/box`);
      expect(pending.pendingChanges).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "upgrade", subject: "node" })]),
      );

      const finished = await deploy(name);
      expect(finished.status).toBe("succeeded");
      expect(finished.log).toContain("upgrade node: 22 -> 24");

      await until(
        async () => ((await files.read("node-proof")) === "v24" ? true : undefined),
        "the process to run on the new version",
      );
      expect(await files.read("notes.txt")).toBe("survive the upgrade");
      const container = runningContainer(name);
      expect(docker("exec", container, "printenv", "KEEP_ME")).toBe("yes");
      const history = await api<BoxDetail>(`${servicePath(name)}/box`);
      expect(history.history[0]).toMatchObject({ reason: "upgrade", status: "succeeded" });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "fails a deployment on a failing hook and leaves what was running in place",
    async () => {
      const name = "hooks";
      await api(`/projects/${project}/box`, "POST", { name, preset: null });
      await api(`${servicePath(name)}/box/processes`, "PUT", {
        processes: [{ name: "web", command: "sleep 3600" }],
      });
      await api(`${servicePath(name)}/box/hooks`, "PUT", { build: "", start: "echo started-ok" });
      expect(await deploy(name)).toMatchObject({ status: "succeeded" });
      const running = runningContainer(name);

      await api(`${servicePath(name)}/box/hooks`, "PUT", { build: "exit 7", start: "" });
      const failedBuild = await deploy(name);
      expect(failedBuild.status).toBe("failed");
      expect(failedBuild.error).toContain("The build hook failed");
      expect(runningContainer(name)).toBe(running);

      await api(`${servicePath(name)}/box/hooks`, "PUT", { build: "", start: "exit 5" });
      const failedStart = await deploy(name);
      expect(failedStart.status).toBe("failed");
      expect(failedStart.error).toContain("The start hook failed");
      // The new task never came up, so the old configuration was put back.
      await until(
        async () => (runningContainer(name) !== "" ? true : undefined),
        "the old version to return",
      );
      const detail = await api<BoxDetail>(`${servicePath(name)}/box`);
      expect(detail.history[0]).toMatchObject({ status: "failed" });
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    "cancels a build without touching what is running",
    async () => {
      const name = "cancel";
      await api(`/projects/${project}/box`, "POST", { name, preset: null });
      await api(`${servicePath(name)}/box/processes`, "PUT", {
        processes: [{ name: "web", command: "sleep 3600" }],
      });
      expect(await deploy(name)).toMatchObject({ status: "succeeded" });
      const running = runningContainer(name);

      await api(`${servicePath(name)}/box/hooks`, "PUT", { build: "sleep 300", start: "" });
      const action = await api<{ id: string }>(`${servicePath(name)}/deploy`, "POST", {});
      await until(async () => {
        const current = await api<{ log: string }>(`/actions/${action.id}`);
        return current.log.includes("/opt/opsifier/hooks/build") ? true : undefined;
      }, "the build hook to start");
      await api(`/actions/${action.id}/cancel`, "POST", {});

      expect(await waitForAction(action.id)).toMatchObject({ status: "cancelled" });
      expect(runningContainer(name)).toBe(running);
      expect((await api<BoxDetail>(`${servicePath(name)}/box`)).history[0]).toMatchObject({
        status: "cancelled",
      });
    },
    FIXTURE_TIMEOUT_MS,
  );
});
