import { z } from "zod";
import { resourceName } from "./common";
import { imageReference } from "./service-tabs/source";

export const databaseEngines = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
export const databaseEngine = z.enum(databaseEngines);
export type DatabaseEngine = z.infer<typeof databaseEngine>;

export const isDatabaseEngine = (value: string): value is DatabaseEngine =>
  (databaseEngines as readonly string[]).includes(value);

export interface DatabaseEngineInfo {
  /** Used when the create form leaves the image empty. */
  defaultImage: string;
  /** Who connects unless the create form names someone else. */
  defaultUser: string;
  /** Redis has one fixed account, so its form has no user field. */
  customUser: boolean;
  /** Mongo and Redis have no database to name. */
  hasDatabaseName: boolean;
  /** MySQL and MariaDB keep a separate administrator account. */
  hasRootPassword: boolean;
  port: number;
  /** Where the named data volume is mounted. */
  dataPath: string;
}

/** Everything specific to an engine that both the forms and the compiler rely on. */
export const databaseEngineInfo: Record<DatabaseEngine, DatabaseEngineInfo> = {
  postgres: {
    defaultImage: "postgres:18",
    defaultUser: "postgres",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: false,
    port: 5432,
    dataPath: "/var/lib/postgresql/data",
  },
  mysql: {
    defaultImage: "mysql:9",
    defaultUser: "mysql",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: true,
    port: 3306,
    dataPath: "/var/lib/mysql",
  },
  mariadb: {
    defaultImage: "mariadb:11",
    defaultUser: "mariadb",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: true,
    port: 3306,
    dataPath: "/var/lib/mysql",
  },
  mongo: {
    defaultImage: "mongo:8",
    defaultUser: "mongo",
    customUser: true,
    hasDatabaseName: false,
    hasRootPassword: false,
    port: 27017,
    dataPath: "/data/db",
  },
  redis: {
    defaultImage: "redis:7",
    defaultUser: "default",
    customUser: false,
    hasDatabaseName: false,
    hasRootPassword: false,
    port: 6379,
    dataPath: "/data",
  },
};

/** Letters, digits, `_` and `-`: all of them are safe unquoted in a connection URL path. */
export const databaseName = z
  .string()
  .max(63, "Must be at most 63 characters")
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, "Use letters, digits, dashes and underscores");

/** MySQL caps account names at 32 characters, the shortest limit of the five engines. */
export const databaseUser = z
  .string()
  .max(32, "Must be at most 32 characters")
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Use letters, digits, dashes, dots and underscores");

/** Set in stone once a real database exists, so what is rejected here never reaches a container. */
export const databasePassword = z
  .string()
  .min(1, "Required")
  .max(256, "Must be at most 256 characters")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Must not contain control characters")
  .refine((value) => value.trim() !== "", "Must not be only spaces");

const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());

/** POST /api/v1/projects/{project}/databases: anything left empty is filled in by the panel. */
export const createDatabaseRequest = z.object({
  name: resourceName,
  engine: databaseEngine,
  databaseName: optionalText(databaseName),
  user: optionalText(databaseUser),
  password: optionalText(databasePassword),
  rootPassword: optionalText(databasePassword),
  image: optionalText(imageReference),
});
export type CreateDatabaseRequest = z.infer<typeof createDatabaseRequest>;

/** Action types of the work a database does beyond deploys. */
export const databaseActionTypes = {
  create: "database.create",
  password: "database.password",
  passwordRecovery: "database.password-recovery",
  expose: "database.expose",
  settings: "database.settings",
  reveal: "database.reveal",
  companionEnable: "database.companion-enable",
  companionDisable: "database.companion-disable",
  companionReveal: "database.companion-reveal",
} as const;

/** GET /api/v1/projects/{project}/services/{service}/database: what the service's page needs to know. */
export const databaseDetail = z.object({
  engine: databaseEngine,
  image: z.string(),
  volume: z.string(),
  exposedPort: z.number().int().min(0).max(65535),
  internalHost: z.string(),
  internalPort: z.number().int(),
});
export type DatabaseDetail = z.infer<typeof databaseDetail>;

export { imageReference };
