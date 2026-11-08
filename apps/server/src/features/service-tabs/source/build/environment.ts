import type { AppDeps } from "../../../../core/context";

/** The only parts of the panel's own environment a build tool gets to see. */
const INHERITED = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // A private certificate authority for a self-hosted Git server.
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/** The environment of the Docker CLI: it finds its plugins under HOME and the daemon through DOCKER_HOST. */
export function dockerCliEnv(deps: Pick<AppDeps, "config">): Record<string, string> {
  const { dockerHost, dockerSocket } = deps.config;
  const host = dockerHost ?? (dockerSocket === undefined ? undefined : `unix://${dockerSocket}`);
  return {
    ...inheritedEnv(),
    HOME: process.env.HOME ?? deps.config.dataDir,
    DOCKER_BUILDKIT: "1",
    ...(host === undefined ? {} : { DOCKER_HOST: host }),
  };
}

/** Variables that steer the build tools themselves, so a service's own must not replace them. */
const RESERVED_NAME = /^(?:PATH|HOME|TMPDIR|DOCKER_.*|BUILDKIT_.*|BUILDX_.*|COMPOSE_.*)$/;

export const isReservedBuildVariable = (name: string): boolean => RESERVED_NAME.test(name);
