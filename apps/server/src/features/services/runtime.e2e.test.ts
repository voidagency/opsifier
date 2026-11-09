import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectLeftovers } from "../../testing/e2e-inventory";

/**
 * What a service runs with, on a real daemon in a Docker-in-Docker sandbox, through the panel's API.
 * Run it against a panel using the sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3407 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23807 \
 *   OPSIFIER_E2E_DATA_DIR=... OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/services/runtime.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3211"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "unix:///var/run/docker.sock";
const DATA_DIR = process.env.OPSIFIER_E2E_DATA_DIR ?? "";

const POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 180_000;

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

async function waitForAction(id: string): Promise<{ status: string; error: string | null; log?: string }> {
  for (;;) {
    const action = await api<{ status: string; error: string | null; log?: string }>(`/actions/${id}`);
    if (action.status !== "queued" && action.status !== "running") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const docker = (...args: string[]) =>
  execFileSync("docker", ["-H", DOCKER_HOST, ...args], { encoding: "utf8" }).trim();

const dockerFails = (...args: string[]): boolean => {
  try {
    docker(...args);
    return false;
  } catch {
    return true;
  }
};

const project = `e2e-runtime-${Date.now().toString(36)}`;
const servicePath = (name: string) => `/projects/${project}/services/${name}`;

async function create(name: string, source: unknown): Promise<void> {
  await api(`/projects/${project}/services`, "POST", { name });
  await api(`${servicePath(name)}/source`, "PUT", source);
}

async function run(path: string): Promise<{ status: string; error: string | null }> {
  const action = await api<{ id: string }>(path, "POST", {});
  return waitForAction(action.id);
}

async function deploy(name: string): Promise<void> {
  const finished = await run(`${servicePath(name)}/deploy`);
  expect(finished).toMatchObject({ status: "succeeded", error: null });
}

function serviceSpec(name: string): {
  TaskTemplate: {
    ContainerSpec: { Command?: string[]; Args?: string[]; StopSignal?: string; StopGracePeriod?: number };
    Resources?: { Limits?: { Pids?: number } };
  };
} {
  return JSON.parse(docker("service", "inspect", "--format", "{{json .Spec}}", `${project}_${name}`));
}

/** The running container of a one-task service. */
function taskContainer(name: string): string {
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

describe.skipIf(!enabled)("what a service runs with, on real Docker", () => {
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
    const deleted = await api<{ id: string }>(`/projects/${project}`, "DELETE", { confirm: project });
    await waitForAction(deleted.id);
    const { volumes } = await api<{ volumes: Array<{ name: string; projectName: string }> }>(
      "/retained-volumes",
    );
    for (const { name } of volumes.filter((volume) => volume.projectName === project)) {
      const action = await api<{ id: string }>(`/retained-volumes/${name}`, "DELETE", { confirm: name });
      await waitForAction(action.id);
    }

    expect(projectLeftovers(docker, project)).toEqual([]);
  }, SETTLE_TIMEOUT_MS);

  it("runs a plain command on an image with no shell", { timeout: SETTLE_TIMEOUT_MS }, async () => {
    await create("noshell", { image: "traefik/whoami:v1.10" });
    await api(`${servicePath("noshell")}/advanced/deploy`, "PUT", { command: "/whoami -port 8081" });

    await deploy("noshell");

    expect(serviceSpec("noshell").TaskTemplate.ContainerSpec).toMatchObject({
      Command: ["/whoami", "-port", "8081"],
    });
    expect(serviceSpec("noshell").TaskTemplate.ContainerSpec.Args).toBeUndefined();
    expect(taskContainer("noshell")).not.toBe("");
  });

  it("asks a task to stop with the chosen signal, within the delay", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    await create("stopper", { image: "alpine:3.21" });
    await api(`${servicePath("stopper")}/storage/mounts`, "POST", {
      type: "volume",
      name: "data",
      mountPath: "/data",
    });
    await api(`${servicePath("stopper")}/advanced/deploy`, "PUT", {
      command:
        "trap 'echo quit > /data/marker; exit 0' QUIT; trap 'echo term > /data/marker; exit 0' TERM; while :; do sleep 1; done",
      stopSignal: "SIGQUIT",
      stopGraceSeconds: 40,
    });

    await deploy("stopper");
    expect(serviceSpec("stopper").TaskTemplate.ContainerSpec).toMatchObject({
      StopSignal: "SIGQUIT",
      StopGracePeriod: 40_000_000_000,
    });

    const startedAt = Date.now();
    expect((await run(`${servicePath("stopper")}/stop`)).status).toBe("succeeded");

    expect(Date.now() - startedAt).toBeLessThan(30_000);
    const marker = join(DATA_DIR, "projects", project, "stopper", "volumes", "data", "marker");
    expect(readFileSync(marker, "utf8").trim()).toBe("quit");
  });

  it("bounds how many processes a task can have", { timeout: SETTLE_TIMEOUT_MS }, async () => {
    await create("bounded", { image: "alpine:3.21" });
    await api(`${servicePath("bounded")}/advanced/deploy`, "PUT", { command: "sleep 600" });

    await deploy("bounded");

    expect(serviceSpec("bounded").TaskTemplate.Resources?.Limits?.Pids).toBe(8192);
    expect(docker("inspect", "--format", "{{.HostConfig.PidsLimit}}", taskContainer("bounded"))).toBe("8192");
  });

  it("lets the image's user write to the volume it was given, and nowhere else", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    await create("nonroot", { type: "dockerfile", dockerfile: "FROM alpine:3.21\nUSER 1000\n" });
    await api(`${servicePath("nonroot")}/storage/mounts`, "POST", {
      type: "volume",
      name: "data",
      mountPath: "/data",
    });
    await api(`${servicePath("nonroot")}/storage/mounts`, "POST", {
      type: "file",
      mountPath: "/app.conf",
      content: "kept\n",
    });
    await api(`${servicePath("nonroot")}/advanced/deploy`, "PUT", { command: "sleep 600" });

    await deploy("nonroot");

    const container = taskContainer("nonroot");
    expect(docker("exec", container, "id", "-u")).toBe("1000");
    expect(dockerFails("exec", container, "touch", "/data/ok")).toBe(false);
    expect(docker("exec", container, "ls", "/data")).toContain("ok");
    expect(dockerFails("exec", container, "touch", "/made-at-the-root")).toBe(true);
    // A file mount belongs to whoever runs the panel. Only a Linux host shows that to a container:
    // Docker Desktop's file sharing lets any user write through a mount from the Mac's disk.
    if (process.platform === "linux") {
      expect(dockerFails("exec", container, "sh", "-c", "echo changed >> /app.conf")).toBe(true);
      expect(docker("exec", container, "cat", "/app.conf")).toBe("kept");
    }
  });
});
