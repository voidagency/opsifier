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

/**
 * Names that act on the programs the panel runs for a build or a stack, rather than on what they build.
 * Those programs run as root next to the Docker socket and read their whole environment, which is
 * where a service's own values reach them, so none of these may come from a service:
 *
 * - what steers the tools themselves: Docker, BuildKit, Buildx, Compose and pack;
 * - what the dynamic loader and the C library read in any process: preloaded libraries, library and
 *   module paths, tunables, allocator hooks, resolver files;
 * - what Go's runtime, Git, SSH, OpenSSL and shells read from the environment, since Compose fetches
 *   remote files with Git and BuildKit forwards an SSH agent;
 * - where a program finds its configuration and trusted certificates.
 *
 * `GIT_SHA` is the panel's own, set for every build from a repository.
 */
const RESERVED_NAME = new RegExp(
  `^(?:${[
    "PATH",
    "HOME",
    "TMPDIR",
    "SHELL",
    "ENV",
    "BASH_ENV",
    "BASH_FUNC_.*",
    "SHELLOPTS",
    "PS4",
    "IFS",
    "DOCKER_.*",
    "BUILDKIT_.*",
    "BUILDX_.*",
    "COMPOSE_.*",
    "PACK_.*",
    "XDG_.*",
    "LD_.*",
    "GLIBC_.*",
    "GCONV_PATH",
    "GETCONF_DIR",
    "HOSTALIASES",
    "LOCALDOMAIN",
    "LOCPATH",
    "MALLOC_.*",
    "NIS_PATH",
    "NLSPATH",
    "NSS_.*",
    "RESOLV_.*",
    "RES_OPTIONS",
    "TZDIR",
    "GODEBUG",
    "GOTRACEBACK",
    "GIT_(?!SHA$).*",
    "SSH_.*",
    "SSL_CERT_.*",
    "SSLKEYLOGFILE",
    "OPENSSL_.*",
    "CURL_.*",
  ].join("|")})$`,
);

export const isReservedBuildVariable = (name: string): boolean => RESERVED_NAME.test(name);
