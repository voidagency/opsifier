import { describe, expect, it } from "vitest";
import {
  allowlistIpProblem,
  createAllowlistEntryRequest,
  createProtectionUserRequest,
  isAllowlistIp,
  isAllowlistPath,
  isProtectedPurpose,
  publicConfirmation,
  setServerPurposeRequest,
} from "./server-purpose";

describe("the purpose", () => {
  it("protects everything but production, including when nothing has been chosen", () => {
    expect(isProtectedPurpose("development")).toBe(true);
    expect(isProtectedPurpose("staging")).toBe(true);
    expect(isProtectedPurpose(null)).toBe(true);
    expect(isProtectedPurpose("production")).toBe(false);
  });

  it("only takes known values", () => {
    expect(setServerPurposeRequest.safeParse({ purpose: "production" }).success).toBe(true);
    expect(setServerPurposeRequest.safeParse({ purpose: "prod" }).success).toBe(false);
  });

  it("states the number of domains in the confirmation", () => {
    expect(publicConfirmation(12)).toBe("PUBLIC 12");
  });
});

describe("allowlist paths", () => {
  it.each(["/healthz", "/hooks/*", "/a/b.c", "/.well-known/x", "/a_b~c-d"])("accepts %s", (value) => {
    expect(isAllowlistPath(value)).toBe(true);
  });

  it.each([
    "",
    "healthz",
    "/",
    "/*",
    "//",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/a/*/b",
    "/a*",
    "/a b",
    "/a%20b",
    "/a`b",
    "/robots.txt",
    "/ROBOTS.TXT",
    "/robots.txt/*",
    `/${"a".repeat(300)}`,
  ])("refuses %s", (value) => {
    expect(isAllowlistPath(value)).toBe(false);
  });
});

describe("allowlist addresses", () => {
  it.each([
    "203.0.113.7",
    "203.0.113.0/24",
    "10.0.0.0/8",
    "192.168.1.1/32",
    "2001:db8::1",
    "2001:db8::/32",
    "fd00::/8".replace("/8", "/48"),
  ])("accepts %s", (value) => {
    expect(isAllowlistIp(value)).toBe(true);
  });

  it.each([
    ["0.0.0.0/0", "This range covers every address"],
    ["::/0", "This range covers every address"],
    ["0.0.0.0", "This range covers every address"],
    ["10.1.2.3/8", "Use the first address of the range"],
    ["2001:db8::1/64", "Use the first address of the range"],
    ["1.0.0.0/7", "This range is too broad: use /8 or narrower"],
    ["2001::/20", "This range is too broad: use /28 or narrower"],
  ])("refuses %s, saying why", (value, message) => {
    expect(allowlistIpProblem(value)).toBe(message);
  });

  it.each([
    "",
    "not-an-ip",
    "999.1.1.1",
    "01.2.3.4",
    "1.2.3",
    "1.2.3.4.5",
    "1.2.3.4/33",
    "1.2.3.0/08",
    "1.2.3.0/abc",
    "1.2.3.0/24/8",
    "::ffff:1.2.3.4",
    "2001:db8:::1",
    "2001:db8::1::",
    "2001:db8::1%eth0",
    "12345::",
    "1:2:3:4:5:6:7:8:9",
  ])("refuses %s as invalid", (value) => {
    expect(isAllowlistIp(value)).toBe(false);
  });
});

describe("allowlist requests", () => {
  const target = { project: "shop", service: "web" };

  it("validates by kind", () => {
    expect(createAllowlistEntryRequest.safeParse({ ...target, kind: "path", value: "/ok" }).success).toBe(
      true,
    );
    expect(createAllowlistEntryRequest.safeParse({ ...target, kind: "ip", value: "/ok" }).success).toBe(
      false,
    );
    expect(createAllowlistEntryRequest.safeParse({ ...target, kind: "path", value: "1.2.3.4" }).success).toBe(
      false,
    );
    expect(createAllowlistEntryRequest.safeParse({ ...target, kind: "other", value: "/ok" }).success).toBe(
      false,
    );
  });

  it("trims what it stores", () => {
    expect(createAllowlistEntryRequest.parse({ ...target, kind: "ip", value: " 1.2.3.4 " }).value).toBe(
      "1.2.3.4",
    );
  });
});

describe("credentials", () => {
  it("accepts a username the proxy can hold, with or without a password", () => {
    expect(createProtectionUserRequest.safeParse({ username: "alice" }).success).toBe(true);
    expect(createProtectionUserRequest.safeParse({ username: "a.b-c_d@e" }).success).toBe(true);
  });

  it.each(["", "a:b", "a b", "a\nb", "é"])("refuses the username %j", (username) => {
    expect(createProtectionUserRequest.safeParse({ username }).success).toBe(false);
  });

  it("wants a real password", () => {
    expect(createProtectionUserRequest.safeParse({ username: "a", password: "short" }).success).toBe(false);
    expect(createProtectionUserRequest.safeParse({ username: "a", password: " ".repeat(12) }).success).toBe(
      false,
    );
    expect(createProtectionUserRequest.safeParse({ username: "a", password: "x".repeat(73) }).success).toBe(
      false,
    );
    expect(
      createProtectionUserRequest.safeParse({ username: "a", password: "long enough secret" }).success,
    ).toBe(true);
  });
});
