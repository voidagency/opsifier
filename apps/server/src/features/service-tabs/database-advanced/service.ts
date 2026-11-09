import {
  type DatabaseAdvancedSettings,
  databaseActionTypes,
  databaseImageRule,
  isFixedDatabaseImage,
  isMajorVersionChange,
  parseEnvText,
  type SaveDatabaseAdvancedFields,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest, conflict } from "../../../core/errors";
import { assertCopyPossible } from "../../databases/major-version";
import { type DatabaseRecord, requireDatabase } from "../../databases/service";
import { managedEnvKeys, supportsConfigFile } from "../../services/compile/database";
import { envNames, openEnv, sealEnv, sealRetired, valuesGone } from "../../services/env-store";
import { saveServiceSpec } from "../../services/repo";
import type { ServiceTarget } from "../../services/service";

const REDIS_PASSWORD_REFERENCE = /requirepass|REDIS_PASSWORD/;

const imageOf = (record: DatabaseRecord): string =>
  record.spec.source?.type === "image" ? record.spec.source.image : "";

function validate(settings: SaveDatabaseAdvancedFields, deps: AppDeps, target: ServiceTarget): void {
  const record = requireDatabase(deps, target);
  const { engine } = record.spec.database;
  const fields: Record<string, string> = {};

  // A database that already runs a floating tag is left alone: only choosing one is refused.
  if (settings.image !== imageOf(record) && !isFixedDatabaseImage(settings.image)) {
    fields.image = databaseImageRule;
  }

  if (engine === "redis" && settings.command !== "" && !REDIS_PASSWORD_REFERENCE.test(settings.command)) {
    fields.command = 'Keep the password in the command, for example --requirepass "$REDIS_PASSWORD"';
  }

  const managed = new Set(managedEnvKeys(engine));
  const taken = parseEnvText(settings.env ?? "").find(({ key }) => managed.has(key));
  if (taken !== undefined) {
    fields.env = `${taken.key} is managed by the panel. Change it from the Credentials tab`;
  }

  if (settings.configFile !== "" && !supportsConfigFile(engine)) {
    fields.configFile = "Only MySQL and MariaDB read a config file";
  }

  if (Object.keys(fields).length > 0) {
    throw badRequest("validation_failed", "Some fields need attention.", fields);
  }
}

export function getAdvanced(deps: AppDeps, target: ServiceTarget): DatabaseAdvancedSettings {
  const record = requireDatabase(deps, target);
  const { source, deploy, sealedEnv, database } = record.spec;
  return {
    image: source?.type === "image" ? source.image : "",
    command: deploy.command ?? "",
    envNames: envNames(openEnv(deps, sealedEnv)),
    configFile: database.configFile,
  };
}

/** Saves only. What this tab changes reaches the database at its next deployment. */
export function saveAdvanced(
  deps: AppDeps,
  target: ServiceTarget,
  settings: SaveDatabaseAdvancedFields,
  actorEmail: string | undefined,
): DatabaseAdvancedSettings {
  validate(settings, deps, target);
  const record = requireDatabase(deps, target);
  const { spec } = record;
  if (isMajorVersionChange(imageOf(record), settings.image)) {
    if (settings.confirm !== target.serviceName) {
      throw conflict(
        "major_version_change",
        `Moving to ${settings.image} changes the database's major version, which may need its data to be migrated. Confirm by typing the name of this service.`,
        { confirm: "Type the name of this service" },
      );
    }
    assertCopyPossible(record);
  }
  const gone =
    settings.env === undefined
      ? []
      : valuesGone(parseEnvText(openEnv(deps, spec.sealedEnv)), parseEnvText(settings.env));
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...spec,
      source: spec.source?.type === "image" ? { ...spec.source, image: settings.image } : spec.source,
      deploy: { ...spec.deploy, command: settings.command === "" ? null : settings.command },
      sealedEnv: settings.env === undefined ? spec.sealedEnv : sealEnv(deps, settings.env),
      sealedRetired: sealRetired(deps, spec.sealedRetired, gone),
      database: { ...spec.database, configFile: settings.configFile },
    },
    new Date(deps.now()),
  );
  deps.actions.record({
    type: databaseActionTypes.settings,
    title: `Update the advanced settings of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return getAdvanced(deps, target);
}
