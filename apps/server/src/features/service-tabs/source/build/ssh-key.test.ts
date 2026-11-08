import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSshKeyPair } from "./ssh-key";

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe("generateSshKeyPair", () => {
  it("makes an ed25519 key with the comment on the public half", () => {
    const pair = generateSshKeyPair("opsifier-shop-web");

    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ opsifier-shop-web$/);
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(pair.privateKey.endsWith("-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
  });

  it("never makes the same key twice", () => {
    expect(generateSshKeyPair("a").privateKey).not.toBe(generateSshKeyPair("a").privateKey);
  });

  it.skipIf(!hasSshKeygen)("is a key OpenSSH itself can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "opsifier-sshkey-"));
    try {
      const pair = generateSshKeyPair("opsifier-shop-web");
      const file = join(dir, "key");
      writeFileSync(file, pair.privateKey, { mode: 0o600 });

      const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();

      expect(derived).toBe(pair.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
