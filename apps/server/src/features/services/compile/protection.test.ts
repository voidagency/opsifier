import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BASE_FILE, renderBaseConfig } from "../../../core/proxy";
import {
  auditRoutingFiles,
  EXEMPT_ROUTER_PREFIX,
  GATE_MIDDLEWARE,
  NOINDEX_MIDDLEWARE,
  type ProtectionPlan,
  protectBaseConfig,
  protectRoutingFile,
  protectServiceConfig,
  ROBOTS_ROUTER_PREFIX,
  ROBOTS_TAG,
  ROBOTS_TXT_PATH,
  stripProtection,
} from "./protection";

const HOST = "app.example.test";
const rule = `Host(\`${HOST}\`) && PathPrefix(\`/\`)`;
const tls = { certResolver: "letsencrypt", domains: [{ main: HOST }] };

/** Two entry points for one domain, as `compileDomains` writes them. */
const appConfig = () => ({
  http: {
    routers: {
      "http-shop_web-0": {
        rule,
        entryPoints: ["web"],
        service: "shop_web-0",
        middlewares: ["opsifier-redirect-https", "opsifier-error-bad-gateway"],
      },
      "https-shop_web-0": {
        rule,
        entryPoints: ["websecure"],
        service: "shop_web-0",
        middlewares: ["opsifier-error-bad-gateway"],
        tls,
      },
    },
    services: {
      "shop_web-0": { loadBalancer: { passHostHeader: true, servers: [{ url: "http://shop_web:80/" }] } },
    },
  },
});

const on: ProtectionPlan = { enabled: true, users: ["alice:$2y$10$hash"], exemptions: [] };
const production: ProtectionPlan = { enabled: false, users: [], exemptions: [] };

type Routed = {
  http: {
    routers: Record<
      string,
      {
        rule: string;
        middlewares?: string[];
        priority?: number;
        service: string;
        entryPoints?: string[];
        tls?: unknown;
      }
    >;
    middlewares?: Record<string, unknown>;
  };
};
const protect = (config: unknown, plan: ProtectionPlan = on) =>
  protectServiceConfig(config, plan) as unknown as Routed;

describe("protecting a service's routes", () => {
  it("puts the header first and the gate on every route, after a redirect so credentials are not asked over HTTP", () => {
    const { http } = protect(appConfig());

    expect(http.routers["http-shop_web-0"]?.middlewares).toEqual([
      NOINDEX_MIDDLEWARE,
      "opsifier-redirect-https",
      GATE_MIDDLEWARE,
      "opsifier-error-bad-gateway",
    ]);
    expect(http.routers["https-shop_web-0"]?.middlewares).toEqual([
      NOINDEX_MIDDLEWARE,
      GATE_MIDDLEWARE,
      "opsifier-error-bad-gateway",
    ]);
  });

  it("gives every host its own robots.txt route per entry point, above any rule and outside the gate", () => {
    const { http } = protect(appConfig());
    const robots = http.routers[`${ROBOTS_ROUTER_PREFIX}https-shop_web-0`];

    expect(robots).toMatchObject({
      rule: `Host(\`${HOST}\`) && Path(\`/robots.txt\`)`,
      priority: 1_000_000,
      entryPoints: ["websecure"],
      service: "opsifier-panel",
      tls,
    });
    expect(robots?.middlewares).toContain(NOINDEX_MIDDLEWARE);
    expect(robots?.middlewares).not.toContain(GATE_MIDDLEWARE);
    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}http-shop_web-0`]?.entryPoints).toEqual(["web"]);
  });

  it("makes one robots.txt route per host even when a host has several paths", () => {
    const config = appConfig();
    const routers = config.http.routers as Record<string, unknown>;
    routers["https-shop_web-1"] = {
      rule: `Host(\`${HOST}\`) && PathPrefix(\`/api\`)`,
      entryPoints: ["websecure"],
      service: "shop_web-1",
      tls,
    };
    const robots = Object.keys(protect(config).http.routers).filter((name) =>
      name.startsWith(ROBOTS_ROUTER_PREFIX),
    );

    expect(robots).toHaveLength(2);
  });

  it("is idempotent, and protecting then stripping gives back the original", () => {
    const once = protect(appConfig());
    const twice = protect(once);

    expect(twice).toEqual(once);
    expect(stripProtection(once)).toEqual(appConfig());
  });

  it("adds nothing on production, and takes earlier protection off", () => {
    const already = protect(appConfig());

    expect(protect(appConfig(), production)).toEqual(appConfig());
    expect(protect(already, production)).toEqual(appConfig());
  });

  it("protects a wildcard and keeps its priority rule", () => {
    const { http } = protect({
      http: {
        routers: {
          "https-shop_w-0": {
            rule: "HostRegexp(`^[a-z0-9-]+\\.example\\.test$`) && PathPrefix(`/`)",
            priority: 3,
            entryPoints: ["websecure"],
            service: "s",
          },
        },
      },
    });

    expect(http.routers["https-shop_w-0"]?.priority).toBe(3);
    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}https-shop_w-0`]?.rule).toBe(
      "HostRegexp(`^[a-z0-9-]+\\.example\\.test$`) && Path(`/robots.txt`)",
    );
  });

  it("covers every host of a rule with several", () => {
    const { http } = protect({
      http: {
        routers: {
          multi: { rule: "Host(`a.example.test`) || Host(`b.example.test`)", service: "s" },
        },
      },
    });

    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}multi`]?.rule).toBe(
      "(Host(`a.example.test`) || Host(`b.example.test`)) && Path(`/robots.txt`)",
    );
  });

  it("still gives a robots.txt route to a rule with no host", () => {
    const { http } = protect({ http: { routers: { all: { rule: "PathPrefix(`/x`)", service: "s" } } } });

    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}all`]?.rule).toBe("Path(`/robots.txt`)");
  });

  it("refuses raw TCP routes, which basic auth cannot reach", () => {
    expect(() =>
      protect({ http: {}, tcp: { routers: { db: { rule: "HostSNI(`*`)", service: "s" } } } }),
    ).toThrow(/tcp route can't be protected/);
    expect(() => protect({ tcp: { routers: {} } }, production)).not.toThrow();
  });

  it("keeps a service's own basic auth working behind one gate that also accepts its users", () => {
    const { http } = protect({
      http: {
        routers: { r: { rule, service: "s", middlewares: ["own-auth"], entryPoints: ["web"] } },
        middlewares: { "own-auth": { basicAuth: { users: ["bob:$2y$10$own"], removeHeader: true } } },
      },
    });

    const gate = `${GATE_MIDDLEWARE}-r`;
    expect(http.routers.r?.middlewares).toEqual([NOINDEX_MIDDLEWARE, gate, "own-auth"]);
    expect(http.middlewares?.[gate]).toMatchObject({
      basicAuth: { users: ["alice:$2y$10$hash", "bob:$2y$10$own"], removeHeader: false },
    });
    expect(http.middlewares?.["own-auth"]).toEqual({
      basicAuth: { users: ["bob:$2y$10$own"], removeHeader: true },
    });
  });

  it("locks the gate when there are no credentials, instead of publishing the route open", () => {
    const { http } = protect(protectBaseConfig({ http: { routers: {} } }, { ...on, users: [] }), {
      ...on,
      users: [],
    });
    const base = protectBaseConfig({ http: { routers: {} } }, { ...on, users: [] }) as Routed;

    expect(http.routers).toEqual({});
    expect(base.http.middlewares?.[GATE_MIDDLEWARE]).toMatchObject({
      basicAuth: { users: [expect.stringMatching(/^locked:\$2y\$10\$\*{53}$/)] },
    });
  });
});

describe("exemptions", () => {
  const withExemption = (kind: "path" | "ip", value: string) =>
    protect(appConfig(), { ...on, exemptions: [{ kind, value }] });

  it("adds a route for an exact path that needs no credentials but keeps the header", () => {
    const { http } = withExemption("path", "/healthz");
    const exempt = http.routers[`${EXEMPT_ROUTER_PREFIX}https-shop_web-0-0`];

    expect(exempt?.rule).toBe(`(${rule}) && Path(\`/healthz\`)`);
    expect(exempt?.middlewares).toEqual([NOINDEX_MIDDLEWARE, "opsifier-error-bad-gateway"]);
    expect(exempt?.priority).toBe(rule.length + 1);
  });

  it("turns /hooks/* into a prefix", () => {
    expect(
      withExemption("path", "/hooks/*").http.routers[`${EXEMPT_ROUTER_PREFIX}http-shop_web-0-0`]?.rule,
    ).toBe(`(${rule}) && PathPrefix(\`/hooks/\`)`);
  });

  it("adds a route for an IP range", () => {
    expect(
      withExemption("ip", "203.0.113.0/24").http.routers[`${EXEMPT_ROUTER_PREFIX}http-shop_web-0-0`]?.rule,
    ).toBe(`(${rule}) && ClientIP(\`203.0.113.0/24\`)`);
  });

  it("stays above a wildcard's priority by one, not by the length of its rule", () => {
    const { http } = protect(
      { http: { routers: { w: { rule: "HostRegexp(`^x$`)", priority: 5, service: "s" } } } },
      { ...on, exemptions: [{ kind: "path", value: "/ok" }] },
    );

    expect(http.routers[`${EXEMPT_ROUTER_PREFIX}w-0`]?.priority).toBe(6);
  });

  it("ignores an entry that is not valid, leaving the route protected", () => {
    const { http } = withExemption("path", "/`) || Host(`evil");

    expect(Object.keys(http.routers).filter((name) => name.startsWith(EXEMPT_ROUTER_PREFIX))).toEqual([]);
  });
});

describe("protecting the panel's own routes", () => {
  const base = () => parse(renderBaseConfig({ panelHost: "panel.example.test" }));

  it("adds the header and robots.txt but never the gate", () => {
    const { http } = protectBaseConfig(base(), on) as Routed;

    expect(http.routers["opsifier-panel"]?.middlewares).toEqual([NOINDEX_MIDDLEWARE]);
    expect(http.routers["opsifier-panel-http"]?.middlewares).toEqual([
      NOINDEX_MIDDLEWARE,
      "opsifier-redirect-https",
    ]);
    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}opsifier-panel`]).toMatchObject({
      rule: "Host(`panel.example.test`) && Path(`/robots.txt`)",
      priority: 1_000_000,
    });
  });

  it("answers robots.txt on unknown hosts below every real route", () => {
    const { http } = protectBaseConfig(base(), on) as Routed;
    const anyHost = http.routers[`${ROBOTS_ROUTER_PREFIX}opsifier-not-found-https`];

    expect(anyHost?.rule).toBe("HostRegexp(`.+`) && Path(`/robots.txt`)");
    expect(anyHost?.priority).toBe(2);
    expect(http.routers["opsifier-not-found-https"]?.middlewares?.[0]).toBe(NOINDEX_MIDDLEWARE);
  });

  it("defines the shared middlewares once, in the base file, with the header and the page", () => {
    const { http } = protectBaseConfig(base(), on) as Routed;

    expect(http.middlewares?.[NOINDEX_MIDDLEWARE]).toEqual({
      headers: { customResponseHeaders: { "X-Robots-Tag": ROBOTS_TAG } },
    });
    expect(http.middlewares?.["opsifier-protect-robots-path"]).toEqual({
      replacePath: { path: ROBOTS_TXT_PATH },
    });
  });

  it("protects every panel hostname of a rule with several", () => {
    const input = parse(renderBaseConfig({ panelHost: "a.example.test", panelHosts: ["b.example.test"] }));
    const { http } = protectBaseConfig(input, on) as Routed;

    expect(http.routers[`${ROBOTS_ROUTER_PREFIX}opsifier-panel`]?.rule).toBe(
      "(Host(`a.example.test`) || Host(`b.example.test`)) && Path(`/robots.txt`)",
    );
  });

  it("is untouched on production", () => {
    expect(protectBaseConfig(base(), production)).toEqual(base());
  });

  it("goes through the base handling when the file is the base file", () => {
    const viaFile = protectRoutingFile(BASE_FILE, base(), on) as Routed;

    expect(viaFile.http.routers["opsifier-panel"]?.middlewares).toEqual([NOINDEX_MIDDLEWARE]);
  });
});

describe("the audit, which reads back what the proxy was given", () => {
  const baseFile = (plan: ProtectionPlan = on) => ({
    file: BASE_FILE,
    config: protectBaseConfig(parse(renderBaseConfig()), plan),
  });
  const serviceFile = (config: unknown, file = "shop__web.yaml") => ({ file, config });

  it("counts a domain once and calls it protected only if all its routes are", () => {
    const audit = auditRoutingFiles([baseFile(), serviceFile(protect(appConfig()))], true);

    expect(audit.domains).toEqual([
      { host: HOST, path: "/", wildcard: false, file: "shop__web.yaml", protected: true },
    ]);
    expect(audit.panelProtected).toBe(true);
    expect(audit.unreadable).toEqual([]);
  });

  it("reports a domain with one bare route as not protected", () => {
    const config = protect(appConfig());
    const routers = config.http.routers;
    if (routers["https-shop_web-0"] !== undefined) {
      delete routers["https-shop_web-0"].middlewares;
    }

    expect(auditRoutingFiles([baseFile(), serviceFile(config)], true).domains[0]?.protected).toBe(false);
  });

  it("says a route whose gate definition is missing is not protected", () => {
    const audit = auditRoutingFiles([serviceFile(protect(appConfig()))], true);

    expect(audit.domains[0]?.protected).toBe(false);
  });

  it("recognises a wildcard domain", () => {
    const config = protect({
      http: {
        routers: {
          w: { rule: "HostRegexp(`^[a-z0-9-]+\\.example\\.test$`) && PathPrefix(`/`)", service: "s" },
        },
      },
    });

    expect(auditRoutingFiles([baseFile(), serviceFile(config)], true).domains[0]).toMatchObject({
      host: "example.test",
      wildcard: true,
      protected: true,
    });
  });

  it("reads a route's own path back from a rule with a segment boundary", () => {
    const config = protect({
      http: {
        routers: {
          r: { rule: `Host(\`${HOST}\`) && (Path(\`/api\`) || PathPrefix(\`/api/\`))`, service: "s" },
        },
      },
    });

    expect(auditRoutingFiles([baseFile(), serviceFile(config)], true).domains[0]).toMatchObject({
      host: HOST,
      path: "/api",
      protected: true,
    });
  });

  it("still reads a rule written before paths had a boundary", () => {
    const config = {
      http: { routers: { r: { rule: `Host(\`${HOST}\`) && PathPrefix(\`/api\`)`, service: "s" } } },
    };

    expect(auditRoutingFiles([baseFile(), serviceFile(config)], false).domains[0]?.path).toBe("/api");
  });

  it("says when the panel's routes are missing the header, and lists an unreadable file", () => {
    const audit = auditRoutingFiles(
      [
        { file: BASE_FILE, config: parse(renderBaseConfig()) },
        { file: "bad.yaml", config: null },
      ],
      true,
    );

    expect(audit.panelProtected).toBe(false);
    expect(audit.unreadable).toEqual(["bad.yaml"]);
  });

  it("has nothing to say about the panel on production", () => {
    expect(auditRoutingFiles([baseFile(production)], false).panelProtected).toBe(true);
  });
});
