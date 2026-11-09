import { type EnvPair, parseEnvText } from "@opsifier/contract";

export interface EnvInput {
  project: string;
  service: string;
  projectEnv: string;
  serviceEnv: string;
  /** Host of the primary domain, empty when the service has none. */
  primaryHost: string;
  /** Target port of the primary domain. */
  port: number;
  /** The commit a build came from, for a service built from Git. */
  gitSha?: string | null;
  /** Unsealed values for `$(secret.x)` and `$(db.x.y)`, resolved once per deploy and never stored. */
  references?: Readonly<Record<string, string>>;
  /** Fills in `$(PROJECT_NAME)`, `$(SERVICE_NAME)` and `$(PRIMARY_DOMAIN)`. A person has to turn this on. */
  interpolate: boolean;
}

/**
 * The project's variables then the service's. A sealed reference this service explicitly carries is
 * filled in, and the three placeholders are only when `interpolate` says so: every other `$(...)` or
 * `${...}` stays exactly as typed.
 */
export function resolveEnvPairs(
  input: Pick<
    EnvInput,
    "project" | "service" | "projectEnv" | "serviceEnv" | "primaryHost" | "references" | "interpolate"
  >,
): EnvPair[] {
  const known: Record<string, string> = {
    PROJECT_NAME: input.project,
    SERVICE_NAME: input.service,
    PRIMARY_DOMAIN: input.primaryHost,
  };
  const sealed = input.references ?? {};
  const fillPlaceholders = (value: string) =>
    input.interpolate
      ? value.replace(
          /\$\((PROJECT_NAME|SERVICE_NAME|PRIMARY_DOMAIN)\)/g,
          (_, name: string) => known[name] ?? "",
        )
      : value;
  const substitute = (value: string) =>
    fillPlaceholders(value).replace(
      /\$\(((?:secret|db)\.[A-Za-z0-9._-]+)\)/g,
      (match, name: string) => sealed[name] ?? match,
    );
  return [...parseEnvText(input.projectEnv), ...parseEnvText(input.serviceEnv)].map(({ key, value }) => ({
    key,
    value: substitute(value),
  }));
}

/** The container's Env, in order: `PORT`, then the project's variables, then the service's. */
export function compileEnv(input: EnvInput): string[] {
  return [
    `PORT=${input.port}`,
    ...(input.gitSha ? [`GIT_SHA=${input.gitSha}`] : []),
    ...resolveEnvPairs(input).map(({ key, value }) => `${key}=${value}`),
  ];
}
