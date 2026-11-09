import { describe, expect, it } from "vitest";
import {
  changeCredentialsRequest,
  loginRequest,
  passwordMaxLength,
  recoveryCode,
  setupRequest,
  twoFactorBegin,
  twoFactorDisable,
} from "./auth";

const name = "Ada Admin";
const email = "admin@example.com";
const password = "a long enough password";
const longEmail = `${"a".repeat(254 - "@example.com".length + 1)}@example.com`;
const atLimitEmail = `${"a".repeat(254 - "@example.com".length)}@example.com`;
const longPassword = "p".repeat(passwordMaxLength + 1);
const atLimitPassword = "p".repeat(passwordMaxLength);

describe("emails", () => {
  it("are capped at 254 characters wherever one is taken", () => {
    expect(longEmail).toHaveLength(255);
    expect(setupRequest.safeParse({ token: "t", name, email: longEmail, password }).success).toBe(false);
    expect(loginRequest.safeParse({ email: longEmail, password }).success).toBe(false);
    expect(
      changeCredentialsRequest.safeParse({
        email: longEmail,
        currentPassword: password,
        newPassword: password,
      }).success,
    ).toBe(false);
  });

  it("may be exactly 254 characters", () => {
    expect(atLimitEmail).toHaveLength(254);
    expect(loginRequest.safeParse({ email: atLimitEmail, password }).success).toBe(true);
  });
});

describe("passwords", () => {
  it("are capped wherever one is taken, so hashing them stays cheap", () => {
    expect(setupRequest.safeParse({ token: "t", name, email, password: longPassword }).success).toBe(false);
    expect(loginRequest.safeParse({ email, password: longPassword }).success).toBe(false);
    expect(
      changeCredentialsRequest.safeParse({ email, currentPassword: longPassword, newPassword: password })
        .success,
    ).toBe(false);
    expect(
      changeCredentialsRequest.safeParse({ email, currentPassword: password, newPassword: longPassword })
        .success,
    ).toBe(false);
    expect(twoFactorBegin.safeParse({ currentPassword: longPassword }).success).toBe(false);
    expect(twoFactorDisable.safeParse({ currentPassword: longPassword, code: "123456" }).success).toBe(false);
  });

  it("may be exactly as long as the maximum", () => {
    expect(setupRequest.safeParse({ token: "t", name, email, password: atLimitPassword }).success).toBe(true);
    expect(loginRequest.safeParse({ email, password: atLimitPassword }).success).toBe(true);
  });
});

describe("the setup token", () => {
  it("is required", () => {
    expect(setupRequest.safeParse({ name, email, password }).success).toBe(false);
    expect(setupRequest.safeParse({ token: "   ", name, email, password }).success).toBe(false);
  });

  it("is trimmed and bounded", () => {
    expect(setupRequest.parse({ token: "  abc\n", name, email, password }).token).toBe("abc");
    expect(setupRequest.safeParse({ token: "x".repeat(129), name, email, password }).success).toBe(false);
  });
});

describe("the owner's name", () => {
  it("is what the setup request carries", () => {
    expect(setupRequest.parse({ token: "t", name, email, password }).name).toBe(name);
  });

  const withName = (value: unknown) => setupRequest.safeParse({ token: "t", name: value, email, password });

  it("is required, and may not be blank", () => {
    expect(setupRequest.safeParse({ token: "t", email, password }).success).toBe(false);
    expect(withName("   ").success).toBe(false);
  });

  it("is bounded, stays on one line and is trimmed", () => {
    expect(withName("x".repeat(101)).success).toBe(false);
    expect(withName("Ada\nAdmin").success).toBe(false);
    expect(setupRequest.parse({ token: "t", name: "  Ada Admin ", email, password }).name).toBe("Ada Admin");
  });
});

describe("recovery codes", () => {
  it("accept the printed form and the ways people retype it", () => {
    for (const value of [
      "abcd-efgh-jkmn-pqrs",
      "ABCD-EFGH-JKMN-PQRS",
      "abcdefghjkmnpqrs",
      "abcd efgh jkmn pqrs",
      "  abcd-efgh-jkmn-pqrs  ",
    ]) {
      expect(recoveryCode.safeParse(value).success).toBe(true);
    }
  });

  it("refuse anything else", () => {
    for (const value of [
      "",
      "abc",
      "abcd-efgh-jkmn",
      "abcd-efgh-jkmn-pqrs-tvwx",
      "abcd_efgh_jkmn_pqrs",
      "12345 6",
    ]) {
      expect(recoveryCode.safeParse(value).success).toBe(false);
    }
  });

  it("are optional at login, alongside the code", () => {
    expect(loginRequest.safeParse({ email, password }).success).toBe(true);
    expect(loginRequest.safeParse({ email, password, recoveryCode: "abcd-efgh-jkmn-pqrs" }).success).toBe(
      true,
    );
  });
});

describe("turning 2FA off", () => {
  it("takes the password and either code", () => {
    const currentPassword = password;
    expect(twoFactorDisable.safeParse({ currentPassword, code: "123456" }).success).toBe(true);
    expect(twoFactorDisable.safeParse({ currentPassword, recoveryCode: "abcd-efgh-jkmn-pqrs" }).success).toBe(
      true,
    );
  });

  it("needs a code of some kind, reported on the code field", () => {
    const result = twoFactorDisable.safeParse({ currentPassword: password });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["code"]);
  });

  it("needs the password", () => {
    expect(twoFactorDisable.safeParse({ code: "123456" }).success).toBe(false);
  });
});
