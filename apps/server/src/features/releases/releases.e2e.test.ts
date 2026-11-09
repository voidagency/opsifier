import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentPage, ReleaseList } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectLeftovers } from "../../testing/e2e-inventory";

/**
 * Going back to an earlier version, on a real daemon in a Docker-in-Docker sandbox, through the
 * panel's API. It pulls one small image and runs a registry from another, inside the sandbox.
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3413 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23813 \
 *   OPSIFIER_E2E_DATA_DIR=... OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/releases/releases.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3211"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "unix:///var/run/docker.sock";
const DATA_DIR = process.env.OPSIFIER_E2E_DATA_DIR ?? "";

const POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 240_000;
const BUSYBOX = "busybox:1.36";
const PROXY_STANDIN = "opsifier-traefik";

let cookie = "";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: new URL(BASE).origin,
      // A build can outlast a keep-alive: a socket closed by the server would reset the next request.
      connection: "close",
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

async function refusedCode(path: string, body: unknown): Promise<string> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, origin: new URL(BASE).origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(409);
  return ((await response.json()) as { error: { code: string } }).error.code;
}

interface FinishedAction {
  id: string;
  status: string;
  error: string | null;
  log?: string;
}

async function waitForAction(id: string): Promise<FinishedAction> {
  for (;;) {
    const action = await api<FinishedAction>(`/actions/${id}`);
    if (action.status !== "queued" && action.status !== "running") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const docker = (...args: string[]) =>
  execFileSync("docker", ["-H", DOCKER_HOST, ...args], { encoding: "utf8" }).trim();

const project = `e2e-rollback-${Date.now().toString(36)}`;
const WEB = `/projects/${project}/services/web`;
const RELEASES = `${WEB}/releases`;

const dockerfile = (marker: string) =>
  `FROM ${BUSYBOX}\nRUN mkdir -p /www && printf ${marker} > /www/index.html\nCMD ["httpd", "-f", "-p", "80", "-h", "/www"]\n`;

async function deploy(path = WEB): Promise<FinishedAction> {
  const action = await api<{ id: string }>(`${path}/deploy`, "POST", {});
  const finished = await waitForAction(action.id);
  expect(finished).toMatchObject({ status: "succeeded", error: null });
  return finished;
}

async function rollBack(number: number, path = WEB): Promise<FinishedAction> {
  const action = await api<{ id: string }>(`${path}/releases/${number}/rollback`, "POST", {
    confirm: path.split("/").at(-1),
  });
  return waitForAction(action.id);
}

const qualified = (name: string) => `${project}_${name}`;

function serviceImage(name: string): string {
  return docker(
    "service",
    "inspect",
    "--format",
    "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    qualified(name),
  );
}

/** The running container of a one-task service. */
function taskContainer(name: string): string {
  return docker(
    "ps",
    "-n",
    "1",
    "--filter",
    `label=com.docker.swarm.service.name=${qualified(name)}`,
    "--filter",
    "status=running",
    "--format",
    "{{.ID}}",
  );
}

const inTask = (name: string, ...args: string[]) => docker("exec", taskContainer(name), ...args);
const served = (name: string) => inTask(name, "wget", "-qO-", "http://127.0.0.1:80/");
const volumeFile = (name: string, file: string) =>
  join(DATA_DIR, "projects", project, name, "volumes", "data", file);

/** Image events on the daemon between two moments: what a pull would show up in. */
function imageEventsSince(since: string): string {
  return docker(
    "events",
    "--since",
    since,
    "--until",
    `${Math.floor(Date.now() / 1000)}`,
    "--filter",
    "type=image",
    "--format",
    "{{.Action}} {{.Actor.ID}}",
  );
}

describe.skipIf(!enabled)("going back to an earlier version, on real Docker", () => {
  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    await api("/projects", "POST", { name: project });
    docker("pull", BUSYBOX);
    // Stands in for Traefik, so that "does it answer" has something to ask from: only `nc` is used.
    docker("service", "create", "--detach", "--name", PROXY_STANDIN, BUSYBOX, "sleep", "86400");
  }, SETTLE_TIMEOUT_MS);

  afterAll(async () => {
    const { services } = await api<{ services: Array<{ name: string }> }>(`/projects/${project}`);
    for (const { name } of services) {
      const action = await api<{ id: string }>(`/projects/${project}/services/${name}`, "DELETE", {
        confirm: name,
      });
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
    docker("service", "rm", PROXY_STANDIN);
    expect(projectLeftovers(docker, project)).toEqual([]);
  }, SETTLE_TIMEOUT_MS);

  it("puts the image and settings of a built version back, keeps the data, and pulls nothing", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    await api(`/projects/${project}/services`, "POST", { name: "web" });
    await api(`${WEB}/source`, "PUT", { type: "dockerfile", dockerfile: dockerfile("v1") });
    await api(`${WEB}/environment`, "PUT", { env: "WHICH=one" });
    await api(`${WEB}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();

    const version1 = (await api<ReleaseList>(RELEASES)).items[0];
    expect(version1).toMatchObject({ number: 1, active: true, image: `opsifier/${project}/web:latest` });
    expect(serviceImage("web")).toBe(version1?.imageId);
    expect(version1?.imageId).toMatch(/^sha256:/);
    expect(await served("web")).toBe("v1");
    inTask("web", "sh", "-c", "echo before > /data/written-by-v1");

    // The panel writes down what really ran, and that something answered on its port.
    const { items } = await api<DeploymentPage>(`${WEB}/deployments`);
    expect(items[0]?.deployment).toMatchObject({
      imageId: version1?.imageId,
      release: 1,
      answering: true,
      runningTasks: 1,
      desiredTasks: 1,
    });

    await api(`${WEB}/source`, "PUT", { type: "dockerfile", dockerfile: dockerfile("v2") });
    await api(`${WEB}/environment`, "PUT", { env: "WHICH=two" });
    await deploy();

    const version2 = (await api<ReleaseList>(RELEASES)).items[0];
    expect(version2?.number).toBe(2);
    expect(version2?.imageId).not.toBe(version1?.imageId);
    expect(await served("web")).toBe("v2");
    expect(inTask("web", "printenv", "WHICH")).toBe("two");
    // The tag has moved on, which is what a rollback has to be immune to.
    expect(docker("image", "inspect", "--format", "{{.Id}}", `opsifier/${project}/web:latest`)).toBe(
      version2?.imageId,
    );

    inTask("web", "sh", "-c", "echo after > /data/written-by-v2");
    const since = `${Math.floor(Date.now() / 1000)}`;

    const finished = await rollBack(1);

    expect(finished).toMatchObject({ status: "succeeded", error: null });
    expect(serviceImage("web")).toBe(version1?.imageId);
    expect(await served("web")).toBe("v1");
    expect(inTask("web", "printenv", "WHICH")).toBe("one");
    // What was written is still there, including what a later version wrote.
    expect(readFileSync(volumeFile("web", "written-by-v1"), "utf8").trim()).toBe("before");
    expect(readFileSync(volumeFile("web", "written-by-v2"), "utf8").trim()).toBe("after");
    expect(inTask("web", "cat", "/data/written-by-v2")).toBe("after");
    expect(imageEventsSince(since)).not.toMatch(/\bpull\b/);

    // A new attempt, and a new version, and what is saved has not moved.
    const listing = await api<ReleaseList>(RELEASES);
    expect(listing.items[0]).toMatchObject({
      number: 3,
      active: true,
      rollbackOf: 1,
      imageId: version1?.imageId,
    });
    const saved = await api<{ source: { dockerfile: string } }>(`${WEB}/source`);
    expect(saved.source.dockerfile).toContain("printf v2");
    expect((await api<{ env: string }>(`${WEB}/environment/reveal`, "POST", {})).env).toBe("WHICH=two");
    const detail = await api<{ pendingChanges: boolean }>(WEB);
    expect(detail.pendingChanges).toBe(true);
  });

  it("refuses what it can't honour, with nothing changed", { timeout: SETTLE_TIMEOUT_MS }, async () => {
    const before = serviceImage("web");
    const keptTag = (number: number) =>
      docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
        .split("\n")
        .find((line) => line.startsWith("opsifier/releases/") && line.endsWith(`:${number}`));

    const tag = keptTag(2);
    expect(tag).toBeDefined();
    docker("tag", BUSYBOX, tag as string);
    expect((await api<ReleaseList>(RELEASES)).items.find((item) => item.number === 2)?.refusal).toBe(
      "image_altered",
    );
    expect(await refusedCode(`${RELEASES}/2/rollback`, { confirm: "web" })).toBe("release_image_altered");

    docker("image", "rm", tag as string);
    const version2 = (await api<ReleaseList>(RELEASES)).items.find((item) => item.number === 2);
    expect(version2?.refusal).toBe("image_altered");

    expect(await refusedCode(`${RELEASES}/1/rollback`, { confirm: "nope" })).toBe("confirmation_mismatch");
    expect(serviceImage("web")).toBe(before);
  });

  it("uses the image it kept after a registry's tag has moved, by its id", {
    timeout: SETTLE_TIMEOUT_MS,
  }, async () => {
    docker("run", "-d", "--name", "e2e-registry", "-p", "127.0.0.1:5000:5000", "registry:2");
    const repository = "127.0.0.1:5000/rollback/app";
    const publish = (marker: string) => {
      const context = docker(
        "run",
        "--rm",
        "busybox:1.36",
        "sh",
        "-c",
        `printf 'FROM ${BUSYBOX}\\nLABEL marker=${marker}\\nCMD ["httpd", "-f", "-p", "80", "-h", "/etc"]' | base64 -w0`,
      );
      execFileSync(
        "sh",
        ["-c", `echo ${context} | base64 -d | docker -H ${DOCKER_HOST} build -q -t ${repository}:v1 -`],
        {
          encoding: "utf8",
        },
      );
      docker("push", `${repository}:v1`);
    };

    publish("one");
    const REG = `/projects/${project}/services/reg`;
    await api(`/projects/${project}/services`, "POST", { name: "reg" });
    await api(`${REG}/source`, "PUT", { image: `${repository}:v1` });
    await deploy(REG);
    const first = (await api<ReleaseList>(`${REG}/releases`)).items[0];
    expect(serviceImage("reg")).toBe(first?.digest);
    expect(first?.digest).toMatch(/@sha256:/);

    // The same tag, now somewhere else. The next deployment takes it, and the rollback must not.
    publish("two");
    await deploy(REG);
    const second = (await api<ReleaseList>(`${REG}/releases`)).items[0];
    expect(second?.number).toBe(2);
    expect(second?.imageId).not.toBe(first?.imageId);

    docker("rm", "-f", "e2e-registry");

    const finished = await rollBack(1, REG);

    expect(finished).toMatchObject({ status: "succeeded", error: null });
    expect(serviceImage("reg")).toBe(first?.imageId);
    expect(
      docker("image", "inspect", "--format", '{{index .Config.Labels "marker"}}', first?.imageId ?? ""),
    ).toBe("one");
  });

  it("leaves kept images out of what a cleanup offers", { timeout: SETTLE_TIMEOUT_MS }, async () => {
    const kept = (await api<ReleaseList>(RELEASES)).items.map((item) => `image:${item.imageId}`);

    const preview = await api<{ items: Array<{ id: string }> }>("/server/docker/cleanup/images");

    expect(kept.length).toBeGreaterThan(0);
    expect(preview.items.filter((item) => kept.includes(item.id))).toEqual([]);
  });
});
