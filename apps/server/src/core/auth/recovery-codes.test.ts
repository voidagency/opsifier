import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT } from "./recovery-codes";

describe("recovery codes", () => {
  it("come as ten distinct, grouped codes", () => {
    const codes = generateRecoveryCodes();

    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/);
    }
  });

  it("hash the same however the code was typed", () => {
    const expected = hashRecoveryCode("abcd-efgh-jkmn-pqrs");

    expect(hashRecoveryCode("ABCD-EFGH-JKMN-PQRS")).toBe(expected);
    expect(hashRecoveryCode("abcdefghjkmnpqrs")).toBe(expected);
    expect(hashRecoveryCode("  abcd efgh jkmn pqrs\n")).toBe(expected);
  });

  it("hash differently for different codes", () => {
    expect(hashRecoveryCode("abcd-efgh-jkmn-pqrs")).not.toBe(hashRecoveryCode("abcd-efgh-jkmn-pqrt"));
  });

  it("never store the code in the hash", () => {
    expect(hashRecoveryCode("abcd-efgh-jkmn-pqrs")).not.toContain("abcd");
  });
});
