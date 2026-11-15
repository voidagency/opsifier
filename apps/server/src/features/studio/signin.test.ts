import { describe, expect, it } from "vitest";
import { protectServiceConfig } from "../services/compile/protection";
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
      "",
      undefined,
    ]) {
      expect(safeReturnPath(elsewhere)).toBe("/");
    }
  });
});
