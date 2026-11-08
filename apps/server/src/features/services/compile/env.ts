import { parseEnvText } from "@opsifier/contract";

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
}

/**
 * The container's Env, in order: `PORT`, then the project's variables, then the service's.
 * Only these three references are filled in. Any other `$(...)` or `${...}` stays as typed.
 */
export function compileEnv(input: EnvInput): string[] {
  const references: Record<string, string> = {
    PROJECT_NAME: input.project,
    SERVICE_NAME: input.service,
    PRIMARY_DOMAIN: input.primaryHost,
  };
  const substitute = (value: string) =>
    value.replace(
      /\$\((PROJECT_NAME|SERVICE_NAME|PRIMARY_DOMAIN)\)/g,
      (_, name: string) => references[name] ?? "",
    );

  return [
    `PORT=${input.port}`,
    ...(input.gitSha ? [`GIT_SHA=${input.gitSha}`] : []),
    ...[...parseEnvText(input.projectEnv), ...parseEnvText(input.serviceEnv)].map(
      ({ key, value }) => `${key}=${substitute(value)}`,
    ),
  ];
}
