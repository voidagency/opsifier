import { randomBytes } from "node:crypto";
import type {
  ProxyDashboard,
  ProxyDashboardStatus,
  ProxyEnvironmentSummary,
  ProxyState,
  TrustedProxiesSettings,
} from "@opsifier/contract";
import { parseEnvText } from "@opsifier/contract";
import { compareSync, hashSync } from "bcryptjs";
import { parse as parseYaml } from "yaml";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { SwarmServiceSpec } from "../../core/docker";
import { DockerDriverError } from "../../core/docker";
import { badRequest, conflict } from "../../core/errors";
import {
  type AddressChallenge,
  addressChallengeEnv,
  addressChallengeFor,
} from "../opsifier-address/proxy-env";
import { registeredDomain } from "../opsifier-address/repo";
import { PROXY_SERVICE } from "../projects/network";
import { getSetting, putSetting } from "../system/repo";
import { generatedServiceBase, getLetsEncryptEmail } from "./settings";

const PROXY_SETTINGS_KEY = "proxy_settings";
const CUSTOM_CONFIG_FILE = "_custom.yaml";
const DASHBOARD_FILE = "_dashboard.yaml";
const ENV_CONTEXT = "proxy-environment";
const DASHBOARD_USER = "admin";

interface StoredProxySettings {
  trustAll: boolean;
  entries: string[];
  customConfig: string;
  sealedEnv: string | null;
  dashboardPasswordHash: string | null;
}

function readSettings(deps: Pick<AppDeps, "db">): StoredProxySettings {
  const stored = getSetting(deps.db, PROXY_SETTINGS_KEY) as Partial<StoredProxySettings> | undefined;
  return {
    trustAll: stored?.trustAll === true,
    entries: stored?.entries ?? [],
    customConfig: stored?.customConfig ?? "",
    sealedEnv: stored?.sealedEnv ?? null,
    dashboardPasswordHash: stored?.dashboardPasswordHash ?? null,
  };
}

function writeSettings(deps: AppDeps, changes: Partial<StoredProxySettings>): void {
  putSetting(deps.db, PROXY_SETTINGS_KEY, { ...readSettings(deps), ...changes }, new Date(deps.now()));
}

function unsealEnv(deps: AppDeps, sealed: string | null): string {
  return sealed === null ? "" : deps.secrets.unseal(sealed, ENV_CONTEXT);
}

export function getTrustedProxies(deps: AppDeps): TrustedProxiesSettings {
  const { trustAll, entries } = readSettings(deps);
  return { trustAll, entries };
}

export function getCustomConfig(deps: AppDeps): { yaml: string } {
  return { yaml: readSettings(deps).customConfig };
}

/** Names only: a value in here may be a DNS provider's API token. */
export function getProxyEnvironment(deps: AppDeps): ProxyEnvironmentSummary {
  return {
    names: parseEnvText(unsealEnv(deps, readSettings(deps).sealedEnv)).map((entry) => entry.key),
  };
}

export function revealProxyEnvironment(deps: AppDeps): { env: string } {
  return { env: unsealEnv(deps, readSettings(deps).sealedEnv) };
}

const RESERVED_NAMES =
  /^(TRAEFIK_(PROVIDERS|ENTRYPOINTS)_|TRAEFIK_API(_|$)|TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_)/;
/** The DNS provider's one set of variables is taken for as long as the server has an address. */
const ADDRESS_NAMES = /^HTTPREQ_/;

export function saveProxyEnvironment(
  deps: AppDeps,
  env: string,
  actorEmail: string | undefined,
): ProxyEnvironmentSummary {
  const entries = parseEnvText(env);
  const hasAddress = registeredDomain(deps.db) !== null;
  const reserved = entries.find(
    (entry) => RESERVED_NAMES.test(entry.key) || (hasAddress && ADDRESS_NAMES.test(entry.key)),
  );
  if (reserved !== undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      env: `${reserved.key} is managed by the panel`,
    });
  }
  writeSettings(deps, { sealedEnv: env.trim() === "" ? null : deps.secrets.seal(env, ENV_CONTEXT) });
  deps.actions.record({ type: "proxy.environment", title: "Change the proxy's environment", actorEmail });
  return getProxyEnvironment(deps);
}

export function saveTrustedProxies(
  deps: AppDeps,
  settings: TrustedProxiesSettings,
  actorEmail: string | undefined,
): void {
  writeSettings(deps, { trustAll: settings.trustAll, entries: settings.entries });
  deps.actions.record({
    type: "proxy.trusted-ips",
    title: "Change the proxy's trusted addresses",
    actorEmail,
  });
}

const ALLOWED_CUSTOM_SECTIONS = new Set(["http", "tcp", "udp", "tls"]);

/** Parses what a person wrote, and refuses what would break or impersonate the panel's own routes. */
function assertUsableCustomConfig(yaml: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml, { maxAliasCount: 16 });
  } catch (error) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      yaml: `This is not valid YAML: ${(error as Error).message.split("\n", 1)[0]}`,
    });
  }
  if (parsed === null || parsed === undefined) {
    return;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      yaml: "The configuration must be a YAML mapping",
    });
  }
  const sections = parsed as Record<string, unknown>;
  const unknown = Object.keys(sections).find((key) => !ALLOWED_CUSTOM_SECTIONS.has(key));
  if (unknown !== undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      yaml: `Only http, tcp, udp and tls sections are allowed, not ${unknown}`,
    });
  }
  for (const section of Object.values(sections)) {
    if (typeof section !== "object" || section === null) {
      continue;
    }
    for (const entries of Object.values(section as Record<string, unknown>)) {
      if (typeof entries !== "object" || entries === null) {
        continue;
      }
      const reserved = Object.keys(entries).find((name) => name.startsWith("opsifier-"));
      if (reserved !== undefined) {
        throw badRequest("validation_failed", "Some fields need attention.", {
          yaml: `Names starting with opsifier- are reserved: ${reserved}`,
        });
      }
    }
  }
}

/** Applies at once through the file provider. The file only ever holds valid YAML. */
export async function saveCustomConfig(
  deps: AppDeps,
  yaml: string,
  actorEmail: string | undefined,
): Promise<void> {
  assertUsableCustomConfig(yaml);
  writeSettings(deps, { customConfig: yaml });
  await writeCustomFile(deps);
  deps.actions.record({
    type: "proxy.custom-config",
    title: "Change the proxy's custom configuration",
    actorEmail,
  });
}

async function writeCustomFile(deps: AppDeps): Promise<void> {
  const { customConfig } = readSettings(deps);
  if (customConfig.trim() === "") {
    await deps.proxy.removeOwnFile(CUSTOM_CONFIG_FILE);
  } else {
    await deps.proxy.writeOwnFile(CUSTOM_CONFIG_FILE, customConfig);
  }
}

const traefikDir = (deps: AppDeps) => `${deps.config.dataDir}/traefik`;

/** Where the proxy's task sees the panel's traefik folder, which is mounted under its own path. */
function mountedTraefikDir(deps: AppDeps, spec: SwarmServiceSpec): string {
  const host = traefikDir(deps);
  const mount = spec.TaskTemplate.ContainerSpec.Mounts?.find((candidate) => candidate.Source === host);
  return mount?.Target ?? host;
}

/**
 * Traefik's static configuration, as environment variables: file, arguments and environment are
 * exclusive sources, and only the environment can also carry what people add for DNS challenges.
 */
export function renderProxyEnv(input: {
  directory: string;
  email: string | null;
  trustAll: boolean;
  entries: readonly string[];
  userEnv: string;
  /** Adds the resolver for the server's address. The owner's own variables can't override it. */
  addressChallenge?: AddressChallenge | null;
}): string[] {
  const env: Record<string, string> = {
    TRAEFIK_PROVIDERS_FILE_DIRECTORY: `${input.directory}/dynamic`,
    TRAEFIK_PROVIDERS_FILE_WATCH: "true",
    TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ":80",
    TRAEFIK_ENTRYPOINTS_WEBSECURE_ADDRESS: ":443",
    // No outside calls: the panel keeps Traefik up to date, and nothing reports home.
    TRAEFIK_GLOBAL_CHECKNEWVERSION: "false",
    TRAEFIK_GLOBAL_SENDANONYMOUSUSAGE: "false",
    TRAEFIK_API: "true",
    TRAEFIK_API_DASHBOARD: "true",
    TRAEFIK_PING: "true",
    TRAEFIK_ACCESSLOG: "true",
    TRAEFIK_LOG_LEVEL: "INFO",
    TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_STORAGE: `${input.directory}/acme.json`,
    TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_HTTPCHALLENGE_ENTRYPOINT: "web",
  };
  if (input.email !== null) {
    env.TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL = input.email;
  }
  for (const entryPoint of ["WEB", "WEBSECURE"]) {
    if (input.trustAll) {
      env[`TRAEFIK_ENTRYPOINTS_${entryPoint}_FORWARDEDHEADERS_INSECURE`] = "true";
    } else if (input.entries.length > 0) {
      env[`TRAEFIK_ENTRYPOINTS_${entryPoint}_FORWARDEDHEADERS_TRUSTEDIPS`] = input.entries.join(",");
    }
  }
  for (const entry of parseEnvText(input.userEnv)) {
    env[entry.key] = entry.value;
  }
  if (input.addressChallenge !== undefined && input.addressChallenge !== null) {
    Object.assign(env, addressChallengeEnv(input.directory, input.email, input.addressChallenge));
  }
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

export async function proxyStatus(deps: AppDeps): Promise<ProxyState> {
  let service: Awaited<ReturnType<AppDeps["docker"]["inspectService"]>>;
  try {
    service = await deps.docker.inspectService(PROXY_SERVICE);
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return "unknown";
    }
    throw error;
  }
  if (service === null) {
    return "missing";
  }
  const tasks = await deps.docker.listTasks({ service: PROXY_SERVICE }).catch(() => null);
  if (tasks === null) {
    return "unknown";
  }
  const desired = tasks.filter((task) => task.desiredState === "running");
  if (desired.some((task) => task.state === "running")) {
    return "running";
  }
  return desired.some((task) => task.state === "failed" || task.state === "rejected")
    ? "failing"
    : "starting";
}

/** Rewrites the proxy's configuration and restarts it through its Swarm update counter. */
export function enqueueProxyRestart(
  deps: AppDeps,
  actorEmail: string | undefined,
  reason: string,
): ActionRow {
  return deps.actions.enqueue({
    type: "proxy.restart",
    title: `Restart the proxy: ${reason}`,
    actorEmail,
    run: (ctx) => applyProxy(deps, ctx),
  });
}

async function applyProxy(deps: AppDeps, ctx: ActionContext): Promise<void> {
  const proxy = await deps.docker.inspectService(PROXY_SERVICE);
  if (proxy === null) {
    throw conflict("proxy_missing", "The proxy service is not installed on this server.");
  }
  const settings = readSettings(deps);
  await writeCustomFile(deps);

  const directory = mountedTraefikDir(deps, proxy.spec);
  ctx.log("Applying the proxy's configuration");
  const env = renderProxyEnv({
    directory,
    email: getLetsEncryptEmail(deps),
    trustAll: settings.trustAll,
    entries: settings.entries,
    userEnv: unsealEnv(deps, settings.sealedEnv),
    addressChallenge: addressChallengeFor(deps, directory),
  });

  // Rotates the dashboard's password: a restart should leave nothing valid from before it.
  if (settings.dashboardPasswordHash !== null) {
    writeSettings(deps, { dashboardPasswordHash: null });
    await deps.proxy.removeOwnFile(DASHBOARD_FILE);
    ctx.log("Closed the proxy dashboard");
  }

  const { Args: _args, ...container } = proxy.spec.TaskTemplate.ContainerSpec;
  await deps.docker.updateService(PROXY_SERVICE, {
    ...proxy.spec,
    TaskTemplate: {
      ...proxy.spec.TaskTemplate,
      ContainerSpec: { ...container, Env: env },
      ForceUpdate: (proxy.spec.TaskTemplate.ForceUpdate ?? 0) + 1,
    },
  });
  ctx.log("The proxy is restarting");
}

function dashboardHost(deps: AppDeps): string | null {
  const base = generatedServiceBase(deps);
  return base === null ? null : `proxy.${base}`;
}

export function getDashboardStatus(deps: AppDeps): ProxyDashboardStatus {
  const open = readSettings(deps).dashboardPasswordHash !== null;
  const host = dashboardHost(deps);
  return { open, url: open && host !== null ? `https://${host}/dashboard/` : null };
}

/** Publishes the dashboard on a generated host, behind a password that is shown this once. */
export async function openProxyDashboard(
  deps: AppDeps,
  actorEmail: string | undefined,
): Promise<ProxyDashboard> {
  const host = dashboardHost(deps);
  if (host === null) {
    throw conflict(
      "server_address_unknown",
      "The server's address is unknown, so the dashboard has no host.",
    );
  }
  if ((await proxyStatus(deps)) === "missing") {
    throw conflict("proxy_missing", "The proxy service is not installed on this server.");
  }
  const password = randomBytes(24).toString("base64url");
  const hash = hashSync(password, 10);
  await deps.proxy.writeOwnFile(DASHBOARD_FILE, {
    http: {
      middlewares: {
        "dashboard-auth": { basicAuth: { users: [`${DASHBOARD_USER}:${hash}`], removeHeader: true } },
      },
      routers: {
        dashboard: {
          rule: `Host(\`${host}\`)`,
          entryPoints: ["websecure"],
          service: "api@internal",
          middlewares: ["dashboard-auth"],
          tls: { certResolver: "letsencrypt" },
        },
      },
    },
  });
  writeSettings(deps, { dashboardPasswordHash: hash });
  deps.actions.record({ type: "proxy.dashboard", title: "Open the proxy dashboard", actorEmail });
  return { url: `https://${host}/dashboard/`, username: DASHBOARD_USER, password };
}

export async function closeProxyDashboard(deps: AppDeps, actorEmail: string | undefined): Promise<void> {
  writeSettings(deps, { dashboardPasswordHash: null });
  await deps.proxy.removeOwnFile(DASHBOARD_FILE);
  deps.actions.record({ type: "proxy.dashboard", title: "Close the proxy dashboard", actorEmail });
}

export function verifyDashboardPassword(deps: AppDeps, password: string): boolean {
  const { dashboardPasswordHash } = readSettings(deps);
  return dashboardPasswordHash !== null && compareSync(password, dashboardPasswordHash);
}
