import type { ComposeDetail, CreateDatabaseRequest, ServiceDetail } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeContainerInfo, SwarmServiceSpec } from "../../core/docker";
import type { TestContext } from "../../testing/harness";
import { type DatabaseTestContext, PROJECT, scriptExec, setupDatabaseTests } from "../databases/testing";
import { effectiveOf, recordApplied } from "../services/applied";
import { findService } from "../services/repo";
import { PROXY_SERVICE } from "./network";

let suite: DatabaseTestContext;
let context: TestContext;

const OTHER = "rival";
const IMAGE = "traefik/whoami:v1.10";

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
  await context.docker.createService({
    Name: PROXY_SERVICE,
    TaskTemplate: { ContainerSpec: { Image: "traefik:3" }, Networks: [{ Target: "opsifier" }] },
  });
  await suite.api("/projects", "POST", { name: OTHER });
});

afterEach(async () => {
  await suite.close();
  vi.restoreAllMocks();
});

const servicePath = (project: string, name: string) => `/projects/${project}/services/${name}`;

async function networksOf(service: string): Promise<string[]> {
  const known = await context.docker.listNetworks();
  const current = await context.docker.inspectService(service);
  return (current?.spec.TaskTemplate.Networks ?? [])
    .map(
      ({ Target }) =>
        known.find((network) => network.id === Target || network.name === Target)?.name ?? Target,
    )
    .sort();
}

/** The proxy's networks, leaving aside those of the other project, which is not what is moving here. */
const proxyNetworks = async () => (await networksOf(PROXY_SERVICE)).filter((name) => !name.includes(OTHER));

async function deployedApp(name: string, project = PROJECT, env?: string): Promise<void> {
  expect((await suite.api(`/projects/${project}/services`, "POST", { name })).status).toBe(201);
  const path = servicePath(project, name);
  expect((await suite.api(`${path}/source`, "PUT", { image: IMAGE })).status).toBe(200);
  if (env !== undefined) {
    expect((await suite.api(`${path}/environment`, "PUT", { env })).status).toBe(200);
  }
  await expectDeployed(path);
}

async function expectDeployed(path: string) {
  const action = await suite.run(`${path}/deploy`);
  expect(action.error).toBeNull();
  expect(action.status).toBe("succeeded");
  return action;
}

async function deployedDatabase(
  name: string,
  project = PROJECT,
  body: Partial<CreateDatabaseRequest> = {},
): Promise<void> {
  const created = await suite.api<ServiceDetail>(`/projects/${project}/databases`, "POST", {
    name,
    engine: "redis",
    ...body,
  });
  expect(created.status).toBe(201);
  const action = created.body.activeAction;
  expect((await suite.waitFor(action?.id ?? "")).status).toBe("succeeded");
}

/** Puts a Swarm service back on the networks an earlier version of the panel gave it. */
async function setNetworks(
  name: string,
  networks: NonNullable<SwarmServiceSpec["TaskTemplate"]["Networks"]>,
) {
  const current = await context.docker.inspectService(name);
  if (current === null) {
    throw new Error(`There is no service ${name}`);
  }
  await context.docker.updateService(name, {
    ...current.spec,
    TaskTemplate: { ...current.spec.TaskTemplate, Networks: networks },
  });
}

/** What the proxy looked like before it had networks of its own: on every project's network. */
async function proxyAsBeforeTheUpgrade(project = PROJECT): Promise<void> {
  await context.docker.removeNetwork(`opsifier-${project}_proxy`);
  await setNetworks(PROXY_SERVICE, [{ Target: "opsifier" }, { Target: `opsifier-${project}` }]);
}

const appAsBeforeTheUpgrade = (name: string, project = PROJECT) =>
  setNetworks(`${project}_${name}`, [
    { Target: `opsifier-${project}`, Aliases: [`${project}-${name}`, name] },
  ]);

const databaseAsBeforeTheUpgrade = (name: string, project = PROJECT) =>
  setNetworks(`${project}_${name}`, [
    { Target: "opsifier", Aliases: [`${project}-${name}`] },
    { Target: `opsifier-${project}`, Aliases: [`${project}-${name}`, name] },
  ]);

describe("the networks of a project", () => {
  it("are one for its services and another for the proxy, which is only on that one", async () => {
    expect(await networksOf(PROXY_SERVICE)).toEqual(["opsifier", `opsifier-${OTHER}_proxy`]);
    expect(await context.docker.inspectNetwork(`opsifier-${OTHER}`)).toMatchObject({
      attachable: true,
      labels: { "opsifier.project": OTHER },
    });
    expect(await context.docker.inspectNetwork(`opsifier-${OTHER}_proxy`)).toMatchObject({
      attachable: true,
      labels: { "opsifier.project": OTHER },
    });
  });

  it("hold an app on both and a database on its project's own, where the proxy isn't", async () => {
    await deployedApp("web");
    await deployedDatabase("db");

    expect(await networksOf("shop_web")).toEqual(["opsifier-shop", "opsifier-shop_proxy"]);
    expect(await networksOf("shop_db")).toEqual(["opsifier-shop"]);
    expect(await networksOf(PROXY_SERVICE)).not.toContain("opsifier-shop");
  });

  it("go with the project: both are removed, and the proxy leaves them in one change", async () => {
    const version = (await context.docker.inspectService(PROXY_SERVICE))?.version ?? 0;

    const action = await suite.run(`/projects/${OTHER}`, "DELETE", { confirm: OTHER });

    expect(action.status).toBe("succeeded");
    expect(await context.docker.inspectNetwork(`opsifier-${OTHER}`)).toBeNull();
    expect(await context.docker.inspectNetwork(`opsifier-${OTHER}_proxy`)).toBeNull();
    expect(await networksOf(PROXY_SERVICE)).toEqual(["opsifier"]);
    expect((await context.docker.inspectService(PROXY_SERVICE))?.version).toBe(version + 1);
  });
});

describe("each change to the proxy's networks restarts it", () => {
  it("so a server moving over does it once, for every project at once", async () => {
    await deployedApp("web");
    await deployedApp("web", OTHER);
    await context.docker.removeNetwork("opsifier-shop_proxy");
    await context.docker.removeNetwork(`opsifier-${OTHER}_proxy`);
    await setNetworks(PROXY_SERVICE, [
      { Target: "opsifier" },
      { Target: "opsifier-shop" },
      { Target: `opsifier-${OTHER}` },
    ]);
    await appAsBeforeTheUpgrade("web");
    await appAsBeforeTheUpgrade("web", OTHER);
    const version = (await context.docker.inspectService(PROXY_SERVICE))?.version ?? 0;

    await deployedApp("api");

    expect(await networksOf(PROXY_SERVICE)).toEqual(
      expect.arrayContaining(["opsifier-shop_proxy", `opsifier-${OTHER}_proxy`]),
    );
    expect((await context.docker.inspectService(PROXY_SERVICE))?.version).toBe(version + 1);
  });

  it("and another project's network not being made is no reason to fail a deployment", async () => {
    await context.docker.removeNetwork(`opsifier-${OTHER}_proxy`);
    const create = context.docker.createNetwork.bind(context.docker);
    vi.spyOn(context.docker, "createNetwork").mockImplementation(async (options) => {
      if (options.name === `opsifier-${OTHER}_proxy`) {
        throw new Error("no more address space");
      }
      return create(options);
    });

    await deployedApp("web");
  });
});

describe("what an upgrade does to what is already running", () => {
  beforeEach(async () => {
    await deployedApp("web");
    await deployedDatabase("db");
    await appAsBeforeTheUpgrade("web");
    await databaseAsBeforeTheUpgrade("db");
    await proxyAsBeforeTheUpgrade();
  });

  it("changes nothing until the next deploy", async () => {
    const proxy = await context.docker.inspectService(PROXY_SERVICE);
    const web = await context.docker.inspectService("shop_web");
    const db = await context.docker.inspectService("shop_db");

    await context.restart();

    expect(await context.docker.inspectService(PROXY_SERVICE)).toEqual(proxy);
    expect(await context.docker.inspectService("shop_web")).toEqual(web);
    expect(await context.docker.inspectService("shop_db")).toEqual(db);
    expect(await context.docker.inspectNetwork("opsifier-shop_proxy")).toBeNull();
  });

  it("shows on the service that a deploy would change something, until one has", async () => {
    const database = findService(context.deps.db, PROJECT, "db");
    if (database === undefined) {
      throw new Error("The database should exist");
    }
    const target = { projectName: PROJECT, serviceName: "db" };
    const effective = effectiveOf(context.deps, target, database) as {
      swarm: { TaskTemplate: { Networks: unknown } };
    };
    effective.swarm.TaskTemplate.Networks = [
      { Target: "opsifier", Aliases: ["shop-db"] },
      { Target: "opsifier-shop", Aliases: ["shop-db", "db"] },
    ];
    recordApplied(context.deps, target, effective);

    expect((await suite.api<ServiceDetail>(servicePath(PROJECT, "db"))).body.pendingChanges).toBe(true);

    await expectDeployed(servicePath(PROJECT, "db"));

    expect((await suite.api<ServiceDetail>(servicePath(PROJECT, "db"))).body.pendingChanges).toBe(false);
  });

  it("moves a database off the shared network at its next deploy, with every name intact", async () => {
    const path = servicePath(PROJECT, "db");
    const before = (await suite.api(`${path}/database`)).body;

    const action = await expectDeployed(path);

    expect(action.log).toMatch(/only its own project can reach it/);
    expect(action.log).toMatch(/address and connection strings stay the same/);
    expect((await context.docker.inspectService("shop_db"))?.spec.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-shop", Aliases: ["shop-db", "db"] },
    ]);
    expect((await suite.api(`${path}/database`)).body).toEqual(before);
  });

  it("puts the networks back when that deployment fails", async () => {
    context.docker.taskFailure = (spec) =>
      spec.Name === "shop_db" && spec.TaskTemplate.Networks?.length === 1 ? "task: non-zero exit (1)" : null;

    const action = await suite.run(`${servicePath(PROJECT, "db")}/deploy`);

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/previous version is running again/);
    expect(await networksOf("shop_db")).toEqual(["opsifier", "opsifier-shop"]);
  });

  it("keeps the proxy on the project's network until the last workload has moved", async () => {
    await deployedApp("api");
    await setNetworks("shop_api", [{ Target: "opsifier-shop", Aliases: ["shop-api", "api"] }]);

    await expectDeployed(servicePath(PROJECT, "web"));
    expect(await proxyNetworks()).toEqual(["opsifier", "opsifier-shop", "opsifier-shop_proxy"]);
    expect(await networksOf("shop_web")).toEqual(["opsifier-shop", "opsifier-shop_proxy"]);

    const action = await expectDeployed(servicePath(PROJECT, "api"));
    expect(action.log).toContain("Disconnecting the proxy from opsifier-shop");
    expect(await proxyNetworks()).toEqual(["opsifier", "opsifier-shop_proxy"]);
  });

  it("does not count a database as something the proxy has to reach", async () => {
    await expectDeployed(servicePath(PROJECT, "web"));

    expect(await proxyNetworks()).toEqual(["opsifier", "opsifier-shop_proxy"]);
    expect(await networksOf("shop_db")).toEqual(["opsifier", "opsifier-shop"]);
  });

  it("releases the proxy from a project that holds only databases", async () => {
    await suite.run(`${servicePath(PROJECT, "web")}/stop`);
    await context.docker.removeService("shop_web");

    await expectDeployed(servicePath(PROJECT, "db"));

    expect(await proxyNetworks()).toEqual(["opsifier"]);
  });

  it("counts a stopped app, which comes back on the networks it had", async () => {
    await deployedApp("api");
    await setNetworks("shop_api", [{ Target: "opsifier-shop", Aliases: ["shop-api", "api"] }]);
    await suite.run(`${servicePath(PROJECT, "api")}/stop`);

    await expectDeployed(servicePath(PROJECT, "web"));

    expect(await proxyNetworks()).toContain("opsifier-shop");
  });

  it("counts the children of a stack deployed before, until the stack has moved", async () => {
    const child: ComposeContainerInfo = {
      id: "old",
      name: "shop_stack-web-1",
      image: "nginx",
      project: "shop_stack",
      child: "web",
      number: 1,
      state: "running",
      status: "Up",
      exitCode: null,
      health: null,
      ports: [],
      labels: {},
      networks: ["shop_stack_default", "opsifier-shop"],
    };
    context.docker.composeContainers.push(child);

    await expectDeployed(servicePath(PROJECT, "web"));
    expect(await proxyNetworks()).toContain("opsifier-shop");

    child.networks = ["shop_stack_default", "opsifier-shop", "opsifier-shop_proxy"];
    await expectDeployed(servicePath(PROJECT, "web"));
    expect(await proxyNetworks()).not.toContain("opsifier-shop");
  });

  it("does not hold up a deployment when the proxy can't be changed afterwards", async () => {
    await expectDeployed(servicePath(PROJECT, "web"));
    context.docker.failNext("listServices");

    const action = await expectDeployed(servicePath(PROJECT, "web"));

    expect(action.log).toMatch(/Could not settle the proxy's networks/);
  });
});

describe("a database's web tool, through an upgrade", () => {
  it("moves with the database at its next deploy, and stops holding the proxy back", async () => {
    await deployedDatabase("db", PROJECT, { engine: "postgres" });
    const companions = `${servicePath(PROJECT, "db")}/companions`;
    expect((await suite.run(`${companions}/pgweb`)).status).toBe("succeeded");
    expect(await networksOf("shop_db-pgweb")).toEqual(["opsifier-shop", "opsifier-shop_proxy"]);

    await setNetworks("shop_db-pgweb", [{ Target: "opsifier-shop", Aliases: ["shop_db-pgweb"] }]);
    await databaseAsBeforeTheUpgrade("db");
    await setNetworks(PROXY_SERVICE, [
      { Target: "opsifier" },
      { Target: "opsifier-shop" },
      { Target: (await context.docker.inspectNetwork("opsifier-shop_proxy"))?.id ?? "" },
    ]);
    // Reading the tool's tasks is routine for it, and a rollout here would otherwise wait on one.
    scriptExec(context, () => ({ exitCode: 0, output: "" }));

    await expectDeployed(servicePath(PROJECT, "db"));

    expect(await networksOf("shop_db-pgweb")).toEqual(["opsifier-shop", "opsifier-shop_proxy"]);
    expect(await proxyNetworks()).toEqual(["opsifier", "opsifier-shop_proxy"]);
  });
});

describe("a service naming a database of another project", () => {
  const refused = async (project: string, service: string) => {
    const action = await suite.run(`${servicePath(project, service)}/deploy`);
    expect(action.status).toBe("failed");
    return action.error ?? "";
  };

  beforeEach(async () => {
    await deployedDatabase("db", OTHER);
  });

  it.each([
    ["a URL", "DATABASE_URL=postgres://user:secret@rival_db:5432/app", "DATABASE_URL"],
    ["a URL by its alias", "DATABASE_URL=postgres://user:secret@rival-db:5432/app", "DATABASE_URL"],
    ["one of several hosts", "MONGO=mongodb://u:p@x:27017,rival_db:27017/app", "MONGO"],
    ["host and port", "CACHE=rival_db:6379", "CACHE"],
    ["a variable for a host", "PGHOST=rival_db", "PGHOST"],
  ])("is refused at deploy when it does so through %s", async (_label, env, where) => {
    await deployedApp("web");
    await suite.api(`${servicePath(PROJECT, "web")}/environment`, "PUT", { env });
    const before = await context.docker.inspectService("shop_web");

    const error = await refused(PROJECT, "web");

    expect(error).toContain(`${where} points at a host this project can't reach`);
    expect(error).toMatch(/publish its port on its Expose tab and connect through the server's address/);
    expect(error).not.toContain("secret");
    expect((await context.docker.inspectService("shop_web"))?.version).toBe(before?.version);
  });

  it("is refused for the project's variables too, and says nothing about whose it is", async () => {
    await deployedDatabase("cache");
    await suite.api(`/projects/${PROJECT}/env`, "PUT", { env: "DB_HOST=rival_db" });
    const error = await refused(PROJECT, "cache");

    expect(error).toContain("DB_HOST points at a host this project can't reach");
    expect(error).not.toContain(`project ${OTHER}`);
  });

  it("is refused for a database's own command", async () => {
    await deployedDatabase("cache");
    await suite.api(`${servicePath(PROJECT, "cache")}/advanced/deploy`, "PUT", {
      command: "redis-server --replicaof rival_db 6379",
    });

    expect(await refused(PROJECT, "cache")).toContain(
      "The command points at a host this project can't reach",
    );
  });

  it.each([
    ["a variable that just reads the same", "SLUG=rival-db"],
    ["a bucket with the same name", "S3_BUCKET=rival_db"],
    ["a host of its own", "DATABASE_URL=postgres://u:p@db.example.com:5432/app"],
    ["this project's database", "DATABASE_URL=postgres://u:p@shop_local:5432/app"],
  ])("is not refused for %s", async (_label, env) => {
    await deployedDatabase("local");
    await deployedApp("web", PROJECT, env);
  });

  it("is told apart from a service of its own project that happens to have that name", async () => {
    await deployedApp("rival-db");
    await deployedApp("web", PROJECT, "UPSTREAM=rival-db:80");
  });

  it("is refused when starting a service moved here, which creates it again", async () => {
    await deployedApp("web", OTHER, "REDIS=rival_db:6379");
    await suite.run(`${servicePath(OTHER, "web")}/stop`);
    const moved = await suite.api(`${servicePath(OTHER, "web")}/rename`, "POST", {
      projectName: PROJECT,
      name: "web",
    });
    expect(moved.status).toBe(200);

    expect((await suite.run(`${servicePath(PROJECT, "web")}/start`)).error).toMatch(/can't reach/);
  });

  it("is refused for what a Compose file tells its children, and for a stack's variables", async () => {
    await suite.api(`/projects/${PROJECT}/compose`, "POST", { name: "stack" });
    await suite.api(`${servicePath(PROJECT, "stack")}/compose/source`, "PUT", {
      type: "inline",
      content:
        "services:\n  web:\n    image: nginx\n    restart: always\n    environment:\n      DATABASE_URL: redis://rival_db:6379\n",
    });
    expect(await refused(PROJECT, "stack")).toContain(
      "DATABASE_URL points at a host this project can't reach",
    );

    await suite.api(`${servicePath(PROJECT, "stack")}/compose/source`, "PUT", {
      type: "inline",
      content: "services:\n  web:\n    image: nginx\n    restart: always\n",
    });
    await suite.api(`${servicePath(PROJECT, "stack")}/environment`, "PUT", { env: "PGHOST=rival-db" });
    expect(await refused(PROJECT, "stack")).toContain("PGHOST points at a host this project can't reach");
  });
});

describe("a database another project relies on, moving off the shared network", () => {
  const DB = servicePath(PROJECT, "db");

  beforeEach(async () => {
    await deployedDatabase("db");
    await databaseAsBeforeTheUpgrade("db");
  });

  async function consumerStack(file: string): Promise<void> {
    await suite.api(`/projects/${OTHER}/compose`, "POST", { name: "stack" });
    const saved = await suite.api<ComposeDetail>(`${servicePath(OTHER, "stack")}/compose/source`, "PUT", {
      type: "inline",
      content: file,
    });
    expect(saved.status).toBe(200);
  }

  const JOINS_AND_NAMES_IT =
    "services:\n  app:\n    image: nginx\n    restart: always\n    networks: [panel]\n    environment:\n      DATABASE_URL: redis://shop-db:6379\nnetworks:\n  panel:\n    external: true\n    name: opsifier\n";

  it("is refused, in terms that name nothing of the other project, while a stack uses it", async () => {
    await consumerStack(JOINS_AND_NAMES_IT);
    const warn = vi.spyOn(context.deps.logger, "warn");

    const action = await suite.run(`${DB}/deploy`);

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/A service in another project connects to this database by name/);
    expect(action.error).toMatch(/nothing was changed/);
    expect(action.error).toMatch(/publish its port on its Expose tab/);
    expect(action.error).not.toContain(OTHER);
    expect(action.error).not.toContain("stack");
    expect(await networksOf("shop_db")).toEqual(["opsifier", "opsifier-shop"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ consumer: { projectName: OTHER, serviceName: "stack" } }),
      expect.any(String),
    );
  });

  it("goes ahead once that stack has changed, saving it being enough", async () => {
    await consumerStack(JOINS_AND_NAMES_IT);
    expect((await suite.run(`${DB}/deploy`)).status).toBe("failed");

    await suite.api(`${servicePath(OTHER, "stack")}/compose/source`, "PUT", {
      type: "inline",
      content: "services:\n  app:\n    image: nginx\n    restart: always\n",
    });

    await expectDeployed(DB);
    expect(await networksOf("shop_db")).toEqual(["opsifier-shop"]);
  });

  it("is refused while a database still on the network connects to it", async () => {
    await deployedDatabase("replica", OTHER);
    await databaseAsBeforeTheUpgrade("replica", OTHER);
    await suite.api(`${servicePath(OTHER, "replica")}/environment`, "PUT", {
      env: "REPLICA_OF=shop-db:6379",
    });

    expect((await suite.run(`${DB}/deploy`)).error).toMatch(/connects to this database by name/);
  });

  it("is not held up by a database that has already left, or is stopped", async () => {
    await deployedDatabase("replica", OTHER);
    await suite.api(`${servicePath(OTHER, "replica")}/environment`, "PUT", {
      env: "REPLICA_OF=shop-db:6379",
    });
    await expectDeployed(DB);

    await databaseAsBeforeTheUpgrade("db");
    await databaseAsBeforeTheUpgrade("replica", OTHER);
    await suite.run(`${servicePath(OTHER, "replica")}/stop`);
    await expectDeployed(DB);
  });

  it("is not held up by a stack that never joined that network", async () => {
    await consumerStack(
      "services:\n  app:\n    image: nginx\n    restart: always\n    environment:\n      DATABASE_URL: redis://shop-db:6379\n",
    );

    await expectDeployed(DB);
  });

  it("does not start a password change that couldn't finish", async () => {
    await consumerStack(JOINS_AND_NAMES_IT);
    const password = "a-brand-new-password";
    const before = findService(context.deps.db, PROJECT, "db")?.spec.database?.sealedPassword;

    const action = await suite.run(`${DB}/credentials`, "PUT", { password });

    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/connects to this database by name/);
    const after = findService(context.deps.db, PROJECT, "db")?.spec.database;
    expect(after?.sealedPassword).toBe(before);
    expect(after?.rotation).toBeNull();
  });
});
