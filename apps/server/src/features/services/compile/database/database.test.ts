import { createHash } from "node:crypto";
import {
  type DatabaseEngine,
  databaseEngineInfo,
  databaseEngines,
  deploySettings,
  resourcesSpec,
} from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import type { SwarmServiceSpec } from "../../../../core/docker";
import { type AppServiceSpec, appServiceSpec, type StoredDatabase } from "../../spec";
import { compileService } from "../index";
import { MAX_TASK_PROCESSES } from "../resources";
import { compileCompanion } from "./companions";
import { connectionUrl, maskedConnectionUrl, percentEncode } from "./connection";
import { compileDatabaseService, type DatabaseSecrets } from "./index";

const SECRETS: DatabaseSecrets = { password: "pw", rootPassword: "rootpw" };

function database(engine: DatabaseEngine, overrides: Partial<StoredDatabase> = {}): StoredDatabase {
  const info = databaseEngineInfo[engine];
  return {
    engine,
    databaseName: info.hasDatabaseName ? "probe-data" : null,
    user: info.defaultUser,
    sealedPassword: "sealed",
    sealedRootPassword: info.hasRootPassword ? "sealed-root" : null,
    volume: "probe-data_db_data",
    exposedPort: 0,
    configFile: "",
    companions: {},
    rotation: null,
    ...overrides,
  };
}

function spec(
  engine: DatabaseEngine,
  overrides: Partial<AppServiceSpec> = {},
): AppServiceSpec & { database: StoredDatabase } {
  return {
    ...appServiceSpec.parse({
      source: { type: "image", image: `${engine}:tag`, username: null, sealedPassword: null },
      database: database(engine),
    }),
    ...overrides,
  } as AppServiceSpec & { database: StoredDatabase };
}

function compile(
  engine: DatabaseEngine,
  { env: serviceEnv, ...overrides }: Partial<AppServiceSpec> & { env?: string } = {},
  options: { secrets?: DatabaseSecrets; env?: string; forceUpdate?: number } = {},
) {
  return compileDatabaseService({
    project: { name: "probe-data" },
    service: { name: "db", spec: spec(engine, overrides) },
    env: { project: options.env ?? "", service: serviceEnv ?? "" },
    secrets: options.secrets ?? SECRETS,
    dataDir: "/var/lib/opsifier",
    forceUpdate: options.forceUpdate ?? 0,
  });
}

function swarm(result: ReturnType<typeof compile>): SwarmServiceSpec {
  if (result.swarmSpec === null) {
    throw new Error("Expected a Swarm spec");
  }
  return result.swarmSpec;
}

const container = (result: ReturnType<typeof compile>) => swarm(result).TaskTemplate.ContainerSpec;

describe("DAT-02: the Swarm service of a database", () => {
  const compiled = swarm(compile("postgres"));

  it("is one service named <project>_<service> with one replica", () => {
    expect(compiled.Name).toBe("probe-data_db");
    expect(compiled.Mode).toEqual({ Replicated: { Replicas: 1 } });
  });

  it("runs under init, stops within 10 seconds and restarts on any failure after 5 seconds", () => {
    expect(compiled.TaskTemplate.ContainerSpec.Init).toBe(true);
    expect(compiled.TaskTemplate.ContainerSpec.StopGracePeriod).toBe(10_000_000_000);
    expect(compiled.TaskTemplate.RestartPolicy).toEqual({
      Condition: "any",
      Delay: 5_000_000_000,
      MaxAttempts: 0,
    });
  });

  it("uses a DNS round-robin endpoint and json-file logs limited to 3 files of 10 MB", () => {
    expect(compiled.EndpointSpec).toEqual({ Mode: "dnsrr" });
    expect(compiled.TaskTemplate.LogDriver).toEqual({
      Name: "json-file",
      Options: { "max-file": "3", "max-size": "10m" },
    });
  });

  it("updates and rolls back stop-first, one at a time, monitored for 5 seconds, pausing on failure", () => {
    const expected = expect.objectContaining({
      Parallelism: 1,
      FailureAction: "pause",
      Monitor: 5_000_000_000,
      Order: "stop-first",
    });
    expect(compiled.UpdateConfig).toEqual(expected);
    expect(compiled.RollbackConfig).toEqual(expected);
  });

  it("joins only its project's network, under its aliases", () => {
    expect(compiled.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-probe-data", Aliases: ["probe-data-db", "db"] },
    ]);
  });

  it("keeps a database's data on a named volume, not on a host path", () => {
    expect(compiled.TaskTemplate.ContainerSpec.Mounts).toMatchObject([
      { Type: "volume", Source: "probe-data_db_data", Target: "/var/lib/postgresql/data" },
    ]);
  });

  it("marks the volume it asks Docker to create as the panel's", () => {
    expect(compiled.TaskTemplate.ContainerSpec.Mounts?.[0]?.VolumeOptions?.Labels).toEqual({
      "opsifier.project": "probe-data",
      "opsifier.service": "db",
      "opsifier.type": "postgres",
    });
  });

  it("keeps its tasks on the node that holds the volume", () => {
    expect(compiled.TaskTemplate.Placement).toEqual({ Constraints: ["node.role==manager"] });
  });

  it("creates no proxy route", () => {
    expect(compile("postgres").proxyConfig).toEqual({ http: { routers: {}, services: {} } });
  });

  it("waits for the engine to answer before a task counts as running", () => {
    expect(compiled.TaskTemplate.ContainerSpec.Healthcheck).toEqual(
      expect.objectContaining({
        Test: expect.arrayContaining(["pg_isready"]),
        StartPeriod: 300_000_000_000,
      }),
    );
  });

  it("carries the labels the rest of the panel reads", () => {
    expect(compiled.Labels).toMatchObject({ "opsifier.project": "probe-data", "opsifier.service": "db" });
  });

  it("raises Swarm's counter so a redeploy always replaces the task", () => {
    expect(swarm(compile("redis", {}, { forceUpdate: 3 })).TaskTemplate.ForceUpdate).toBe(3);
  });

  it("runs nothing while stopped, and stays one replica however the stored spec was tampered with", () => {
    expect(swarm(compile("postgres", { stopped: true })).Mode).toEqual({ Replicated: { Replicas: 0 } });
    const scaled = compile("postgres", {
      deploy: deploySettings.parse({ replicas: 5, zeroDowntime: true }),
    });
    expect(swarm(scaled).Mode).toEqual({ Replicated: { Replicas: 1 } });
    expect(swarm(scaled).UpdateConfig).toMatchObject({ Order: "stop-first" });
  });
});

describe("DAT-14: per-engine differences", () => {
  const expectations: Record<
    DatabaseEngine,
    { port: number; mount: string; defaultImage: string; defaultUser: string; env: string[] }
  > = {
    postgres: {
      port: 5432,
      mount: "/var/lib/postgresql/data",
      defaultImage: "postgres:18.6",
      defaultUser: "postgres",
      env: [
        "POSTGRES_PASSWORD=pw",
        "POSTGRES_USER=postgres",
        "POSTGRES_DB=probe-data",
        "PGDATA=/var/lib/postgresql/data",
      ],
    },
    mysql: {
      port: 3306,
      mount: "/var/lib/mysql",
      defaultImage: "mysql:9.7.4",
      defaultUser: "mysql",
      env: [
        "MYSQL_ROOT_PASSWORD=rootpw",
        "MYSQL_DATABASE=probe-data",
        "MYSQL_USER=mysql",
        "MYSQL_PASSWORD=pw",
      ],
    },
    mariadb: {
      port: 3306,
      mount: "/var/lib/mysql",
      defaultImage: "mariadb:11.8.9",
      defaultUser: "mariadb",
      env: [
        "MARIADB_ROOT_PASSWORD=rootpw",
        "MARIADB_DATABASE=probe-data",
        "MARIADB_USER=mariadb",
        "MARIADB_PASSWORD=pw",
      ],
    },
    mongo: {
      port: 27017,
      mount: "/data/db",
      defaultImage: "mongo:8.3.13",
      defaultUser: "mongo",
      env: ["MONGO_INITDB_ROOT_USERNAME=mongo", "MONGO_INITDB_ROOT_PASSWORD=pw"],
    },
    redis: {
      port: 6379,
      mount: "/data",
      defaultImage: "redis:7.4.8",
      defaultUser: "default",
      env: ["REDIS_PASSWORD=pw"],
    },
  };

  describe.each(databaseEngines)("%s", (engine) => {
    const expected = expectations[engine];

    it("has the documented defaults", () => {
      expect(databaseEngineInfo[engine]).toMatchObject({
        port: expected.port,
        defaultImage: expected.defaultImage,
        defaultUser: expected.defaultUser,
        dataPath: expected.mount,
      });
    });

    it("mounts its data at the documented path", () => {
      expect(container(compile(engine)).Mounts).toMatchObject([
        { Type: "volume", Source: "probe-data_db_data", Target: expected.mount },
      ]);
    });

    it("sets exactly the documented variables", () => {
      expect(container(compile(engine)).Env).toEqual(expected.env);
    });

    it("runs the stored image", () => {
      expect(container(compile(engine)).Image).toBe(`${engine}:tag`);
    });
  });

  it("starts Redis with its password from the environment, never on the command line it holds", () => {
    const { Command, Args } = container(compile("redis"));
    expect(Command).toEqual([
      "/bin/sh",
      "-c",
      'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes',
    ]);
    expect(Args).toBeUndefined();
    expect(JSON.stringify(Command)).not.toContain('pw"');
  });

  it("lets every other engine start from the image's own command", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongo"] as const) {
      expect(container(compile(engine)).Command).toBeUndefined();
    }
  });
});

describe("DAT-05: connection strings", () => {
  const target = {
    engine: "postgres" as const,
    host: "shop_db",
    port: 5432,
    user: "app",
    databaseName: "shop",
  };

  it("builds the Postgres URL, ending with sslmode=disable", () => {
    expect(connectionUrl(target, "secret")).toBe("postgres://app:secret@shop_db:5432/shop?sslmode=disable");
  });

  it("builds the Redis URL with the literal user default", () => {
    expect(
      connectionUrl(
        { engine: "redis", host: "shop_db", port: 6379, user: "default", databaseName: null },
        "pw",
      ),
    ).toBe("redis://default:pw@shop_db:6379");
  });

  it("builds a mysql:// URL for both MySQL and MariaDB", () => {
    const base = { host: "h", port: 3306, user: "u", databaseName: "d" };
    expect(connectionUrl({ ...base, engine: "mysql" }, "p")).toBe("mysql://u:p@h:3306/d");
    expect(connectionUrl({ ...base, engine: "mariadb" }, "p")).toBe("mysql://u:p@h:3306/d");
  });

  it("builds the Mongo URL with tls=false", () => {
    expect(
      connectionUrl({ engine: "mongo", host: "h", port: 27017, user: "u", databaseName: null }, "p"),
    ).toBe("mongodb://u:p@h:27017/?tls=false");
  });

  it("percent-encodes everything a URL treats specially, in user, password and database", () => {
    const url = connectionUrl(
      { engine: "postgres", host: "h", port: 5432, user: "a@b:c", databaseName: "my/db?#" },
      "p@ss:w/rd?#%'()*!&+=",
    );
    expect(url).toBe(
      "postgres://a%40b%3Ac:p%40ss%3Aw%2Frd%3F%23%25%27%28%29%2A%21%26%2B%3D@h:5432/my%2Fdb%3F%23?sslmode=disable",
    );
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("a@b:c");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss:w/rd?#%'()*!&+=");
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe("my/db?#");
    expect(parsed.hostname).toBe("h");
  });

  it("puts an IPv6 host in brackets", () => {
    expect(connectionUrl({ ...target, host: "2001:db8::1" }, "p")).toBe(
      "postgres://app:p@[2001:db8::1]:5432/shop?sslmode=disable",
    );
  });

  it("masks the password in what is shown before anyone reveals it", () => {
    const masked = maskedConnectionUrl(target);
    expect(masked).toBe("postgres://app:••••••••@shop_db:5432/shop?sslmode=disable");
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("!*'()")).toBe("%21%2A%27%28%29");
  });
});

describe("DAT-07: public ports", () => {
  it("publishes the engine port on the host in host mode", () => {
    const result = compile("redis", {
      database: database("redis", { exposedPort: 16379 }),
    } as Partial<AppServiceSpec>);
    expect(swarm(result).EndpointSpec).toEqual({
      Mode: "dnsrr",
      Ports: [{ Protocol: "tcp", TargetPort: 6379, PublishedPort: 16379, PublishMode: "host" }],
    });
  });

  it("publishes nothing when the port is 0", () => {
    expect(swarm(compile("redis")).EndpointSpec).toEqual({ Mode: "dnsrr" });
  });
});

describe("DAT-08: resources", () => {
  it("turns 64/128 MB and 0.1/0.5 cores into reservations and limits", () => {
    const result = compile("redis", {
      resources: resourcesSpec.parse({
        memoryReservation: 64,
        memoryLimit: 128,
        cpuReservation: 0.1,
        cpuLimit: 0.5,
      }),
    });
    expect(swarm(result).TaskTemplate.Resources).toEqual({
      Reservations: { NanoCPUs: 100_000_000, MemoryBytes: 67108864 },
      Limits: { NanoCPUs: 500_000_000, MemoryBytes: 134217728, Pids: MAX_TASK_PROCESSES },
    });
  });

  it("leaves limits and reservations empty when every value is zero", () => {
    expect(swarm(compile("redis")).TaskTemplate.Resources).toEqual({
      Limits: { Pids: MAX_TASK_PROCESSES },
      Reservations: {},
    });
  });

  it("applies a CPU limit on its own instead of dropping it", () => {
    const result = compile("postgres", { resources: resourcesSpec.parse({ cpuLimit: 0.5 }) });
    expect(swarm(result).TaskTemplate.Resources).toEqual({
      Limits: { NanoCPUs: 500_000_000, Pids: MAX_TASK_PROCESSES },
      Reservations: {},
    });
  });
});

describe("DAT-09: advanced settings", () => {
  it("adds environment lines after the engine's variables", () => {
    const { Env } = container(compile("postgres", { env: "TZ=UTC\nLOG_LEVEL=debug" }));
    expect(Env).toEqual([
      "POSTGRES_PASSWORD=pw",
      "POSTGRES_USER=postgres",
      "POSTGRES_DB=probe-data",
      "PGDATA=/var/lib/postgresql/data",
      "TZ=UTC",
      "LOG_LEVEL=debug",
    ]);
  });

  it("passes project variables on, and never lets them replace a managed one", () => {
    const { Env } = container(compile("redis", {}, { env: "SHARED=1\nREDIS_PASSWORD=stolen" }));
    expect(Env).toEqual(["REDIS_PASSWORD=pw", "SHARED=1"]);
  });

  it("never lets a stored environment line replace a managed variable", () => {
    const { Env } = container(compile("postgres", { env: "POSTGRES_PASSWORD=other\nTZ=UTC" }));
    expect(Env).toContain("POSTGRES_PASSWORD=pw");
    expect(Env).not.toContain("POSTGRES_PASSWORD=other");
    expect(Env).toContain("TZ=UTC");
  });

  it("does not pass on a line without an equals sign", () => {
    const { Env } = container(compile("redis", { env: "NOVALUE\nKEY=value" }));
    expect(Env).toContain("KEY=value");
    expect(Env).not.toContain("NOVALUE");
  });

  it("reflects a custom Postgres command as /bin/sh -c", () => {
    const command = "docker-entrypoint.sh postgres -c max_connections=200";
    const { Command } = container(compile("postgres", { deploy: deploySettings.parse({ command }) }));
    expect(Command).toEqual(["/bin/sh", "-c", command]);
  });

  it("honours a custom Redis command instead of quietly ignoring it", () => {
    const command = 'redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 100mb';
    const { Command, Args } = container(compile("redis", { deploy: deploySettings.parse({ command }) }));
    expect(Command).toEqual(["/bin/sh", "-c", command]);
    expect(Args).toBeUndefined();
  });

  it("returns to the image's own command when the custom one is cleared", () => {
    const { Command, Args } = container(
      compile("postgres", { deploy: deploySettings.parse({ command: null }) }),
    );
    expect(Command).toBeUndefined();
    expect(Args).toBeUndefined();
  });

  it("mounts a config file for MySQL and MariaDB, readable by the server's own user", () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      const result = compile(engine, {
        database: database(engine, { configFile: "[mysqld]\nmax_connections=500\n" }),
      } as Partial<AppServiceSpec>);
      expect(result.files).toEqual([
        {
          path: "/var/lib/opsifier/projects/probe-data/db/files/opsifier.cnf",
          content: "[mysqld]\nmax_connections=500\n",
          mode: 0o644,
        },
      ]);
      expect(container(result).Mounts).toContainEqual({
        Type: "bind",
        Source: "/var/lib/opsifier/projects/probe-data/db/files/opsifier.cnf",
        Target: "/etc/mysql/conf.d/opsifier.cnf",
        ReadOnly: true,
      });
    }
  });

  it("mounts no config file for other engines, even if one was stored", () => {
    const result = compile("postgres", {
      database: database("postgres", { configFile: "ignored" }),
    } as Partial<AppServiceSpec>);
    expect(result.files).toEqual([]);
    expect(container(result).Mounts).toHaveLength(1);
  });
});

describe("DAT-13: web admin companions", () => {
  const input = {
    project: "probe-data",
    service: "db",
    tool: "pgweb" as const,
    engine: "postgres" as const,
    user: "app",
    databaseName: "shop",
    password: "p@ss/w:rd",
    rootPassword: null,
    host: "probe-data-db-pgweb.203.0.113.10.sslip.io",
    username: "opsifier",
    token: "tokenvalue",
  };

  it("runs as its own Swarm service on the project's networks, where the proxy can reach it", () => {
    const { swarmSpec } = compileCompanion(input);
    expect(swarmSpec.Name).toBe("probe-data_db-pgweb");
    expect(swarmSpec.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-probe-data", Aliases: ["probe-data_db-pgweb"] },
      { Target: "opsifier-probe-data_proxy" },
    ]);
    expect(swarmSpec.Labels).toMatchObject({ "opsifier.type": "companion", "opsifier.parent": "db" });
  });

  it("hands the tool a correctly encoded connection string", () => {
    const { swarmSpec } = compileCompanion(input);
    expect(swarmSpec.TaskTemplate.ContainerSpec.Env).toEqual([
      "PGWEB_DATABASE_URL=postgres://app:p%40ss%2Fw%3Ard@probe-data_db:5432/shop?sslmode=disable",
    ]);
  });

  it("publishes it on its own domain, behind a generated token kept hashed in the proxy", () => {
    const config = compileCompanion(input).proxyConfig.http as unknown as {
      routers: Record<string, { rule: string; middlewares: string[] }>;
      middlewares: Record<string, { basicAuth: { users: string[]; removeHeader: boolean } }>;
    };
    expect(config.routers["https-probe-data_db-pgweb"]?.rule).toBe(`Host(\`${input.host}\`)`);
    expect(config.routers["https-probe-data_db-pgweb"]?.middlewares).toEqual(["probe-data_db-pgweb-auth"]);

    const hashed = `{SHA}${createHash("sha1").update("tokenvalue").digest("base64")}`;
    expect(config.middlewares["probe-data_db-pgweb-auth"]?.basicAuth).toEqual({
      removeHeader: true,
      users: [`opsifier:${hashed}`],
    });
    expect(JSON.stringify(config)).not.toContain("tokenvalue");
  });

  it("names the DbGate plugin the engine needs, sharing MySQL's for MariaDB", () => {
    const env = (engine: "mariadb" | "redis", tool: "dbgate" = "dbgate") =>
      compileCompanion({ ...input, tool, engine, databaseName: engine === "redis" ? null : "d" }).swarmSpec
        .TaskTemplate.ContainerSpec.Env ?? [];
    expect(env("mariadb")).toContain("ENGINE_db=mariadb@dbgate-plugin-mysql");
    expect(env("redis")).toContain("ENGINE_db=redis@dbgate-plugin-redis");
    expect(env("redis").some((line) => line.startsWith("USER_db"))).toBe(false);
  });

  it("rejects a hostname unfit for a Traefik rule", () => {
    expect(() => compileCompanion({ ...input, host: "bad host`" })).toThrow();
  });
});

describe("App services and databases stay separate", () => {
  it("does not change what compileService produces for an App", () => {
    const appSpec = appServiceSpec.parse({
      source: { type: "image", image: "traefik/whoami:v1.10", username: null, sealedPassword: null },
    });
    const result = compileService({
      project: { name: "shop" },
      service: { name: "web", spec: appSpec },
      domains: [],
      dataDir: "/var/lib/opsifier",
      forceUpdate: 0,
    });
    expect(result.swarmSpec?.EndpointSpec).toEqual({ Mode: "vip" });
    expect(result.swarmSpec?.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-shop", Aliases: ["shop-web", "web"] },
      { Target: "opsifier-shop_proxy" },
    ]);
  });
});
