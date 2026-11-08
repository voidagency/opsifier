import type { DatabaseAdvancedSettings, ServiceDetail } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../../../testing/harness";
import { apiErrorOf, type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../../databases/testing";

let suite: DatabaseTestContext;
let context: TestContext;

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
});

afterEach(async () => {
  await suite.close();
  vi.restoreAllMocks();
});

const path = () => `${suite.service()}/database-advanced`;
const settings = async () => (await suite.api<DatabaseAdvancedSettings>(path())).body;
const container = async () =>
  (await context.docker.inspectService("shop_db"))?.spec.TaskTemplate.ContainerSpec;

describe("DAT-09: advanced settings", () => {
  it("reports the image, command and environment", async () => {
    await suite.deployed({ engine: "postgres", image: "postgres:17-alpine" });
    expect(await settings()).toEqual({
      image: "postgres:17-alpine",
      command: "",
      env: "",
      configFile: "",
    });
  });

  it("applies a new image at once", async () => {
    await suite.deployed({ engine: "redis" });
    const action = await suite.run(path(), "PUT", { image: "redis:8", command: "", env: "" });

    expect(action.status).toBe("succeeded");
    expect((await container())?.Image).toBe("redis:8");
    expect((await settings()).image).toBe("redis:8");
    expect((await suite.api<ServiceDetail>(suite.service())).body.source).toMatchObject({ image: "redis:8" });
  });

  it("adds a new variable to the container and removes it when cleared", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(path(), "PUT", { image: "postgres:18", env: "TZ=UTC" });
    expect((await container())?.Env).toContain("TZ=UTC");

    await suite.run(path(), "PUT", { image: "postgres:18", env: "" });
    expect((await container())?.Env?.some((line) => line.startsWith("TZ="))).toBe(false);
  });

  it("rejects a line without an equals sign, naming it, as the rest of the panel does", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(path(), "PUT", { image: "postgres:18", env: "ok=1\nno equals here" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toEqual({ env: "Line 2 must look like NAME=value" });
    expect((await settings()).env).toBe("");
  });

  it("reflects a custom Postgres command as /bin/sh -c, and clears it", async () => {
    await suite.deployed({ engine: "postgres" });
    const command = "docker-entrypoint.sh postgres -c max_connections=200";

    await suite.run(path(), "PUT", { image: "postgres:18", command });
    expect((await container())?.Command).toEqual(["/bin/sh", "-c", command]);

    await suite.run(path(), "PUT", { image: "postgres:18", command: "" });
    expect((await container())?.Command).toBeUndefined();
    expect((await settings()).command).toBe("");
  });

  it("really runs a custom Redis command, keeping the password in it", async () => {
    await suite.deployed({ engine: "redis" });
    const command = 'redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 256mb';

    const action = await suite.run(path(), "PUT", { image: "redis:7", command });

    expect(action.status).toBe("succeeded");
    expect((await container())?.Command).toEqual(["/bin/sh", "-c", command]);
    expect((await settings()).command).toBe(command);
  });

  it("refuses a Redis command that would turn the password off", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { image: "redis:7", command: "redis-server" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.command).toContain("$REDIS_PASSWORD");
    expect((await container())?.Command).toEqual([
      "/bin/sh",
      "-c",
      'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes',
    ]);
  });

  it("refuses a variable the panel manages", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(path(), "PUT", {
      image: "postgres:18",
      env: "POSTGRES_PASSWORD=changed",
    });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toContain("POSTGRES_PASSWORD");
  });

  it("accepts a config file on MySQL and MariaDB, and refuses one elsewhere", async () => {
    await suite.deployed({ engine: "mariadb" });
    const accepted = await suite.run(path(), "PUT", {
      image: "mariadb:11",
      configFile: "[mysqld]\nmax_connections=200\n",
    });
    expect(accepted.status).toBe("succeeded");
    expect((await settings()).configFile).toBe("[mysqld]\nmax_connections=200\n");
    expect((await container())?.Mounts).toContainEqual({
      Type: "bind",
      Source: `${context.dataDir}/projects/${PROJECT}/db/files/opsifier.cnf`,
      Target: "/etc/mysql/conf.d/opsifier.cnf",
      ReadOnly: true,
    });

    await suite.deployed({ engine: "postgres", name: "pg" });
    const refused = await suite.api(`${suite.service("pg")}/database-advanced`, "PUT", {
      image: "postgres:18",
      configFile: "x",
    });
    expect(refused.status).toBe(400);
    expect(Object.keys(apiErrorOf(refused).fields ?? {})).toEqual(["configFile"]);
  });

  it("rejects a badly formed image", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { image: "not valid" });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.image).toBe("Enter an image such as name:tag");
  });

  it("stores changes without starting a stopped database", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.run(`${suite.service()}/stop`);

    const action = await suite.run(path(), "PUT", { image: "redis:8" });

    expect(action.status).toBe("succeeded");
    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("stopped");
    expect((await container())?.Image).toBe("redis:8");
  });

  it("reports a failed rollout on the Action", async () => {
    await suite.deployed({ engine: "redis" });
    context.docker.failNext("pullImage");

    const action = await suite.run(path(), "PUT", { image: "redis:8" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("pullImage failed");
  });
});
