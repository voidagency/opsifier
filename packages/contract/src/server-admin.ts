import { z } from "zod";
import { envText } from "./env";
import { MAX_RELEASES_KEPT } from "./service-tabs/deployments";
import { domainHost } from "./service-tabs/domains";

/** The word a person types to confirm each operation. Checked again on the server. */
export const serverConfirmWords = {
  panelRestart: "panel",
  proxyRestart: "proxy",
  reboot: "reboot",
  panelUpdate: "update",
} as const;

export const confirmedRequest = z.strictObject({ confirm: z.string().min(1, "Required") });
export type ConfirmedRequest = z.infer<typeof confirmedRequest>;

export const proxyState = z.enum(["running", "starting", "failing", "missing", "unknown"]);
export type ProxyState = z.infer<typeof proxyState>;

export const dockerEngineWarning = z.enum(["unavailable", "too-old", "swarm-inactive", "unsupported"]);
export type DockerEngineWarning = z.infer<typeof dockerEngineWarning>;

/** What the panel needs from Docker, each one detected rather than assumed from a version number. */
export const dockerFeature = z.enum(["version", "api", "swarm", "overlay", "volumes", "buildx", "compose"]);
export type DockerFeature = z.infer<typeof dockerFeature>;

export const dockerEngine = z.object({
  available: z.boolean(),
  /** Null while Docker is not answering. */
  version: z.string().nullable(),
  apiVersion: z.string().nullable(),
  /** The oldest engine this release of the panel has been tested against. */
  minimumVersion: z.string(),
  /** The Engine API that engine speaks, which is what is checked against what the daemon reports. */
  minimumApiVersion: z.string(),
  swarm: z.string().nullable(),
  /** What this engine can't do that the panel needs. Whatever would use it is refused until it can. */
  missing: z.array(dockerFeature),
  warnings: z.array(dockerEngineWarning),
});
export type DockerEngine = z.infer<typeof dockerEngine>;

/** GET /api/v1/server/overview */
export const serverOverview = z.object({
  hostname: z.string(),
  /** Seconds. Null where the platform does not report it. */
  uptimeSeconds: z.number().min(0).nullable(),
  dailyCleanup: z.boolean(),
  /** How many versions each service keeps for going back to. Each holds an image on this disk. */
  releasesKept: z.number().int().min(1),
  panel: z.object({
    version: z.string(),
    /** False when the panel does not run as the `opsifier` Swarm service, as in development. */
    managed: z.boolean(),
  }),
  proxy: z.object({ state: proxyState }),
  docker: dockerEngine,
});
export type ServerOverview = z.infer<typeof serverOverview>;

/** PUT /api/v1/server/daily-cleanup */
export const saveDailyCleanupRequest = z.strictObject({ enabled: z.boolean() });

/** PUT /api/v1/server/releases-kept */
export const saveReleasesKeptRequest = z.strictObject({
  keep: z.number().int("Must be a whole number").min(1).max(MAX_RELEASES_KEPT),
});

const optionalHost = z.union([domainHost, z.literal("").transform(() => null), z.null()]);

/** GET /api/v1/server/panel-domain */
export const panelDomainSettings = z.object({
  defaultDomain: z.string().nullable(),
  customDomain: z.string().nullable(),
  serveOnIp: z.boolean(),
  /** Where the panel now answers. */
  url: z.string().nullable(),
});
export type PanelDomainSettings = z.infer<typeof panelDomainSettings>;

/** PUT /api/v1/server/panel-domain */
export const savePanelDomainRequest = z.strictObject({
  customDomain: optionalHost,
  serveOnIp: z.boolean(),
});
export type SavePanelDomainRequest = z.input<typeof savePanelDomainRequest>;

/** GET /api/v1/server/service-domain */
export const serviceDomainSettings = z.object({
  defaultDomain: z.string().nullable(),
  customDomain: z.string().nullable(),
});
export type ServiceDomainSettings = z.infer<typeof serviceDomainSettings>;

/** PUT /api/v1/server/service-domain */
export const saveServiceDomainRequest = z.strictObject({ customDomain: optionalHost });
export type SaveServiceDomainRequest = z.input<typeof saveServiceDomainRequest>;

/** GET and PUT /api/v1/server/letsencrypt-email */
export const letsEncryptEmail = z.strictObject({
  email: z.email("Enter a valid email address").max(254, "Must be at most 254 characters"),
});
export type LetsEncryptEmail = z.infer<typeof letsEncryptEmail>;

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_CIDR = /^[0-9a-f:]{2,45}(?:\/\d{1,3})?$/i;

/** A single address or a CIDR range. */
export function isValidCidr(value: string): boolean {
  const v4 = IPV4_CIDR.exec(value);
  if (v4 !== null) {
    const octets = v4.slice(1, 5).map(Number);
    const prefix = v4[5] === undefined ? 32 : Number(v4[5]);
    return octets.every((octet) => octet >= 0 && octet <= 255) && prefix >= 0 && prefix <= 32;
  }
  if (!IPV6_CIDR.test(value) || !value.includes(":")) {
    return false;
  }
  const [address = "", bits] = value.split("/");
  if (bits !== undefined && Number(bits) > 128) {
    return false;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return false;
  }
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  return (
    groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) &&
    (halves.length === 2 ? groups.length < 8 : groups.length === 8)
  );
}

/** GET and PUT /api/v1/server/proxy/trusted-proxies */
export const trustedProxiesSettings = z.strictObject({
  /** Believes forwarded headers from anyone. Only for a proxy that cannot be reached directly. */
  trustAll: z.boolean(),
  entries: z
    .array(z.string().trim().refine(isValidCidr, "Enter an IP address or a CIDR range"))
    .max(1024, "At most 1024 entries"),
});
export type TrustedProxiesSettings = z.infer<typeof trustedProxiesSettings>;

/** GET and PUT /api/v1/server/proxy/custom-config */
export const proxyCustomConfig = z.strictObject({
  yaml: z.string().max(256 * 1024, "This is too long"),
});
export type ProxyCustomConfig = z.infer<typeof proxyCustomConfig>;

/** GET /api/v1/server/proxy/environment. Values may hold API tokens, so only names are listed. */
export const proxyEnvironmentSummary = z.object({ names: z.array(z.string()) });
export type ProxyEnvironmentSummary = z.infer<typeof proxyEnvironmentSummary>;

/** PUT /api/v1/server/proxy/environment and the answer to .../environment/reveal */
export const proxyEnvironment = z.strictObject({ env: envText });
export type ProxyEnvironment = z.infer<typeof proxyEnvironment>;

/** POST /api/v1/server/proxy/dashboard: the password appears here once, and rotates with the proxy. */
export const proxyDashboard = z.object({
  url: z.string(),
  username: z.string(),
  password: z.string(),
});
export type ProxyDashboard = z.infer<typeof proxyDashboard>;

export const proxyDashboardStatus = z.object({ open: z.boolean(), url: z.string().nullable() });
export type ProxyDashboardStatus = z.infer<typeof proxyDashboardStatus>;

export const releaseCheck = z.object({
  current: z.string(),
  /** Null when the check could not be made. */
  latest: z.string().nullable(),
  /** Null when nobody can tell. */
  upToDate: z.boolean().nullable(),
  notes: z.string().nullable(),
  /** Set when the check could not be made, and why. */
  problem: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});
export type ReleaseCheck = z.infer<typeof releaseCheck>;

/** GET /api/v1/server/docker/update */
export const dockerUpdateCheck = releaseCheck.extend({ engine: dockerEngine });
export type DockerUpdateCheck = z.infer<typeof dockerUpdateCheck>;

export const dockerCleanupKinds = ["images", "builder", "system"] as const;
export const dockerCleanupKind = z.enum(dockerCleanupKinds);
export type DockerCleanupKind = z.infer<typeof dockerCleanupKind>;

export const dockerCleanupPath = z.object({ kind: dockerCleanupKind });

export const cleanupItemType = z.enum(["image", "build-cache", "container", "network"]);
export type CleanupItemType = z.infer<typeof cleanupItemType>;

export const cleanupItem = z.object({
  id: z.string(),
  type: cleanupItemType,
  label: z.string(),
  sizeBytes: z.number().min(0).nullable(),
});
export type CleanupItem = z.infer<typeof cleanupItem>;

export const cleanupRetainReason = z.enum(["in-use", "rollback", "shared"]);

/** GET /api/v1/server/docker/cleanup/{kind}: exactly what would be removed, and nothing beyond it. */
export const cleanupPreview = z.object({
  kind: dockerCleanupKind,
  items: z.array(cleanupItem),
  retained: z.array(z.object({ label: z.string(), reason: cleanupRetainReason })),
  /** Things the panel did not create, which no cleanup ever touches. */
  foreignCount: z.number().int().min(0),
  reclaimableBytes: z.number().min(0),
});
export type CleanupPreview = z.infer<typeof cleanupPreview>;

/** POST /api/v1/server/docker/cleanup/{kind}. Only `items` that are still eligible are removed. */
export const runCleanupRequest = z.strictObject({
  confirm: z.string().min(1, "Required"),
  items: z.array(z.string().max(512)).min(1, "Select something to remove").max(5000),
});
export type RunCleanupRequest = z.infer<typeof runCleanupRequest>;

/** GET /api/v1/server/disk */
export const diskUsageQuery = z.strictObject({
  path: z.string().max(4096).default("/"),
});
export type DiskUsageQuery = z.infer<typeof diskUsageQuery>;

export const diskUsageEntry = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.boolean(),
  sizeBytes: z.number().min(0),
});

export const diskUsageListing = z.object({
  /** `host` looks at the whole server through a helper, `data` only at the panel's data directory. */
  scope: z.enum(["host", "data"]),
  path: z.string(),
  parent: z.string().nullable(),
  sizeBytes: z.number().min(0),
  entries: z.array(diskUsageEntry),
  truncated: z.boolean(),
});
export type DiskUsageListing = z.infer<typeof diskUsageListing>;

export const hostConsolePath = "/api/v1/terminal/host";

export const systemLogsTopic = (name: "panel" | "proxy"): string => `system-logs:${name}`;
