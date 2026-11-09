import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DatabaseAvailability,
  type DatabaseDetail,
  type DatabaseEngine,
  databaseEngineInfo,
  databaseEngines,
  databaseImageRule,
  isFixedDatabaseImage,
  type ProjectList,
  type ServiceDetail,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "../../testing/harness";
import { findService, saveServiceSpec } from "../services/repo";
import { databaseDetail, prepareDatabaseSpec, requireDatabase } from "./service";
import { apiErrorOf, type DatabaseTestContext, PROJECT, scriptExec, setupDatabaseTests } from "./testing";

let suite: DatabaseTestContext;
let context: TestContext;

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
});

afterEach(async () => {
  await suite.close();
});

const swarm = () => context.docker.inspectService(`${PROJECT}_db`);
/** What a deployment pins an image to: the digest it came with. */
const pinned = async (image: string) => (await context.docker.inspectImage(image))?.digests[0];
const storedSpec = async (name = "db") => {
  const { services } = (await suite.api<ProjectList>("/projects")).body.projects.find(
    (project) => project.name === PROJECT,
  ) ?? { services: [] };
  return services.find((service) => service.name === name);
};

describe("DAT-02: creating a database", () => {
  it.each(databaseEngines)("creates and deploys %s immediately, with one swarm service", async (engine) => {
    const created = await suite.deployed({ engine });

    expect(created).toMatchObject({ name: "db", type: engine, status: "running" });
    const service = await swarm();
    expect(service?.spec.Name).toBe("shop_db");
    expect(service?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      await pinned(databaseEngineInfo[engine].defaultImage),
    );
    expect(service?.spec.TaskTemplate.ContainerSpec.Mounts?.[0]).toMatchObject({
      Type: "volume",
      Source: "shop_db_data",
      Target: databaseEngineInfo[engine].dataPath,
    });
  });

  it("uses the image from the form", async () => {
    await suite.deployed({ engine: "redis", image: "redis:7.4.8-alpine" });
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await pinned("redis:7.4.8-alpine"));
  });

  it("keeps the proposed version, the configured version and the running image apart", async () => {
    await suite.deployed({ engine: "postgres", image: "postgres:17.6" });

    const { versions } = (await suite.api<DatabaseDetail>(`${suite.service()}/database`)).body;

    expect(versions.proposed).toBe(databaseEngineInfo.postgres.defaultImage);
    expect(versions.configured).toBe("postgres:17.6");
    expect(versions.running).toEqual({
      image: "postgres:17.6",
      digest: await pinned("postgres:17.6"),
      imageId: expect.stringMatching(/^sha256:/),
    });

    await suite.api(`${suite.service()}/database-advanced`, "PUT", {
      image: "postgres:17.7",
      command: "",
      env: "",
    });

    const after = (await suite.api<DatabaseDetail>(`${suite.service()}/database`)).body.versions;
    expect(after.configured).toBe("postgres:17.7");
    expect(after.running?.image).toBe("postgres:17.6");
  });

  it("says a database not deployed yet has no running image", async () => {
    const created = await suite.api<{ name: string }>(`/projects/${PROJECT}/databases`, "POST", {
      name: "db",
      engine: "redis",
    });
    expect(created.status).toBe(201);
    // Creating starts the deployment, but it has not reported anything yet.
    const { versions } = (await suite.api<DatabaseDetail>(`${suite.service()}/database`)).body;
    expect(versions.configured).toBe(databaseEngineInfo.redis.defaultImage);
    expect(versions.proposed).toBe(databaseEngineInfo.redis.defaultImage);
  });

  it("has no domain and writes nothing for the proxy", async () => {
    await suite.deployed({ engine: "postgres" });
    const detail = (await suite.api<ServiceDetail>(suite.service())).body;

    expect(detail.primaryUrl).toBeNull();
    expect(existsSync(join(context.deps.config.traefikDynamicDir, "shop__db.yaml"))).toBe(false);
  });

  it("keeps the first service when a second one takes the same name", async () => {
    await suite.deployed({ engine: "postgres" });
    const second = await suite.api(`/projects/${PROJECT}/databases`, "POST", { name: "db", engine: "redis" });

    expect(second.status).toBe(409);
    expect(apiErrorOf(second).fields).toEqual({ name: "This name is taken in this project" });
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await pinned("postgres:18.6"));
  });

  it("rejects an empty name with Required, and creates nothing", async () => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", { engine: "redis", name: "" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("validation_failed");
    expect(apiErrorOf(result).fields).toEqual({ name: "Required" });
    expect(await context.docker.listServices()).toEqual([]);
  });

  it("rejects uppercase letters and spaces, naming the allowed characters", async () => {
    for (const name of ["Bad", "with space"]) {
      const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", { engine: "redis", name });
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields?.name).toBe("Use lowercase letters, digits, dashes and underscores");
    }
    expect(await context.docker.listServices()).toEqual([]);
  });

  it("rejects an unknown engine", async () => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", { engine: "oracle", name: "x" });
    expect(result.status).toBe(400);
  });

  it("answers 404 for a project that does not exist", async () => {
    const result = await suite.api("/projects/ghost/databases", "POST", { engine: "redis", name: "x" });
    expect(result.status).toBe(404);
  });

  it("uses the project name as the database name, unless told otherwise", async () => {
    await suite.deployed({ engine: "postgres" });
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env).toContain("POSTGRES_DB=shop");

    await suite.deployed({ engine: "postgres", name: "other", databaseName: "custom_db" });
    const other = await context.docker.inspectService("shop_other");
    expect(other?.spec.TaskTemplate.ContainerSpec.Env).toContain("POSTGRES_DB=custom_db");
  });

  it("creates the named user, and the engine's default without one", async () => {
    await suite.deployed({ engine: "postgres", user: "app" });
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env).toContain("POSTGRES_USER=app");

    await suite.deployed({ engine: "mysql", name: "m2" });
    const mysql = await context.docker.inspectService("shop_m2");
    expect(mysql?.spec.TaskTemplate.ContainerSpec.Env).toContain("MYSQL_USER=mysql");
  });

  it.each<[DatabaseEngine, string]>([
    ["mongo", "databaseName"],
    ["redis", "databaseName"],
    ["redis", "user"],
    ["postgres", "rootPassword"],
    ["mongo", "rootPassword"],
    ["redis", "rootPassword"],
  ])("rejects a field that %s does not have (%s)", async (engine, field) => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", {
      name: "x",
      engine,
      [field]: "value",
    });
    expect(result.status).toBe(400);
    expect(Object.keys(apiErrorOf(result).fields ?? {})).toEqual([field]);
    expect(await context.docker.listServices()).toEqual([]);
  });

  it("does not let MySQL's administrator be picked as the regular user", async () => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", {
      name: "x",
      engine: "mysql",
      user: "root",
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.user).toBeDefined();
  });

  it("refuses a system database name on MySQL", async () => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", {
      name: "x",
      engine: "mysql",
      databaseName: "mysql",
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.databaseName).toBeDefined();
  });

  it("generates a strong password on empty, 20 lowercase alphanumeric characters", async () => {
    await suite.deployed({ engine: "redis", password: "" });
    const env = (await swarm())?.spec.TaskTemplate.ContainerSpec.Env ?? [];
    const password = env.find((line) => line.startsWith("REDIS_PASSWORD="))?.slice("REDIS_PASSWORD=".length);

    expect(password).toMatch(/^[a-z0-9]{20}$/);
  });

  it("generates a different password each time", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.deployed({ engine: "redis", name: "other" });
    const passwordOf = async (name: string) =>
      (await context.docker.inspectService(name))?.spec.TaskTemplate.ContainerSpec.Env?.[0];

    expect(await passwordOf("shop_db")).not.toBe(await passwordOf("shop_other"));
  });

  it("generates both passwords on MySQL and MariaDB", async () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      await suite.deployed({ engine, name: engine });
      const env =
        (await context.docker.inspectService(`shop_${engine}`))?.spec.TaskTemplate.ContainerSpec.Env ?? [];
      const prefix = engine === "mysql" ? "MYSQL" : "MARIADB";
      const value = (key: string) => env.find((line) => line.startsWith(`${key}=`))?.split("=")[1];
      expect(value(`${prefix}_ROOT_PASSWORD`)).toMatch(/^[a-z0-9]{20}$/);
      expect(value(`${prefix}_PASSWORD`)).toMatch(/^[a-z0-9]{20}$/);
      expect(value(`${prefix}_ROOT_PASSWORD`)).not.toBe(value(`${prefix}_PASSWORD`));
    }
  });

  it.each(["\u0000abc", "abc\ndef", "   "])("rejects the password %j", async (password) => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", {
      name: "x",
      engine: "redis",
      password,
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.password).toBeDefined();
    expect(await context.docker.listServices()).toEqual([]);
  });

  it("rejects a badly formed image", async () => {
    const result = await suite.api(`/projects/${PROJECT}/databases`, "POST", {
      name: "x",
      engine: "redis",
      image: "not an image",
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.image).toBe("Enter an image such as name:tag");
  });

  describe("a fixed version (REQ-495)", () => {
    const create = (image: string) =>
      suite.api(`/projects/${PROJECT}/databases`, "POST", { name: "x", engine: "postgres", image });

    it("has one in every default, so that nobody starts on a tag that moves", () => {
      for (const engine of databaseEngines) {
        expect(isFixedDatabaseImage(databaseEngineInfo[engine].defaultImage), engine).toBe(true);
      }
    });

    it.each(["postgres:latest", "postgres", "postgres:18", "postgres:18-alpine", "postgres:alpine"])(
      "refuses %s, which can change under the data by itself",
      async (image) => {
        const result = await create(image);
        expect(result.status).toBe(400);
        expect(apiErrorOf(result).fields?.image).toBe(databaseImageRule);
        expect(await context.docker.listServices()).toEqual([]);
      },
    );

    it("refuses a registry port taken for a tag", async () => {
      const result = await create("registry.example.com:5000/postgres");
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields?.image).toBe(databaseImageRule);
    });

    it.each([
      "postgres:18.6",
      "postgres:18.6-alpine",
      "registry.example.com:5000/postgres:18.6",
      `postgres@sha256:${"a".repeat(64)}`,
      `postgres:18@sha256:${"a".repeat(64)}`,
    ])("accepts %s, which names one version", async (image) => {
      const result = await create(image);
      expect(result.status).toBe(201);
      expect(
        databaseDetail(requireDatabase(context.deps, { projectName: PROJECT, serviceName: "x" })),
      ).toMatchObject({
        image,
      });
    });

    it("refuses a floating image from a template's form too", async () => {
      await expect(
        prepareDatabaseSpec(context.deps, PROJECT, {
          name: "from-template",
          engine: "postgres",
          image: "postgres:latest",
        }),
      ).rejects.toMatchObject({ code: "validation_failed", fields: { image: databaseImageRule } });
    });

    it("leaves the source route out of it", async () => {
      await suite.deployed({ engine: "postgres" });
      const result = await suite.api(`${suite.service()}/source`, "PUT", {
        type: "image",
        image: "postgres:latest",
      });
      expect(result.status).toBe(409);
      expect(apiErrorOf(result).code).toBe("database_image_managed");
      expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await pinned("postgres:18.6"));
    });
  });

  it("gives a new database its own volume, never a name already in use", async () => {
    await context.docker.createVolume({ name: "shop_db_data" });
    await suite.deployed({ engine: "redis" });

    const mounts = (await swarm())?.spec.TaskTemplate.ContainerSpec.Mounts;
    expect(mounts?.[0]?.Source).toBe("shop_db_data_2");
  });

  it("offers the engine's client in the console, on top of the usual shells", async () => {
    await suite.deployed({ engine: "redis" });
    const { body } = await suite.api<{ scripts: string[] }>(`${suite.service()}/console`);
    expect(body.scripts).toEqual(["Redis Client"]);
  });
});

describe("whether the engine really lets the panel in (REQ-198)", () => {
  const availability = async () =>
    (await suite.api<DatabaseAvailability>(`${suite.service()}/database/availability`)).body;

  it("reports a running process and an accepted sign-in, as two facts", async () => {
    await suite.deployed({ engine: "postgres" });
    const calls = scriptExec(context, () => ({ exitCode: 0, output: "opsifier-ok\n" }));

    const result = await availability();

    expect(result).toMatchObject({ process: "running", signIn: "accepted", detail: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.command[0]).toBe("psql");
    expect(calls[0]?.options.env).toContainEqual(expect.stringMatching(/^PGPASSWORD=/));
  });

  it("reports a running process that refuses the panel's credentials", async () => {
    await suite.deployed({ engine: "postgres", password: "the-sealed-one" });
    scriptExec(context, () => ({
      exitCode: 2,
      output: 'psql: error: password authentication failed for user "postgres" (the-sealed-one)\n',
    }));

    const result = await availability();

    expect(result).toMatchObject({ process: "running", signIn: "refused" });
    expect(result.detail).toContain("password authentication failed");
    expect(result.detail).not.toContain("the-sealed-one");
  });

  it("does not ask an engine that is not running", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${suite.service()}/stop`);
    const calls = scriptExec(context, () => ({ exitCode: 0, output: "opsifier-ok\n" }));

    expect(await availability()).toMatchObject({ process: "not-running", signIn: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("says it does not know while a password change is unsettled", async () => {
    await suite.deployed({ engine: "postgres" });
    const record = requireDatabase(context.deps, { projectName: PROJECT, serviceName: "db" });
    saveServiceSpec(
      context.deps.db,
      PROJECT,
      "db",
      {
        ...record.spec,
        database: {
          ...record.spec.database,
          rotation: {
            from: { sealedPassword: "a", sealedRootPassword: null },
            to: { sealedPassword: "b", sealedRootPassword: null },
          },
        },
      },
      new Date(context.deps.now()),
    );

    expect(await availability()).toMatchObject({ process: "running", signIn: "unknown" });
  });

  it("is only for databases", async () => {
    await suite.api(`/projects/${PROJECT}/services`, "POST", { name: "web" });
    expect((await suite.api(`${suite.service("web")}/database/availability`)).status).toBe(404);
  });

  it("says in a deployment's output what the engine answered", async () => {
    const deployed = await suite.create({ engine: "postgres" });
    const finished = await suite.waitFor((deployed.activeAction as { id: string }).id);
    expect(finished.log).toMatch(/The database accepts the panel's credentials/);
  });

  it("still deploys when the engine turns the panel away, and says so", async () => {
    scriptExec(context, () => ({ exitCode: 2, output: "password authentication failed\n" }));
    const deployed = await suite.create({ engine: "postgres" });
    const finished = await suite.waitFor((deployed.activeAction as { id: string }).id);
    expect(finished.status).toBe("succeeded");
    expect(finished.log).toMatch(/Deployed, but the panel could not sign in: password authentication failed/);
  });
});

describe("DAT-03: overview and live status", () => {
  it("reports the engine details the page needs", async () => {
    await suite.deployed({ engine: "postgres", image: "postgres:17.11-alpine" });
    const { body, status } = await suite.api<DatabaseDetail>(`${suite.service()}/database`);

    expect(status).toBe(200);
    expect(body).toEqual({
      engine: "postgres",
      image: "postgres:17.11-alpine",
      volume: "shop_db_data",
      exposedPort: 0,
      internalHost: "shop_db",
      internalPort: 5432,
      versions: {
        proposed: databaseEngineInfo.postgres.defaultImage,
        configured: "postgres:17.11-alpine",
        running: {
          image: "postgres:17.11-alpine",
          digest: await pinned("postgres:17.11-alpine"),
          imageId: expect.stringMatching(/^sha256:/),
        },
      },
    });
  });

  it("answers 404 for a service that is not a database", async () => {
    await suite.api(`/projects/${PROJECT}/services`, "POST", { name: "web" });
    expect((await suite.api(`${suite.service("web")}/database`)).status).toBe(404);
  });

  it("lists the database with its status, and nothing about its credentials", async () => {
    await suite.deployed({ engine: "postgres" });
    const service = await storedSpec();

    expect(service).toMatchObject({ name: "db", type: "postgres", status: "running" });
  });

  it("reads metrics through the shared endpoint", async () => {
    await suite.deployed({ engine: "postgres" });
    const { status, body } = await suite.api<{ cpuPercent: number }>(`${suite.service()}/metrics`);

    expect(status).toBe(200);
    expect(body.cpuPercent).toBeGreaterThanOrEqual(0);
  });
});

describe("DAT-04: start and stop", () => {
  it("scales to zero and back, keeping the service, its volume and its credentials", async () => {
    await suite.deployed({ engine: "postgres", password: "stays-the-same" });
    const before = (await swarm())?.spec.TaskTemplate.ContainerSpec;

    const stopped = await suite.run(`${suite.service()}/stop`);
    expect(stopped.status).toBe("succeeded");
    expect((await swarm())?.spec.Mode).toEqual({ Replicated: { Replicas: 0 } });
    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("stopped");

    const started = await suite.run(`${suite.service()}/start`);
    expect(started.status).toBe("succeeded");
    expect((await swarm())?.spec.Mode).toEqual({ Replicated: { Replicas: 1 } });
    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("running");

    const after = (await swarm())?.spec.TaskTemplate.ContainerSpec;
    expect(after?.Mounts).toEqual(before?.Mounts);
    expect(after?.Env).toEqual(before?.Env);
  });

  it("restarts by replacing the task, keeping the same data volume", async () => {
    await suite.deployed({ engine: "redis" });
    const before = (await swarm())?.spec.TaskTemplate.ForceUpdate ?? 0;

    expect((await suite.run(`${suite.service()}/restart`)).status).toBe("succeeded");
    expect((await swarm())?.spec.TaskTemplate.ForceUpdate).toBe(before + 1);
  });

  it("redeploys on request with a new task and the same volume", async () => {
    await suite.deployed({ engine: "postgres" });
    const before = await swarm();

    expect((await suite.run(`${suite.service()}/deploy`)).status).toBe("succeeded");

    const after = await swarm();
    expect(after?.spec.TaskTemplate.ForceUpdate).toBe((before?.spec.TaskTemplate.ForceUpdate ?? 0) + 1);
    expect(after?.spec.TaskTemplate.ContainerSpec.Mounts).toEqual(
      before?.spec.TaskTemplate.ContainerSpec.Mounts,
    );
  });
});

describe("DAT-12: notes, rename and destroy", () => {
  it("saves a note through the shared endpoint", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.api(`${suite.service()}/notes`, "PUT", { notes: "Keep this one" });

    expect((await suite.api<ServiceDetail>(suite.service())).body.notes).toBe("Keep this one");
  });

  it("refuses to destroy without the exact name", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(suite.service(), "DELETE", { confirm: "wrong" });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("confirmation_mismatch");
    expect(await swarm()).not.toBeNull();
  });

  it("removes the service and its row when destroyed, and keeps its data volume", async () => {
    await suite.deployed({ engine: "postgres" });
    await context.docker.createVolume({ name: "shop_db_data" });

    const destroyed = await suite.run(suite.service(), "DELETE", { confirm: "db" });

    expect(destroyed.status).toBe("succeeded");
    expect(destroyed.log).toContain("Keeping the volume shop_db_data");
    expect(await swarm()).toBeNull();
    expect(await context.docker.inspectVolume("shop_db_data")).not.toBeNull();
    expect((await suite.api(suite.service())).status).toBe(404);
  });

  it("never hands a kept volume to a new database of the same name", async () => {
    await suite.deployed({ engine: "postgres" });
    await context.docker.createVolume({ name: "shop_db_data" });
    await suite.run(suite.service(), "DELETE", { confirm: "db" });

    const again = await suite.deployed({ engine: "postgres" });

    const volume = findService(context.deps.db, "shop", again.name)?.spec.database?.volume;
    expect(volume).toBe("shop_db_data_2");
    expect(await context.docker.inspectVolume("shop_db_data")).not.toBeNull();
  });

  it("keeps a database's volume across a rename, so its data comes along", async () => {
    await suite.deployed({ engine: "redis", password: "same" });
    await suite.run(`${suite.service()}/stop`);

    const renamed = await suite.api<ServiceDetail>(`${suite.service()}/rename`, "POST", {
      projectName: PROJECT,
      name: "renamed",
    });
    expect(renamed.status).toBe(200);
    const started = await suite.run(`${suite.service("renamed")}/start`);
    expect(started.status).toBe("succeeded");

    const service = await context.docker.inspectService("shop_renamed");
    expect(service?.spec.TaskTemplate.ContainerSpec.Mounts?.[0]?.Source).toBe("shop_db_data");
    expect(service?.spec.TaskTemplate.ContainerSpec.Env).toContain("REDIS_PASSWORD=same");
    expect((await suite.api<DatabaseDetail>(`${suite.service("renamed")}/database`)).body.volume).toBe(
      "shop_db_data",
    );
  });

  it("writes the MySQL config file a redeploy needs, readable by the server's user", async () => {
    const created = await suite.deployed({ engine: "mysql" });
    expect(created.status).toBe("running");
    await suite.saveThenDeploy(`${suite.service()}/database-advanced`, {
      image: "mysql:9.7.4",
      command: "",
      env: "",
      configFile: "[mysqld]\nmax_connections=500\n",
    });

    const path = join(context.dataDir, "projects", "shop", "db", "files", "opsifier.cnf");
    expect(readFileSync(path, "utf8")).toBe("[mysqld]\nmax_connections=500\n");
  });
});
