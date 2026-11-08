import { describe, expect, it } from "vitest";
import {
  domainHost,
  isValidHostname,
  isValidMiddlewareName,
  isValidRoutePath,
  routePath,
  saveDomainRequest,
} from "./domains";
import { maintenanceSettings } from "./maintenance";
import { goRegexError } from "./redirect-regex";
import { saveRedirectRequest } from "./redirects";
import { createBasicAuthRequest, updateBasicAuthRequest } from "./security";

describe("hostnames", () => {
  it.each([
    "example.com",
    "whoami.example.test",
    "a-b.c-d.example",
    "xn--bcher-kva.example",
    "shop-web.203.0.113.10.sslip.io",
    "a.b",
  ])("accepts %s", (host) => {
    expect(isValidHostname(host)).toBe(true);
  });

  it.each([
    "",
    "localhost",
    "1.2.3.4",
    "bad host.example.com",
    "exa_mple.com",
    "-leading.example.com",
    "trailing-.example.com",
    "double..dot.example.com",
    "dot.example.com.",
    "*.example.com",
    "back`tick.example.com",
    "UPPER.example.com",
    `${"a".repeat(64)}.example.com`,
    `${"a".repeat(250)}.example`,
  ])("refuses %j", (host) => {
    expect(isValidHostname(host)).toBe(false);
  });

  it("lowercases and trims at the schema", () => {
    expect(domainHost.parse(" Shop.Example.COM ")).toBe("shop.example.com");
  });

  it("says which rule failed", () => {
    expect(domainHost.safeParse("").error?.issues[0]?.message).toBe("Required");
    expect(domainHost.safeParse("nope").error?.issues[0]?.message).toMatch(/full hostname/);
  });
});

describe("paths", () => {
  it.each(["/", "/api", "/api/v1", "/.well-known/x", "/a-b_c~d.e", "/a%20b", "/a:b@c!$&'()*+,;="])(
    "accepts %s",
    (path) => {
      expect(isValidRoutePath(path)).toBe(true);
    },
  );

  it.each([
    "",
    "noslash",
    "/two//slashes",
    "/./dot",
    "/../up",
    "/a/../b",
    "/spa ce",
    "/tick`",
    '/quote"',
    "/back\\slash",
    "/brace{",
    "/%zz",
    "/%2",
    "/line\nbreak",
    "/?query",
    "/#hash",
  ])("refuses %j", (path) => {
    expect(isValidRoutePath(path)).toBe(false);
  });

  it("drops a trailing slash so one route isn't stored twice", () => {
    expect(routePath.parse("/api/")).toBe("/api");
    expect(routePath.parse("/")).toBe("/");
  });

  it("asks for a leading slash by name", () => {
    expect(routePath.safeParse("api").error?.issues[0]?.message).toBe("Must start with /");
  });
});

describe("the domain request", () => {
  const parse = (body: unknown) => saveDomainRequest.safeParse(body);

  it("fills in the defaults", () => {
    const result = parse({ host: "a.example.test" });
    expect(result.data).toEqual({
      host: "a.example.test",
      path: "/",
      https: true,
      port: 80,
      destinationProtocol: "http",
      destinationPath: "/",
      certificateResolver: null,
      wildcard: false,
      middlewares: [],
    });
  });

  it.each([
    [{ host: "a.example.test", port: 0 }],
    [{ host: "a.example.test", port: 65536 }],
    [{ host: "a.example.test", port: "80" }],
    [{ host: "a.example.test", port: 1.5 }],
    [{ host: "a.example.test", destinationProtocol: "tcp" }],
    [{ host: "a.example.test", certificateResolver: "my resolver" }],
    [{ host: "a.example.test", middlewares: ["ok", "not ok"] }],
    [{ host: "a.example.test", middlewares: [""] }],
    [{ host: "a.example.test", middlewares: ["opsifier-anything"] }],
    [{ host: "a.example.test", middlewares: Array.from({ length: 21 }, (_, i) => `m${i}`) }],
    [{ host: "a.example.test", wildcard: true }],
  ])("refuses %j", (body) => {
    expect(parse(body).success).toBe(false);
  });

  it("accepts a wildcard over plain HTTP, or with a named resolver", () => {
    expect(parse({ host: "a.example.test", wildcard: true, https: false }).success).toBe(true);
    expect(parse({ host: "a.example.test", wildcard: true, certificateResolver: "dns" }).success).toBe(true);
  });

  it("treats a blank resolver as the default one", () => {
    expect(parse({ host: "a.example.test", certificateResolver: "  " }).data?.certificateResolver).toBe("");
  });

  it("knows the shape of a middleware reference", () => {
    expect(isValidMiddlewareName("rate-limit")).toBe(true);
    expect(isValidMiddlewareName("headers@file")).toBe(true);
    expect(isValidMiddlewareName("a@b@c")).toBe(false);
    expect(isValidMiddlewareName("-leading")).toBe(false);
  });
});

describe("regular expressions, by the rules of Go's engine", () => {
  it.each([
    "^https?://www\\.my-domain\\.com/(.*)",
    "^(.*)/old-path",
    "^http://host/old(.*)",
    "(?i)^http://example\\.com/(.*)$",
    "(?P<rest>.*)",
    "(?<rest>.*)",
    "(?:a|b)+?c*?d??",
    "a{2}",
    "a{2,}b{1,3}?",
    "x{1000}",
    "(a{10}){100}",
    "a{",
    "{}",
    "a{,3}",
    "[a-z]+",
    "[^/]+",
    "[]a]",
    "[[:alpha:]]+",
    "[[:^digit:]]",
    "\\d+\\w*\\s?\\.",
    "\\pL+",
    "\\p{Greek}",
    "\\Qa.b\\E",
    "\\x41\\x{1F600}",
    "\\0",
    "\\012",
    "\\A\\z",
    "^*$",
    "(a|)",
    "(|a)*",
    "()",
    "(?s).",
    "(?i:a)b",
    "(?-i:a)",
    "(?i-s:a)",
    "\\_\\/\\-",
    "é+",
    "😀*",
  ])("accepts %s", (pattern) => {
    expect(goRegexError(pattern)).toBeNull();
  });

  it.each([
    ["(unclosed"],
    ["unopened)"],
    ["[unclosed"],
    ["[z-a]"],
    ["(?=lookahead)"],
    ["(?!negative)"],
    ["(?<=behind)"],
    ["(?<!behind)"],
    ["(?P=name)"],
    ["(?P<>x)"],
    ["(?<1 x>y)"],
    ["(?P<a>x)(?P<a>y)"],
    ["(?z)x"],
    ["\\1"],
    ["\\9"],
    ["a\\k<x>"],
    ["\\y"],
    ["\\é"],
    ["*"],
    ["+a"],
    ["(*)"],
    ["(|*)"],
    ["a|*"],
    ["a**"],
    ["a*+"],
    ["a++"],
    ["a{2}{3}"],
    ["a{2}*"],
    ["a*?*"],
    ["a{1001}"],
    ["a{2,1}"],
    ["(a{10}){200}"],
    ["(x{500}){3}"],
    ["[[:bogus:]]"],
    ["\\p{Bogus}"],
    ["\\pl"],
    ["\\xZZ"],
    ["\\x{110000}"],
    ["\\x{}"],
    ["\\C"],
    ["[\\b]"],
    ["[a-\\d]"],
    ["trailing\\"],
  ])("refuses %j", (pattern) => {
    expect(goRegexError(pattern)).not.toBeNull();
  });

  it("gives up rather than recurse for ever", () => {
    expect(goRegexError(`${"(".repeat(200)}a${")".repeat(200)}`)).not.toBeNull();
    expect(goRegexError(`${"(".repeat(50)}a${")".repeat(50)}`)).toBeNull();
  });
});

describe("the redirect request", () => {
  it("has the right defaults", () => {
    expect(saveRedirectRequest.parse({ regex: "^a", replacement: "b" })).toEqual({
      enabled: true,
      regex: "^a",
      replacement: "b",
      permanent: false,
    });
  });

  it("refuses control characters and spaces in either field", () => {
    for (const value of ["a b", "a\tb", "a\u0000b"]) {
      expect(saveRedirectRequest.safeParse({ regex: value, replacement: "b" }).success).toBe(false);
      expect(saveRedirectRequest.safeParse({ regex: "a", replacement: value }).success).toBe(false);
    }
  });
});

describe("basic auth credentials", () => {
  it("accepts the ordinary case, including non-ASCII within 72 bytes", () => {
    expect(createBasicAuthRequest.safeParse({ username: "bob", password: "s".repeat(72) }).success).toBe(
      true,
    );
    expect(createBasicAuthRequest.safeParse({ username: "bob", password: "é".repeat(36) }).success).toBe(
      true,
    );
  });

  it("makes the password optional on an update only", () => {
    expect(updateBasicAuthRequest.safeParse({ username: "bob" }).success).toBe(true);
    expect(createBasicAuthRequest.safeParse({ username: "bob" }).success).toBe(false);
  });
});

describe("maintenance settings", () => {
  it("defaults to off with no page content", () => {
    expect(maintenanceSettings.parse({})).toEqual({
      enabled: false,
      title: "",
      subtitle: "",
      customLogo: null,
      customCss: "",
      hideLogo: false,
      hideLinks: false,
    });
  });

  it("only takes inline images as a logo", () => {
    const check = (customLogo: unknown) => maintenanceSettings.safeParse({ customLogo }).success;

    expect(check("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true);
    expect(check(null)).toBe(true);
    expect(check("http://example.com/x.png")).toBe(false);
    expect(check("data:image/png;base64,bad!chars")).toBe(false);
  });
});
