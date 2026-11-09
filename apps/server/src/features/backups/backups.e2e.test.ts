import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Backs up and restores against real database engines, in a Docker-in-Docker sandbox. A dump can look
 * right and still fail to import, or import and lose accounts, so nothing here is simulated. Each
 * engine costs an image, so `OPSIFIER_E2E_ENGINES` picks which ones run. Against a panel in the sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3410 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23810 \
 *   OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... OPSIFIER_E2E_ENGINES=postgres,mysql \
 *   bunx vitest run apps/server/src/features/backups/backups.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3410"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "";
const ENGINES = (process.env.OPSIFIER_E2E_ENGINES ?? "postgres,mysql,mariadb,mongo").split(",");
const SUFFIX = Date.now().toString(36);
const PROJECT = `e2e-backups-${SUFFIX}`;
const LONG = 600_000;

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

interface Action {
  id: string;
  status: string;
  error: string | null;
  log?: string;
}

async function finished(action: Action): Promise<Action> {
  for (;;) {
    const current = await api<Action>(`/actions/${action.id}`);
    if (current.status !== "queued" && current.status !== "running") {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function succeeded(action: Action): Promise<Action> {
  const done = await finished(action);
  expect(done.error ?? done.status, done.log).toBe("succeeded");
  return done;
}

/** Only ever the sandbox's daemon: an empty host would fall through to the machine's own. */
function docker(args: readonly string[], input?: string): string {
  if (DOCKER_HOST === "") {
    throw new Error("Set OPSIFIER_E2E_DOCKER_HOST to the sandbox's daemon.");
  }
  return execFileSync("docker", ["-H", DOCKER_HOST, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const containerOf = (service: string): string => {
  const [id = ""] = docker(["ps", "-q", "--filter", `name=${PROJECT}_${service}`]).split("\n");
  expect(id, `no running container for ${service}`).not.toBe("");
  return id;
};

interface Backup {
  id: string;
  scope: string;
  status: string;
  origin: string;
  format: string | null;
}

interface Document {
  backups: Backup[];
}

async function createDatabase(body: Record<string, unknown>): Promise<void> {
  const created = await api<{ activeAction: Action }>(`/projects/${PROJECT}/databases`, "POST", body);
  await succeeded(created.activeAction);
}

const servicePath = (service: string) => `/projects/${PROJECT}/services/${service}`;

async function backupOf(service: string, scope: string, databaseName?: string): Promise<Backup> {
  const config = await api<{ id: string }>(`${servicePath(service)}/backups/configs`, "POST", {
    kind: "database",
    enabled: false,
    schedule: "0 2 * * *",
    retention: null,
    scope,
    ...(databaseName === undefined ? {} : { databaseName }),
    storageProviderId: "local-disk",
    path: `e2e/${SUFFIX}/${service}/${scope}`,
  });
  await succeeded(await api<Action>(`${servicePath(service)}/backups/configs/${config.id}/run`, "POST", {}));
  const { backups } = await api<Document>(`${servicePath(service)}/backups`);
  const latest = backups.find((row) => row.scope === scope && row.origin === "manual");
  expect(latest?.status).toBe("succeeded");
  return latest as Backup;
}

const restore = async (service: string, id: string, confirm: string) =>
  succeeded(await api<Action>(`${servicePath(service)}/backups/${id}/restore`, "POST", { confirm }));

const mysqlRun = (service: string, password: string, sql: string, client = "mysql") =>
  docker(
    ["exec", "-i", "-e", `MYSQL_PWD=${password}`, containerOf(service), client, "-uroot", "-N", "-B"],
    sql,
  );

const signsIn = (service: string, client: string, user: string, password: string): boolean => {
  try {
    docker([
      "exec",
      "-e",
      `MYSQL_PWD=${password}`,
      containerOf(service),
      client,
      "-h127.0.0.1",
      `-u${user}`,
      "-N",
      "-e",
      "SELECT 1",
    ]);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!enabled)("backups against real engines", () => {
  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    await api("/projects", "POST", { name: PROJECT });
  }, LONG);

  afterAll(async () => {
    const detail = await api<{ services: Array<{ name: string }> }>(`/projects/${PROJECT}`).catch(() => null);
    for (const service of detail?.services ?? []) {
      await api<Action>(servicePath(service.name), "DELETE", { confirm: service.name })
        .then(finished)
        .catch(() => undefined);
    }
    await api(`/projects/${PROJECT}`, "DELETE", { confirm: PROJECT }).catch(() => undefined);
  }, LONG);

  describe.runIf(ENGINES.includes("postgres"))("PostgreSQL", () => {
    const psql = (sql: string, database = "shop") =>
      docker(
        [
          "exec",
          "-i",
          containerOf("pg"),
          "psql",
          "-U",
          "owner",
          "-d",
          database,
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        sql,
      );

    beforeAll(async () => {
      await createDatabase({
        name: "pg",
        engine: "postgres",
        image: "postgres:18.6-alpine",
        databaseName: "shop",
        user: "owner",
      });
      psql(`
        CREATE TABLE items (id int primary key, label text);
        INSERT INTO items VALUES (1, 'première'), (2, 'deuxième');
        CREATE ROLE reader LOGIN PASSWORD 'reader-pass';
        CREATE DATABASE analytics OWNER reader;
      `);
      psql("CREATE TABLE events (id int primary key); INSERT INTO events VALUES (10);", "analytics");
    }, LONG);

    it(
      "restores exactly one database, and leaves the other and the roles as they are now (REQ-669)",
      async () => {
        const backup = await backupOf("pg", "database", "shop");
        psql(`UPDATE items SET label = 'later' WHERE id = 1; CREATE ROLE later_role;`);
        psql("INSERT INTO events VALUES (20);", "analytics");

        await restore("pg", backup.id, "shop");

        expect(psql("SELECT label FROM items WHERE id = 1;")).toBe("première");
        expect(psql("SELECT count(*) FROM events;", "analytics")).toBe("2");
        expect(psql("SELECT count(*) FROM pg_roles WHERE rolname = 'later_role';")).toBe("1");
        psql("DROP ROLE later_role;");
        psql("DELETE FROM events WHERE id = 20;", "analytics");
      },
      LONG,
    );

    it(
      "restores users and roles without touching data or the panel's own account (REQ-667)",
      async () => {
        const backup = await backupOf("pg", "accounts");
        expect(backup.format).toBe("postgres-accounts-sql-gz-v1");
        psql(`ALTER ROLE reader PASSWORD 'changed' NOLOGIN; UPDATE items SET label = 'after' WHERE id = 2;`);

        await restore("pg", backup.id, "pg");

        expect(psql("SELECT label FROM items WHERE id = 2;")).toBe("after");
        expect(psql("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'reader';")).toBe("t");
        expect(
          docker([
            "exec",
            "-e",
            "PGPASSWORD=reader-pass",
            containerOf("pg"),
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "reader",
            "-d",
            "postgres",
            "-At",
            "-c",
            "SELECT current_user;",
          ]),
        ).toBe("reader");
        psql("UPDATE items SET label = 'deuxième' WHERE id = 2;");
      },
      LONG,
    );

    it(
      "restores a whole server, with its accounts and the earlier volume kept (REQ-667, REQ-670)",
      async () => {
        const backup = await backupOf("pg", "instance");
        expect(backup.format).toBe("postgres-instance-sql-gz-v1");
        psql("DROP DATABASE analytics;");
        psql(`DROP ROLE reader; UPDATE items SET label = 'wrong';`);
        const before = await api<{ volume: string }>(`${servicePath("pg")}/database`);

        await restore("pg", backup.id, "pg");

        expect(psql("SELECT label FROM items ORDER BY id;")).toBe("première\ndeuxième");
        expect(psql("SELECT count(*) FROM events;", "analytics")).toBe("1");
        expect(psql("SELECT count(*) FROM pg_roles WHERE rolname = 'reader';")).toBe("1");
        const after = await api<{ volume: string }>(`${servicePath("pg")}/database`);
        expect(after.volume).not.toBe(before.volume);
        expect(docker(["volume", "ls", "-q"]).split("\n")).toContain(before.volume);
      },
      LONG,
    );
  });

  describe.runIf(ENGINES.includes("mysql"))("MySQL with GTID on (REQ-679, REQ-680)", () => {
    const ROOT = "root-Passw0rd";

    beforeAll(async () => {
      await createDatabase({
        name: "my",
        engine: "mysql",
        databaseName: "shop",
        user: "appuser",
        password: "app-Passw0rd",
        rootPassword: ROOT,
      });
      await api(`${servicePath("my")}/database-advanced`, "PUT", {
        image: "mysql:9.7.4",
        command: "",
        env: "",
        configFile: "[mysqld]\ngtid_mode=ON\nenforce_gtid_consistency=ON\n",
      });
      await succeeded(await api<Action>(`${servicePath("my")}/deploy`, "POST", {}));
      mysqlRun(
        "my",
        ROOT,
        `SELECT @@gtid_mode;
         CREATE TABLE shop.items (id INT PRIMARY KEY, label VARCHAR(50));
         INSERT INTO shop.items VALUES (1, 'première'), (2, 'deuxième');
         CREATE USER 'reporter'@'%' IDENTIFIED BY 'report-Passw0rd';
         GRANT SELECT ON shop.* TO 'reporter'@'%';`,
      );
      expect(mysqlRun("my", ROOT, "SELECT @@gtid_mode;")).toBe("ON");
    }, LONG);

    it(
      "takes a backup without changing the source's GTID position",
      async () => {
        const before = mysqlRun("my", ROOT, "SELECT @@global.gtid_executed;");
        await backupOf("my", "database", "shop");
        await backupOf("my", "accounts");
        await backupOf("my", "instance");
        expect(mysqlRun("my", ROOT, "SELECT @@global.gtid_executed;")).toBe(before);
      },
      LONG,
    );

    it(
      "imports a database dump on a GTID server, data and users intact",
      async () => {
        const backup = await backupOf("my", "database", "shop");
        mysqlRun("my", ROOT, "DELETE FROM shop.items WHERE id = 1;");

        await restore("my", backup.id, "shop");

        expect(mysqlRun("my", ROOT, "SELECT label FROM shop.items ORDER BY id;")).toBe("première\ndeuxième");
        expect(signsIn("my", "mysql", "reporter", "report-Passw0rd")).toBe(true);
        expect(signsIn("my", "mysql", "appuser", "app-Passw0rd")).toBe(true);
      },
      LONG,
    );

    it(
      "restores accounts and a whole server on GTID, keeping the panel's accounts usable",
      async () => {
        const accounts = await backupOf("my", "accounts");
        mysqlRun("my", ROOT, "DROP USER 'reporter'@'%';");
        await restore("my", accounts.id, "my");
        expect(signsIn("my", "mysql", "reporter", "report-Passw0rd")).toBe(true);
        expect(signsIn("my", "mysql", "appuser", "app-Passw0rd")).toBe(true);

        const instance = await backupOf("my", "instance");
        mysqlRun("my", ROOT, "DROP DATABASE shop;");
        await restore("my", instance.id, "my");
        expect(mysqlRun("my", ROOT, "SELECT label FROM shop.items ORDER BY id;")).toBe("première\ndeuxième");
        expect(signsIn("my", "mysql", "reporter", "report-Passw0rd")).toBe(true);
        expect(mysqlRun("my", ROOT, "SELECT @@gtid_mode;")).toBe("ON");
      },
      LONG,
    );
  });

  describe.runIf(ENGINES.includes("mariadb"))("MariaDB", () => {
    const ROOT = "root-Passw0rd";

    beforeAll(async () => {
      await createDatabase({
        name: "ma",
        engine: "mariadb",
        databaseName: "shop",
        user: "appuser",
        password: "app-Passw0rd",
        rootPassword: ROOT,
      });
      mysqlRun(
        "ma",
        ROOT,
        `CREATE TABLE shop.items (id INT PRIMARY KEY, label VARCHAR(50));
         INSERT INTO shop.items VALUES (1, 'première');
         CREATE USER 'reporter'@'%' IDENTIFIED BY 'report-Passw0rd';
         CREATE ROLE readonly_role;
         GRANT SELECT ON shop.* TO readonly_role;
         GRANT readonly_role TO 'reporter'@'%';`,
        "mariadb",
      );
    }, LONG);

    it(
      "restores accounts and a whole server",
      async () => {
        const accounts = await backupOf("ma", "accounts");
        mysqlRun("ma", ROOT, "DROP USER 'reporter'@'%'; DROP ROLE readonly_role;", "mariadb");
        await restore("ma", accounts.id, "ma");
        expect(signsIn("ma", "mariadb", "reporter", "report-Passw0rd")).toBe(true);
        expect(
          mysqlRun("ma", ROOT, "SELECT count(*) FROM mysql.user WHERE user = 'readonly_role';", "mariadb"),
        ).toBe("1");

        const instance = await backupOf("ma", "instance");
        mysqlRun("ma", ROOT, "DROP DATABASE shop;", "mariadb");
        await restore("ma", instance.id, "ma");
        expect(mysqlRun("ma", ROOT, "SELECT label FROM shop.items;", "mariadb")).toBe("première");
        expect(signsIn("ma", "mariadb", "appuser", "app-Passw0rd")).toBe(true);
      },
      LONG,
    );
  });

  describe.runIf(ENGINES.includes("mongo"))("MongoDB", () => {
    const shell = (script: string, user = "root1", password = "mongo-Passw0rd") =>
      docker([
        "exec",
        "-i",
        containerOf("mo"),
        "mongosh",
        "--quiet",
        "--norc",
        "-u",
        user,
        "-p",
        password,
        "--authenticationDatabase",
        "admin",
        "--eval",
        script,
      ]);

    beforeAll(async () => {
      await createDatabase({ name: "mo", engine: "mongo", user: "root1", password: "mongo-Passw0rd" });
      shell(`
        db.getSiblingDB("shop").items.insertMany([{ _id: 1, label: "première" }, { _id: 2, label: "deuxième" }]);
        db.getSiblingDB("admin").createUser({ user: "reporter", pwd: "report-Passw0rd", roles: [{ role: "read", db: "shop" }] });
      `);
    }, LONG);

    it(
      "restores accounts and a whole server, and the panel still gets in after a password change",
      async () => {
        const accounts = await backupOf("mo", "accounts");
        expect(accounts.format).toBe("mongo-accounts-jsonl-gz-v1");
        shell(`db.getSiblingDB("admin").dropUser("reporter");`);
        await restore("mo", accounts.id, "mo");
        expect(
          shell(`print(db.getSiblingDB("shop").items.countDocuments());`, "reporter", "report-Passw0rd"),
        ).toBe("2");

        const instance = await backupOf("mo", "instance");
        expect(instance.format).toBe("mongo-instance-archive-v1");
        await succeeded(
          await api<Action>(`${servicePath("mo")}/credentials`, "PUT", { password: "rotated-Passw0rd" }),
        );
        shell(`db.getSiblingDB("shop").items.deleteOne({ _id: 1 });`, "root1", "rotated-Passw0rd");

        await restore("mo", instance.id, "mo");

        expect(
          shell(`print(db.getSiblingDB("shop").items.countDocuments());`, "root1", "rotated-Passw0rd"),
        ).toBe("2");
      },
      LONG,
    );
  });
});
