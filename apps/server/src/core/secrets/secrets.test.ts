import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecrets, loadOrCreateSecretKey, Secrets, SecretsError } from "./index";

describe("seal and unseal", () => {
  const secrets = new Secrets(randomBytes(32));

  it("round-trips text, including empty strings and unicode", () => {
    for (const value of ["", "hello", "pässwörd 🔑", "x".repeat(10_000)]) {
      expect(secrets.unseal(secrets.seal(value))).toBe(value);
    }
  });

  it("never produces the same output twice and does not contain the plaintext", () => {
    const first = secrets.seal("same value");
    const second = secrets.seal("same value");
    expect(first).not.toBe(second);
    expect(first).not.toContain("same value");
  });

  it("rejects a value with any part changed", () => {
    const [version, iv, ciphertext, tag] = secrets.seal("top secret").split(".") as [
      string,
      string,
      string,
      string,
    ];
    const flip = (part: string) => `${part.startsWith("A") ? "B" : "A"}${part.slice(1)}`;

    for (const tampered of [
      [version, flip(iv), ciphertext, tag],
      [version, iv, flip(ciphertext), tag],
      [version, iv, ciphertext, flip(tag)],
    ]) {
      expect(() => secrets.unseal(tampered.join("."))).toThrow(SecretsError);
    }
  });

  it("rejects values that are not sealed at all", () => {
    for (const value of ["", "plaintext", "v1.a.b", "v2.a.b.c", "v1.a.b.c.d"]) {
      expect(() => secrets.unseal(value)).toThrow(SecretsError);
    }
  });

  it("rejects a truncated authentication tag", () => {
    const [version, iv, ciphertext, tag] = secrets.seal("value").split(".") as [
      string,
      string,
      string,
      string,
    ];
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 12).toString("base64url");
    expect(() => secrets.unseal([version, iv, ciphertext, shortTag].join("."))).toThrow(SecretsError);
  });

  it("cannot be opened with a different key", () => {
    const sealed = secrets.seal("value");
    expect(() => new Secrets(randomBytes(32)).unseal(sealed)).toThrow(SecretsError);
  });

  it("binds a value to its context", () => {
    const sealed = secrets.seal("value", "totp:user-1");
    expect(secrets.unseal(sealed, "totp:user-1")).toBe("value");
    expect(() => secrets.unseal(sealed, "totp:user-2")).toThrow(SecretsError);
  });

  it("refuses keys of the wrong size", () => {
    expect(() => new Secrets(randomBytes(16))).toThrow(SecretsError);
  });
});

describe("the key file", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "opsifier-secrets-"));
    file = join(directory, "nested", "secret.key");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is created with 32 random bytes and mode 0600", () => {
    const key = loadOrCreateSecretKey(file);
    expect(key).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is reused on later boots, so values stay readable", () => {
    const sealed = createSecrets(file).seal("survives a restart");
    expect(createSecrets(file).unseal(sealed)).toBe("survives a restart");
  });

  it("leaves no temporary files behind", () => {
    loadOrCreateSecretKey(file);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("is tightened if it was left readable by others", () => {
    const key = loadOrCreateSecretKey(file);
    chmodSync(file, 0o644);
    expect(loadOrCreateSecretKey(file).equals(key)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace a missing key when told something may be sealed with it", () => {
    expect(() => loadOrCreateSecretKey(file, { allowCreate: false })).toThrow(SecretsError);
    expect(() => loadOrCreateSecretKey(file, { allowCreate: false })).toThrow(/missing.*backup/s);
    expect(existsSync(file)).toBe(false);
  });

  it("still loads an existing key when it may not create one", () => {
    const key = loadOrCreateSecretKey(file);
    expect(loadOrCreateSecretKey(file, { allowCreate: false }).equals(key)).toBe(true);
  });

  it("stops the boot instead of replacing a damaged key", () => {
    loadOrCreateSecretKey(file);
    writeFileSync(file, Buffer.alloc(10));
    expect(() => loadOrCreateSecretKey(file)).toThrow(SecretsError);
    expect(readFileSync(file)).toHaveLength(10);
  });
});
