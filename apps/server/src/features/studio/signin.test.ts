import { describe, expect, it } from "vitest";
import { auditRoutingFiles, protectServiceConfig } from "../services/compile/protection";
import { PreviewSignIn, safeReturnPath, withStudioSignIn } from "./signin";

const ADDRESS = "http://opsifier:3000/api/proxy-pages/studio-signin";
const FILE = "lovable__site-preview.yaml";
const MIDDLEWARE = "opsifier-studio-signin-lovable__site-preview";

const plain = {
  http: {
    routers: {
      web: { rule: "Host(`site.example.com`)", middlewares: ["opsifier-redirect-https"] },
      secure: { rule: "Host(`site.example.com`)", middlewares: ["opsifier-redirect-site-0"] },
    },
    middlewares: { "opsifier-redirect-site-0": { redirectRegex: { regex: "^a", replacement: "b" } } },
  },
};

type Routed = {
  http: { routers: Record<string, { middlewares?: string[] }>; middlewares?: Record<string, unknown> };
};

describe("a Studio preview's routes", () => {
  it("ask the panel on every route, after the move to HTTPS", () => {
    const signed = withStudioSignIn(FILE, plain, ADDRESS) as Routed;

    expect(signed.http.routers.web?.middlewares).toEqual(["opsifier-redirect-https", MIDDLEWARE]);
    expect(signed.http.routers.secure?.middlewares).toEqual([MIDDLEWARE, "opsifier-redirect-site-0"]);
    expect(signed.http.middlewares?.[MIDDLEWARE]).toEqual({
      forwardAuth: { address: ADDRESS, trustForwardHeader: false },
    });
  });

  it("lose the sign-in when it is off, however often they are written", () => {
    const signed = withStudioSignIn(FILE, withStudioSignIn(FILE, plain, ADDRESS), ADDRESS);
    expect((signed as Routed).http.routers.secure?.middlewares).toEqual([
      MIDDLEWARE,
      "opsifier-redirect-site-0",
    ]);

    expect(withStudioSignIn(FILE, signed, null)).toEqual(plain);
  });

  it("are left out of the server's gate, which counts them as protected", () => {
    const signed = withStudioSignIn(FILE, plain, ADDRESS);

    const gated = protectServiceConfig(signed, {
      enabled: true,
      users: ["opsifier:$2y$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"],
      exemptions: [],
    }) as Routed;

    expect(gated.http.routers.secure?.middlewares).toEqual([
      "opsifier-protect-noindex",
      MIDDLEWARE,
      "opsifier-redirect-site-0",
    ]);
    expect(JSON.stringify(gated)).not.toContain("opsifier-protect-gate");
  });
});

describe("the panel's pages on a Studio preview's own address", () => {
  const GUEST = `${MIDDLEWARE}__guest`;
  /** As the panel writes a site's routes: one entry point each, the secure one with its certificate. */
  const served = {
    http: {
      routers: {
        web: {
          rule: "Host(`site.example.com`)",
          entryPoints: ["web"],
          middlewares: ["opsifier-redirect-https"],
          service: "site",
        },
        secure: {
          rule: "Host(`site.example.com`)",
          entryPoints: ["websecure"],
          middlewares: ["opsifier-redirect-site-0"],
          service: "site",
          tls: { certResolver: "letsencrypt" },
        },
        "secure-api": {
          rule: "Host(`site.example.com`) && PathPrefix(`/api`)",
          entryPoints: ["websecure"],
          service: "site",
          tls: { certResolver: "letsencrypt" },
        },
      },
      middlewares: plain.http.middlewares,
    },
  };

  it("send /__opsifier/studio/ on each host of the preview to the panel, signed in or not", () => {
    const routed = withStudioSignIn(FILE, served, null, true) as Routed;

    expect(routed.http.routers["opsifier-studio-guest-web"]).toEqual({
      rule: "Host(`site.example.com`) && PathPrefix(`/__opsifier/studio/`)",
      entryPoints: ["web"],
      middlewares: ["opsifier-redirect-https", GUEST],
      service: "opsifier-panel",
    });
    expect(routed.http.routers["opsifier-studio-guest-secure"]).toEqual({
      rule: "Host(`site.example.com`) && PathPrefix(`/__opsifier/studio/`)",
      entryPoints: ["websecure"],
      middlewares: [GUEST],
      service: "opsifier-panel",
      tls: { certResolver: "letsencrypt" },
    });
    // One route for each host and entry point.
    expect(routed.http.routers["opsifier-studio-guest-secure-api"]).toBeUndefined();
    expect(routed.http.middlewares?.[GUEST]).toEqual({
      replacePathRegex: {
        regex: "^/__opsifier/studio/(.*)$",
        replacement: "/api/proxy-pages/studio/$1",
      },
    });
    // The preview's own routes are as they were: the sign-in is off.
    expect(routed.http.routers.secure?.middlewares).toEqual(["opsifier-redirect-site-0"]);
  });

  it("go once the service is no longer a Studio project's preview", () => {
    const routed = withStudioSignIn(FILE, withStudioSignIn(FILE, served, ADDRESS, true), ADDRESS, true);
    expect(Object.keys((routed as Routed).http.routers)).toEqual([
      "web",
      "secure",
      "secure-api",
      "opsifier-studio-guest-web",
      "opsifier-studio-guest-secure",
    ]);

    expect(withStudioSignIn(FILE, routed, null, false)).toEqual(served);
  });

  it("are left out of the server's gate and of the site's domains: the panel checks who is there", () => {
    const routed = withStudioSignIn(FILE, served, null, true);

    const gated = protectServiceConfig(routed, {
      enabled: true,
      users: ["opsifier:$2y$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"],
      exemptions: [],
    }) as Routed;

    expect(gated.http.routers["opsifier-studio-guest-secure"]?.middlewares).toEqual([
      "opsifier-protect-noindex",
      GUEST,
    ]);
    const audit = auditRoutingFiles([{ file: FILE, config: gated }], true);
    expect(audit.domains.map((domain) => domain.path)).toEqual(["/", "/api"]);
  });
});

describe("the hops of a preview's sign-in", () => {
  const secrets = {
    seal: (value: string, context = "") => Buffer.from(`${context}|${value}`).toString("base64url"),
    unseal: (value: string, context = "") => {
      const [own, ...rest] = Buffer.from(value, "base64url").toString().split("|");
      if (own !== context) {
        throw new Error("another context");
      }
      return rest.join("|");
    },
  };

  it("give a code good once, for one host, for a minute", () => {
    let now = 0;
    const signIn = new PreviewSignIn(secrets, () => now);

    const code = signIn.issueCode("u1", "Site.example.com");
    expect(signIn.redeemCode(code, "other.example.com")).toBeNull();
    const again = signIn.issueCode("u1", "site.example.com");
    expect(signIn.redeemCode(again, "site.example.com")).toBe("u1");
    expect(signIn.redeemCode(again, "site.example.com")).toBeNull();

    const late = signIn.issueCode("u1", "site.example.com");
    now += 60_001;
    expect(signIn.redeemCode(late, "site.example.com")).toBeNull();
  });

  it("make a cookie for one host, for twelve hours", () => {
    let now = 0;
    const signIn = new PreviewSignIn(secrets, () => now);

    const cookie = signIn.cookieFor("u1", "site.example.com");
    expect(signIn.readCookie(cookie.value, "site.example.com")).toBe("u1");
    expect(signIn.readCookie(cookie.value, "other.example.com")).toBeNull();
    expect(signIn.readCookie("forged", "site.example.com")).toBeNull();
    now += 12 * 60 * 60 * 1000 + 1;
    expect(signIn.readCookie(cookie.value, "site.example.com")).toBeNull();
  });

  it("only ever land on a path of the preview itself", () => {
    expect(safeReturnPath("/fr/contact?x=1")).toBe("/fr/contact?x=1");
    for (const elsewhere of [
      "//evil.example.com/",
      "https://evil.example.com/",
      "/\\evil.example.com",
      "/\t/evil.example.com",
      "/\n/evil.example.com",
      "/\r/evil.example.com",
      "/\u0000/evil.example.com",
      "/\u007f/evil.example.com",
      "",
      undefined,
    ]) {
      expect(safeReturnPath(elsewhere)).toBe("/");
    }
  });
});
