import { type DatabaseAdvancedSettings, deployActionType, parseEnvText } from "@opsifier/contract";
import type { ActionRow } from "../../../core/actions";
import type { AppDeps } from "../../../core/context";
import { badRequest } from "../../../core/errors";
import { rolloutDatabase } from "../../databases/rollout";
import { requireDatabase } from "../../databases/service";
import { managedEnvKeys, supportsConfigFile } from "../../services/compile/database";
import { saveServiceSpec } from "../../services/repo";
import type { ServiceTarget } from "../../services/service";

const REDIS_PASSWORD_REFERENCE = /requirepass|REDIS_PASSWORD/;

function validate(settings: DatabaseAdvancedSettings, deps: AppDeps, target: ServiceTarget): void {
  const { engine } = requireDatabase(deps, target).spec.database;
  const fields: Record<string, string> = {};

  if (engine === "redis" && settings.command !== "" && !REDIS_PASSWORD_REFERENCE.test(settings.command)) {
    fields.command = 'Keep the password in the command, for example --requirepass "$REDIS_PASSWORD"';
  }

  const managed = new Set(managedEnvKeys(engine));
  const taken = parseEnvText(settings.env).find(({ key }) => managed.has(key));
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
  const { source, deploy, env, database } = record.spec;
  return {
    image: source?.type === "image" ? source.image : "",
    command: deploy.command ?? "",
    env,
    configFile: database.configFile,
  };
}

/** Saves and applies at once. Whatever this tab changes is only reachable through a new task. */
export function saveAdvanced(
  deps: AppDeps,
  target: ServiceTarget,
  settings: DatabaseAdvancedSettings,
  actorEmail: string | undefined,
): ActionRow {
  validate(settings, deps, target);
  const record = requireDatabase(deps, target);
  const { spec } = record;
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    {
      ...spec,
      source: spec.source?.type === "image" ? { ...spec.source, image: settings.image } : spec.source,
      deploy: { ...spec.deploy, command: settings.command === "" ? null : settings.command },
      env: settings.env,
      database: { ...spec.database, configFile: settings.configFile },
    },
    new Date(deps.now()),
  );
  return deps.actions.enqueue({
    type: deployActionType,
    title: `Apply advanced settings to ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: (ctx) => rolloutDatabase(deps, target, ctx),
  });
}
