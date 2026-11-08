import type { DatabaseEngine } from "@opsifier/contract";
import { databaseEngineInfo } from "@opsifier/contract";
import { type ExecPlan, SUCCESS_MARKER } from "./exec";

export interface OpsCredentials {
  password: string;
  /** Only MySQL and MariaDB have a separate administrator. */
  rootPassword: string | null;
}

/** What a script needs to know about the service it runs in. */
export interface OpsTarget {
  /** The Swarm service name, as other tasks reach it. */
  host: string;
  user: string;
  databaseName: string | null;
}

export interface EngineOps {
  /**
   * Signs in with `login` and sets every account to `desired`. Null when the running server keeps no
   * password of its own: Redis takes it from the environment at startup, so a rollout is the change.
   */
  change: ((target: OpsTarget, login: OpsCredentials, desired: OpsCredentials) => ExecPlan) | null;
  /** Each plan succeeds only if one account's password is really accepted. */
  probe(target: OpsTarget, credentials: OpsCredentials): ExecPlan[];
}

/** E'...' keeps a backslash literal whatever `standard_conforming_strings` is set to. */
const postgresLiteral = (value: string): string =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const postgresIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const POSTGRES_PORT = databaseEngineInfo.postgres.port;
const MYSQL_PORT = databaseEngineInfo.mysql.port;
const MONGO_PORT = databaseEngineInfo.mongo.port;
const REDIS_PORT = databaseEngineInfo.redis.port;

const postgres: EngineOps = {
  change: ({ user, databaseName }, login, desired) => ({
    // Through the local socket, where the image's trust rule lets the rotation run even mid-change.
    command: ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", databaseName ?? user],
    env: [`PGPASSWORD=${login.password}`],
    stdin:
      `ALTER ROLE ${postgresIdentifier(user)} WITH PASSWORD ${postgresLiteral(desired.password)};\n` +
      `\\echo ${SUCCESS_MARKER}\n`,
  }),
  // Over the network, never through the socket or loopback, where the image trusts everyone.
  probe: ({ host, user, databaseName }, { password }) => [
    {
      command: [
        "psql",
        "-X",
        "-q",
        "-w",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        host,
        "-p",
        String(POSTGRES_PORT),
        "-U",
        user,
        "-d",
        databaseName ?? user,
      ],
      env: [`PGPASSWORD=${password}`, "PGCONNECT_TIMEOUT=5"],
      stdin: `SELECT 1;\n\\echo ${SUCCESS_MARKER}\n`,
    },
  ],
};

/** Backslash escapes are predictable because the session clears sql_mode first. */
const mysqlLiteral = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

const MYSQL_ROOT_ACCOUNTS = ["'root'@'%'", "'root'@'localhost'"];

function mysqlFamily(client: string): EngineOps {
  const clientFlags = ["--batch", "--skip-column-names", "--connect-timeout=10"];
  return {
    change: ({ user }, login, desired) => {
      const statements = [
        "SET SESSION sql_mode='';",
        `ALTER USER ${mysqlLiteral(user)}@'%' IDENTIFIED BY ${mysqlLiteral(desired.password)};`,
      ];
      if (desired.rootPassword !== null) {
        for (const account of MYSQL_ROOT_ACCOUNTS) {
          statements.push(
            `ALTER USER IF EXISTS ${account} IDENTIFIED BY ${mysqlLiteral(desired.rootPassword)};`,
          );
        }
      }
      statements.push("FLUSH PRIVILEGES;", `SELECT '${SUCCESS_MARKER}';`);
      return {
        // Local socket as root: the only account that can change the others.
        command: [client, "--user=root", ...clientFlags],
        env: [`MYSQL_PWD=${login.rootPassword ?? ""}`],
        stdin: `${statements.join("\n")}\n`,
      };
    },
    probe: ({ user }, { password, rootPassword }) => {
      const check = `SELECT '${SUCCESS_MARKER}';\n`;
      const probes: ExecPlan[] = [
        {
          command: [client, `--host=127.0.0.1`, `--port=${MYSQL_PORT}`, `--user=${user}`, ...clientFlags],
          env: [`MYSQL_PWD=${password}`],
          stdin: check,
        },
      ];
      if (rootPassword !== null) {
        probes.push({
          command: [client, "--user=root", ...clientFlags],
          env: [`MYSQL_PWD=${rootPassword}`],
          stdin: check,
        });
      }
      return probes;
    },
  };
}

const jsString = (value: string): string => JSON.stringify(value);

/** One statement per line would keep going past an error, so everything is one line in a try block. */
const mongoScript = (body: string): string =>
  `try { ${body} print(${jsString(SUCCESS_MARKER)}); } catch (error) { print("failed: " + error.message); quit(1); }\n`;

const mongoAuth = (user: string, password: string): string =>
  `db.getSiblingDB("admin").auth(${jsString(user)}, ${jsString(password)});`;

const mongoClient = (host: string): string[] => [
  "mongosh",
  "--quiet",
  "--norc",
  `mongodb://${host}:${MONGO_PORT}/admin`,
];

const mongo: EngineOps = {
  change: ({ user }, login, desired) => ({
    command: mongoClient("127.0.0.1"),
    stdin: mongoScript(
      `${mongoAuth(user, login.password)} ` +
        `db.getSiblingDB("admin").changeUserPassword(${jsString(user)}, ${jsString(desired.password)});`,
    ),
  }),
  probe: ({ user }, { password }) => [
    { command: mongoClient("127.0.0.1"), stdin: mongoScript(mongoAuth(user, password)) },
  ],
};

const redis: EngineOps = {
  change: null,
  probe: (_target, { password }) => [
    {
      command: ["redis-cli", "--no-auth-warning", "-h", "127.0.0.1", "-p", String(REDIS_PORT)],
      env: [`REDISCLI_AUTH=${password}`],
      stdin: `PING\nECHO ${SUCCESS_MARKER}\n`,
    },
  ],
};

const engineOps: Record<DatabaseEngine, EngineOps> = {
  postgres,
  mysql: mysqlFamily("mysql"),
  mariadb: mysqlFamily("mariadb"),
  mongo,
  redis,
};

export const opsFor = (engine: DatabaseEngine): EngineOps => engineOps[engine];
