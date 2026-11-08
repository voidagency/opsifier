import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClientIp } from "../auth/client-ip";
import { ConfigError, loadConfig } from "./index";

describe("loadConfig", () => {
  it("uses /var/lib/opsifier in production and .data in development", () => {
    expect(loadConfig({ NODE_ENV: "production" }).dataDir).toBe("/var/lib/opsifier");
    expect(loadConfig({}).dataDir).toBe(join(process.cwd(), ".data"));
  });

  it("derives every path from the data directory", () => {
    const config = loadConfig({ OPSIFIER_DATA_DIR: "/srv/m" });
    expect(config.databaseFile).toBe("/srv/m/opsifier.db");
    expect(config.secretKeyFile).toBe("/srv/m/secret.key");
    expect(config.setupTokenFile).toBe("/srv/m/setup-token");
    expect(config.actionsDir).toBe("/srv/m/actions");
    expect(config.traefikDynamicDir).toBe("/srv/m/traefik/dynamic");
  });

  it("listens on loopback in development and on all interfaces in production", () => {
    expect(loadConfig({})).toMatchObject({ host: "127.0.0.1", port: 3000 });
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({ host: "0.0.0.0", port: 3000 });
  });

  it("reports invalid values instead of ignoring them", () => {
    expect(() => loadConfig({ OPSIFIER_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPSIFIER_PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPSIFIER_SERVER_IP: "not-an-ip" })).toThrow(ConfigError);
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ OPSIFIER_PORT: "", OPSIFIER_WEB_DIR: "" })).toMatchObject({
      port: 3000,
      webDir: undefined,
    });
  });

  it("resolves the web directory to an absolute path", () => {
    expect(isAbsolute(loadConfig({ OPSIFIER_WEB_DIR: "dist/web" }).webDir as string)).toBe(true);
  });

  it("only trusts the Vite dev origin outside production", () => {
    expect(loadConfig({}).allowedOrigins.has("http://localhost:5173")).toBe(true);
    expect(loadConfig({ NODE_ENV: "production" }).allowedOrigins.size).toBe(0);
  });

  it("rejects allowed origins with a path", () => {
    expect(() => loadConfig({ OPSIFIER_ALLOWED_ORIGINS: "https://a.example/app" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPSIFIER_ALLOWED_ORIGINS: "ftp://a.example" })).toThrow(ConfigError);
  });

  it("rejects malformed trusted proxies", () => {
    expect(() => loadConfig({ OPSIFIER_TRUSTED_PROXIES: "10.0.0.0/99" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPSIFIER_TRUSTED_PROXIES: "proxy.local" })).toThrow(ConfigError);
  });
});

describe("resolveClientIp", () => {
  const trusted = loadConfig({ OPSIFIER_TRUSTED_PROXIES: "10.0.0.0/8,::1" }).trustedProxies;
  const none = loadConfig({}).trustedProxies;

  it("ignores X-Forwarded-For from anyone not configured as a proxy", () => {
    expect(resolveClientIp("203.0.113.5", "1.1.1.1", none)).toBe("203.0.113.5");
    expect(resolveClientIp("203.0.113.5", "1.1.1.1", trusted)).toBe("203.0.113.5");
  });

  it("takes the right-most address a trusted proxy did not add", () => {
    expect(resolveClientIp("10.0.0.2", "1.1.1.1, 203.0.113.9, 10.0.0.3", trusted)).toBe("203.0.113.9");
  });

  it("cannot be spoofed by prepending entries", () => {
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 203.0.113.9", trusted)).toBe("203.0.113.9");
  });

  it("normalizes IPv4-mapped peers and handles a missing peer", () => {
    expect(resolveClientIp("::ffff:203.0.113.5", undefined, none)).toBe("203.0.113.5");
    expect(resolveClientIp(undefined, undefined, none)).toBe("unknown");
  });

  it("falls back to the peer when every hop is a proxy", () => {
    expect(resolveClientIp("10.0.0.2", "10.0.0.3", trusted)).toBe("10.0.0.2");
  });
});
