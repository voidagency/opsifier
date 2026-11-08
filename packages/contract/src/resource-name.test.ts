import { describe, expect, it } from "vitest";
import { resourceName } from "./common";

const accepted = (name: string) => resourceName.safeParse(name).success;

describe("resourceName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["a", "web", "shop-api", "shop_api", "a1", "1a", "a-b_c-d", `a${"b".repeat(61)}c`]) {
      expect(accepted(name)).toBe(true);
    }
  });

  it("cannot end with a dash or an underscore", () => {
    for (const name of ["web-", "web_", "a--", "a__", "a-_"]) {
      expect(accepted(name)).toBe(false);
    }
  });

  it("cannot contain two underscores in a row", () => {
    for (const name of ["a__b", "shop__web", "a___b"]) {
      expect(accepted(name)).toBe(false);
    }
  });

  it("may still use a single underscore and repeated dashes in the middle", () => {
    expect(accepted("a_b_c")).toBe(true);
    expect(accepted("a--b")).toBe(true);
  });

  it("still enforces the existing rules", () => {
    for (const name of ["", "-a", "_a", "A", "a b", "a.b", "../etc", "a".repeat(64)]) {
      expect(accepted(name)).toBe(false);
    }
  });

  it("says what is wrong", () => {
    const messageFor = (name: string) => resourceName.safeParse(name).error?.issues[0]?.message;
    expect(messageFor("web-")).toContain("end with");
    expect(messageFor("a__b")).toContain("underscores");
    expect(messageFor("")).toBe("Required");
  });
});
