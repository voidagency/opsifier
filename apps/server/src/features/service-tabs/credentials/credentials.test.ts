import {
  type ActionPage,
  type DatabaseCredentials,
  type DatabaseEngine,
  databaseEngineInfo,
  databaseEngines,
  type ProjectList,
  type RevealedSecret,
  type ServiceDetail,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerDriverError } from "../../../core/docker";
import { call, type TestContext } from "../../../testing/harness";
import {
  apiErrorOf,
  type DatabaseTestContext,
  type ExecCall,
  PROJECT,
  scriptExec,
  setupDatabaseTests,
} from "../../databases/testing";
import { findService, saveServiceSpec } from "../../services/repo";

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

const credentialsPath = () => `${suite.service()}/credentials`;
const credentials = async () => (await suite.api<DatabaseCredentials>(credentialsPath())).body;
const reveal = async (secret: string, path = suite.service()) => {
  const response = await suite.api<RevealedSecret>(`${path}/credentials/reveal`, "POST", { secret });
  return response;
};
const swarmEnv = async (name = "shop_db") =>
  (await context.docker.inspectService(name))?.spec.TaskTemplate.ContainerSpec.Env ?? [];

describe("DAT-05: credentials and connection strings", () => {
  it("shows the user, the internal host and port, and a masked URL", async () => {
    await suite.deployed({ engine: "postgres", password: "s3cret-pw" });

    expect(await credentials()).toEqual({
      engine: "postgres",
      user: "postgres",
      hasRootPassword: false,
      databaseName: "shop",
      internal: {
        host: "shop_db",
        port: 5432,
        maskedUrl: "postgres://postgres:••••••••@shop_db:5432/shop?sslmode=disable",
      },
      external: null,
      rotationUnresolved: false,
    });
  });

  it.each(databaseEngines)("gives %s the engine's fields and internal host", async (engine) => {
    await suite.deployed({ engine });
    const body = await credentials();

    expect(body.engine).toBe(engine);
    expect(body.user).toBe(databaseEngineInfo[engine].defaultUser);
    expect(body.hasRootPassword).toBe(databaseEngineInfo[engine].hasRootPassword);
    expect(body.databaseName).toBe(databaseEngineInfo[engine].hasDatabaseName ? "shop" : null);
    expect(body.internal.host).toBe("shop_db");
    expect(body.internal.port).toBe(databaseEngineInfo[engine].port);
    expect(body.internal.maskedUrl).toContain("••••••••");
  });

  it("uses the literal user default in Redis URLs", async () => {
    await suite.deployed({ engine: "redis", password: "x" });
    expect((await reveal("internalUrl")).body.value).toBe("redis://default:x@shop_db:6379");
  });

  it("ends the Postgres URL with sslmode=disable", async () => {
    await suite.deployed({ engine: "postgres", password: "x", user: "app", databaseName: "appdb" });
    expect((await reveal("internalUrl")).body.value).toBe(
      "postgres://app:x@shop_db:5432/appdb?sslmode=disable",
    );
  });

  it("percent-encodes a password that would otherwise break the URL", async () => {
    const password = "p@ss/w:rd?#";
    await suite.deployed({ engine: "postgres", password, user: "app", databaseName: "appdb" });

    const { value } = (await reveal("internalUrl")).body;
    expect(value).toBe("postgres://app:p%40ss%2Fw%3Ard%3F%23@shop_db:5432/appdb?sslmode=disable");
    expect(decodeURIComponent(new URL(value).password)).toBe(password);
  });

  it("reveals the password itself, exactly as stored", async () => {
    await suite.deployed({ engine: "postgres", password: "p@ss/w:rd" });
    expect((await reveal("password")).body.value).toBe("p@ss/w:rd");
  });

  it("reveals the root password on MySQL and MariaDB only", async () => {
    await suite.deployed({ engine: "mysql", rootPassword: "rooty" });
    expect((await reveal("rootPassword")).body.value).toBe("rooty");

    await suite.deployed({ engine: "postgres", name: "pg" });
    expect((await reveal("rootPassword", suite.service("pg"))).status).toBe(409);
  });

  it("marks every reveal as uncacheable", async () => {
    await suite.deployed({ engine: "redis" });
    expect((await reveal("password")).headers.get("cache-control")).toBe("no-store");
  });

  it("offers no external group until the database is exposed", async () => {
    await suite.deployed({ engine: "redis" });
    expect((await credentials()).external).toBeNull();
    expect((await reveal("externalUrl")).status).toBe(409);
  });

  it("adds the external host, port and URL once exposed, using the exposed port", async () => {
    await suite.deployed({ engine: "redis", password: "x" });
    await suite.run(`${suite.service()}/expose`, "PUT", { port: 16379 });

    const body = await credentials();
    expect(body.external).toEqual({
      host: "203.0.113.10",
      port: 16379,
      maskedUrl: "redis://default:••••••••@203.0.113.10:16379",
    });
    expect((await reveal("externalUrl")).body.value).toBe("redis://default:x@203.0.113.10:16379");
  });

  it("uses the hostname the panel was reached on as the external host", async () => {
    await suite.deployed({ engine: "redis", password: "x" });
    await suite.run(`${suite.service()}/expose`, "PUT", { port: 16379 });

    const asBrowser = await call<DatabaseCredentials>(context.app, `/api/v1${credentialsPath()}`, {
      cookie: suite.cookie,
      headers: { host: "panel.example.com:3000" },
    });
    expect(asBrowser.body.external).toMatchObject({ host: "panel.example.com", port: 16379 });

    const ipv6 = await call<DatabaseCredentials>(context.app, `/api/v1${credentialsPath()}`, {
      cookie: suite.cookie,
      headers: { host: "[2001:db8::1]:3000" },
    });
    expect(ipv6.body.external?.host).toBe("2001:db8::1");
    expect(ipv6.body.external?.maskedUrl).toBe("redis://default:••••••••@[2001:db8::1]:16379");
  });

  it("answers 404 on a service that is not a database", async () => {
    await suite.api(`/projects/${PROJECT}/services`, "POST", { name: "web" });
    expect((await suite.api(`${suite.service("web")}/credentials`)).status).toBe(404);
  });

  it("refuses an unknown secret name", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await reveal("everything");
    expect(result.status).toBe(400);
  });

  it("refuses a reveal without a session", async () => {
    await suite.deployed({ engine: "redis" });
    const { app } = context;
    const response = await app.request(`/api/v1${credentialsPath()}/reveal`, {
      method: "POST",
      body: JSON.stringify({ secret: "password" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
  });
});

describe("Secrets: sealed, and never on an ordinary response", () => {
  const PASSWORD = "very-distinctive-secret-value";
  const ROOT = "another-distinctive-root-value";

  const everythingVisible = async (): Promise<string> => {
    const paths = [
      "/projects",
      `/projects/${PROJECT}`,
      suite.service(),
      `${suite.service()}/database`,
      credentialsPath(),
      `${suite.service()}/database-advanced`,
      `${suite.service()}/database-resources`,
      `${suite.service()}/expose`,
      `${suite.service()}/companions`,
      `${suite.service()}/deployments`,
      "/actions?limit=100",
    ];
    const bodies: unknown[] = [];
    for (const path of paths) {
      bodies.push((await suite.api(path)).body);
    }
    const { items } = (await suite.api<ActionPage>("/actions?limit=100")).body;
    for (const action of items) {
      bodies.push((await suite.api(`/actions/${action.id}`)).body);
    }
    return JSON.stringify(bodies);
  };

  it("stores passwords sealed, and never in plaintext, in the database", async () => {
    await suite.deployed({ engine: "mysql", password: PASSWORD, rootPassword: ROOT });
    const record = findService(context.deps.db, PROJECT, "db");

    const stored = JSON.stringify(record?.spec);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(ROOT);
    expect(record?.spec.database?.sealedPassword).toMatch(/^v1\./);
    expect(record?.spec.database?.sealedRootPassword).toMatch(/^v1\./);
  });

  it("appears in no list, detail, settings or log response", async () => {
    await suite.deployed({ engine: "mysql", password: PASSWORD, rootPassword: ROOT });
    await suite.run(`${suite.service()}/expose`, "PUT", { port: 13306 });
    await suite.run(`${suite.service()}/deploy`);

    const visible = await everythingVisible();
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain(ROOT);
    const record = findService(context.deps.db, PROJECT, "db");
    expect(visible).not.toContain(record?.spec.database?.sealedPassword);
  });

  it("still leaks nothing after a password change, succeeded or failed", async () => {
    scriptExec(context, ({ stdin, options }) =>
      options.command[0] === "psql" && stdin.includes("ALTER ROLE")
        ? { exitCode: 1, output: `psql: ERROR at "ALTER ROLE WITH PASSWORD ${PASSWORD}"\n` }
        : { exitCode: 0, output: "opsifier-ok\n" },
    );
    await suite.deployed({ engine: "postgres", password: "old-secret-value" });
    const failed = await suite.run(credentialsPath(), "PUT", { password: PASSWORD });
    expect(failed.status).toBe("failed");

    const visible = await everythingVisible();
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain("old-secret-value");
  });

  it("is only ever returned by the reveal endpoint, for the secret asked for", async () => {
    await suite.deployed({ engine: "mysql", password: PASSWORD, rootPassword: ROOT });

    const password = await reveal("password");
    expect(password.body).toEqual({ value: PASSWORD });
    expect(JSON.stringify(password.body)).not.toContain(ROOT);
  });

  it("audits every reveal with who asked and for what", async () => {
    await suite.deployed({ engine: "postgres" });
    await reveal("password");
    await reveal("internalUrl");

    const { items } = (await suite.api<ActionPage>("/actions?limit=100")).body;
    const reveals = items.filter((action) => action.type === "database.reveal");
    expect(reveals.map((action) => action.title).sort()).toEqual([
      "Reveal the internal connection URL of shop/db",
      "Reveal the password of shop/db",
    ]);
    expect(reveals.every((action) => action.actorEmail === "admin@example.com")).toBe(true);
    expect(reveals.every((action) => action.status === "succeeded")).toBe(true);
  });
});

describe("DAT-06: changing the password", () => {
  /** Stands in for the engines. Every script succeeds unless a failure was arranged. */
  function liveEngine(options: { failOn?: RegExp; rejectAfterChange?: boolean } = {}): ExecCall[] {
    return scriptExec(context, ({ stdin }) => {
      if (options.failOn?.test(stdin)) {
        return { exitCode: 1, output: "ERROR: the server refused\n" };
      }
      if (
        options.rejectAfterChange === true &&
        /opsifier-ok/.test(stdin) &&
        /SELECT 1;|SELECT 'opsifier/.test(stdin)
      ) {
        return { exitCode: 2, output: "FATAL: password authentication failed\n" };
      }
      return { exitCode: 0, output: "opsifier-ok\n" };
    });
  }

  it("changes it inside the running database, then in the panel, then in the service", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    const before = (await context.docker.inspectService("shop_db"))?.spec.TaskTemplate.ForceUpdate ?? 0;
    const calls = liveEngine();

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("succeeded");
    expect(calls.map((call) => call.options.command[0])).toEqual(["psql", "psql"]);
    expect(calls[0]?.stdin).toContain(`ALTER ROLE "app" WITH PASSWORD E'new-pass';`);
    expect(calls[1]?.options.env).toContain("PGPASSWORD=new-pass");
    expect(calls[1]?.options.command).toContain("-h");
    expect((await reveal("password")).body.value).toBe("new-pass");
    expect(await swarmEnv()).toContain("POSTGRES_PASSWORD=new-pass");
    expect((await context.docker.inspectService("shop_db"))?.spec.TaskTemplate.ForceUpdate).toBe(before + 1);
    const log = (await suite.api<{ log: string }>(`/actions/${action.id}`)).body.log;
    expect(log).not.toContain("new-pass");
    expect(log).not.toContain("old-pass");
  });

  it("never puts a password on a command line", async () => {
    await suite.deployed({ engine: "postgres", password: "oldpass" });
    const calls = liveEngine();
    await suite.run(credentialsPath(), "PUT", { password: "newpass" });

    for (const call of calls) {
      expect(call.options.command.join(" ")).not.toMatch(/oldpass|newpass/);
    }
  });

  it("quotes a password that is hostile to SQL", async () => {
    await suite.deployed({ engine: "postgres", password: "oldpass" });
    const calls = liveEngine();
    const hostile = `a'b\\c"; DROP ROLE x; --`;

    expect((await suite.run(credentialsPath(), "PUT", { password: hostile })).status).toBe("succeeded");
    expect(calls[0]?.stdin).toContain(`E'a''b\\\\c"; DROP ROLE x; --'`);
    expect((await reveal("password")).body.value).toBe(hostile);
  });

  it("fails visibly and changes nothing when the database refuses", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    liveEngine({ failOn: /ALTER ROLE/ });

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("The password was not changed");
    expect(action.error).toContain("the server refused");
    expect((await reveal("password")).body.value).toBe("old-pass");
    expect(await swarmEnv()).toContain("POSTGRES_PASSWORD=old-pass");
  });

  it("undoes the change and stays on the old password when the new one does not work", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    const calls = scriptExec(context, ({ stdin, options }) => {
      if (
        options.command[0] === "psql" &&
        options.env?.includes("PGPASSWORD=new-pass") &&
        stdin.includes("SELECT 1")
      ) {
        return { exitCode: 2, output: "FATAL: password authentication failed\n" };
      }
      return { exitCode: 0, output: "opsifier-ok\n" };
    });

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("The password was not changed");
    expect(calls.some((call) => call.stdin.includes(`WITH PASSWORD E'old-pass'`))).toBe(true);
    expect((await reveal("password")).body.value).toBe("old-pass");
    expect(findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation).toBeNull();
  });

  it("keeps the new password when undoing fails but the new one turns out to work", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    let verifiedNew = 0;
    scriptExec(context, ({ stdin, options }) => {
      const usesNew = options.env?.includes("PGPASSWORD=new-pass") === true;
      if (stdin.includes("SELECT 1")) {
        if (usesNew && verifiedNew === 0) {
          verifiedNew += 1;
          return { exitCode: 2, output: "FATAL: password authentication failed\n" };
        }
        return usesNew ? { exitCode: 0, output: "opsifier-ok\n" } : { exitCode: 2, output: "FATAL\n" };
      }
      return { exitCode: 0, output: "opsifier-ok\n" };
    });

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("succeeded");
    expect((await reveal("password")).body.value).toBe("new-pass");
  });

  it("reports when it cannot tell which password the database uses", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass" });
    scriptExec(context, ({ stdin }) =>
      stdin.includes("ALTER ROLE")
        ? { exitCode: 1, output: "ERROR: refused\n" }
        : { exitCode: 2, output: "FATAL: nothing works\n" },
    );

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("could not be undone");
    expect(findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation).not.toBeNull();
    expect((await credentials()).rotationUnresolved).toBe(true);
  });

  it("settles an interrupted change from the Credentials tab", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass" });
    scriptExec(context, ({ stdin }) =>
      stdin.includes("ALTER ROLE")
        ? { exitCode: 1, output: "ERROR: refused\n" }
        : { exitCode: 2, output: "FATAL: nothing works\n" },
    );
    await suite.run(credentialsPath(), "PUT", { password: "new-pass" });
    expect((await credentials()).rotationUnresolved).toBe(true);

    // The database recovered in the meantime: the new password is in fact the one that works.
    scriptExec(context, ({ options }) =>
      options.env?.includes("PGPASSWORD=new-pass") === true
        ? { exitCode: 0, output: "opsifier-ok\n" }
        : { exitCode: 2, output: "FATAL: nothing works\n" },
    );
    const check = await suite.run(`${credentialsPath()}/check`);

    expect(check.status).toBe("succeeded");
    expect((await credentials()).rotationUnresolved).toBe(false);
    expect((await reveal("password")).body.value).toBe("new-pass");
  });

  it("reports that nothing changed when no task can run the change", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass" });
    context.docker.failNext("execAttach", new DockerDriverError("No running task for service shop_db.", 409));

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("The password was not changed");
    expect(action.error).toContain("No running task");
    expect(findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation).toBeNull();
    expect((await reveal("password")).body.value).toBe("old-pass");
  });

  it("rejects an empty password", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(credentialsPath(), "PUT", { password: "" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.password).toBe("Required");
  });

  it("requires a value on an engine with one account", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(credentialsPath(), "PUT", {});
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.password).toBe("Required");
  });

  it("refuses a root password on an engine without that account", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(credentialsPath(), "PUT", { rootPassword: "x" });
    expect(result.status).toBe(400);
    expect(Object.keys(apiErrorOf(result).fields ?? {})).toEqual(["rootPassword"]);
  });

  it("refuses to change the password of a stopped database", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${suite.service()}/stop`);

    const result = await suite.api(credentialsPath(), "PUT", { password: "newpass1" });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("service_stopped");
  });

  it.each<[string, DatabaseEngine, string, string]>([
    ["mysql", "mysql", "ALTER USER 'app'@'%' IDENTIFIED BY 'new-pass'", "MYSQL_PWD=old-root"],
    ["mariadb", "mariadb", "ALTER USER 'app'@'%' IDENTIFIED BY 'new-pass'", "MYSQL_PWD=old-root"],
  ])("changes %s's user through its root account", async (_, engine, statement, login) => {
    await suite.deployed({ engine, user: "app", password: "old-pass", rootPassword: "old-root" });
    const calls = liveEngine();

    expect((await suite.run(credentialsPath(), "PUT", { password: "new-pass" })).status).toBe("succeeded");

    expect(calls[0]?.options.command[0]).toBe(engine === "mysql" ? "mysql" : "mariadb");
    expect(calls[0]?.options.env).toContain(login);
    expect(calls[0]?.stdin).toContain(statement);
    expect((await reveal("password")).body.value).toBe("new-pass");
  });

  it("changes MySQL's root password as well, on every root account, when asked to", async () => {
    await suite.deployed({ engine: "mysql", user: "app", password: "old-pass", rootPassword: "old-root" });
    const calls = liveEngine();

    const action = await suite.run(credentialsPath(), "PUT", { rootPassword: "new-root" });

    expect(action.status).toBe("succeeded");
    expect(calls[0]?.stdin).toContain("ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY 'new-root'");
    expect(calls[0]?.stdin).toContain("ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY 'new-root'");
    // The other account stays as it was, and both are checked.
    expect(calls[0]?.stdin).toContain("IDENTIFIED BY 'old-pass'");
    expect(calls.slice(1).map((call) => call.options.env)).toEqual([
      ["MYSQL_PWD=old-pass"],
      ["MYSQL_PWD=new-root"],
    ]);
    expect((await reveal("rootPassword")).body.value).toBe("new-root");
    expect(await swarmEnv()).toContain("MYSQL_ROOT_PASSWORD=new-root");
  });

  it("changes a non-default account, not the engine's default one", async () => {
    await suite.deployed({ engine: "postgres", user: "app", password: "old-pass" });
    const calls = liveEngine();
    await suite.run(credentialsPath(), "PUT", { password: "new-pass" });
    expect(calls[0]?.stdin).toContain('ALTER ROLE "app"');
  });

  it("changes Mongo's account in the admin database", async () => {
    await suite.deployed({ engine: "mongo", user: "root1", password: "old-pass" });
    const calls = liveEngine();

    expect((await suite.run(credentialsPath(), "PUT", { password: "new-pass" })).status).toBe("succeeded");
    expect(calls[0]?.options.command).toContain("mongosh");
    expect(calls[0]?.stdin).toContain('auth("root1", "old-pass")');
    expect(calls[0]?.stdin).toContain('changeUserPassword("root1", "new-pass")');
    expect((await reveal("password")).body.value).toBe("new-pass");
  });

  it("changes Redis by restarting it with the new password, then checks it answers", async () => {
    await suite.deployed({ engine: "redis", password: "old-pass" });
    const calls = liveEngine();

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("succeeded");
    expect(await swarmEnv()).toContain("REDIS_PASSWORD=new-pass");
    expect(calls.map((call) => call.options.command[0])).toEqual(["redis-cli"]);
    expect(calls[0]?.options.env).toEqual(["REDISCLI_AUTH=new-pass"]);
    expect((await reveal("password")).body.value).toBe("new-pass");
  });

  it("puts Redis back on its old password when the restart with the new one does not work", async () => {
    await suite.deployed({ engine: "redis", password: "old-pass" });
    scriptExec(context, ({ options }) =>
      options.env?.includes("REDISCLI_AUTH=new-pass") === true
        ? { exitCode: 0, output: "NOAUTH\n" }
        : { exitCode: 0, output: "opsifier-ok\n" },
    );

    const action = await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("The password was not changed");
    expect(await swarmEnv()).toContain("REDIS_PASSWORD=old-pass");
    expect((await reveal("password")).body.value).toBe("old-pass");
    expect(findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation).toBeNull();
  });

  it("does nothing when the password would not change", async () => {
    await suite.deployed({ engine: "postgres", password: "same-pass" });
    const calls = liveEngine();

    const action = await suite.run(credentialsPath(), "PUT", { password: "same-pass" });

    expect(action.status).toBe("succeeded");
    expect(calls).toEqual([]);
  });

  it("recovers a change that the panel died in the middle of", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    // The panel saved its intent, the database took the new password, and then the panel died.
    const record = findService(context.deps.db, PROJECT, "db");
    const database = record?.spec.database;
    if (record === undefined || database == null) {
      throw new Error("Expected a stored database");
    }
    const sealed = (value: string) => context.deps.secrets.seal(value, "database-password");
    saveServiceSpec(
      context.deps.db,
      PROJECT,
      "db",
      {
        ...record.spec,
        database: {
          ...database,
          rotation: {
            from: { sealedPassword: database.sealedPassword, sealedRootPassword: null },
            to: { sealedPassword: sealed("new-pass"), sealedRootPassword: null },
          },
        },
      },
      new Date(),
    );
    scriptExec(context, ({ options }) =>
      options.env?.includes("PGPASSWORD=new-pass") === true
        ? { exitCode: 0, output: "opsifier-ok\n" }
        : { exitCode: 2, output: "FATAL\n" },
    );

    const { recoverInterruptedRotations } = await import("../../databases/rotation");
    recoverInterruptedRotations(context.deps);
    await expect
      .poll(() => findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation, { timeout: 3000 })
      .toBeNull();

    expect((await reveal("password")).body.value).toBe("new-pass");
    expect(findService(context.deps.db, PROJECT, "db")?.spec.database?.rotation).toBeNull();
  });

  it("survives redeploys and restarts with the password it was given", async () => {
    await suite.deployed({ engine: "postgres", password: "keepthis" });
    await suite.run(`${suite.service()}/deploy`);
    await suite.run(`${suite.service()}/restart`);

    expect((await reveal("password")).body.value).toBe("keepthis");
  });

  it("does not expose the rotation state's values anywhere it reports it", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass" });
    scriptExec(context, ({ stdin }) =>
      stdin.includes("ALTER ROLE")
        ? { exitCode: 1, output: "ERROR: refused\n" }
        : { exitCode: 2, output: "FATAL: nothing works\n" },
    );
    await suite.run(credentialsPath(), "PUT", { password: "new-pass" });

    const body = JSON.stringify(await credentials());
    expect(body).not.toContain("new-pass");
    expect(body).not.toContain("old-pass");
    expect(JSON.stringify((await suite.api<ServiceDetail>(suite.service())).body)).not.toContain("new-pass");
    expect(JSON.stringify((await suite.api<ProjectList>("/projects")).body)).not.toContain("new-pass");
  });
});
