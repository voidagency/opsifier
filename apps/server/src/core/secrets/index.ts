import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export class SecretsError extends Error {
  override readonly name = "SecretsError";
}

/** Seals values with AES-256-GCM. `context` binds a value to its purpose, so it cannot be moved. */
export class Secrets {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new SecretsError(`The secret key must be exactly ${KEY_BYTES} bytes.`);
    }
  }

  seal(plaintext: string, context = ""): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, ciphertext, tag]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  /** Throws a {@link SecretsError} for anything tampered with, malformed or sealed under another key. */
  unseal(sealed: string, context = ""): string {
    const [version, ivText, ciphertextText, tagText, ...extra] = sealed.split(".");
    if (
      version !== VERSION ||
      ivText === undefined ||
      ciphertextText === undefined ||
      tagText === undefined ||
      extra.length > 0
    ) {
      throw new SecretsError("The sealed value is malformed.");
    }

    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretsError("The sealed value is malformed.");
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      const ciphertext = Buffer.from(ciphertextText, "base64url");
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretsError("The sealed value could not be authenticated.");
    }
  }
}

function writeNewKey(file: string): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(KEY_BYTES));
    fsyncSync(fd);
    closeSync(fd);
    // link() fails if the target exists, so a racing process can never replace a key in use,
    // and the key only appears at its final path once it is complete.
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface SecretKeyOptions {
  /**
   * Whether a missing key may be replaced with a new one. Only a panel with nothing sealed yet can
   * say yes: for any other, the new key could open nothing that came before it.
   */
  allowCreate?: boolean;
}

/**
 * Loads the key, creating it with mode 0600 the first time. A key that exists but is damaged, or
 * one that went missing from a panel already in use, stops the panel: replacing it would make
 * everything already sealed unreadable.
 */
export function loadOrCreateSecretKey(file: string, options: SecretKeyOptions = {}): Buffer {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  try {
    statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (options.allowCreate === false) {
      throw new SecretsError(
        `The secret key ${file} is missing, but this panel already has users. ` +
          "Everything sealed with it would be unreadable, so Opsifier will not create a new one. " +
          "Restore the file from a backup and start Opsifier again.",
      );
    }
    writeNewKey(file);
  }

  const { mode } = statSync(file);
  if ((mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
  }

  const key = readFileSync(file);
  if (key.length !== KEY_BYTES) {
    throw new SecretsError(`${file} must contain exactly ${KEY_BYTES} bytes. Restore it from a backup.`);
  }
  return key;
}

export function createSecrets(file: string, options: SecretKeyOptions = {}): Secrets {
  return new Secrets(loadOrCreateSecretKey(file, options));
}
