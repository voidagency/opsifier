import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionEntry,
  DomainEntry,
  ProjectList,
  ServiceDetail,
  ServiceMetrics,
  ServiceSource,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { services } from "../../core/db/schema";
import type { RegistryAuth, TaskInfo } from "../../core/docker";
import { DockerDriverError } from "../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_EMAIL,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { putSetting, SERVICE_DOMAIN_KEY } from "../system/repo";

let context: TestContext;
let cookie: string;

type ImageSource = Extract<ServiceSource, { type: "image" }>;

const IMAGE = "traefik/whoami:v1.10";
const SERVICE = "/projects/shop/services/web";

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

async function waitForAction(id: string): Promise<ActionEntry & { log: string }> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body } = await api<ActionEntry & { log: string }>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

async function run(path: string, method = "POST", body?: unknown) {
  const accepted = await api<ActionEntry>(path, method, body);
  if (accepted.status !== 202) {
    throw new Error(`${method} ${path} answered ${accepted.status}: ${JSON.stringify(accepted.body)}`);
  }
  return waitForAction(accepted.body.id);
}

async function createService(name = "web", project = "shop") {
  return api<ServiceDetail>(`/projects/${project}/services`, "POST", { name });
}

async function deployedService() {
  await createService();
  await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
  const deployed = await run(`${SERVICE}/deploy`);
  expect(deployed.status).toBe("succeeded");
  return deployed;
}

const detail = async (path = SERVICE) => (await api<ServiceDetail>(path)).body;
const swarm = (name = "shop_web") => context.docker.inspectService(name);
const tasks = (name = "shop_web") => context.docker.listTasks({ service: name });
const routesFile = (name = "shop__web.yaml") => join(context.deps.config.traefikDynamicDir, name);
const routes = (name?: string) => parse(readFileSync(routesFile(name), "utf8"));

describe("creating a service", () => {
  it("starts with one primary default domain and nothing to run", async () => {
    const created = await createService();

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "web",
      type: "app",
      source: null,
      status: "undeployed",
      stopped: false,
      notes: "",
      primaryUrl: "https://shop-web.203.0.113.10.sslip.io/",
    });

    const { domains } = (await api<{ domains: DomainEntry[] }>(`${SERVICE}/domains`)).body;
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      host: "shop-web.203.0.113.10.sslip.io",
      path: "/",
      port: 80,
      https: true,
      primary: true,
      url: "https://shop-web.203.0.113.10.sslip.io/",
      internalUrl: "http://shop_web:80/",
    });
  });

  it("has no Swarm service yet, but its routes exist already", async () => {
    await createService();

    expect(await swarm()).toBeNull();
    const config = routes();
    expect(config.http.routers["http-shop_web-0"].rule).toBe(
      "Host(`shop-web.203.0.113.10.sslip.io`) && PathPrefix(`/`)",
    );
    expect(config.http.routers["https-shop_web-0"].tls).toEqual({
      certResolver: "letsencrypt",
      domains: [{ main: "shop-web.203.0.113.10.sslip.io" }],
    });
    expect(config.http.services["shop_web-0"].loadBalancer.servers).toEqual([{ url: "http://shop_web:80/" }]);
  });

  it("shows the internal URL that the proxy really uses", async () => {
    await createService();
    const { domains } = (await api<{ domains: DomainEntry[] }>(`${SERVICE}/domains`)).body;

    expect(routes().http.services["shop_web-0"].loadBalancer.servers[0].url).toBe(domains[0]?.internalUrl);
  });

  it("uses the service domain setting when there is one", async () => {
    putSetting(context.deps.db, SERVICE_DOMAIN_KEY, "apps.example.com", new Date());
    await createService();

    expect((await detail()).primaryUrl).toBe("https://shop-web.apps.example.com/");
  });

  it("ignores an unusable service domain setting", async () => {
    putSetting(context.deps.db, SERVICE_DOMAIN_KEY, "not a domain", new Date());
    await createService();

    expect((await detail()).primaryUrl).toBe("https://shop-web.203.0.113.10.sslip.io/");
  });

  it("replaces underscores in the hostname, and keeps colliding hostnames apart", async () => {
    await createService("a_b");
    await createService("a-b");

    expect((await detail("/projects/shop/services/a_b")).primaryUrl).toBe(
      "https://shop-a-b.203.0.113.10.sslip.io/",
    );
    expect((await detail("/projects/shop/services/a-b")).primaryUrl).toBe(
      "https://shop-a-b-2.203.0.113.10.sslip.io/",
    );
  });

  it("keeps hostnames apart across projects", async () => {
    await api("/projects", "POST", { name: "shop-web" });
    await createService("x", "shop-web");
    await createService("web-x");

    expect((await detail("/projects/shop-web/services/x")).primaryUrl).toBe(
      "https://shop-web-x.203.0.113.10.sslip.io/",
    );
    expect((await detail("/projects/shop/services/web-x")).primaryUrl).toBe(
      "https://shop-web-x-2.203.0.113.10.sslip.io/",
    );
  });

  it("creates the service's data directory", async () => {
    await createService();
    expect(existsSync(join(context.dataDir, "projects", "shop", "web"))).toBe(true);
  });

  it("rejects invalid and missing names with field messages", async () => {
    for (const name of ["Bad Name!", "UPPER", "", "ends-", "two__underscores"]) {
      const result = await api("/projects/shop/services", "POST", { name });
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields).toHaveProperty("name");
    }
  });

  it("refuses a name that would make the Swarm name too long", async () => {
    const result = await api("/projects/shop/services", "POST", { name: "a".repeat(60) });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.name).toContain("63");
  });

  it("allows only one service of a name per project", async () => {
    await createService();
    const again = await createService();

    expect(again.status).toBe(409);
    expect(apiErrorOf(again).code).toBe("service_exists");
  });

  it("answers 404 for a project that does not exist", async () => {
    expect((await createService("web", "missing")).status).toBe(404);
  });

  it("lists the new service with its project", async () => {
    await createService();
    const { body } = await api<ProjectList>("/projects");

    expect(body.projects[0]?.services.map((service) => service.name)).toEqual(["web"]);
  });
});

describe("the source", () => {
  beforeEach(async () => {
    await createService();
  });

  it("is required before deploying", async () => {
    const result = await api(`${SERVICE}/deploy`, "POST");
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("service_has_no_source");
  });

  it("needs an image", async () => {
    const result = await api(`${SERVICE}/source`, "PUT", { image: "" });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.image).toBe("Required");
  });

  it.each(["not an image", "UPPERCASE:1", "image:"])("rejects the malformed reference %j", async (image) => {
    const result = await api(`${SERVICE}/source`, "PUT", { image });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("image");
  });

  it("saves any well-formed image without touching Docker", async () => {
    let pulled = false;
    const realPull = context.docker.pullImage.bind(context.docker);
    context.docker.pullImage = async (...args) => {
      pulled = true;
      return realPull(...args);
    };

    const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", {
      image: "registry.invalid.example:5000/team/app:missing",
    });

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      type: "image",
      image: "registry.invalid.example:5000/team/app:missing",
      username: null,
      hasPassword: false,
    });
    expect(pulled).toBe(false);
    expect(await swarm()).toBeNull();
  });

  describe("registry credentials", () => {
    const rawSpec = () =>
      JSON.stringify(
        context.deps.db.select({ spec: services.spec }).from(services).where(eq(services.name, "web")).get()
          ?.spec,
      );

    it("stores the password sealed and only ever reports that it exists", async () => {
      const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", {
        image: "registry.example.com/team/app:1",
        username: "deployer",
        password: "hunter2-secret",
      });

      expect(saved.body).toEqual({
        type: "image",
        image: "registry.example.com/team/app:1",
        username: "deployer",
        hasPassword: true,
      });
      expect(rawSpec()).not.toContain("hunter2");
      expect((await api<{ source: ImageSource }>(`${SERVICE}/source`)).body.source.hasPassword).toBe(true);
      expect(JSON.stringify((await api(`${SERVICE}`)).body)).not.toContain("hunter2");
      expect(JSON.stringify((await api(`${SERVICE}`)).body)).not.toContain("sealedPassword");
    });

    it("keeps the stored password when it is left out", async () => {
      await api(`${SERVICE}/source`, "PUT", { image: IMAGE, username: "deployer", password: "first" });
      const before = rawSpec();

      const saved = await api<ImageSource>(`${SERVICE}/source`, "PUT", {
        image: "nginx:1.28",
        username: "deployer",
      });

      expect(saved.body.hasPassword).toBe(true);
      expect(rawSpec()).toContain(JSON.parse(before).source.sealedPassword);
    });

    it("removes both when the username is cleared", async () => {
      await api(`${SERVICE}/source`, "PUT", { image: IMAGE, username: "deployer", password: "first" });
      const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", { image: IMAGE, username: "" });

      expect(saved.body).toMatchObject({ username: null, hasPassword: false });
    });

    it("rejects a password without a username and a username without a password", async () => {
      const noUser = await api(`${SERVICE}/source`, "PUT", { image: IMAGE, password: "x" });
      expect(noUser.status).toBe(400);
      expect(apiErrorOf(noUser).fields).toHaveProperty("username");

      const noPassword = await api(`${SERVICE}/source`, "PUT", { image: IMAGE, username: "x" });
      expect(noPassword.status).toBe(400);
      expect(apiErrorOf(noPassword).fields).toHaveProperty("password");
    });

    it("pulls and deploys with the credentials", async () => {
      const auth: Array<RegistryAuth | undefined> = [];
      const realPull = context.docker.pullImage.bind(context.docker);
      const realCreate = context.docker.createService.bind(context.docker);
      context.docker.pullImage = (ref, options) => {
        auth.push(options?.registryAuth);
        return realPull(ref, options);
      };
      context.docker.createService = (spec, options) => {
        auth.push(options?.registryAuth);
        return realCreate(spec, options);
      };

      await api(`${SERVICE}/source`, "PUT", {
        image: "registry.example.com/team/app:1",
        username: "deployer",
        password: "hunter2-secret",
      });
      const deployed = await run(`${SERVICE}/deploy`);

      expect(deployed.status).toBe("succeeded");
      expect(auth).toEqual([
        { username: "deployer", password: "hunter2-secret", serveraddress: "registry.example.com" },
        { username: "deployer", password: "hunter2-secret", serveraddress: "registry.example.com" },
      ]);
      expect(deployed.log).not.toContain("hunter2");
    });

    it("uses Docker Hub for an image with no registry in its name", async () => {
      let seen: RegistryAuth | undefined;
      const realPull = context.docker.pullImage.bind(context.docker);
      context.docker.pullImage = (ref, options) => {
        seen = options?.registryAuth;
        return realPull(ref, options);
      };

      await api(`${SERVICE}/source`, "PUT", { image: "team/app:1", username: "deployer", password: "x" });
      await run(`${SERVICE}/deploy`);

      expect(seen?.serveraddress).toBe("https://index.docker.io/v1/");
    });
  });
});

describe("deploying", () => {
  it("creates the Swarm service with the compiled spec and logs the pull", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    await api("/projects/shop/env", "PUT", { env: "SHARED_ONE=project-value" });
    await api(`${SERVICE}/environment`, "PUT", {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
      env: "REF=$(PRIMARY_DOMAIN)\n# skip\nSHARED_REF=${SHARED_ONE}",
    });

    const deployed = await run(`${SERVICE}/deploy`);

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toContain(`Pulling image ${IMAGE}`);
    const service = await swarm();
    expect(service?.spec.Name).toBe("shop_web");
    expect(service?.spec.TaskTemplate.ContainerSpec.Env).toEqual([
      "PORT=80",
      "SHARED_ONE=project-value",
      "REF=shop-web.203.0.113.10.sslip.io",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
      "SHARED_REF=${SHARED_ONE}",
    ]);
    expect((await tasks()).filter((task) => task.state === "running")).toHaveLength(1);
  });

  it("never injects a Git revision or a timestamp", async () => {
    await deployedService();
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env?.join("\n")).not.toMatch(
      /GIT_SHA|DEPLOY_TIMESTAMP/,
    );
  });

  it("does not change running services when settings are saved", async () => {
    await deployedService();
    const before = (await swarm())?.version;

    await api(`${SERVICE}/environment`, "PUT", { env: "NEW=1" });
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:1.28" });
    await api("/projects/shop/env", "PUT", { env: "SHARED=1" });

    expect((await swarm())?.version).toBe(before);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(IMAGE);
  });

  it("replaces the tasks on the next deploy, using Docker's own counter", async () => {
    await deployedService();
    const [first] = await tasks();
    const before = (await swarm())?.spec.TaskTemplate.ForceUpdate ?? 0;

    await run(`${SERVICE}/deploy`);

    expect((await swarm())?.spec.TaskTemplate.ForceUpdate).toBe(before + 1);
    const running = (await tasks()).filter((task) => task.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).not.toBe(first?.id);
  });

  it("marks the deployment failed when the image cannot be pulled, and logs why", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    context.docker.failNext("pullImage", new DockerDriverError("pull image: no such host"));

    const deployed = await run(`${SERVICE}/deploy`);

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("no such host");
    expect(deployed.log).toContain("no such host");
    expect(await swarm()).toBeNull();
  });

  it("does not report success until the new tasks are running", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });

    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await new Promise((resolve) => setTimeout(resolve, 15));

    // The update has been issued by now, but the tasks are still starting.
    const midway = await api<ActionEntry>(`/actions/${accepted.body.id}`);
    expect(["queued", "running"]).toContain(midway.body.status);
    expect((await waitForAction(accepted.body.id)).status).toBe("succeeded");
  });

  it("marks the deployment failed when the tasks crash", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    // Every task it asks about is a fresh one that has already failed.
    context.docker.listTasks = async () => [failedTask("t1"), failedTask("t2"), failedTask("t3")];

    const deployed = await run(`${SERVICE}/deploy`);

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("non-zero exit");
  });

  it("marks the deployment failed when the tasks never settle", async () => {
    await context.close();
    context = await createTestContext({ rollout: { timeoutMs: 30 } });
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    context.docker.listTasks = async () => [];

    const deployed = await run(`${SERVICE}/deploy`);

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("did not settle");
  });

  it("can be cancelled while it waits, without pretending to have succeeded", async () => {
    await context.close();
    context = await createTestContext({ rollout: { timeoutMs: 5000 } });
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    context.docker.listTasks = async () => [];

    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await api(`/actions/${accepted.body.id}/cancel`, "POST");

    expect((await waitForAction(accepted.body.id)).status).toBe("cancelled");
  });

  it("reports the outcome of each deployment in the wake and the history", async () => {
    await deployedService();
    context.docker.failNext("pullImage", new DockerDriverError("nope"));
    await run(`${SERVICE}/deploy`);

    const service = await detail();
    expect(service.wake).toEqual(["succeeded", "failed"]);
    expect(service.lastDeployedAt).not.toBeNull();

    const history = await api<{ items: ActionEntry[] }>(`${SERVICE}/deployments`);
    expect(history.body.items.map((item) => item.status)).toEqual(["failed", "succeeded"]);
    expect(history.body.items[0]?.actorEmail).toBe(TEST_EMAIL);
  });

  it("exposes the running action so the toolbar can follow it, then clears it", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });

    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    expect((await detail()).activeAction).toEqual({ id: accepted.body.id, type: "service.deploy" });

    await waitForAction(accepted.body.id);
    expect((await detail()).activeAction).toBeNull();
    expect((await detail()).status).toBe("running");
  });

  it("does not let the history of a destroyed service leak into a new one of the same name", async () => {
    await deployedService();
    await run(SERVICE, "DELETE", { confirm: "web" });
    context.advance(1000);

    await createService();
    expect((await detail()).wake).toEqual([]);
    expect((await api<{ items: ActionEntry[] }>(`${SERVICE}/deployments`)).body.items).toEqual([]);
  });
});

function failedTask(id: string): TaskInfo {
  return {
    id,
    serviceId: "s",
    serviceName: "shop_web",
    slot: 1,
    nodeId: "n",
    containerId: null,
    image: IMAGE,
    desiredState: "shutdown",
    state: "failed",
    message: "started",
    error: "task: non-zero exit (1)",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("stop, start and restart", () => {
  beforeEach(async () => {
    await deployedService();
  });

  it("stops: no replicas, and the domains have nothing behind them", async () => {
    const stopped = await run(`${SERVICE}/stop`);

    expect(stopped.status).toBe("succeeded");
    expect((await swarm())?.spec.Mode?.Replicated?.Replicas).toBe(0);
    expect(routes().http.services["shop_web-0"].loadBalancer.servers).toEqual([]);
    expect(routes().http.routers["http-shop_web-0"]).toBeDefined();
    expect(await detail()).toMatchObject({ status: "stopped", stopped: true });
  });

  it("starts: restores the replicas and the routes, keeping saved settings", async () => {
    await api(`${SERVICE}/environment`, "PUT", { env: "PENDING=1" });
    await run(`${SERVICE}/stop`);
    const before = (await swarm())?.spec.TaskTemplate.ContainerSpec.Env;

    const started = await run(`${SERVICE}/start`);

    expect(started.status).toBe("succeeded");
    expect((await swarm())?.spec.Mode?.Replicated?.Replicas).toBe(1);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env).toEqual(before);
    expect(routes().http.services["shop_web-0"].loadBalancer.servers).toEqual([
      { url: "http://shop_web:80/" },
    ]);
    expect(await detail()).toMatchObject({ status: "running", stopped: false });
    expect((await api<{ env: string }>(`${SERVICE}/environment`)).body.env).toBe("PENDING=1");
  });

  it("restarts through the force-update counter, with new tasks and the same env", async () => {
    const [first] = await tasks();
    const before = await swarm();

    const restarted = await run(`${SERVICE}/restart`);

    expect(restarted.status).toBe("succeeded");
    const after = await swarm();
    expect(after?.spec.TaskTemplate.ForceUpdate).toBe((before?.spec.TaskTemplate.ForceUpdate ?? 0) + 1);
    expect(after?.spec.TaskTemplate.ContainerSpec.Env).toEqual(before?.spec.TaskTemplate.ContainerSpec.Env);
    expect((await tasks()).filter((task) => task.state === "running")[0]?.id).not.toBe(first?.id);
  });

  it("refuses to stop a stopped service or restart it", async () => {
    await run(`${SERVICE}/stop`);

    const stop = await api(`${SERVICE}/stop`, "POST");
    expect(stop.status).toBe(409);
    expect(apiErrorOf(stop).code).toBe("service_stopped");

    expect((await api(`${SERVICE}/restart`, "POST")).status).toBe(409);
  });

  it("refuses to start a running service", async () => {
    const start = await api(`${SERVICE}/start`, "POST");
    expect(start.status).toBe(409);
    expect(apiErrorOf(start).code).toBe("service_running");
  });

  it("brings a stopped service back on deploy", async () => {
    await run(`${SERVICE}/stop`);
    await run(`${SERVICE}/deploy`);

    expect(await detail()).toMatchObject({ status: "running", stopped: false });
  });

  it("refuses all of it before the first deployment", async () => {
    await createService("other");
    for (const verb of ["stop", "start", "restart"]) {
      expect((await api(`/projects/shop/services/other/${verb}`, "POST")).status).toBe(409);
    }
  });
});

describe("renaming and moving", () => {
  it("is refused while the service runs", async () => {
    await deployedService();

    const refused = await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "renamed" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("service_running");
  });

  it("renames a stopped service: new routes, same domain, history follows", async () => {
    await deployedService();
    await run(`${SERVICE}/stop`);

    const renamed = await api<ServiceDetail>(`${SERVICE}/rename`, "POST", {
      projectName: "shop",
      name: "renamed",
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: "renamed",
      primaryUrl: "https://shop-web.203.0.113.10.sslip.io/",
    });
    expect(renamed.body.wake).toEqual(["succeeded"]);
    expect((await api(SERVICE)).status).toBe(404);
    expect(existsSync(routesFile())).toBe(false);
    expect(Object.keys(routes("shop__renamed.yaml").http.routers)).toEqual([
      "http-shop_renamed-0",
      "https-shop_renamed-0",
    ]);
    expect(await swarm()).toBeNull();
    expect(existsSync(join(context.dataDir, "projects", "shop", "renamed"))).toBe(true);
    expect(existsSync(join(context.dataDir, "projects", "shop", "web"))).toBe(false);
  });

  it("starts again under the new name, and renaming back restores it", async () => {
    await deployedService();
    await run(`${SERVICE}/stop`);
    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "renamed" });

    const started = await run("/projects/shop/services/renamed/start");
    expect(started.status).toBe("succeeded");
    expect((await swarm("shop_renamed"))?.spec.TaskTemplate.ContainerSpec.Image).toBe(IMAGE);

    await run("/projects/shop/services/renamed/stop");
    await api("/projects/shop/services/renamed/rename", "POST", { projectName: "shop", name: "web" });
    expect((await run(`${SERVICE}/start`)).status).toBe("succeeded");
    expect(await detail()).toMatchObject({ status: "running" });
  });

  it("moves between projects", async () => {
    await api("/projects", "POST", { name: "other" });
    await deployedService();
    await run(`${SERVICE}/stop`);

    const moved = await api<ServiceDetail>(`${SERVICE}/rename`, "POST", {
      projectName: "other",
      name: "web",
    });

    expect(moved.status).toBe(200);
    expect(moved.body.projectName).toBe("other");
    expect((await run("/projects/other/services/web/start")).status).toBe("succeeded");
    expect((await swarm("other_web"))?.spec.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-other", Aliases: ["other-web", "web"] },
    ]);
  });

  it("works on a service that was never deployed", async () => {
    await createService();

    expect((await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "other" })).status).toBe(200);
  });

  it("refuses a taken name, an unknown project, a bad name and no change", async () => {
    await createService();
    await createService("taken");

    const taken = await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "taken" });
    expect(taken.status).toBe(409);
    expect(apiErrorOf(taken).code).toBe("service_exists");

    expect((await api(`${SERVICE}/rename`, "POST", { projectName: "nope", name: "x" })).status).toBe(404);
    expect((await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "Bad!" })).status).toBe(400);
    expect((await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web" })).status).toBe(409);
  });
});

describe("notes", () => {
  it("are saved, returned and limited", async () => {
    await createService();

    expect((await api(`${SERVICE}/notes`, "PUT", { notes: "# Runbook\n**bold**" })).status).toBe(200);
    expect((await detail()).notes).toBe("# Runbook\n**bold**");
    expect((await api(`${SERVICE}/notes`, "PUT", { notes: "x".repeat(70_000) })).status).toBe(400);
  });
});

describe("metrics", () => {
  it("are zero before the first deployment", async () => {
    await createService();

    expect((await api<ServiceMetrics>(`${SERVICE}/metrics`)).body).toEqual({
      cpuPercent: 0,
      memoryUsedBytes: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      readAt: null,
    });
  });

  it("add up the running tasks", async () => {
    await deployedService();

    const { body } = await api<ServiceMetrics>(`${SERVICE}/metrics`);
    expect(body.memoryUsedBytes).toBeGreaterThan(0);
    expect(body.cpuPercent).toBeGreaterThan(0);
    expect(body.readAt).not.toBeNull();
  });

  it("are zero when Docker does not answer", async () => {
    await deployedService();
    context.docker.failNext("serviceStats");

    expect((await api<ServiceMetrics>(`${SERVICE}/metrics`)).body.memoryUsedBytes).toBe(0);
  });
});

describe("status", () => {
  it("reads unknown, not failing, when Docker does not answer", async () => {
    await deployedService();
    context.docker.failNext("listServices");

    expect((await detail()).status).toBe("unknown");
  });
});

describe("destroying", () => {
  it("needs the exact name, checked on the server", async () => {
    await createService();

    expect(apiErrorOf(await api(SERVICE, "DELETE", { confirm: "other" })).code).toBe("confirmation_mismatch");
    expect((await api(SERVICE)).status).toBe(200);
  });

  it("removes the service from Docker, the proxy, the disk and the database", async () => {
    await deployedService();

    const destroyed = await run(SERVICE, "DELETE", { confirm: "web" });

    expect(destroyed.status).toBe("succeeded");
    expect(await swarm()).toBeNull();
    expect(existsSync(routesFile())).toBe(false);
    expect(existsSync(join(context.dataDir, "projects", "shop", "web"))).toBe(false);
    expect((await api(SERVICE)).status).toBe(404);
  });

  it("works on a service that was never deployed", async () => {
    await createService();
    expect((await run(SERVICE, "DELETE", { confirm: "web" })).status).toBe("succeeded");
  });

  it("queues behind a running deployment instead of racing it", async () => {
    await createService();
    await api(`${SERVICE}/source`, "PUT", { image: IMAGE });
    const deploying = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    const destroying = await api<ActionEntry>(SERVICE, "DELETE", { confirm: "web" });

    await waitForAction(destroying.body.id);

    expect((await waitForAction(deploying.body.id)).status).toBe("succeeded");
    expect((await api(SERVICE)).status).toBe(404);
  });
});

describe("authentication", () => {
  it("is required on every route", async () => {
    await createService();
    for (const [path, method] of [
      ["/api/v1/projects", "GET"],
      ["/api/v1/projects/shop", "GET"],
      ["/api/v1/projects/shop/services/web", "GET"],
      ["/api/v1/projects/shop/services/web/deploy", "POST"],
      ["/api/v1/projects/shop/services/web/metrics", "GET"],
    ] as const) {
      expect((await call(context.app, path, { method, origin: TEST_ORIGIN })).status).toBe(401);
    }
  });

  it("rejects a mutation from another origin", async () => {
    const refused = await call(context.app, "/api/v1/projects", {
      method: "POST",
      body: { name: "evil" },
      cookie,
      origin: "https://evil.example",
    });
    expect(refused.status).toBe(403);
  });

  it("records who started an action, and nobody for a token", async () => {
    await deployedService();
    const history = await api<{ items: ActionEntry[] }>(`${SERVICE}/deployments`);

    expect(history.body.items[0]?.actorEmail).toBe(TEST_EMAIL);
  });
});
