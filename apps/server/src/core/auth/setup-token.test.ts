import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSetupToken, removeSetupToken, verifySetupToken } from "./setup-token";

const crypto = vi.hoisted(() => ({ compared: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      crypto.compared += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-setup-token-"));
  file = join(directory, "nested", "setup-token");
  crypto.compared = 0;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("ensureSetupToken", () => {
  it("writes a long random token with mode 0600", () => {
    const token = ensureSetupToken(file);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
  });

  it("issues a different token each time one is created", () => {
    const first = ensureSetupToken(file);
    removeSetupToken(file);
    expect(ensureSetupToken(file)).not.toBe(first);
  });

  it("keeps the token already on disk across a restart", () => {
    const token = ensureSetupToken(file);
    expect(ensureSetupToken(file)).toBe(token);
  });

  it("replaces a token others could have read", () => {
    const token = ensureSetupToken(file);
    chmodSync(file, 0o644);

    expect(ensureSetupToken(file)).not.toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a damaged token", () => {
    ensureSetupToken(file);
    writeFileSync(file, "too short", { mode: 0o600 });
    expect(ensureSetupToken(file)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("leaves no temporary files behind", () => {
    ensureSetupToken(file);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("verifySetupToken", () => {
  it("accepts the token and nothing else, whatever the length of the guess", () => {
    const token = ensureSetupToken(file);

    expect(verifySetupToken(file, token)).toBe(true);
    for (const guess of ["", "x", token.slice(0, -1), `${token}a`, "y".repeat(10_000)]) {
      expect(verifySetupToken(file, guess)).toBe(false);
    }
  });

  it("compares in constant time, for every guess", () => {
    const token = ensureSetupToken(file);

    verifySetupToken(file, token);
    verifySetupToken(file, "z".repeat(5));

    expect(crypto.compared).toBe(2);
  });

  it("rejects everything when no token exists", () => {
    expect(verifySetupToken(file, "x".repeat(43))).toBe(false);
  });

  it("rejects everything when the file holds nothing usable", () => {
    const token = ensureSetupToken(file);
    writeFileSync(file, "");
    expect(verifySetupToken(file, "")).toBe(false);
    expect(verifySetupToken(file, token)).toBe(false);
  });
});

describe("removeSetupToken", () => {
  it("removes the file, and does not mind if it is already gone", () => {
    ensureSetupToken(file);
    removeSetupToken(file);
    expect(existsSync(file)).toBe(false);
    expect(() => removeSetupToken(file)).not.toThrow();
  });
});
