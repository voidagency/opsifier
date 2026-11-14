import { createHash, randomBytes, randomInt } from "node:crypto";

/** How long a request waits for someone to approve it. */
export const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;
/** How often the command line asks whether it was approved, in seconds. */
export const CLI_LOGIN_INTERVAL_S = 3;
/** Requests waiting at one time, all addresses together: a flood cannot grow memory without bound. */
const MAX_PENDING = 1000;
/** No vowels and nothing that reads as another character: a code never spells a word or confuses. */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

type Status = "pending" | "approved" | "denied" | "collected";

export interface CliLoginEntry {
  userCode: string;
  client: string;
  address: string | null;
  requestedAt: number;
  expiresAt: number;
  status: Status;
  /** Who approved it, once someone has. */
  userId?: string;
}

export type Collected =
  | { status: "pending" }
  | { status: "approved"; entry: CliLoginEntry }
  | { status: "gone"; reason: "expired" | "denied" | "unknown" };

const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");

function newUserCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Normalises what a person types: case and the dash do not matter. */
export function normalizeUserCode(code: string): string {
  const letters = code.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : "";
}

/**
 * Requests from the command line to sign in as a person, in memory: there is one panel process, and
 * a request lives ten minutes. A restart only makes the command line ask again.
 */
export class CliLogins {
  /** By the digest of the device code: the secret itself is never kept. */
  private readonly byDevice = new Map<string, CliLoginEntry>();
  private readonly byUserCode = new Map<string, string>();

  constructor(private readonly now: () => number) {}

  start(client: string, address: string | null): { deviceCode: string; entry: CliLoginEntry } | null {
    this.sweep();
    if (this.byDevice.size >= MAX_PENDING) {
      return null;
    }
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode = newUserCode();
    while (this.byUserCode.has(userCode)) {
      userCode = newUserCode();
    }
    const requestedAt = this.now();
    const entry: CliLoginEntry = {
      userCode,
      client,
      address,
      requestedAt,
      expiresAt: requestedAt + CLI_LOGIN_TTL_MS,
      status: "pending",
    };
    const key = digest(deviceCode);
    this.byDevice.set(key, entry);
    this.byUserCode.set(userCode, key);
    return { deviceCode, entry };
  }

  /** A request still waiting for an answer, by the code a person reads. */
  waiting(userCode: string): CliLoginEntry | undefined {
    this.sweep();
    const key = this.byUserCode.get(normalizeUserCode(userCode));
    const entry = key === undefined ? undefined : this.byDevice.get(key);
    return entry?.status === "pending" ? entry : undefined;
  }

  approve(entry: CliLoginEntry, userId: string): void {
    entry.status = "approved";
    entry.userId = userId;
  }

  deny(entry: CliLoginEntry): void {
    entry.status = "denied";
  }

  /** What the command line gets for its device code. An approved request is handed over once. */
  collect(deviceCode: string): Collected {
    this.sweep();
    const key = digest(deviceCode);
    const entry = this.byDevice.get(key);
    if (entry === undefined) {
      return { status: "gone", reason: "unknown" };
    }
    if (entry.status === "pending") {
      return { status: "pending" };
    }
    this.forget(key, entry);
    if (entry.status === "approved") {
      entry.status = "collected";
      return { status: "approved", entry };
    }
    return { status: "gone", reason: "denied" };
  }

  private forget(key: string, entry: CliLoginEntry): void {
    this.byDevice.delete(key);
    this.byUserCode.delete(entry.userCode);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.byDevice) {
      if (entry.expiresAt <= now) {
        this.forget(key, entry);
      }
    }
  }
}
