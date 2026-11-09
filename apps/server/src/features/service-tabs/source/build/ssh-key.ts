import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export interface SshKeyPair {
  /** The OpenSSH private key format, which `ssh` reads directly. */
  privateKey: string;
  /** One `authorized_keys` line. */
  publicKey: string;
}

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

const sshString = (data: Buffer): Buffer => Buffer.concat([uint32(data.length), data]);

/** Generates an ed25519 key in memory, so the private half never touches the disk in the clear. */
export function generateSshKeyPair(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const keyType = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);

  // The same random number twice proves a decrypted key is intact. There is no encryption here,
  // the private key is sealed by the panel, but the format still asks for it.
  const check = randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment)),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (unpadded.length % 8)) % 8 }, (_, index) => index + 1),
  );
  const container = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString(Buffer.from("none")),
    sshString(Buffer.from("none")),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(publicBlob),
    sshString(Buffer.concat([unpadded, padding])),
  ]);

  const body = container
    .toString("base64")
    .replace(/(.{70})/g, "$1\n")
    .trimEnd();
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
  };
}

/** The fingerprint `ssh-keygen -l` prints, of a line such as `ssh-ed25519 AAAA... comment`. */
export function sshFingerprint(publicKey: string): string {
  const base64 = publicKey.trim().split(/\s+/)[1] ?? "";
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}
