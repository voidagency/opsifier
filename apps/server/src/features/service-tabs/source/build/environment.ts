import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** What a proxy setting of the Docker CLI's configuration may hold. */
const PROXY_FIELDS = ["httpProxy", "httpsProxy", "noProxy", "ftpProxy", "allProxy"] as const;

/**
 * The `proxies` of a Docker configuration, each daemon's, with nothing but their text fields: the CLI
 * passes them to every build and container it starts.
 */
function proxiesOf(config: unknown): Record<string, Record<string, string>> | null {
  const proxies = (config as { proxies?: unknown } | null)?.proxies;
  if (proxies === null || typeof proxies !== "object" || Array.isArray(proxies)) {
    return null;
  }
  const kept: Record<string, Record<string, string>> = {};
  for (const [daemon, settings] of Object.entries(proxies)) {
    if (settings !== null && typeof settings === "object" && !Array.isArray(settings)) {
      kept[daemon] = Object.fromEntries(
        PROXY_FIELDS.flatMap((field) => {
          const value = (settings as Record<string, unknown>)[field];
          return typeof value === "string" ? [[field, value]] : [];
        }),
      );
    }
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * A build's own Docker configuration, in `dir`: the CLI and pack would otherwise sign in to registries
 * with whatever the panel's own holds, so a build gets one with nothing but the proxies of the panel's
 * (`.docker/config.json` under `home`), and what it pulls is what a registry gives anyone. Its
 * credentials, credential helpers and contexts stay out.
 */
export async function writeBuildDockerConfig(dir: string, home: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  let config: unknown = null;
  try {
    config = JSON.parse(await readFile(join(home, ".docker", "config.json"), "utf8"));
  } catch {
    return;
  }
  const proxies = proxiesOf(config);
  if (proxies !== null) {
    await writeFile(join(dir, "config.json"), JSON.stringify({ proxies }), { mode: 0o600 });
  }
}

/**
 * Names that act on the programs the panel runs for a build or a stack, rather than on what they build.
 * Those programs run as root next to the Docker socket and read their whole environment, which is
 * where a service's own values reach them, so none of these may come from a service:
 *
 * - what steers the tools themselves: Docker, BuildKit, Buildx, Compose and pack, their experimental
 *   switches (Buildx reads a source policy, which can swap any image or frontend, from a file an
 *   `EXPERIMENTAL_` name points at) and where they send traces (`OTEL_`);
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
    "EXPERIMENTAL_.*",
    "OTEL_.*",
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
