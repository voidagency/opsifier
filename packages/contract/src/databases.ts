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
    defaultImage: "postgres:18.6",
    defaultUser: "postgres",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: false,
    port: 5432,
    dataPath: "/var/lib/postgresql/data",
  },
  mysql: {
    defaultImage: "mysql:9.7.4",
    defaultUser: "mysql",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: true,
    port: 3306,
    dataPath: "/var/lib/mysql",
  },
  mariadb: {
    defaultImage: "mariadb:11.8.9",
    defaultUser: "mariadb",
    customUser: true,
    hasDatabaseName: true,
    hasRootPassword: true,
    port: 3306,
    dataPath: "/var/lib/mysql",
  },
  mongo: {
    defaultImage: "mongo:8.3.13",
    defaultUser: "mongo",
    customUser: true,
    hasDatabaseName: false,
    hasRootPassword: false,
    port: 27017,
    dataPath: "/data/db",
  },
  redis: {
    defaultImage: "redis:7.4.8",
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

/** Shown when an image could change on its own, the next time it is pulled. */
export const databaseImageRule = "Use a fixed version such as postgres:18.6, or pin it with a digest";

const FIXED_VERSION_TAG = /^v?\d+\.\d+/;

/** The tag of an image reference. Null for a bare name or a digest with no tag. */
function imageTagOf(reference: string): string | null {
  const name = reference.split("@", 1)[0] ?? "";
  const last = name.split("/").at(-1) ?? "";
  const colon = last.lastIndexOf(":");
  return colon === -1 ? null : last.slice(colon + 1);
}

/** Everything before the tag and the digest. */
function imageRepositoryOf(reference: string): string {
  const name = reference.split("@", 1)[0] ?? "";
  const tag = imageTagOf(name);
  return tag === null ? name : name.slice(0, -(tag.length + 1));
}

/**
 * `postgres:18.6`, `postgres:18.6-alpine` and a digest name one version. `latest`, no tag and a bare
 * major such as `postgres:18` are names for whatever comes next, so the engine could change under the
 * data at any pull. Only a digest or a tag with at least a major and a minor number stays put.
 */
export function isFixedDatabaseImage(reference: string): boolean {
  if (reference.includes("@sha256:")) {
    return true;
  }
  const tag = imageTagOf(reference);
  return tag !== null && FIXED_VERSION_TAG.test(tag);
}

/** The image of a new database, which must not move by itself. */
export const fixedDatabaseImage = imageReference.refine(isFixedDatabaseImage, databaseImageRule);

/** The major version a tag names. Null when the reference does not say, as with a digest alone. */
export function imageMajorVersion(reference: string): number | null {
  const tag = imageTagOf(reference);
  const major = tag === null ? undefined : /^v?(\d+)/.exec(tag)?.[1];
  return major === undefined ? null : Number(major);
}

/**
 * Whether moving from one image to another may need the engine's data to be migrated. A difference
 * in the major number is one, and so is anything that can't be compared: another repository, or a
 * tag or digest that does not say which major version it is. Only the same major of the same image
 * is known to read the same files.
 */
export function isMajorVersionChange(from: string, to: string): boolean {
  if (from === to) {
    return false;
  }
  if (imageRepositoryOf(from) !== imageRepositoryOf(to)) {
    return true;
  }
  const before = imageMajorVersion(from);
  const after = imageMajorVersion(to);
  return before === null || after === null || before !== after;
}

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
  image: optionalText(fixedDatabaseImage),
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
  /** Kept apart on purpose: a newer catalogue default is never a reason to touch a running database. */
  versions: z.object({
    /** What the catalogue offers for new databases of this engine today. */
    proposed: z.string(),
    /** What this database is set to run. */
    configured: z.string(),
    /** What it really ran at its last deployment. Null before there has been one. */
    running: z.object({ image: z.string(), digest: z.string().nullable(), imageId: z.string() }).nullable(),
  }),
});
export type DatabaseDetail = z.infer<typeof databaseDetail>;

/**
 * GET .../database/availability: a process that has started and a server that accepts its credentials
 * are not the same thing, and this says which of the two is true.
 */
export const databaseSignIns = ["accepted", "refused", "unknown"] as const;
export const databaseAvailability = z.object({
  /** Whether a task of this database is running, whatever it may answer. */
  process: z.enum(["running", "not-running"]),
  /** Whether the engine accepted the panel's own credentials just now. */
  signIn: z.enum(databaseSignIns),
  /** The engine's own words, with secrets removed, when it did not accept them or could not be asked. */
  detail: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});
export type DatabaseAvailability = z.infer<typeof databaseAvailability>;

export { imageReference };
