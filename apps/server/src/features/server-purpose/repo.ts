import { allowlistKind, serverPurpose } from "@opsifier/contract";
import { z } from "zod";
import type { DbHandle } from "../../core/db";
import { getSetting, putSetting } from "../system/repo";

const SETTING_KEY = "server_protection";

const storedUser = z.object({
  id: z.string(),
  username: z.string(),
  /** bcrypt, the only form the proxy ever needs. The password itself is never stored. */
  passwordHash: z.string(),
  createdAt: z.iso.datetime(),
});
export type StoredUser = z.infer<typeof storedUser>;

const storedAllowlistEntry = z.object({
  id: z.string(),
  project: z.string(),
  service: z.string(),
  kind: allowlistKind,
  value: z.string(),
  createdAt: z.iso.datetime(),
});
export type StoredAllowlistEntry = z.infer<typeof storedAllowlistEntry>;

const storedProtection = z.object({
  purpose: serverPurpose.nullable(),
  users: z.array(storedUser),
  allowlist: z.array(storedAllowlistEntry),
});
export type ProtectionState = z.infer<typeof storedProtection>;

const STRICTEST: ProtectionState = { purpose: null, users: [], allowlist: [] };

/** Nothing stored, or nothing readable, is the strictest state: no purpose, no credentials, no exemptions. */
export function readProtection(db: DbHandle): ProtectionState {
  const parsed = storedProtection.safeParse(getSetting(db, SETTING_KEY));
  return parsed.success ? parsed.data : STRICTEST;
}

export function saveProtection(db: DbHandle, state: ProtectionState, updatedAt: Date): void {
  putSetting(db, SETTING_KEY, state, updatedAt);
}

/** For the test harness, which runs as production unless a test says otherwise. Never used at runtime. */
export function seedProtection(db: DbHandle, purpose: ProtectionState["purpose"], updatedAt: Date): void {
  saveProtection(db, { ...STRICTEST, purpose }, updatedAt);
}
