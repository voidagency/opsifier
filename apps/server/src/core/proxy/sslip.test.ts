import { describe, expect, it } from "vitest";
import { sslipBase } from "./sslip";

describe("the server's name on sslip.io", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(sslipBase("203.0.113.10")).toBe("203.0.113.10.sslip.io");
  });

  it("writes an IPv6 address in lowercase with dashes, never starting with one", () => {
    expect(sslipBase("2001:DB8::1")).toBe("2001-db8--1.sslip.io");
    expect(sslipBase("::1")).toBe("0--1.sslip.io");
  });
});
