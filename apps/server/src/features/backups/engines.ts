import type { BackupFormat, DatabaseBackupScope, DatabaseEngine } from "@opsifier/contract";
import { databaseEngineInfo } from "@opsifier/contract";
import { type ExecPlan, SUCCESS_MARKER } from "../databases/exec";

export interface EngineCredentials {
  user: string;
  password: string;
  rootPassword: string | null;
}

/** A whole server or its accounts: exports of the server itself rather than of one database. */
export interface ServerExportOps {
  format: BackupFormat;
  /** What the file is called after its timestamp. */
  extension: string;
  /** The export is plain text, compressed by the panel as it arrives. */
  gzipInPanel: boolean;
  /** Whether an import stands or falls as one transaction, so that a failed one changes nothing. */
  transactional: boolean;
  /** Each plan writes one part of the export to stdout, in this order. */
  dump(credentials: EngineCredentials, databases: readonly string[]): ExecPlan[];
  /** Reads the export from stdin. */
  restore(credentials: EngineCredentials): ExecPlan;
  /** Prints the size of the data, in bytes. Null where there is too little of it to matter. */
  sizeBytes: ((credentials: EngineCredentials) => ExecPlan) | null;
  /**
   * Rewrites a line of the part of an export that holds accounts, or leaves it out with null. This is
   * how the panel's own account is kept out of a restore: the panel holds that password and nobody
   * else does, so nothing in a backup may change it. `isAccountsEnd` says where that part stops.
   */
  rewriteAccountLine: ((line: string, ownUser: string) => string | null) | null;
  isAccountsEnd?: (line: string) => boolean;
  /** Builds a script from the export's lines, for an engine with no client that reads them directly. */
  restoreFromLines?: (credentials: EngineCredentials, lines: readonly string[]) => ExecPlan;
}

/**
 * An instance export goes into a server of its own first: an empty one on a new volume, with
 * nothing else connected, so that the import never has to work around what is already there.
 */
export interface InstanceExportOps extends ServerExportOps {
  /** What that temporary server is started with instead of its usual environment. */
  isolatedEnv(env: readonly string[]): string[];
  /** Run once the import is done, before the server is put in service. */
  afterImport(credentials: EngineCredentials): ExecPlan | null;
}

export interface EngineBackupOps {
  format: BackupFormat;
  /** What the file is called after its timestamp. */
  extension: string;
  /** The dump is plain text, compressed by the panel as it arrives. */
  gzipInPanel: boolean;
  /** Writes the dump to stdout. */
  dump(credentials: EngineCredentials, databaseName: string): ExecPlan;
  /** Reads the dump from stdin. */
  restore(credentials: EngineCredentials, databaseName: string, sourceName: string | null): ExecPlan;
  /** Prints the server's version. */
  version(credentials: EngineCredentials): ExecPlan;
  /** Prints one user database per line. */
  listDatabases(credentials: EngineCredentials): ExecPlan;
  /** Prints the size of the data, in bytes. */
  sizeBytes(credentials: EngineCredentials, databaseName: string): ExecPlan;
  /**
   * The objects that exist right now, one per line, or null where a failed restore has nothing to
   * clean up after. Used to remove what a failed import created before putting the old data back.
   */
  listObjects: ((credentials: EngineCredentials, databaseName: string) => ExecPlan) | null;
  /** Drops named objects, printing the success marker. */
  dropObjects:
    | ((credentials: EngineCredentials, databaseName: string, names: readonly string[]) => ExecPlan)
    | null;
  /** Whether an import stands or falls as one transaction, so that a failed one changes nothing. */
  transactional: boolean;
  instance: InstanceExportOps;
  accounts: ServerExportOps;
}

const MONGO_PORT = databaseEngineInfo.mongo.port;
/** How long a restore waits for applications to let go of a table before it gives up cleanly. */
const LOCK_TIMEOUT_SECONDS = 300;

const postgresClient = (user: string, databaseName: string): string[] => [
  "psql",
  "-X",
  "-q",
  "-t",
  "-A",
  "-v",
  "ON_ERROR_STOP=1",
  "--username",
  user,
  "--dbname",
  databaseName,
];

const postgresEnv = (password: string): string[] => [`PGPASSWORD=${password}`];

/** Names exactly as `pg_dumpall` writes them: bare when it can, quoted otherwise. */
const POSTGRES_ROLE_NAME = String.raw`("(?:[^"]|"")+"|[^"\s]+)`;
const POSTGRES_CREATE_ROLE = new RegExp(`^CREATE ROLE ${POSTGRES_ROLE_NAME};$`);
const POSTGRES_ALTER_ROLE = new RegExp(`^ALTER ROLE ${POSTGRES_ROLE_NAME} WITH `);

const postgresRoleName = (written: string): string =>
  written.startsWith('"') ? written.slice(1, -1).replaceAll('""', '"') : written;

/**
 * The panel's role is left as it is, and a role that already exists does not stop the import. The
 * dollar-quoted body keeps psql's `\restrict` happy: there is no backslash command in it.
 */
function postgresRoleLine(line: string, ownUser: string): string | null {
  const created = POSTGRES_CREATE_ROLE.exec(line);
  if (created !== null) {
    const written = created[1] as string;
    if (postgresRoleName(written) === ownUser) {
      return null;
    }
    return written.includes("$opsifier$")
      ? line
      : `DO $opsifier$ BEGIN CREATE ROLE ${written}; EXCEPTION WHEN duplicate_object THEN NULL; END $opsifier$;`;
  }
  const altered = POSTGRES_ALTER_ROLE.exec(line);
  return altered !== null && postgresRoleName(altered[1] as string) === ownUser ? null : line;
}

const postgresServerClient = ({ user, password }: EngineCredentials): ExecPlan => ({
  command: ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--username", user, "--dbname", "postgres"],
  env: [
    ...postgresEnv(password),
    `PGOPTIONS=-c client_min_messages=warning -c lock_timeout=${LOCK_TIMEOUT_SECONDS * 1000}`,
  ],
});

const postgres: EngineBackupOps = {
  format: "postgres-sql-gz-v1",
  extension: ".sql.gz",
  gzipInPanel: true,
  transactional: true,
  dump: ({ user, password }, databaseName) => ({
    command: [
      "pg_dump",
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--username",
      user,
      "--dbname",
      databaseName,
    ],
    env: postgresEnv(password),
  }),
  restore: ({ user, password }, databaseName) => ({
    command: ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--username", user, "--dbname", databaseName],
    env: [
      ...postgresEnv(password),
      `PGOPTIONS=-c client_min_messages=warning -c lock_timeout=${LOCK_TIMEOUT_SECONDS * 1000}`,
    ],
  }),
  version: ({ user, password }) => ({
    command: postgresClient(user, "postgres"),
    env: postgresEnv(password),
    stdin: `SHOW server_version;\n\\echo ${SUCCESS_MARKER}\n`,
  }),
  listDatabases: ({ user, password }) => ({
    command: postgresClient(user, "postgres"),
    env: postgresEnv(password),
    stdin: `SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;\n\\echo ${SUCCESS_MARKER}\n`,
  }),
  sizeBytes: ({ user, password }, databaseName) => ({
    command: postgresClient(user, databaseName),
    env: postgresEnv(password),
    stdin: `SELECT pg_database_size(current_database());\n\\echo ${SUCCESS_MARKER}\n`,
  }),
  listObjects: null,
  dropObjects: null,
  instance: {
    format: "postgres-instance-sql-gz-v1",
    extension: ".instance.sql.gz",
    gzipInPanel: true,
    // `CREATE DATABASE` cannot run inside a transaction, which is why this goes to a server of its own.
    transactional: false,
    dump: ({ user, password }) => [
      { command: ["pg_dumpall", "--username", user], env: postgresEnv(password) },
    ],
    restore: postgresServerClient,
    sizeBytes: ({ user, password }) => ({
      command: postgresClient(user, "postgres"),
      env: postgresEnv(password),
      stdin: `SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datallowconn;\n\\echo ${SUCCESS_MARKER}\n`,
    }),
    rewriteAccountLine: postgresRoleLine,
    isAccountsEnd: (line) => line.startsWith("\\connect "),
    // An empty server with nothing but its own `postgres` database, so that the dump can create the rest.
    isolatedEnv: (env) =>
      env.map((line) => (line.startsWith("POSTGRES_DB=") ? "POSTGRES_DB=postgres" : line)),
    afterImport: () => null,
  },
  accounts: {
    format: "postgres-accounts-sql-gz-v1",
    extension: ".accounts.sql.gz",
    gzipInPanel: true,
    transactional: true,
    dump: ({ user, password }) => [
      { command: ["pg_dumpall", "--roles-only", "--username", user], env: postgresEnv(password) },
    ],
    restore: postgresServerClient,
    sizeBytes: null,
    rewriteAccountLine: postgresRoleLine,
  },
};

const mysqlIdentifier = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

/** Everything ahead of this line in an instance export is accounts. It is ours, so nothing else writes it. */
const MYSQL_ACCOUNTS_END = "-- opsifier: end of accounts";

/** The accounts a server starts with, and the panel's own administrator: never part of an export. */
const MYSQL_SYSTEM_ACCOUNTS =
  "user NOT LIKE 'mysql.%' AND user NOT LIKE 'mariadb.%' AND user NOT IN ('root', 'healthcheck', '')";

const MYSQL_SYSTEM_SCHEMAS = "('mysql','information_schema','performance_schema','sys')";

/**
 * A script of fixed text: the only values in it are read back from the server's own account list, and
 * the shell never re-reads what they expand to. Every account comes first, because a grant may name
 * a role, and one that existed before this restore is replaced, so that what it holds is what the
 * backup says.
 */
function mysqlAccountsScript(
  client: string,
  options: { listRoles: string | null; hexPasswords: boolean },
): string {
  const run = `${client} --user=root --batch --skip-column-names --raw --default-character-set=utf8mb4`;
  const hex = options.hexPasswords ? "SET SESSION print_identified_with_as_hex=ON; " : "";
  const listUsers = `SELECT CONCAT(QUOTE(user),'@',QUOTE(host)) FROM mysql.user WHERE ${MYSQL_SYSTEM_ACCOUNTS}${
    options.listRoles === null ? "" : " AND is_role='N'"
  } ORDER BY user, host`;
  return [
    "set -eu",
    `run() { ${run} "$@"; }`,
    `users=$(run -e "${listUsers}")`,
    `roles=$(${options.listRoles === null ? "true" : `run -e "${options.listRoles}"`})`,
    `printf '%s\n' "$roles" | while IFS= read -r role; do`,
    `  [ -n "$role" ] || continue`,
    `  printf 'CREATE ROLE IF NOT EXISTS %s;\n' "$role"`,
    "done",
    // Each result is taken first, so that a failing query stops the script instead of vanishing into a pipe.
    `printf '%s\n' "$users" | while IFS= read -r account; do`,
    `  [ -n "$account" ] || continue`,
    `  printf 'DROP USER IF EXISTS %s;\n' "$account"`,
    `  created=$(run -e "${hex}SHOW CREATE USER $account;")`,
    `  printf '%s\n' "$created" | sed 's/$/;/'`,
    "done",
    `printf '%s\n%s\n' "$users" "$roles" | while IFS= read -r account; do`,
    `  [ -n "$account" ] || continue`,
    `  grants=$(run -e "SHOW GRANTS FOR $account;")`,
    `  printf '%s\n' "$grants" | sed 's/$/;/'`,
    "done",
    `printf '%s\n' '${MYSQL_ACCOUNTS_END}'`,
  ].join("\n");
}

/** Each statement of an accounts export is one line, and each names its account the same two ways. */
const mysqlAccountLine = (line: string, ownUser: string): string | null =>
  line.includes(`\`${ownUser}\`@`) || line.includes(`'${ownUser}'@`) ? null : line;

function mysqlFamily(
  client: string,
  dumpTool: string,
  format: BackupFormat,
  gtidFlag: boolean,
  prefix: "mysql" | "mariadb",
): EngineBackupOps {
  const clientFlags = ["--batch", "--skip-column-names", "--connect-timeout=10", "--user=root"];
  const env = (rootPassword: string | null): string[] => [`MYSQL_PWD=${rootPassword ?? ""}`];
  const query = (rootPassword: string | null, database: string | null, statements: string): ExecPlan => ({
    command: [client, ...clientFlags, ...(database === null ? [] : [`--database=${database}`])],
    env: env(rootPassword),
    stdin: `${statements}\nSELECT '${SUCCESS_MARKER}';\n`,
  });
  const dumpFlags = [
    "--user=root",
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--no-tablespaces",
    "--default-character-set=utf8mb4",
    // Without this a GTID-enabled source writes a statement that fails when imported elsewhere.
    ...(gtidFlag ? ["--set-gtid-purged=OFF"] : []),
  ];
  const accountsPlan = ({ rootPassword }: EngineCredentials): ExecPlan => ({
    command: [
      "/bin/sh",
      "-c",
      mysqlAccountsScript(client, {
        listRoles:
          prefix === "mariadb"
            ? `SELECT QUOTE(user) FROM mysql.user WHERE is_role='Y' AND ${MYSQL_SYSTEM_ACCOUNTS} ORDER BY user`
            : null,
        hexPasswords: prefix === "mysql",
      }),
    ],
    env: env(rootPassword),
  });
  const serverClient = ({ rootPassword }: EngineCredentials): ExecPlan => ({
    command: [
      client,
      "--user=root",
      "--binary-mode=1",
      "--default-character-set=utf8mb4",
      `--init-command=SET SESSION lock_wait_timeout=${LOCK_TIMEOUT_SECONDS};`,
    ],
    env: env(rootPassword),
  });
  const accountsOps = {
    gzipInPanel: true,
    transactional: false,
    restore: serverClient,
    rewriteAccountLine: mysqlAccountLine,
    isAccountsEnd: (line: string) => line === MYSQL_ACCOUNTS_END,
  };

  return {
    format,
    extension: ".sql.gz",
    gzipInPanel: true,
    transactional: false,
    dump: ({ rootPassword }, databaseName) => ({
      command: [dumpTool, ...dumpFlags, "--", databaseName],
      env: env(rootPassword),
    }),
    restore: ({ rootPassword }, databaseName) => ({
      command: [
        client,
        "--user=root",
        "--binary-mode=1",
        "--default-character-set=utf8mb4",
        `--init-command=SET SESSION lock_wait_timeout=${LOCK_TIMEOUT_SECONDS};`,
        `--database=${databaseName}`,
      ],
      env: env(rootPassword),
    }),
    version: ({ rootPassword }) => query(rootPassword, null, "SELECT VERSION();"),
    listDatabases: ({ rootPassword }) =>
      query(
        rootPassword,
        null,
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1;",
      ),
    sizeBytes: ({ rootPassword }, databaseName) =>
      query(
        rootPassword,
        databaseName,
        "SELECT IFNULL(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE();",
      ),
    listObjects: ({ rootPassword }, databaseName) =>
      query(
        rootPassword,
        databaseName,
        "SELECT CONCAT(table_type, '\\t', table_name) FROM information_schema.tables WHERE table_schema = DATABASE();",
      ),
    dropObjects: ({ rootPassword }, databaseName, names) => {
      const statements = names.map((entry) => {
        const [type = "", name = ""] = entry.split("\t");
        return type === "VIEW"
          ? `DROP VIEW IF EXISTS ${mysqlIdentifier(name)};`
          : `DROP TABLE IF EXISTS ${mysqlIdentifier(name)};`;
      });
      return query(rootPassword, databaseName, `SET FOREIGN_KEY_CHECKS = 0;\n${statements.join("\n")}`);
    },
    instance: {
      ...accountsOps,
      format: `${prefix}-instance-sql-gz-v1`,
      extension: ".instance.sql.gz",
      dump: (credentials, databases) => [
        accountsPlan(credentials),
        ...(databases.length === 0
          ? []
          : [
              {
                command: [dumpTool, ...dumpFlags, "--databases", "--", ...databases],
                env: env(credentials.rootPassword),
              },
            ]),
      ],
      sizeBytes: ({ rootPassword }) =>
        query(
          rootPassword,
          null,
          `SELECT IFNULL(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema NOT IN ${MYSQL_SYSTEM_SCHEMAS};`,
        ),
      isolatedEnv: (env) => [...env],
      afterImport: () => null,
    },
    accounts: {
      ...accountsOps,
      format: `${prefix}-accounts-sql-gz-v1`,
      extension: ".accounts.sql.gz",
      dump: (credentials) => [accountsPlan(credentials)],
      sizeBytes: null,
    },
  };
}

const jsString = (value: string): string => JSON.stringify(value);

/** A Mongo shell script that fails if any statement fails, and proves it reached the end. */
const mongoScript = (user: string, password: string, body: string): ExecPlan => ({
  command: ["mongosh", "--quiet", "--norc", `mongodb://127.0.0.1:${MONGO_PORT}/admin`],
  stdin: `try { db.getSiblingDB("admin").auth(${jsString(user)}, ${jsString(password)}); ${body} print(${jsString(SUCCESS_MARKER)}); } catch (error) { print("failed: " + error.message); quit(1); }\n`,
});

function mongoConnectionUri(user: string, password: string): string {
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${MONGO_PORT}/?authSource=admin`;
}

/**
 * `mongodump` and `mongorestore` only take a password on their command line or in a URI. Passing it in
 * the environment and letting a shell expand it keeps it out of Docker's own record of the command,
 * and nothing but this fixed text ever reaches the shell.
 */
const mongoTool = (script: string, env: Record<string, string>): ExecPlan => ({
  command: ["/bin/sh", "-c", script],
  env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
});

const MONGO_SYSTEM_DATABASES = new Set(["admin", "local", "config"]);

/** Prints every account as one line of Extended JSON, read back from the server's own collections. */
const MONGO_ACCOUNTS_DUMP = [
  'const admin = db.getSiblingDB("admin");',
  "admin.auth(process.env.FP_USER, process.env.FP_PASSWORD);",
  'for (const [collection, kind] of [["system.users", "users"], ["system.roles", "roles"]]) {',
  "  admin.getCollection(collection).find().forEach((doc) => print(EJSON.stringify({ c: kind, d: doc }, { relaxed: false })));",
  "}",
].join("\n");

/** Sets the panel's own account on a server that does not ask for one yet. */
const mongoOwnAccount = ({ user, password }: EngineCredentials): ExecPlan => ({
  command: ["mongosh", "--quiet", "--norc", `mongodb://127.0.0.1:${MONGO_PORT}/admin`],
  stdin: `try { const admin = db.getSiblingDB("admin"); const user = ${jsString(user)}; const pwd = ${jsString(password)}; if (admin.getUser(user) === null) { admin.createUser({ user, pwd, roles: [{ role: "root", db: "admin" }] }); } else { admin.changeUserPassword(user, pwd); } print(${jsString(SUCCESS_MARKER)}); } catch (error) { print("failed: " + error.message); quit(1); }\n`,
});

/** Put back one account at a time, leaving out the panel's own. */
function mongoAccountsScript(user: string, password: string, lines: readonly string[]): ExecPlan {
  const docs = lines.flatMap((line) => {
    const entry = JSON.parse(line) as { c: string; d: { user?: string; db?: string } };
    return entry.c === "users" && entry.d.user === user && entry.d.db === "admin"
      ? []
      : [`EJSON.parse(${jsString(line)})`];
  });
  // The system collections accept no writes from anyone: what `mongorestore` itself does goes through this.
  return mongoScript(
    user,
    password,
    [
      'const admin = db.getSiblingDB("admin");',
      'const users = "opsifier_restore_users", roles = "opsifier_restore_roles";',
      "admin.getCollection(users).drop(); admin.getCollection(roles).drop();",
      "admin.createCollection(users); admin.createCollection(roles);",
      `[${docs.join(",")}].forEach((entry) => admin.getCollection(entry.c === "roles" ? roles : users).insertOne(entry.d));`,
      'db.adminCommand({ _mergeAuthzCollections: 1, tempUsersCollection: "admin." + users, tempRolesCollection: "admin." + roles, drop: false, db: "" });',
      "admin.getCollection(users).drop(); admin.getCollection(roles).drop();",
    ].join(" "),
  );
}

const mongo: EngineBackupOps = {
  format: "mongo-archive-v1",
  extension: ".archive.gz",
  gzipInPanel: false,
  transactional: false,
  dump: ({ user, password }, databaseName) =>
    mongoTool('exec mongodump --quiet --uri="$FP_URI" --db="$FP_DB" --archive --gzip', {
      FP_URI: mongoConnectionUri(user, password),
      FP_DB: databaseName,
    }),
  restore: ({ user, password }, databaseName, sourceName) =>
    sourceName !== null && sourceName !== databaseName
      ? mongoTool(
          'exec mongorestore --quiet --uri="$FP_URI" --archive --gzip --drop --stopOnError --nsInclude="$FP_SOURCE" --nsFrom="$FP_SOURCE" --nsTo="$FP_TARGET"',
          {
            FP_URI: mongoConnectionUri(user, password),
            FP_SOURCE: `${sourceName}.*`,
            FP_TARGET: `${databaseName}.*`,
          },
        )
      : mongoTool(
          'exec mongorestore --quiet --uri="$FP_URI" --archive --gzip --drop --stopOnError --nsInclude="$FP_TARGET"',
          {
            FP_URI: mongoConnectionUri(user, password),
            FP_TARGET: `${databaseName}.*`,
          },
        ),
  version: ({ user, password }) => mongoScript(user, password, "print(db.version());"),
  listDatabases: ({ user, password }) =>
    mongoScript(
      user,
      password,
      "db.adminCommand({ listDatabases: 1 }).databases.forEach((entry) => print(entry.name));",
    ),
  sizeBytes: ({ user, password }, databaseName) =>
    mongoScript(user, password, `print(db.getSiblingDB(${jsString(databaseName)}).stats().dataSize);`),
  listObjects: ({ user, password }, databaseName) =>
    mongoScript(
      user,
      password,
      `db.getSiblingDB(${jsString(databaseName)}).getCollectionNames().forEach((name) => print(name));`,
    ),
  dropObjects: ({ user, password }, databaseName, names) =>
    mongoScript(
      user,
      password,
      `const target = db.getSiblingDB(${jsString(databaseName)}); ${names
        .map((name) => `target.getCollection(${jsString(name)}).drop();`)
        .join(" ")}`,
    ),
  instance: {
    format: "mongo-instance-archive-v1",
    extension: ".instance.archive.gz",
    gzipInPanel: false,
    transactional: false,
    dump: ({ user, password }) => [
      mongoTool('exec mongodump --quiet --uri="$FP_URI" --archive --gzip', {
        FP_URI: mongoConnectionUri(user, password),
      }),
    ],
    // The temporary server asks for no account: its passwords come from the backup, and may be old.
    restore: () =>
      mongoTool('exec mongorestore --quiet --uri="$FP_URI" --archive --gzip --stopOnError', {
        FP_URI: `mongodb://127.0.0.1:${MONGO_PORT}/`,
      }),
    sizeBytes: ({ user, password }) =>
      mongoScript(user, password, "print(db.adminCommand({ listDatabases: 1 }).totalSize);"),
    rewriteAccountLine: null,
    isolatedEnv: (env) => env.filter((line) => !line.startsWith("MONGO_INITDB_ROOT_")),
    afterImport: mongoOwnAccount,
  },
  accounts: {
    format: "mongo-accounts-jsonl-gz-v1",
    extension: ".accounts.jsonl.gz",
    gzipInPanel: true,
    transactional: false,
    dump: ({ user, password }) => [
      {
        command: [
          "mongosh",
          "--quiet",
          "--norc",
          `mongodb://127.0.0.1:${MONGO_PORT}/admin`,
          "--eval",
          MONGO_ACCOUNTS_DUMP,
        ],
        env: [`FP_USER=${user}`, `FP_PASSWORD=${password}`],
      },
    ],
    restore: () => {
      throw new Error("Mongo accounts are put back from their lines.");
    },
    sizeBytes: null,
    rewriteAccountLine: null,
    restoreFromLines: ({ user, password }, lines) => mongoAccountsScript(user, password, lines),
  },
};

const engineOps: Partial<Record<DatabaseEngine, EngineBackupOps>> = {
  postgres,
  mysql: mysqlFamily("mysql", "mysqldump", "mysql-sql-gz-v1", true, "mysql"),
  mariadb: mysqlFamily("mariadb", "mariadb-dump", "mariadb-sql-gz-v1", false, "mariadb"),
  mongo,
};

/** The engine's operations for one scope that is not a single database. */
export function serverExportOps(ops: EngineBackupOps, scope: Exclude<DatabaseBackupScope, "database">) {
  return scope === "instance" ? ops.instance : ops.accounts;
}

/** Redis has no database to export: it is the one engine with no Backups tab. */
export function backupOpsFor(engine: DatabaseEngine): EngineBackupOps | null {
  return engineOps[engine] ?? null;
}

export const engineHasBackups = (engine: DatabaseEngine): boolean => backupOpsFor(engine) !== null;

const systemDatabaseFilter = (engine: DatabaseEngine, names: readonly string[]): string[] =>
  engine === "mongo" ? names.filter((name) => !MONGO_SYSTEM_DATABASES.has(name)) : [...names];

export { systemDatabaseFilter };

/** The first number of a version string: 18 from `18.1 (Debian 18.1-1.pgdg120+1)`. */
export function majorVersionOf(version: string): number | null {
  const match = /^\D*(\d+)/.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}
