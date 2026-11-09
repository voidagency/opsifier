import { z } from "zod";

/** A host name or IP address, written the way `ssh` will be given it. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
] as const;

const hostField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Required")
  .max(253, "This is too long")
  .regex(HOST, "Enter a host name such as git.example.com");

const portField = z.coerce.number().int().min(1, "Between 1 and 65535").max(65535, "Between 1 and 65535");

/** `ssh-ed25519 AAAA...`, or the same with `host` in front, which `known_hosts` and `ssh-keyscan` print. */
export const SSH_PUBLIC_KEY = new RegExp(
  `^(?:[^\\s]+\\s+)?(${SSH_KEY_TYPES.join("|")})\\s+([A-Za-z0-9+/]+=*)(?:\\s.*)?$`,
);

/** One key of one host, as the registry holds it. */
export const knownHost = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  publicKey: z.string(),
  /** As `ssh-keygen -lf` prints it, to compare with what the Git host publishes. */
  fingerprint: z.string(),
  /** Who confirmed this identity. Null for one imported from before the registry existed. */
  addedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type KnownHost = z.infer<typeof knownHost>;

/** GET /api/v1/settings/known-hosts */
export const knownHostList = z.object({ items: z.array(knownHost) });
export type KnownHostList = z.infer<typeof knownHostList>;

/** POST /api/v1/settings/known-hosts */
export const addKnownHostRequest = z.object({
  host: hostField,
  port: portField.default(22),
  publicKey: z
    .string()
    .trim()
    .min(1, "Required")
    .max(16 * 1024, "This is too long")
    .regex(SSH_PUBLIC_KEY, "Paste one public key, such as ssh-ed25519 AAAA..."),
});
export type AddKnownHostRequest = z.infer<typeof addKnownHostRequest>;

/** POST /api/v1/settings/known-hosts/scan */
export const scanKnownHostRequest = z.object({ host: hostField, port: portField.default(22) });
export type ScanKnownHostRequest = z.infer<typeof scanKnownHostRequest>;

export const scannedHostKey = z.object({
  keyType: z.string(),
  publicKey: z.string(),
  fingerprint: z.string(),
});
export type ScannedHostKey = z.infer<typeof scannedHostKey>;

export const scanKnownHostResponse = z.object({ items: z.array(scannedHostKey) });
export type ScanKnownHostResponse = z.infer<typeof scanKnownHostResponse>;

export const knownHostPath = z.object({ id: z.string().min(1).max(64) });
