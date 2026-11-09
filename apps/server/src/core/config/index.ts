import { BlockList, isIP } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import pkg from "../../../package.json" with { type: "json" };

const PRODUCTION_DATA_DIR = "/var/lib/opsifier";
const DEVELOPMENT_DATA_DIR = ".data";
const DEFAULT_BUILD_TIMEOUT_SECONDS = 60 * 60;
const DEFAULT_BUILDERS_DIR = "/opt/opsifier/builders";
const DOCKER_RELEASES_URL = "https://api.github.com/repos/moby/moby/releases/latest";
/** Replaced at release time: the project's own feed, a JSON file described in `core/config`. */
const PANEL_RELEASES_URL = "https://github.com/voidagency/opsifier/releases/latest/download/release.json";
const DEFAULT_UPDATE_VERIFY_SECONDS = 40;
const NAMES_URL = "https://names.opsifier.dev";

/** The dev server of `apps/web` proxies to us from this origin. Never allowed in production. */
const DEVELOPMENT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema);

const list = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  )
  .optional();

const envSchema = z.object({
  NODE_ENV: optional(z.enum(["development", "test", "production"]).default("development")),
  OPSIFIER_DATA_DIR: optional(z.string().optional()),
  OPSIFIER_HOST: optional(z.union([z.ipv4(), z.ipv6()]).optional()),
  OPSIFIER_PORT: optional(z.coerce.number().int().min(1).max(65535).optional()),
  OPSIFIER_DRIVER: optional(z.enum(["dockerode", "fake"]).optional()),
  OPSIFIER_DOCKER_SOCKET: optional(z.string().optional()),
  DOCKER_HOST: optional(z.string().optional()),
  OPSIFIER_WEB_DIR: optional(z.string().optional()),
  OPSIFIER_ALLOWED_ORIGINS: optional(list),
  OPSIFIER_TRUSTED_PROXIES: optional(list),
  OPSIFIER_SERVER_IP: optional(z.union([z.ipv4(), z.ipv6()]).optional()),
  /** Where Traefik reaches the panel, when that isn't the usual `http://opsifier:3000`. */
  OPSIFIER_PANEL_UPSTREAM: optional(z.url().optional()),
  OPSIFIER_BUILD_TIMEOUT_SECONDS: optional(z.coerce.number().int().min(1).optional()),
  OPSIFIER_BUILDERS_DIR: optional(z.string().optional()),
  OPSIFIER_VERSION: optional(z.string().optional()),
  /** Where the panel learns about new releases of itself. `off` keeps it from asking at all. */
  OPSIFIER_RELEASES_URL: optional(z.union([z.literal("off"), z.url()]).optional()),
  /** How long a new version must keep running before its update counts as a success. */
  OPSIFIER_UPDATE_VERIFY_SECONDS: optional(z.coerce.number().int().min(0).optional()),
  /** The image host operations run from, when the panel is not itself a Swarm service. */
  OPSIFIER_HELPER_IMAGE: optional(z.string().optional()),
  /** Where the panel asks what the newest Docker engine is. */
  OPSIFIER_DOCKER_RELEASES_URL: optional(z.url().optional()),
  /** The address service, the one call home. `off`, or anything that isn't a URL, keeps it from being made. */
  OPSIFIER_NAMES_URL: optional(z.string().optional()),
  /** Where Telegram's API lives. Only ever moved for tests. */
  OPSIFIER_TELEGRAM_API_URL: optional(z.url().optional()),
  OPSIFIER_LOG_LEVEL: optional(
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  ),
});

export type RuntimeEnvironment = "development" | "test" | "production";
export type DriverKind = "dockerode" | "fake";

export interface Config {
  environment: RuntimeEnvironment;
  isProduction: boolean;
  version: string;
  dataDir: string;
  databaseFile: string;
  secretKeyFile: string;
  /** Exists only while no user does. Holding its content is what proves a claim on the panel. */
  setupTokenFile: string;
  actionsDir: string;
  traefikDynamicDir: string;
  host: string;
  port: number;
  driver: DriverKind;
  dockerSocket: string | undefined;
  /** `tcp://host:port` or `unix:///path`, for a daemon other than the local socket. */
  dockerHost: string | undefined;
  webDir: string | undefined;
  /** How long one build step may run before it is killed. */
  buildTimeoutMs: number;
  /** Where versioned builder tools are installed, as `<dir>/<tool>/<version>/<tool>`. */
  buildersDir: string;
  /** The image host operations run from. Undefined means the panel's own running image. */
  helperImage: string | undefined;
  /** Where the panel asks what the newest Docker engine is. */
  dockerReleasesUrl: string;
  /** Where the panel learns about new releases of itself. Null means it never asks. */
  releasesUrl: string | null;
  /** How long a new version must keep running before its update counts as a success. */
  updateVerifyMs: number;
  /** The address service's base URL, with no trailing slash. Null means it is never called. */
  namesUrl: string | null;
  telegramApiUrl: string;
  /** Where Traefik reaches the panel. Undefined means the shared network's default name. */
  panelUpstream: string | undefined;
  /** Origins accepted in addition to the one the request itself was sent to. */
  allowedOrigins: ReadonlySet<string>;
  /** Peers whose X-Forwarded-For header is believed. Empty unless configured. */
  trustedProxies: BlockList;
  serverIp: string | undefined;
  logLevel: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`OPSIFIER_ALLOWED_ORIGINS: "${value}" is not a valid origin.`);
  }
  const bareOrigin = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  if (!bareOrigin || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ConfigError(`OPSIFIER_ALLOWED_ORIGINS: "${value}" must be a scheme and host with no path.`);
  }
  return url.origin;
}

function parseTrustedProxies(entries: readonly string[]): BlockList {
  const blockList = new BlockList();
  for (const entry of entries) {
    const [address = "", prefix, ...rest] = entry.split("/");
    const family = isIP(address);
    if (family === 0 || rest.length > 0) {
      throw new ConfigError(`OPSIFIER_TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range.`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      blockList.addAddress(address, type);
      continue;
    }
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
    if (!(bits >= 0 && bits <= (family === 4 ? 32 : 128))) {
      throw new ConfigError(`OPSIFIER_TRUSTED_PROXIES: "${entry}" has an invalid prefix length.`);
    }
    blockList.addSubnet(address, bits, type);
  }
  return blockList;
}

/** Only http or https and nothing else. A bad value turns this off: it must never be what stops a server. */
function parseNamesUrl(value: string | undefined): string | null {
  if (value === undefined) {
    return NAMES_URL;
  }
  try {
    const url = new URL(value);
    const usable =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    return usable ? url.href.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function chooseDriver(requested: DriverKind | undefined, isProduction: boolean): DriverKind {
  if (isProduction) {
    if (requested === "fake") {
      throw new ConfigError("OPSIFIER_DRIVER=fake is for development and tests. Production needs Docker.");
    }
    return "dockerode";
  }
  return requested ?? "fake";
}

/** Reads the environment once at boot. Every problem is reported together. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment: ${details}`);
  }

  const values = parsed.data;
  const environment = values.NODE_ENV;
  const isProduction = environment === "production";
  const dataDir = resolve(
    values.OPSIFIER_DATA_DIR ?? (isProduction ? PRODUCTION_DATA_DIR : DEVELOPMENT_DATA_DIR),
  );
  const configuredOrigins = (values.OPSIFIER_ALLOWED_ORIGINS ?? []).map(parseOrigin);

  return {
    environment,
    isProduction,
    version: values.OPSIFIER_VERSION ?? pkg.version,
    dataDir,
    databaseFile: join(dataDir, "opsifier.db"),
    secretKeyFile: join(dataDir, "secret.key"),
    setupTokenFile: join(dataDir, "setup-token"),
    actionsDir: join(dataDir, "actions"),
    traefikDynamicDir: join(dataDir, "traefik", "dynamic"),
    host: values.OPSIFIER_HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
    port: values.OPSIFIER_PORT ?? 3000,
    driver: chooseDriver(values.OPSIFIER_DRIVER, isProduction),
    dockerSocket: values.OPSIFIER_DOCKER_SOCKET,
    dockerHost: values.DOCKER_HOST,
    webDir: values.OPSIFIER_WEB_DIR === undefined ? undefined : resolve(values.OPSIFIER_WEB_DIR),
    buildTimeoutMs: (values.OPSIFIER_BUILD_TIMEOUT_SECONDS ?? DEFAULT_BUILD_TIMEOUT_SECONDS) * 1000,
    buildersDir: resolve(values.OPSIFIER_BUILDERS_DIR ?? DEFAULT_BUILDERS_DIR),
    helperImage: values.OPSIFIER_HELPER_IMAGE,
    dockerReleasesUrl: values.OPSIFIER_DOCKER_RELEASES_URL ?? DOCKER_RELEASES_URL,
    releasesUrl:
      values.OPSIFIER_RELEASES_URL === "off" ? null : (values.OPSIFIER_RELEASES_URL ?? PANEL_RELEASES_URL),
    updateVerifyMs: (values.OPSIFIER_UPDATE_VERIFY_SECONDS ?? DEFAULT_UPDATE_VERIFY_SECONDS) * 1000,
    namesUrl: parseNamesUrl(values.OPSIFIER_NAMES_URL),
    telegramApiUrl: values.OPSIFIER_TELEGRAM_API_URL ?? "https://api.telegram.org",
    panelUpstream: values.OPSIFIER_PANEL_UPSTREAM,
    allowedOrigins: new Set(
      isProduction ? configuredOrigins : [...DEVELOPMENT_ORIGINS, ...configuredOrigins],
    ),
    trustedProxies: parseTrustedProxies(values.OPSIFIER_TRUSTED_PROXIES ?? []),
    serverIp: values.OPSIFIER_SERVER_IP,
    logLevel:
      values.OPSIFIER_LOG_LEVEL ?? (environment === "test" ? "silent" : isProduction ? "info" : "debug"),
  };
}
