import { beforeEach, describe, expect, it, vi } from "vitest";

const timingSafeEqualCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualCalls.count += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const {
  challengeFqdnOf,
  hashSecret,
  ID_LENGTH,
  isChallengeValue,
  isPublicIpv4,
  isReservedName,
  isValidId,
  randomId,
  randomSecret,
  secretMatches,
} = await import("./rules");

beforeEach(() => {
  timingSafeEqualCalls.count = 0;
});

describe("IDs", () => {
  it("come out in the right shape, every time", () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const id = randomId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(isValidId(id)).toBe(true);
    }
  });

  it.each(["www", "api", "get", "mail", "ns1", "ns2", "names", "panel"])("treat %s as reserved", (name) => {
    expect(isReservedName(name)).toBe(true);
    expect(isValidId(name)).toBe(false);
  });

  it.each([
    "",
    "UPPERCAS",
    "bcdfghj",
    "bcdfghjkm",
    "2cdfghjk",
    "bcdfghj0",
    "bcdfghjo",
    "bcd-fghj",
    "../../et",
  ])("refuse %j", (id) => {
    expect(isValidId(id)).toBe(false);
  });
});

describe("secrets", () => {
  it("are long and different each time", () => {
    const secrets = new Set(Array.from({ length: 100 }, randomSecret));
    expect(secrets.size).toBe(100);
    expect([...secrets][0]?.length).toBe(43);
  });

  it("match their own hash and nothing else", () => {
    const secret = randomSecret();
    expect(secretMatches(secret, hashSecret(secret))).toBe(true);
    expect(secretMatches(`${secret}x`, hashSecret(secret))).toBe(false);
  });

  it("are compared in constant time", () => {
    const secret = randomSecret();
    secretMatches(secret, hashSecret(secret));
    expect(timingSafeEqualCalls.count).toBe(1);
  });

  it("are still compared, and refused, when nothing is stored", () => {
    expect(secretMatches("anything", undefined)).toBe(false);
    expect(timingSafeEqualCalls.count).toBe(1);
  });

  it("are refused against a stored value of the wrong shape", () => {
    expect(secretMatches("anything", "not hex")).toBe(false);
    expect(secretMatches("anything", "")).toBe(false);
  });
});

describe("source addresses", () => {
  it.each([
    "93.184.216.34",
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("accept the public address %s", (ip) => {
    expect(isPublicIpv4(ip)).toBe(true);
  });

  it.each([
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.168.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255",
    "0.0.0.0",
  ])("refuse the address %s", (ip) => {
    expect(isPublicIpv4(ip)).toBe(false);
  });

  it.each([
    "",
    "1.2.3",
    "1.2.3.4.5",
    "1.2.3.256",
    "01.2.3.4",
    "1.2.3.4/32",
    " 1.2.3.4",
    "2001:db8::1",
    "::ffff:1.2.3.4",
    "a.b.c.d",
  ])("refuse the malformed %j", (ip) => {
    expect(isPublicIpv4(ip)).toBe(false);
  });
});

describe("challenges", () => {
  it("are answered on one name per server, with the trailing dot httpreq sends", () => {
    expect(challengeFqdnOf("bcdfghjk", "opsifier.dev")).toBe("_acme-challenge.bcdfghjk.opsifier.dev.");
  });

  it("accept only what a key authorization digest looks like", () => {
    expect(isChallengeValue("a".repeat(43))).toBe(true);
    expect(isChallengeValue(`${"a".repeat(41)}-_`)).toBe(true);
    expect(isChallengeValue("a".repeat(44))).toBe(false);
    expect(isChallengeValue(`${"a".repeat(42)}"`)).toBe(false);
  });
});
