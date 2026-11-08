import { type DatabaseEngine, parseEnvText } from "@opsifier/contract";
import { engineRuntime } from "./engines";

export interface DatabaseEnvInput {
  engine: DatabaseEngine;
  databaseName: string | null;
  user: string;
  password: string;
  rootPassword: string | null;
  /** Variables shared with every service of the project. */
  projectEnv: string;
  /** The Advanced tab's Environment field. */
  serviceEnv: string;
}

/**
 * The engine's own variables, then whatever the project and service add. A managed name
 * anywhere else is dropped here too, in case something older than the save validation wrote it.
 */
export function compileDatabaseEnv(input: DatabaseEnvInput): string[] {
  const runtime = engineRuntime[input.engine];
  const managed = new Set(runtime.managedEnv);
  const extras = [...parseEnvText(input.projectEnv), ...parseEnvText(input.serviceEnv)]
    .filter(({ key }) => !managed.has(key))
    .map(({ key, value }) => `${key}=${value}`);

  return [
    ...runtime.env({
      databaseName: input.databaseName,
      user: input.user,
      password: input.password,
      rootPassword: input.rootPassword,
    }),
    ...extras,
  ];
}

/** The names a saved Environment line may not use on this engine. */
export function managedEnvKeys(engine: DatabaseEngine): readonly string[] {
  return engineRuntime[engine].managedEnv;
}
