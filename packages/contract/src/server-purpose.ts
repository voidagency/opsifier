import { z } from "zod";
import { projectName, resourceName } from "./common";

export const serverPurposes = ["development", "staging", "production"] as const;
export const serverPurpose = z.enum(serverPurposes);
export type ServerPurpose = z.infer<typeof serverPurpose>;

/** Everything but production is protected, and so is a server whose owner has not chosen yet. */
export const isProtectedPurpose = (purpose: ServerPurpose | null): boolean => purpose !== "production";

/** What has to be typed to take a server to production. It states how many domains that opens. */
export const publicConfirmation = (domains: number): string => `PUBLIC ${domains}`;

/** The most a list of exemptions may hold for one service. Exemptions are meant to stay few. */
export const MAX_ALLOWLIST_ENTRIES = 32;

const MAX_ALLOWLIST_VALUE = 256;
const MAX_PASSWORD_BYTES = 72;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const USERNAME = /^[A-Za-z0-9._@-]+$/;
const DIGITS = /^\d{1,3}$/;
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** Broader than this, a range stops being an exemption and becomes a hole. */
const MIN_PREFIX = { 4: 8, 6: 28 } as const;

/**
 * A path a callback or health check uses, exactly, or everything under it when it ends in `/*`.
 * Only unreserved characters: nothing here can end a Traefik rule, and no percent-encoding, because
 * Traefik matches decoded paths. The whole site is not a path someone can exempt.
 */
export function isAllowlistPath(value: string): boolean {
  if (value.length > MAX_ALLOWLIST_VALUE || !value.startsWith("/")) {
    return false;
  }
  const body = value.endsWith("/*") ? value.slice(0, -2) : value;
  if (body === "" || body.toLowerCase() === "/robots.txt") {
    return false;
  }
  return body
    .slice(1)
    .split("/")
    .every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => IPV4_OCTET.test(part))) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

function groupBytes(groups: readonly string[]): number[] {
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

/** Strict on purpose: no embedded IPv4, no zone, one `::` at most. */
function ipv6Bytes(address: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(address) || address.includes(":::")) {
    return null;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const written = [...head, ...tail];
  if (!written.every((group) => HEX_GROUP.test(group))) {
    return null;
  }
  if (halves.length === 1) {
    return written.length === 8 ? groupBytes(written) : null;
  }
  if (written.length > 7) {
    return null;
  }
  return groupBytes([...head, ...Array<string>(8 - written.length).fill("0"), ...tail]);
}

function hostBitsAreZero(bytes: readonly number[], prefix: number): boolean {
  return bytes.every((byte, index) => {
    const networkBits = Math.max(0, Math.min(8, prefix - index * 8));
    return (byte & (0xff >> networkBits)) === 0;
  });
}

/**
 * Why a single address or CIDR range can't be exempted, or null when it can. A network address has
 * no host bits set, so `10.1.2.3/8` is refused instead of quietly meaning something else.
 */
export function allowlistIpProblem(value: string): string | null {
  const invalid = "Enter an IP address or a CIDR range such as 203.0.113.0/24";
  if (value.length > MAX_ALLOWLIST_VALUE) {
    return invalid;
  }
  const [address = "", prefixText, ...rest] = value.split("/");
  if (rest.length > 0) {
    return invalid;
  }
  const ipv4 = ipv4Bytes(address);
  const bytes = ipv4 ?? ipv6Bytes(address);
  if (bytes === null) {
    return invalid;
  }
  if (bytes.every((byte) => byte === 0)) {
    return "This range covers every address";
  }
  const family = ipv4 !== null ? 4 : 6;
  const bits = family === 4 ? 32 : 128;
  if (prefixText === undefined) {
    return null;
  }
  const prefix = DIGITS.test(prefixText) && !/^0\d/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (Number.isNaN(prefix) || prefix > bits) {
    return invalid;
  }
  if (prefix < MIN_PREFIX[family]) {
    return `This range is too broad: use /${MIN_PREFIX[family]} or narrower`;
  }
  return hostBitsAreZero(bytes, prefix) ? null : "Use the first address of the range";
}

export const isAllowlistIp = (value: string): boolean => allowlistIpProblem(value) === null;

const pathValue = z
  .string()
  .trim()
  .refine(isAllowlistPath, "Enter a path such as /healthz, or /hooks/* for everything under it");

const ipValue = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const problem = allowlistIpProblem(value);
    if (problem !== null) {
      context.addIssue({ code: "custom", message: problem });
    }
  });

/** bcrypt ignores whatever comes after its 72nd byte, so a longer password is refused instead. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const protectionUsername = z
  .string()
  .trim()
  .min(1, "Required")
  .max(64, "This is too long")
  .regex(USERNAME, "Use letters, digits, dots, dashes, underscores and @");

export const protectionPassword = z
  .string()
  .min(12, "Must be at least 12 characters long")
  .refine((value) => value.trim() !== "", "Required")
  .refine(
    (value) => utf8Length(value) <= MAX_PASSWORD_BYTES,
    `Must be at most ${MAX_PASSWORD_BYTES} bytes long`,
  );

/** Credentials as they leave the server: only ever in the one response that created them. */
export const shownOnceCredentials = z.object({ username: z.string(), password: z.string() });
export type ShownOnceCredentials = z.infer<typeof shownOnceCredentials>;

/** How a domain stands against the server's purpose. `exposed` is the failure nobody should see. */
export const domainProtection = z.enum(["protected", "exposed", "public"]);
export type DomainProtection = z.infer<typeof domainProtection>;

export const protectedDomain = z.object({
  host: z.string(),
  path: z.string(),
  wildcard: z.boolean(),
  project: z.string(),
  service: z.string(),
  status: domainProtection,
});
export type ProtectedDomain = z.infer<typeof protectedDomain>;

export const protectionProblem = z.object({
  code: z.enum(["no_credentials", "panel_exposed", "unreadable_file"]),
  /** The routing file concerned, when it is one. */
  file: z.string().optional(),
});
export type ProtectionProblem = z.infer<typeof protectionProblem>;

/** GET /api/v1/server-purpose */
export const serverPurposeState = z.object({
  /** Null until the owner has chosen. The server then behaves as non-production. */
  purpose: serverPurpose.nullable(),
  /** False only on production. */
  protection: z.boolean(),
  /** Exposed domains first. */
  domains: z.array(protectedDomain),
  /** Domains the proxy really protects, read back from what it was given. */
  protectedCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  problems: z.array(protectionProblem),
  /** The exact text that moves this server to production right now. */
  confirmation: z.string(),
});
export type ServerPurposeState = z.infer<typeof serverPurposeState>;

/** PUT /api/v1/server-purpose */
export const setServerPurposeRequest = z.object({
  purpose: serverPurpose,
  /** Required to move to production: `PUBLIC <domains>`. */
  confirm: z.string().optional(),
});
export type SetServerPurposeRequest = z.infer<typeof setServerPurposeRequest>;

export const setServerPurposeResult = z.object({
  state: serverPurposeState,
  /** Present once: when the change generated the server's first credentials. */
  credentials: shownOnceCredentials.nullable(),
});
export type SetServerPurposeResult = z.infer<typeof setServerPurposeResult>;

/** One set of credentials as the panel shows it: never with its password or hash. */
export const protectionUser = z.object({
  id: z.string(),
  username: z.string(),
  createdAt: z.iso.datetime(),
});
export type ProtectionUser = z.infer<typeof protectionUser>;

/** GET /api/v1/server-purpose/users */
export const protectionUserList = z.object({ users: z.array(protectionUser) });
export type ProtectionUserList = z.infer<typeof protectionUserList>;

/** POST /api/v1/server-purpose/users: with no password, a strong one is generated and shown once. */
export const createProtectionUserRequest = z.object({
  username: protectionUsername,
  password: protectionPassword.optional(),
});
export type CreateProtectionUserRequest = z.infer<typeof createProtectionUserRequest>;

/** PUT /api/v1/server-purpose/users/{id}: with no password, a strong one is generated and shown once. */
export const updateProtectionUserRequest = z.object({ password: protectionPassword.optional() });
export type UpdateProtectionUserRequest = z.infer<typeof updateProtectionUserRequest>;

export const protectionUserResult = z.object({
  user: protectionUser,
  /** Only a generated password comes back, and only here. */
  credentials: shownOnceCredentials.nullable(),
});
export type ProtectionUserResult = z.infer<typeof protectionUserResult>;

export const protectionUserPath = z.object({ id: z.string().min(1).max(64) });

export const allowlistKinds = ["path", "ip"] as const;
export const allowlistKind = z.enum(allowlistKinds);
export type AllowlistKind = z.infer<typeof allowlistKind>;

const allowlistTarget = z.object({ project: projectName, service: resourceName });

/** POST /api/v1/server-purpose/allowlist */
export const createAllowlistEntryRequest = z.discriminatedUnion("kind", [
  allowlistTarget.extend({ kind: z.literal("path"), value: pathValue }),
  allowlistTarget.extend({ kind: z.literal("ip"), value: ipValue }),
]);
export type CreateAllowlistEntryRequest = z.infer<typeof createAllowlistEntryRequest>;

export const allowlistEntry = z.object({
  id: z.string(),
  project: z.string(),
  service: z.string(),
  kind: allowlistKind,
  value: z.string(),
  createdAt: z.iso.datetime(),
});
export type AllowlistEntry = z.infer<typeof allowlistEntry>;

/** GET /api/v1/server-purpose/allowlist */
export const allowlistState = z.object({
  entries: z.array(allowlistEntry),
  /** What an entry can be added to. */
  services: z.array(allowlistTarget),
});
export type AllowlistState = z.infer<typeof allowlistState>;

export const allowlistEntryPath = z.object({ id: z.string().min(1).max(64) });

export const deletedProtectionItem = z.object({ id: z.string() });
export type DeletedProtectionItem = z.infer<typeof deletedProtectionItem>;
