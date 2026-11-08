import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Null when there is no usable token: nothing has been issued, or the file is not ours. */
function readToken(file: string): string | null {
  try {
    if (!lstatSync(file).isFile()) {
      return null;
    }
    const token = readFileSync(file, "utf8").trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeNewToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // Written aside and renamed, so a reader only ever sees a whole token.
    writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return token;
}

/**
 * The token an unclaimed panel can be set up with. A restart keeps it, so a link already handed
 * to someone stays good. One that others could have read is replaced: nothing depends on it.
 */
export function ensureSetupToken(file: string): string {
  const existing = readToken(file);
  if (existing !== null && (lstatSync(file).mode & 0o077) === 0) {
    return existing;
  }
  return writeNewToken(file);
}

/** Compared as digests: always the same length, so the time taken says nothing about a guess. */
export function verifySetupToken(file: string, candidate: string): boolean {
  const stored = readToken(file);
  if (stored === null) {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(stored));
}

export function removeSetupToken(file: string): void {
  rmSync(file, { force: true });
}
