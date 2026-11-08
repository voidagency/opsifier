import { type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";

export interface EngineEnvInput {
  databaseName: string | null;
  user: string;
  password: string;
  rootPassword: string | null;
}

export interface EngineRuntime {
  /** Its variables, in the order the container receives them. */
  env(input: EngineEnvInput): string[];
  /** The panel sets these: an entry in the Environment field must never replace them. */
  managedEnv: readonly string[];
  /** Null when the image's own start command is what we want. */
  startCommand: string | null;
  /** Readiness, run inside the container. Exec form, so nothing here passes through a shell. */
  health(input: { user: string; databaseName: string | null }): string[];
}

const requireDatabase = (name: string | null): string => {
  if (name === null) {
    throw new Error("This engine needs a database name.");
  }
  return name;
};

const requireRoot = (password: string | null): string => {
  if (password === null) {
    throw new Error("This engine needs a root password.");
  }
  return password;
};

function mysqlFamily(prefix: "MYSQL" | "MARIADB", adminTool: string): EngineRuntime {
  return {
    env: ({ rootPassword, databaseName, user, password }) => [
      `${prefix}_ROOT_PASSWORD=${requireRoot(rootPassword)}`,
      `${prefix}_DATABASE=${requireDatabase(databaseName)}`,
      `${prefix}_USER=${user}`,
      `${prefix}_PASSWORD=${password}`,
    ],
    managedEnv: [
      `${prefix}_ROOT_PASSWORD`,
      `${prefix}_DATABASE`,
      `${prefix}_USER`,
      `${prefix}_PASSWORD`,
      "MYSQL_ROOT_HOST",
    ],
    startCommand: null,
    health: () => ["CMD", adminTool, "ping", "--host=127.0.0.1", "--silent"],
  };
}

const POSTGRES_PORT = databaseEngineInfo.postgres.port;
const MONGO_PORT = databaseEngineInfo.mongo.port;

/** What each engine needs at runtime. Only the compilers and engine scripts look at this table. */
export const engineRuntime: Record<DatabaseEngine, EngineRuntime> = {
  postgres: {
    env: ({ password, user, databaseName }) => [
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_USER=${user}`,
      `POSTGRES_DB=${requireDatabase(databaseName)}`,
      `PGDATA=${databaseEngineInfo.postgres.dataPath}`,
    ],
    managedEnv: ["POSTGRES_PASSWORD", "POSTGRES_USER", "POSTGRES_DB", "PGDATA", "POSTGRES_INITDB_ARGS"],
    startCommand: null,
    health: ({ user, databaseName }) => [
      "CMD",
      "pg_isready",
      "-q",
      "-h",
      "127.0.0.1",
      "-p",
      String(POSTGRES_PORT),
      "-U",
      user,
      "-d",
      requireDatabase(databaseName),
    ],
  },
  mysql: mysqlFamily("MYSQL", "mysqladmin"),
  mariadb: mysqlFamily("MARIADB", "mariadb-admin"),
  mongo: {
    env: ({ user, password }) => [
      `MONGO_INITDB_ROOT_USERNAME=${user}`,
      `MONGO_INITDB_ROOT_PASSWORD=${password}`,
    ],
    managedEnv: ["MONGO_INITDB_ROOT_USERNAME", "MONGO_INITDB_ROOT_PASSWORD"],
    startCommand: null,
    health: () => [
      "CMD",
      "mongosh",
      "--quiet",
      "--norc",
      "--eval",
      "db.adminCommand('ping').ok",
      `mongodb://127.0.0.1:${MONGO_PORT}/test`,
    ],
  },
  redis: {
    env: ({ password }) => [`REDIS_PASSWORD=${password}`],
    managedEnv: ["REDIS_PASSWORD"],
    // The password stays out of the shell's text: it is read from the environment when the server starts.
    startCommand: 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes',
    health: () => [
      "CMD-SHELL",
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning ping | grep -q PONG',
    ],
  },
};

const MYSQL_ENGINES: readonly DatabaseEngine[] = ["mysql", "mariadb"];

export const supportsConfigFile = (engine: DatabaseEngine): boolean => MYSQL_ENGINES.includes(engine);

/** Where MySQL and MariaDB pick up the operator's own settings. */
export const MYSQL_CONFIG_PATH = "/etc/mysql/conf.d/opsifier.cnf";
