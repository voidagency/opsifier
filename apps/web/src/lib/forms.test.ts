import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { applyApiError, schemaErrors } from "./forms";

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

describe("applyApiError", () => {
  it("puts each named field on the form and keeps a banner", () => {
    const error = new ApiError(400, "validation_failed", "Some fields need attention.", {
      email: "Already in use",
    });

    expect(applyApiError(error, ["email", "password"], t)).toEqual({
      banner: "Some fields need attention.",
      fields: { email: "Already in use" },
    });
  });

  it("adds messages for fields the form does not show to the banner", () => {
    const error = new ApiError(400, "validation_failed", "Some fields need attention.", {
      unknown: "Must be set",
    });

    expect(applyApiError(error, ["email"], t)).toEqual({
      banner: "Some fields need attention. Must be set",
      fields: {},
    });
  });

  it("puts a specific single-field failure on the field, translated, under a general banner", () => {
    const translations: Record<string, string> = {
      "common:apiErrors.invalid_current_password": "Mot de passe incorrect",
      "common:apiErrors.validation_failed": "Vérifiez les champs",
    };
    const translate = ((key: string, options?: { defaultValue?: string }) =>
      translations[key] ?? options?.defaultValue ?? key) as unknown as TFunction;
    const error = new ApiError(400, "invalid_current_password", "The current password is not correct.", {
      currentPassword: "Incorrect password",
    });

    expect(applyApiError(error, ["currentPassword"], translate)).toEqual({
      banner: "Vérifiez les champs",
      fields: { currentPassword: "Mot de passe incorrect" },
    });
  });

  it("falls back to a banner for anything that is not an API error", () => {
    expect(applyApiError(new Error("boom"), ["email"], t)).toEqual({
      banner: "common:errors.unexpected",
      fields: {},
    });
  });
});

describe("schemaErrors", () => {
  const schema = {
    safeParse: () => ({
      success: false as const,
      error: {
        issues: [
          { path: ["email"], message: "first" },
          { path: ["email"], message: "second" },
          { path: ["password"], message: "too short" },
        ],
      },
    }),
  };

  it("keeps the first problem per field and prefers the translated text", () => {
    expect(schemaErrors<"email" | "password">(schema, {}, { password: "Trop court" })).toEqual({
      email: "first",
      password: "Trop court",
    });
  });
});
