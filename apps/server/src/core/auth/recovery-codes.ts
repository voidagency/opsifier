import { randomInt } from "node:crypto";
import { hashToken } from "./credentials";

export const RECOVERY_CODE_COUNT = 10;

/** Crockford's base32 in lowercase, which leaves out the letters easily misread as digits. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const GROUPS = 4;
const GROUP_LENGTH = 4;

function generateCode(): string {
  const group = () =>
    Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return Array.from({ length: GROUPS }, group).join("-");
}

/** One-time codes for a lost authenticator. Each carries 80 random bits. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, generateCode);
}

/** With 80 random bits behind every code, a plain hash is all the storage needs. */
export function hashRecoveryCode(code: string): string {
  return hashToken(code.replace(/[\s-]/g, "").toLowerCase());
}
