import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { projectLeftovers } from "../../testing/e2e-inventory";

/**
 * Checks templates and stacks against a real panel in a Docker-in-Docker sandbox, through the real
 * proxy. A template is only marked `verified` in the catalogue once it passes here. Run it against a
 * running panel:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3211 OPSIFIER_E2E_PROXY_PORT=28451 \
 *   OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23761 OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/templates/templates.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3211"}/api/v1`;
const PROXY_PORT = Number(process.env.OPSIFIER_E2E_PROXY_PORT ?? 443);
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "unix:///var/run/docker.sock";

const POLL_MS = 1000;

interface ProxyResponse {
  status: number;
  body: string;
}

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

/** What a browser would get from this host through the proxy, certificate checks aside. */
function throughProxy(host: string, path: string, auth?: [string, string]): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        path,
        servername: host,
        rejectUnauthorized: false,
        headers: {
          host,
          ...(auth === undefined
            ? {}
            : { authorization: `Basic ${Buffer.from(`${auth[0]}:${auth[1]}`).toString("base64")}` }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("timed out")));
    req.end();
  });
}

async function waitForAction(id: string): Promise<{ status: string; error: string | null }> {
  for (;;) {
    const action = await api<{ status: string; error: string | null }>(`/actions/${id}`);
    if (action.status !== "queued" && action.status !== "running") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

interface Install {
  id: string;
  components: Array<{ role: string; url: string | null; service: { name: string; status: string } }>;
}

interface Doc {
  id: string;
  services: Array<{
    key: string;
    name: string;
    kind: string;
    startup?: { path: string; expect: number[] } | null;
  }>;
}

async function login(): Promise<void> {
  await api("/auth/login", "POST", {
    email: process.env.OPSIFIER_E2E_EMAIL,
    password: process.env.OPSIFIER_E2E_PASSWORD,
  });
}

async function createProject(): Promise<string> {
  const name = `e2e-${Date.now().toString(36)}`;
  await api("/projects", "POST", { name });
  return name;
}

/**
 * A project can only be deleted empty, so its services go first, then the volumes that deleting a
 * service keeps on purpose. Then it checks that nothing of this project is left on the daemon.
 */
async function destroyProject(project: string): Promise<void> {
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

  expect(projectLeftovers(docker, project)).toEqual([]);
}

async function deploy(project: string, install: string, scope: "pending" | "all"): Promise<void> {
  const action = await api<{ id: string }>(`/projects/${project}/templates/${install}/deploy`, "POST", {
    scope,
  });
  const finished = await waitForAction(action.id);
  expect(finished).toMatchObject({ status: "succeeded", error: null });
}

async function installTemplate(project: string, id: string): Promise<{ install: Install; doc: Doc }> {
  const { templates } = await api<{ templates: Doc[] }>("/templates");
  const doc = templates.find((template) => template.id === id) as Doc;
  const install = await api<Install>(`/projects/${project}/templates`, "POST", {
    source: { type: "catalogue", id },
    services: Object.fromEntries(doc.services.map((service) => [service.key, { name: service.name }])),
    params: {},
  });
  // Installing is only configuration: deploying is a separate, explicit step.
  expect(install.components.every((component) => component.service.status === "undeployed")).toBe(true);
  await deploy(project, install.id, "pending");
  return { install, doc };
}

function hostOf(url: string | null): string {
  return new URL(url as string).hostname;
}

/** The document's own start-up test, through the real proxy. */
async function expectStartup(install: Install, doc: Doc): Promise<void> {
  for (const component of install.components) {
    const startup = doc.services.find((service) => service.key === component.role)?.startup;
    if (startup != null && component.url !== null) {
      const { status } = await throughProxy(hostOf(component.url), startup.path);
      expect(startup.expect).toContain(status);
    }
  }
}

const reveal = (project: string, install: string, service: string, name: string) =>
  api<{ value: string }>(`/projects/${project}/templates/${install}/secrets/reveal`, "POST", {
    service,
    name,
  });

const docker = (...args: string[]) =>
  execFileSync("docker", ["-H", DOCKER_HOST, ...args], { encoding: "utf8" }).trim();

describe.skipIf(!enabled)("templates and stacks on real Docker", () => {
  it("installs and proves a static site, an app with an account, and an app with a database", {
    timeout: 900_000,
  }, async () => {
    await login();
    const project = await createProject();

    // A static site: address and start-up test.
    const site = await installTemplate(project, "it-tools");
    await expectStartup(site.install, site.doc);

    // An account from generated credentials, data that survives a redeploy.
    const gotify = await installTemplate(project, "gotify");
    await expectStartup(gotify.install, gotify.doc);
    const gotifyHost = hostOf(gotify.install.components[0]?.url ?? null);
    const gotifyPassword = (await reveal(project, gotify.install.id, "gotify", "adminPassword")).value;
    expect((await throughProxy(gotifyHost, "/current/user", ["admin", gotifyPassword])).status).toBe(200);
    expect((await throughProxy(gotifyHost, "/current/user", ["admin", "wrong"])).status).toBe(401);
    await deploy(project, gotify.install.id, "all");
    expect((await throughProxy(gotifyHost, "/current/user", ["admin", gotifyPassword])).status).toBe(200);

    // A database dependency, its generated credentials agreeing with the app's.
    const reader = await installTemplate(project, "miniflux");
    await expectStartup(reader.install, reader.doc);
    const app = reader.install.components.find((component) => component.role === "app");
    const readerHost = hostOf(app?.url ?? null);
    const readerPassword = (await reveal(project, reader.install.id, "miniflux", "adminPassword")).value;
    expect((await throughProxy(readerHost, "/v1/me", ["admin", readerPassword])).status).toBe(200);
    await deploy(project, reader.install.id, "all");
    expect((await throughProxy(readerHost, "/v1/me", ["admin", readerPassword])).status).toBe(200);

    await destroyProject(project);
  });

  it("runs a stack: reaches it through the proxy and keeps its volume through its lifecycle", {
    timeout: 600_000,
  }, async () => {
    await login();
    const project = await createProject();
    await api(`/projects/${project}/compose`, "POST", { name: "stack" });
    const stack = `/projects/${project}/services/stack`;
    await api(`${stack}/compose/source`, "PUT", {
      type: "inline",
      content: [
        "services:",
        "  web:",
        "    image: traefik/whoami:v1.11",
        "    restart: unless-stopped",
        "  cache:",
        "    image: redis:7-alpine",
        "    restart: unless-stopped",
        '    command: ["redis-server", "--appendonly", "yes"]',
        "    volumes:",
        "      - data:/data",
        "volumes:",
        "  data: {}",
        "",
      ].join("\n"),
    });
    const deployAction = await api<{ id: string }>(`${stack}/deploy`, "POST", {});
    expect((await waitForAction(deployAction.id)).status).toBe("succeeded");

    const { domains } = await api<{ domains: Array<{ id: string; host: string }> }>(`${stack}/domains`);
    const [domain] = domains;
    await api(`${stack}/domains/${domain?.id}`, "PUT", {
      host: domain?.host,
      port: 80,
      composeService: "web",
    });
    // The proxy restarts when it joins the project's network, and takes a moment to read the new route.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const reply = await throughProxy(domain?.host as string, "/").catch(() => null);
      if (reply?.status === 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const reached = await throughProxy(domain?.host as string, "/");
    expect(reached.status).toBe(200);
    expect(reached.body).toContain("Hostname");

    const container = `${project}_stack-cache-1`;
    docker("exec", container, "redis-cli", "set", "marker", "alive");

    for (const verb of ["stop", "start", "deploy"]) {
      const action = await api<{ id: string }>(
        `${stack}/${verb}`,
        "POST",
        verb === "deploy" ? {} : undefined,
      );
      expect((await waitForAction(action.id)).status).toBe("succeeded");
    }
    expect(docker("exec", container, "redis-cli", "get", "marker")).toBe("alive");

    const destroyed = await api<{ id: string }>(stack, "DELETE", { confirm: "stack" });
    await waitForAction(destroyed.id);
    await destroyProject(project);
  });
});
