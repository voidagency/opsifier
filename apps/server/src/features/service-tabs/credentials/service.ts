import { isIP } from "node:net";
import type { DatabaseCredentials, DatabaseSecretName, RevealedSecret } from "@opsifier/contract";
import { databaseActionTypes, databaseEngineInfo } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { conflict } from "../../../core/errors";
import { publishedPort, requireDatabase, unsealSecrets } from "../../databases/service";
import { qualifiedName } from "../../services/compile";
import { type ConnectionTarget, connectionUrl, maskedConnectionUrl } from "../../services/compile/database";
import { listActiveServiceActions, type ServiceRecord } from "../../services/repo";
import type { ServiceTarget } from "../../services/service";
import { getSystemInfo } from "../../system/service";

/**
 * The hostname the panel was reached on, or a stand-in for it. The panel's own origin is the one
 * address a browser is known to be able to reach; a database is exposed on that same machine.
 */
function externalHost(deps: AppDeps, requestHost: string | undefined): string {
  const fromHeader = requestHost === undefined ? "" : requestHost.replace(/:\d+$/, "");
  const bracketless = fromHeader.startsWith("[") ? fromHeader.slice(1, -1) : fromHeader;
  const usable = /^[A-Za-z0-9.-]+$/.test(bracketless) || isIP(bracketless) !== 0;
  if (usable && bracketless !== "") {
    return bracketless;
  }
  return getSystemInfo(deps).serverIp ?? "localhost";
}

async function connectionTargets(
  deps: AppDeps,
  record: ServiceRecord,
  target: ServiceTarget,
  requestHost: string | undefined,
): Promise<{ internal: ConnectionTarget; external: ConnectionTarget | null }> {
  const database = record.spec.database;
  if (database === null) {
    throw new Error("Only a database has connection details.");
  }
  const base = {
    engine: database.engine,
    user: database.user,
    databaseName: database.databaseName,
  };
  const internal: ConnectionTarget = {
    ...base,
    host: qualifiedName(target.projectName, target.serviceName),
    port: databaseEngineInfo[database.engine].port,
  };
  // Only what a deployment has published can be connected to, whatever has been saved since.
  const port = (await publishedPort(deps, target)) ?? database.exposedPort;
  const external: ConnectionTarget | null =
    port === 0 ? null : { ...base, host: externalHost(deps, requestHost), port };
  return { internal, external };
}

const hasActiveWork = (deps: AppDeps, target: ServiceTarget): boolean =>
  listActiveServiceActions(deps.db).some(
    (action) => action.projectName === target.projectName && action.serviceName === target.serviceName,
  );

const endpoint = (connection: ConnectionTarget) => ({
  host: connection.host,
  port: connection.port,
  maskedUrl: maskedConnectionUrl(connection),
});

/** Who connects and how. There is no secret in here to leak. */
export async function getCredentials(
  deps: AppDeps,
  target: ServiceTarget,
  requestHost: string | undefined,
): Promise<DatabaseCredentials> {
  const record = requireDatabase(deps, target);
  const { database } = record.spec;
  const { internal, external } = await connectionTargets(deps, record, target, requestHost);
  return {
    engine: database.engine,
    user: database.user,
    hasRootPassword: database.sealedRootPassword !== null,
    databaseName: database.databaseName,
    internal: endpoint(internal),
    external: external === null ? null : endpoint(external),
    rotationUnresolved: database.rotation !== null && !hasActiveWork(deps, target),
  };
}

const SECRET_LABELS: Record<DatabaseSecretName, string> = {
  password: "password",
  rootPassword: "root password",
  internalUrl: "internal connection URL",
  externalUrl: "external connection URL",
};

/**
 * Reads one secret, and leaves a line in the activity log naming who asked. The only place on
 * the API where a database password or a usable connection URL is ever returned.
 */
export async function revealSecret(
  deps: AppDeps,
  target: ServiceTarget,
  secret: DatabaseSecretName,
  requestHost: string | undefined,
  actorEmail: string | undefined,
): Promise<RevealedSecret> {
  const record = requireDatabase(deps, target);
  const secrets = unsealSecrets(deps, record.spec.database);
  const { internal, external } = await connectionTargets(deps, record, target, requestHost);

  let value: string;
  switch (secret) {
    case "password":
      value = secrets.password;
      break;
    case "rootPassword":
      if (secrets.rootPassword === null) {
        throw conflict("no_root_password", "This engine has no separate root account.");
      }
      value = secrets.rootPassword;
      break;
    case "internalUrl":
      value = connectionUrl(internal, secrets.password);
      break;
    case "externalUrl":
      if (external === null) {
        throw conflict("not_exposed", "This database is not exposed on a public port.");
      }
      value = connectionUrl(external, secrets.password);
      break;
  }

  deps.actions.record({
    type: databaseActionTypes.reveal,
    title: `Reveal the ${SECRET_LABELS[secret]} of ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
  });
  return { value };
}
