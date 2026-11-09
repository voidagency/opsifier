import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "../../core/db";
import { settings } from "../../core/db/schema";
import { getSetting, putSetting } from "../system/repo";

const SETTING_KEY = "opsifier_address";

/** Binds the sealed secret to this one purpose. */
export const ADDRESS_SECRET_CONTEXT = "opsifier-address";

const health = z.enum(["ok", "unreachable", "lost", "disabled"]);
export type AddressHealth = z.infer<typeof health>;

const registered = z.object({
  status: z.literal("registered"),
  id: z.string(),
  domain: z.string(),
  sealedSecret: z.string(),
  ip: z.string().nullable(),
  registeredAt: z.iso.datetime(),
  lastHeartbeatAt: z.iso.datetime().nullable(),
  health,
});
export type RegisteredAddress = z.infer<typeof registered>;

/** Holds a name and a secret that nothing can use until the request is approved. */
const requested = z.object({
  status: z.literal("requested"),
  id: z.string(),
  domain: z.string(),
  sealedSecret: z.string(),
  requestedAt: z.iso.datetime(),
});
export type RequestedAddress = z.infer<typeof requested>;

const stored = z.discriminatedUnion("status", [
  registered,
  requested,
  z.object({
    status: z.literal("refused"),
    at: z.iso.datetime(),
  }),
  z.object({
    /** The address was released, and nothing happens until someone asks for another. */
    status: z.literal("off"),
    at: z.iso.datetime(),
  }),
]);
export type StoredAddress = z.infer<typeof stored>;

/** Nothing stored, or nothing readable, means no address: every name falls back to sslip.io. */
export function readAddress(db: DbHandle): StoredAddress | null {
  const parsed = stored.safeParse(getSetting(db, SETTING_KEY));
  return parsed.success ? parsed.data : null;
}

export function saveAddress(db: DbHandle, address: StoredAddress, updatedAt: Date): void {
  putSetting(db, SETTING_KEY, address, updatedAt);
}

/** Leaves no record of an address at all, as if none had been registered. */
export function forgetAddress(db: DbHandle): void {
  db.delete(settings).where(eq(settings.key, SETTING_KEY)).run();
}

/** The address this server holds, whatever state it is in: what its certificate and routes are for. */
export function registeredDomain(db: DbHandle): string | null {
  const address = readAddress(db);
  return address?.status === "registered" ? address.domain : null;
}

/**
 * The base for names that don't exist yet. An address the service no longer honours is not offered for
 * new names, because they would not resolve.
 */
export function liveAddressDomain(db: DbHandle): string | null {
  const address = readAddress(db);
  return address?.status === "registered" && address.health !== "lost" && address.health !== "disabled"
    ? address.domain
    : null;
}
