import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectLeftovers } from "../../testing/e2e-inventory";

/**
 * That one project really can't reach another, tried from inside its containers on a real daemon in a
 * Docker-in-Docker sandbox, through the panel's API. Run it against a panel using the sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3414 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23814 \
 *   OPSIFIER_E2E_PROXY_PORT=28514 OPSIFIER_E2E_DATA_DIR=... OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/projects/isolation.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3211"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "unix:///var/run/docker.sock";
const PROXY_PORT = Number(process.env.OPSIFIER_E2E_PROXY_PORT ?? 443);
const DATA_DIR = process.env.OPSIFIER_E2E_DATA_DIR ?? "";

const SUFFIX = Date.now().toString(36);
const ONE = `e2e-one-${SUFFIX}`;
const TWO = `e2e-two-${SUFFIX}`;
const SLOW = 600_000;
const POLL_MS = 500;
const CLIENT_IMAGE = "redis:7-alpine";
const PUBLIC_PORT = 16379;

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
    throw new ApiFailure(response.status, text);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`${status} ${body}`);
  }
}

interface Finished {
  status: string;
  error: string | null;
  log?: string;
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

const servicePath = (project: string, name: string) => `/projects/${project}/services/${name}`;

async function deploy(project: string, name: string): Promise<Finished> {
  const action = await api<{ id: string }>(`${servicePath(project, name)}/deploy`, "POST", {});
  return waitForAction(action.id);
}

async function createApp(project: string, name: string, image: string, command?: string): Promise<void> {
  await api(`/projects/${project}/services`, "POST", { name });
  await api(`${servicePath(project, name)}/source`, "PUT", { image });
  if (command !== undefined) {
    await api(`${servicePath(project, name)}/advanced/deploy`, "PUT", { command });
  }
  expect(await deploy(project, name)).toMatchObject({ status: "succeeded", error: null });
}

async function createDatabase(project: string, name: string): Promise<void> {
  const created = await api<{ activeAction: { id: string } | null }>(
    `/projects/${project}/databases`,
    "POST",
    {
      name,
      engine: "redis",
    },
  );
  const finished = await waitForAction(created.activeAction?.id ?? "");
  expect(finished).toMatchObject({ status: "succeeded", error: null });
}

const passwordOf = async (project: string, name: string) =>
  (
    await api<{ value: string }>(`${servicePath(project, name)}/credentials/reveal`, "POST", {
      secret: "password",
    })
  ).value;

/** The running container of a one-task service, by the name Swarm gives it. */
function taskOf(service: string): string {
  return docker(
    "ps",
    "--filter",
    `label=com.docker.swarm.service.name=${service}`,
    "--filter",
    "status=running",
    "--format",
    "{{.ID}}",
  );
}

const addressesOf = (container: string): string[] =>
  docker(
    "inspect",
    "--format",
    "{{range $name, $net := .NetworkSettings.Networks}}{{$net.IPAddress}} {{end}}",
    container,
  )
    .split(" ")
    .filter((address) => address !== "");

/** What `redis-cli ping` says from inside a container, whatever way it fails. */
function ping(container: string, host: string, password: string, port = 6379): string {
  const script = `timeout 8 redis-cli -h ${host} -p ${port} --no-auth-warning -a "$REDIS_PW" ping 2>&1 || echo "failed: $?"`;
  return docker("exec", "--env", `REDIS_PW=${password}`, container, "sh", "-c", script);
}

/** Whether the proxy's own task can open a connection. */
function proxyConnects(host: string, port: number): boolean {
  const script = `nc -z -w 3 ${host} ${port} && echo open || echo closed`;
  return docker("exec", taskOf("opsifier-traefik"), "sh", "-c", script).includes("open");
}

const networksOf = (service: string): string[] =>
  (
    JSON.parse(
      docker("service", "inspect", "--format", "{{json .Spec.TaskTemplate.Networks}}", service),
    ) as Array<{
      Target: string;
    }>
  )
    .map(({ Target }) => docker("network", "inspect", "--format", "{{.Name}}", Target))
    .sort();

/** Waits until the proxy has taken a change to its networks, then answers for this host. */
async function statusThroughProxy(host: string): Promise<number> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      return await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: PROXY_PORT,
            path: "/",
            servername: host,
            headers: { host },
            rejectUnauthorized: false,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.setTimeout(8000, () => req.destroy(new Error("timed out")));
        req.end();
      });
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

describe.skipIf(!enabled)("one project can't reach another, on real Docker", () => {
  let webHost = "";
  let dbPassword = "";

  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    const purpose = await api<{ protection: boolean; confirmation: string }>("/server-purpose");
    if (purpose.protection) {
      await api("/server-purpose", "PUT", { purpose: "production", confirm: purpose.confirmation });
    }
    await api("/projects", "POST", { name: ONE });
    await api("/projects", "POST", { name: TWO });

    await createDatabase(ONE, "db");
    await createDatabase(TWO, "db");
    await createApp(ONE, "web", "traefik/whoami:v1.10");
    await createApp(ONE, "client", CLIENT_IMAGE, "sleep 100000");
    await createApp(TWO, "probe", CLIENT_IMAGE, "sleep 100000");
    dbPassword = await passwordOf(ONE, "db");

    const domains = await api<{ domains: Array<{ host: string; primary: boolean }> }>(
      `${servicePath(ONE, "web")}/domains`,
    );
    webHost = domains.domains.find((domain) => domain.primary)?.host ?? "";
  }, SLOW);

  afterAll(async () => {
    for (const project of [ONE, TWO]) {
      const { services } = await api<{ services: Array<{ name: string }> }>(`/projects/${project}`);
      for (const { name } of services) {
        await waitForAction(
          (await api<{ id: string }>(servicePath(project, name), "DELETE", { confirm: name })).id,
        );
      }
      await waitForAction(
        (await api<{ id: string }>(`/projects/${project}`, "DELETE", { confirm: project })).id,
      );
      const { volumes } = await api<{ volumes: Array<{ name: string; projectName: string }> }>(
        "/retained-volumes",
      );
      for (const { name } of volumes.filter((volume) => volume.projectName === project)) {
        await waitForAction(
          (await api<{ id: string }>(`/retained-volumes/${name}`, "DELETE", { confirm: name })).id,
        );
      }
      // A `sleep` ignores the stop signal, so Docker only reaps those tasks once their grace is over.
      const deadline = Date.now() + 30_000;
      while (projectLeftovers(docker, project).length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      expect(projectLeftovers(docker, project)).toEqual([]);
    }
  }, SLOW);

  it("keeps a database out of reach of another project, by name and by address", () => {
    const probe = taskOf(`${TWO}_probe`);
    const otherDatabase = taskOf(`${TWO}_db`);
    const [address] = addressesOf(taskOf(`${ONE}_db`));

    for (const from of [probe, otherDatabase]) {
      expect(ping(from, `${ONE}_db`, dbPassword)).toMatch(/Name does not resolve|NXDOMAIN|failed/);
      expect(ping(from, `${ONE}-db`, dbPassword)).toMatch(/Name does not resolve|NXDOMAIN|failed/);
      expect(ping(from, address ?? "", dbPassword)).toMatch(/failed|timed out|Connection/);
    }
  });

  it("lets a service reach its own project's database by every name it answers to", () => {
    const client = taskOf(`${ONE}_client`);

    expect(ping(client, `${ONE}_db`, dbPassword)).toBe("PONG");
    expect(ping(client, `${ONE}-db`, dbPassword)).toBe("PONG");
    expect(ping(client, "db", dbPassword)).toBe("PONG");
  });

  it("puts the database on its project's network, and the proxy on none of it", () => {
    expect(networksOf(`${ONE}_db`)).toEqual([`opsifier-${ONE}`]);
    expect(networksOf(`${ONE}_web`)).toEqual([`opsifier-${ONE}`, `opsifier-${ONE}_proxy`]);
    expect(networksOf("opsifier-traefik")).not.toContain(`opsifier-${ONE}`);
    expect(networksOf("opsifier-traefik")).toContain(`opsifier-${ONE}_proxy`);
  });

  it("still routes to what it should, and the proxy reaches no database", { timeout: SLOW }, async () => {
    expect(await statusThroughProxy(webHost)).toBe(200);
    expect(proxyConnects(`${ONE}_web`, 80)).toBe(true);
    expect(proxyConnects(`${ONE}_db`, 6379)).toBe(false);
    expect(proxyConnects(addressesOf(taskOf(`${ONE}_db`))[0] ?? "", 6379)).toBe(false);
  });

  it("refuses a Compose file joining another project's network, saying why", { timeout: SLOW }, async () => {
    await api(`/projects/${TWO}/compose`, "POST", { name: "stack" });
    const stack = servicePath(TWO, "stack");
    await api(`${stack}/compose/source`, "PUT", {
      type: "inline",
      content: `services:\n  app:\n    image: ${CLIENT_IMAGE}\n    restart: always\n    command: sleep 100000\n    networks: [theirs]\nnetworks:\n  theirs:\n    external: true\n    name: opsifier-${ONE}\n`,
    });

    await expect(api(`${stack}/deploy`, "POST", {})).rejects.toMatchObject({
      status: 409,
      body: expect.stringContaining("publish its port"),
    });
  });

  it.skipIf(DATA_DIR === "")(
    "refuses one that hides such a network in an included file",
    { timeout: SLOW },
    async () => {
      const stack = servicePath(TWO, "stack");
      await api(`${stack}/compose/source`, "PUT", {
        type: "inline",
        content: `include:\n  - included.yml\nservices:\n  app:\n    image: ${CLIENT_IMAGE}\n    restart: always\n    command: sleep 100000\n`,
      });
      // What a stack keeps in its folder survives a deploy, so Compose finds this one when it looks.
      writeFileSync(
        join(DATA_DIR, `projects/${TWO}/stack/code/included.yml`),
        `services:\n  other:\n    image: ${CLIENT_IMAGE}\n    command: sleep 100000\n    networks: [theirs]\nnetworks:\n  theirs:\n    external: true\n    name: opsifier-${ONE}\n`,
      );

      const finished = await deploy(TWO, "stack");

      expect(finished.status).toBe("failed");
      expect(finished.error).toMatch(/uses opsifier-/);
    },
  );

  it("lets a stack join its project's own network, and routes to its children", {
    timeout: SLOW,
  }, async () => {
    const stack = servicePath(TWO, "stack");
    await api(`${stack}/compose/source`, "PUT", {
      type: "inline",
      content: `services:\n  app:\n    image: traefik/whoami:v1.10\n    restart: always\nnetworks:\n  own:\n    external: true\n    name: opsifier-${TWO}\n`,
    });
    expect(await deploy(TWO, "stack")).toMatchObject({ status: "succeeded", error: null });
    const { domains } = await api<{ domains: Array<{ host: string; primary: boolean }> }>(`${stack}/domains`);
    const host = domains.find((domain) => domain.primary)?.host ?? "";

    expect(await statusThroughProxy(host)).toBe(200);
    expect(proxyConnects(`${TWO}_stack__app`, 80)).toBe(true);
  });

  it("offers another project the database's published port instead", { timeout: SLOW }, async () => {
    await api(`${servicePath(ONE, "db")}/expose`, "PUT", { port: PUBLIC_PORT });
    expect(await deploy(ONE, "db")).toMatchObject({ status: "succeeded", error: null });
    const node = docker("info", "--format", "{{.Swarm.NodeAddr}}");

    expect(ping(taskOf(`${TWO}_probe`), node, dbPassword, PUBLIC_PORT)).toBe("PONG");
  });

  it("moves a database off the old shared network at its next deploy", { timeout: SLOW }, async () => {
    const before = docker(
      "service",
      "inspect",
      "--format",
      "{{json .Spec.TaskTemplate.Networks}}",
      `${TWO}_db`,
    );
    docker("service", "update", "--detach", "--network-add", `name=opsifier,alias=${TWO}-db`, `${TWO}_db`);
    expect(networksOf(`${TWO}_db`)).toContain("opsifier");

    const moved = await deploy(TWO, "db");

    expect(moved).toMatchObject({ status: "succeeded", error: null });
    expect(moved.log).toMatch(/only its own project can reach it/);
    expect(networksOf(`${TWO}_db`)).toEqual([`opsifier-${TWO}`]);
    expect(
      docker("service", "inspect", "--format", "{{json .Spec.TaskTemplate.Networks}}", `${TWO}_db`),
    ).toBe(before);
    const password = await passwordOf(TWO, "db");
    expect(ping(taskOf(`${TWO}_db`), `${TWO}_db`, password)).toBe("PONG");
  });
});
