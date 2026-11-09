import { databaseEngineInfo } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DATABASE_PASSWORD_CONTEXT, DATABASE_ROOT_PASSWORD_CONTEXT } from "../databases/spec";
import { connectionUrl, percentEncode } from "../services/compile/database/connection";
import { findService } from "../services/repo";
import type { ServiceTarget } from "../services/service";
import type { AppServiceSpec } from "../services/spec";
import { TEMPLATE_SECRET_CONTEXT } from "./spec";

/** How a service reaches a database in its own project: the name stays valid in any client's URL parser. */
export const databaseAddress = (project: string, service: string): string => `${project}-${service}`;

/** Thrown when a service refers to something that has been removed: the deploy says so and stops. */
export class MissingReferenceError extends Error {
  override readonly name = "MissingReferenceError";
}

/**
 * Everything `$(secret.x)` and `$(db.x.y)` can stand for in this service's environment. Unsealed only
 * here, and only for the length of one deploy. Nothing that comes back is ever stored.
 */
export function resolveReferences(
  deps: Pick<AppDeps, "db" | "secrets">,
  target: ServiceTarget,
  spec: AppServiceSpec,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, secret] of Object.entries(spec.references.secrets)) {
    resolved[`secret.${name}`] = deps.secrets.unseal(secret.sealed, TEMPLATE_SECRET_CONTEXT);
  }

  for (const [alias, reference] of Object.entries(spec.references.databases)) {
    const record = findService(deps.db, target.projectName, reference.service);
    if (record?.spec.database == null) {
      throw new MissingReferenceError(
        `This service needs the database ${reference.service}, which no longer exists in this project.`,
      );
    }
    const database = record.spec.database;
    const password = deps.secrets.unseal(database.sealedPassword, DATABASE_PASSWORD_CONTEXT);
    resolved[`db.${alias}.password`] = password;
    resolved[`db.${alias}.passwordEncoded`] = percentEncode(password);
    resolved[`db.${alias}.url`] = connectionUrl(
      {
        engine: database.engine,
        host: databaseAddress(target.projectName, reference.service),
        port: databaseEngineInfo[database.engine].port,
        user: database.user,
        databaseName: database.databaseName,
      },
      password,
    );
    if (database.sealedRootPassword !== null) {
      resolved[`db.${alias}.rootPassword`] = deps.secrets.unseal(
        database.sealedRootPassword,
        DATABASE_ROOT_PASSWORD_CONTEXT,
      );
    }
  }
  return resolved;
}
