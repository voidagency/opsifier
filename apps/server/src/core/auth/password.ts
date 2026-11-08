import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

// N=2^15, r=8, p=3 needs 32 MiB per hash, a good fit for a small VPS, and is one of the
// OWASP-recommended parameter sets.
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 3;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions, keyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyBytes, { ...options, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N: COST, r: BLOCK_SIZE, p: PARALLELISM }, KEY_BYTES);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

interface ParsedHash {
  options: ScryptOptions;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const [scheme, cost, blockSize, parallelism, saltText, keyText, ...extra] = stored.split("$");
  if (scheme !== "scrypt" || saltText === undefined || keyText === undefined || extra.length > 0) {
    return null;
  }
  const N = Number(cost);
  const r = Number(blockSize);
  const p = Number(parallelism);
  // Bound the parameters so a corrupted row cannot make verification allocate without limit.
  const sane =
    Number.isInteger(N) &&
    N >= 2 &&
    N <= 2 ** 20 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 32 &&
    128 * N * r < MAX_MEMORY;
  if (!sane) {
    return null;
  }
  const key = Buffer.from(keyText, "base64url");
  return key.length > 0 ? { options: { N, r, p }, salt: Buffer.from(saltText, "base64url"), key } : null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) {
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.options, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

let decoy: Promise<string> | undefined;

function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(32).toString("hex"));
  return decoy;
}

/** Computes the decoy at boot, so the first unknown email is not the slow one. */
export async function prepareDecoyHash(): Promise<void> {
  await decoyHash();
}

/**
 * Burns the same work as checking a real password, so that an unknown email cannot be told
 * from a wrong password by timing.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  await verifyPassword(password, await decoyHash());
}
