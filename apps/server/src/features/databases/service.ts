import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  type CreateDatabaseRequest,
  type DatabaseDetail,
  type DatabaseEngine,
  databaseEngineInfo,
  type ServiceDetail,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { badRequest, conflict, notFound } from "../../core/errors";
import { type CompiledService, qualifiedName } from "../services/compile";
import { compileDatabaseService, type DatabaseSecrets } from "../services/compile/database";
import { enqueueDeploy } from "../services/lifecycle";
import { findService, insertService, listServiceRecords, type ServiceRecord } from "../services/repo";
import {
  assertNameFits,
  getServiceDetail,
  requireProject,
  requireService,
  type ServiceTarget,
  serviceDir,
} from "../services/service";
import { appServiceSpec } from "../services/spec";
import { DATABASE_PASSWORD_CONTEXT, DATABASE_ROOT_PASSWORD_CONTEXT, type StoredDatabase } from "./spec";

export type DatabaseRecord = ServiceRecord & {
  spec: ServiceRecord["spec"] & { database: StoredDatabase };
};

const PASSWORD_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const GENERATED_PASSWORD_LENGTH = 20;

/** Twenty characters from a CSPRNG, about 103 bits: strong, and safe in any URL or shell. */
export function generatePassword(): string {
  let password = "";
  for (let index = 0; index < GENERATED_PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

export const isDatabaseRecord = (record: ServiceRecord): record is DatabaseRecord =>
  record.spec.database !== null;

export function requireDatabase(deps: Pick<AppDeps, "db">, target: ServiceTarget): DatabaseRecord {
  const record = requireService(deps, target);
  if (!isDatabaseRecord(record)) {
    throw notFound("This service is not a database.");
  }
  return record;
}

export function sealSecrets(
  deps: Pick<AppDeps, "secrets">,
  secrets: DatabaseSecrets,
): Pick<StoredDatabase, "sealedPassword" | "sealedRootPassword"> {
  return {
    sealedPassword: deps.secrets.seal(secrets.password, DATABASE_PASSWORD_CONTEXT),
    sealedRootPassword:
      secrets.rootPassword === null
        ? null
        : deps.secrets.seal(secrets.rootPassword, DATABASE_ROOT_PASSWORD_CONTEXT),
  };
}

export function unsealSecrets(
  deps: Pick<AppDeps, "secrets">,
  sealed: Pick<StoredDatabase, "sealedPassword" | "sealedRootPassword">,
): DatabaseSecrets {
  return {
    password: deps.secrets.unseal(sealed.sealedPassword, DATABASE_PASSWORD_CONTEXT),
    rootPassword:
      sealed.sealedRootPassword === null
        ? null
        : deps.secrets.unseal(sealed.sealedRootPassword, DATABASE_ROOT_PASSWORD_CONTEXT),
  };
}

/** The Swarm spec of one database, or what `compileService` is for an App. */
export function compileDatabaseRecord(
  deps: Pick<AppDeps, "secrets" | "config" | "db">,
  target: ServiceTarget,
  record: DatabaseRecord,
  forceUpdate: number,
  overrides: { stopped?: boolean } = {},
): CompiledService {
  const project = requireProject(deps, target.projectName);
  return compileDatabaseService({
    project,
    service: {
      name: target.serviceName,
      spec: { ...record.spec, stopped: overrides.stopped ?? record.spec.stopped },
    },
    secrets: unsealSecrets(deps, record.spec.database),
    dataDir: deps.config.dataDir,
    forceUpdate,
  });
}

/** Shown in the console beside sh and bash. Credentials come from the task's own environment. */
const databaseClientName: Record<DatabaseEngine, string> = {
  postgres: "Postgres Client",
  mysql: "MySQL Client",
  mariadb: "MariaDB Client",
  mongo: "MongoDB Shell",
  redis: "Redis Client",
};

const engineClientScript: Record<DatabaseEngine, string> = {
  postgres: 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  mysql: 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" "$MYSQL_DATABASE"',
  mariadb: 'MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb -u"$MARIADB_USER" "$MARIADB_DATABASE"',
  mongo:
    'exec mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin',
  redis: 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli',
};

const MYSQL_SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

function assertFieldsFit(request: CreateDatabaseRequest): void {
  const { engine } = request;
  const info = databaseEngineInfo[engine];
  const fields: Record<string, string> = {};

  if (!info.hasDatabaseName && request.databaseName !== undefined) {
    fields.databaseName = "This engine has no database name to set";
  }
  if (!info.customUser && request.user !== undefined) {
    fields.user = "This engine has one fixed account";
  }
  if (!info.hasRootPassword && request.rootPassword !== undefined) {
    fields.rootPassword = "This engine has no separate root account";
  }
  if (engine === "mysql" || engine === "mariadb") {
    if (request.user === "root") {
      fields.user = "The root account is set by its own password";
    }
    if (request.databaseName !== undefined && MYSQL_SYSTEM_SCHEMAS.includes(request.databaseName)) {
      fields.databaseName = "This name is reserved by the server";
    }
  }
  if (Object.keys(fields).length > 0) {
    throw badRequest("validation_failed", "Some fields need attention.", fields);
  }
}

const volumeBaseName = (project: string, service: string): string =>
  `${qualifiedName(project, service)}_data`;

/**
 * A volume already holding data would give a new database someone else's files and password, so
 * the name has to be free both here and on the Docker daemon.
 */
async function pickVolumeName(deps: AppDeps, project: string, service: string): Promise<string> {
  const taken = new Set(
    listServiceRecords(deps.db).flatMap((record) =>
      record.spec.database === null ? [] : [record.spec.database.volume],
    ),
  );
  const base = volumeBaseName(project, service);
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}_${attempt}`;
    if (!taken.has(candidate) && (await deps.docker.inspectVolume(candidate)) === null) {
      return candidate;
    }
  }
  throw conflict("volume_exists", "No unused volume name is left for this service.", {
    name: "Pick another name",
  });
}

export async function createDatabase(
  deps: AppDeps,
  projectName: string,
  request: CreateDatabaseRequest,
  actorEmail: string | undefined,
): Promise<ServiceDetail> {
  const target = { projectName, serviceName: request.name };
  requireProject(deps, projectName);
  assertNameFits(projectName, request.name);
  assertFieldsFit(request);
  if (findService(deps.db, projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in this project",
    });
  }

  const info = databaseEngineInfo[request.engine];
  const database: StoredDatabase = {
    engine: request.engine,
    databaseName: info.hasDatabaseName ? (request.databaseName ?? projectName) : null,
    user: request.user ?? info.defaultUser,
    ...sealSecrets(deps, {
      password: request.password ?? generatePassword(),
      rootPassword: info.hasRootPassword ? (request.rootPassword ?? generatePassword()) : null,
    }),
    volume: await pickVolumeName(deps, projectName, request.name),
    exposedPort: 0,
    configFile: "",
    companions: {},
    rotation: null,
  };

  const spec = appServiceSpec.parse({
    source: {
      type: "image",
      image: request.image ?? info.defaultImage,
      username: null,
      sealedPassword: null,
    },
    deploy: { replicas: 1, zeroDowntime: false, tiniInit: true },
    scripts: [{ name: databaseClientName[request.engine], script: engineClientScript[request.engine] }],
    database,
  });
  const now = new Date(deps.now());
  deps.db.transaction((tx) => {
    insertService(tx, projectName, request.name, request.engine, spec, now);
  });
  await mkdir(serviceDir(deps, projectName, request.name), { recursive: true, mode: 0o700 });

  deps.actions.record({
    type: "service.create",
    title: `Create ${projectName}/${request.name}`,
    ...target,
    actorEmail,
  });
  // A database has nothing further to configure, so it deploys straight away.
  enqueueDeploy(deps, target, actorEmail);
  return getServiceDetail(deps, target);
}

export function databaseDetail(record: DatabaseRecord): DatabaseDetail {
  const { database, source } = record.spec;
  const info = databaseEngineInfo[database.engine];
  return {
    engine: database.engine,
    image: source?.type === "image" ? source.image : info.defaultImage,
    volume: database.volume,
    exposedPort: database.exposedPort,
    internalHost: qualifiedName(record.projectName, record.name),
    internalPort: info.port,
  };
}
