import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { InvalidProxyInputError } from "../../../core/proxy";
import { compileMiddlewares } from "./middlewares";

const base = { qualifiedName: "shop_web", project: "shop", service: "web" };
const hash = `$2b$10$${"a".repeat(53)}`;

describe("WRK-22 redirects", () => {
  const rule = (overrides = {}) => ({
    id: "r1",
    enabled: true,
    regex: "^http://host/old(.*)",
    replacement: "http://host/new$${1}",
    permanent: false,
    ...overrides,
  });

  it("compiles an enabled rule to redirectRegex, attached to the service", () => {
    const compiled = compileMiddlewares({ ...base, redirects: [rule()] });

    expect(compiled.definitions["opsifier-redirect-shop_web-0"]).toEqual({
      redirectRegex: { regex: "^http://host/old(.*)", replacement: "http://host/new$${1}", permanent: false },
    });
    expect(compiled.attached).toEqual(["opsifier-redirect-shop_web-0"]);
  });

  it("marks a permanent rule, for a 301", () => {
    const compiled = compileMiddlewares({ ...base, redirects: [rule({ permanent: true })] });
    expect(compiled.definitions["opsifier-redirect-shop_web-0"]).toMatchObject({
      redirectRegex: { permanent: true },
    });
  });

  it("removes a disabled rule entirely, and renumbers the rest", () => {
    const compiled = compileMiddlewares({
      ...base,
      redirects: [rule({ enabled: false }), rule({ id: "r2", regex: "^other(.*)", replacement: "$${1}" })],
    });

    expect(Object.keys(compiled.definitions)).toEqual(["opsifier-redirect-shop_web-0"]);
    expect(compiled.definitions["opsifier-redirect-shop_web-0"]).toMatchObject({
      redirectRegex: { regex: "^other(.*)" },
    });
  });

  it("refuses a pattern Traefik could not compile", () => {
    expect(() => compileMiddlewares({ ...base, redirects: [rule({ regex: "(?=x)" })] })).toThrow(
      InvalidProxyInputError,
    );
  });

  it("refuses a replacement with spaces", () => {
    expect(() => compileMiddlewares({ ...base, redirects: [rule({ replacement: "a b" })] })).toThrow(
      InvalidProxyInputError,
    );
  });
});

describe("WRK-24 basic authentication", () => {
  it("has one middleware for the service, with bcrypt hashes and the header removed", () => {
    const compiled = compileMiddlewares({
      ...base,
      basicAuth: [
        { id: "a", username: "probeuser", passwordHash: hash },
        { id: "b", username: "other", passwordHash: hash },
      ],
    });

    expect(compiled.definitions["opsifier-auth-shop_web"]).toEqual({
      basicAuth: { users: [`probeuser:${hash}`, `other:${hash}`], removeHeader: true },
    });
    expect(compiled.attached).toEqual(["opsifier-auth-shop_web"]);
  });

  it("has no middleware once the last entry is gone", () => {
    const compiled = compileMiddlewares({ ...base, basicAuth: [] });
    expect(compiled.definitions).toEqual({});
    expect(compiled.attached).toEqual([]);
  });

  it("comes before redirect rules, which come last", () => {
    const compiled = compileMiddlewares({
      ...base,
      basicAuth: [{ id: "a", username: "u", passwordHash: hash }],
      redirects: [{ id: "r", enabled: true, regex: "a", replacement: "b", permanent: false }],
    });
    expect(compiled.attached).toEqual(["opsifier-auth-shop_web", "opsifier-redirect-shop_web-0"]);
  });

  it.each([
    [{ id: "a", username: "co:lon", passwordHash: hash }],
    [{ id: "a", username: "bad user", passwordHash: hash }],
    [{ id: "a", username: "", passwordHash: hash }],
    [{ id: "a", username: "u", passwordHash: "plaintext" }],
    [{ id: "a", username: "u", passwordHash: "" }],
  ])("refuses the entry %j", (entry) => {
    expect(() => compileMiddlewares({ ...base, basicAuth: [entry] })).toThrow(InvalidProxyInputError);
  });
});

describe("WRK-26 maintenance", () => {
  it("adds the page's replacePath while enabled", () => {
    const compiled = compileMiddlewares({ ...base, maintenance: { enabled: true } });

    expect(compiled.maintenance).toBe("opsifier-maintenance-shop_web");
    expect(compiled.definitions["opsifier-maintenance-shop_web"]).toEqual({
      replacePath: { path: "/api/proxy-pages/maintenance/shop/web" },
    });
    expect(compiled.attached).toEqual([]);
  });

  it("adds nothing while disabled", () => {
    const compiled = compileMiddlewares({ ...base, maintenance: { enabled: false } });
    expect(compiled.maintenance).toBeNull();
    expect(compiled.definitions).toEqual({});
  });

  it("refuses names that could not be in a path", () => {
    expect(() => compileMiddlewares({ ...base, project: "../evil", maintenance: { enabled: true } })).toThrow(
      InvalidProxyInputError,
    );
  });
});

describe("the generated YAML", () => {
  it("keeps hostile but valid values intact through YAML, so they can't become structure", () => {
    const hostile = {
      id: "r",
      enabled: true,
      // Everything YAML treats specially, all legal in a Go pattern and a replacement.
      regex: `^x:"y'[#&*!%@{}|>-]`,
      replacement: `"#:{a}[b]|>&*!%@'`,
      permanent: false,
    };
    const compiled = compileMiddlewares({
      ...base,
      redirects: [hostile],
      basicAuth: [{ id: "a", username: `odd#user"'&*`, passwordHash: hash }],
    });

    expect(parse(stringify(compiled.definitions))).toEqual(compiled.definitions);
    expect(compiled.definitions["opsifier-redirect-shop_web-0"]).toEqual({
      redirectRegex: { regex: hostile.regex, replacement: hostile.replacement, permanent: false },
    });
  });
});

describe("a service with nothing configured", () => {
  it("adds nothing at all", () => {
    expect(compileMiddlewares({ qualifiedName: "shop_web" })).toEqual({
      definitions: {},
      attached: [],
      maintenance: null,
    });
  });
});
