import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** What the service accepts, as pure functions. Nothing in here touches AWS. */

/** Letters and digits nobody can mistake for one another. No vowels, so no ID spells a word. */
const LETTERS = "bcdfghjkmnpqrstvwxyz";
const ID_ALPHABET = `${LETTERS}23456789`;
export const ID_LENGTH = 8;

/** Starts with a letter, so a name is never all digits and always reads as a hostname. */
const ID_SHAPE = new RegExp(`^[${LETTERS}][${ID_ALPHABET}]{${ID_LENGTH - 1}}$`);

/**
 * Names that mean something else under the zone. The alphabet cannot produce most of them today, and
 * this list is what still holds if the alphabet or the length ever change.
 */
const RESERVED_NAMES = new Set([
  "abuse",
  "acme",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "autoconfig",
  "autodiscover",
  "billing",
  "blog",
  "cdn",
  "dashboard",
  "dev",
  "docs",
  "ftp",
  "get",
  "help",
  "hostmaster",
  "imap",
  "install",
  "mail",
  "mx",
  "names",
  "ns",
  "ns1",
  "ns2",
  "ns3",
  "ns4",
  "opsifier",
  "panel",
  "pop",
  "pop3",
  "postmaster",
  "prod",
  "root",
  "security",
  "smtp",
  "ssh",
  "staging",
  "static",
  "status",
  "support",
  "test",
  "vpn",
  "webmail",
  "www",
]);

export const isReservedName = (name: string): boolean => RESERVED_NAMES.has(name);

export const isValidId = (id: string): boolean => ID_SHAPE.test(id) && !isReservedName(id);

export function randomId(): string {
  let id = LETTERS[randomInt(LETTERS.length)] as string;
  while (id.length < ID_LENGTH) {
    id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return id;
}

/** 256 bits from a CSPRNG, in characters that survive HTTP Basic. */
export const randomSecret = (): string => randomBytes(32).toString("base64url");

/** Identifies one holder of a lease. */
export const randomToken = (): string => randomBytes(16).toString("hex");

/** A secret this long and this random needs a fast hash, not a slow one. */
export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** Compared as digests in constant time. With nothing stored the same work is done, and the answer is no. */
export function secretMatches(secret: string, storedHash: string | undefined): boolean {
  const presented = createHash("sha256").update(secret).digest();
  const stored = Buffer.from(storedHash ?? "", "hex");
  const candidate = stored.length === presented.length ? stored : Buffer.alloc(presented.length);
  return timingSafeEqual(presented, candidate) && stored.length === presented.length;
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** RFC 6890 and its successors: everything a public DNS name has no business pointing at. */
const NOT_PUBLIC_V4: ReadonlyArray<readonly [network: string, prefix: number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const toNumber = (ip: string): number =>
  ip.split(".").reduce((total, octet) => (total * 256 + Number(octet)) >>> 0, 0);

const mask = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

const inRange = (address: number, [network, prefix]: readonly [string, number]): boolean =>
  (address & mask(prefix)) >>> 0 === (toNumber(network) & mask(prefix)) >>> 0;

export const isIpv4 = (ip: string): boolean => IPV4.test(ip);

/** IPv4 only for now, and only an address the public internet can actually reach. */
export function isPublicIpv4(ip: string): boolean {
  if (!isIpv4(ip)) {
    return false;
  }
  const address = toNumber(ip);
  return !NOT_PUBLIC_V4.some((range) => inRange(address, range));
}

/** What an ACME key authorization digest looks like: 43 characters of base64url, nothing else. */
const CHALLENGE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export const isChallengeValue = (value: string): boolean => CHALLENGE_VALUE.test(value);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PURPOSE_LENGTH = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

export const isEmail = (value: string): boolean => value.length <= MAX_EMAIL_LENGTH && EMAIL.test(value);

/** Read by a person deciding, so it has to say something and fit on a screen. */
export function isPurpose(value: string): boolean {
  const length = value.trim().length;
  return length > 0 && length <= MAX_PURPOSE_LENGTH && !CONTROL_CHARACTERS.test(value);
}

export const domainOf = (id: string, zone: string): string => `${id}.${zone}`;
export const wildcardOf = (id: string, zone: string): string => `*.${id}.${zone}`;
export const challengeNameOf = (id: string, zone: string): string => `_acme-challenge.${id}.${zone}`;

/** The one name a server may answer a challenge on, in the form the httpreq provider sends it. */
export const challengeFqdnOf = (id: string, zone: string): string => `${challengeNameOf(id, zone)}.`;
