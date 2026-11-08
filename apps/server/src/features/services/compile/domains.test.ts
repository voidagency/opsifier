import { describe, expect, it } from "vitest";
import {
  BACKEND_TLS_TRANSPORT,
  BAD_GATEWAY_MIDDLEWARE,
  InvalidProxyInputError,
  PANEL_SERVICE,
  STOPPED_MIDDLEWARE,
} from "../../../core/proxy";
import { type CompiledDomains, compileDomains, type DomainInput, internalUrl } from "./domains";
import { compileMiddlewares, REDIRECT_HTTPS_MIDDLEWARE } from "./middlewares";

const plain = (overrides: Partial<DomainInput> = {}): DomainInput => ({
  host: "whoami.example.test",
  path: "/",
  port: 80,
  https: false,
  ...overrides,
});

const compile = (
  domains: DomainInput[],
  options: { stopped?: boolean; middlewares?: ReturnType<typeof compileMiddlewares> } = {},
): CompiledDomains =>
  compileDomains({
    qualifiedName: "shop_web",
    domains,
    stopped: options.stopped ?? false,
    middlewares: options.middlewares ?? compileMiddlewares({ qualifiedName: "shop_web" }),
  });

describe("WRK-19 domains", () => {
  it("gains only the http router when HTTPS is off", () => {
    const compiled = compile([plain({ host: "first.example.test", https: true }), plain()]);

    expect(Object.keys(compiled.routers)).toEqual(["http-shop_web-0", "https-shop_web-0", "http-shop_web-1"]);
    expect(compiled.routers["http-shop_web-1"]?.entryPoints).toEqual(["web"]);
  });

  it("does not redirect an HTTP-only domain, and redirects an HTTPS one", () => {
    const compiled = compile([plain(), plain({ host: "secure.example.test", https: true })]);

    expect(compiled.routers["http-shop_web-0"]?.middlewares).toEqual([BAD_GATEWAY_MIDDLEWARE]);
    expect(compiled.routers["http-shop_web-1"]?.middlewares).toEqual([
      REDIRECT_HTTPS_MIDDLEWARE,
      BAD_GATEWAY_MIDDLEWARE,
    ]);
  });

  it("writes the path into the rule and leaves it on the request", () => {
    const compiled = compile([plain({ path: "/api" })]);

    expect(compiled.routers["http-shop_web-0"]?.rule).toBe(
      "Host(`whoami.example.test`) && PathPrefix(`/api`)",
    );
    // No path-stripping middleware: the backend sees /api/hello.
    expect(compiled.middlewares).toEqual({});
    expect(compiled.routers["http-shop_web-0"]?.middlewares).toEqual([BAD_GATEWAY_MIDDLEWARE]);
  });

  it("removes a domain's routers when the domain is gone", () => {
    expect(compile([]).routers).toEqual({});
    expect(compile([]).services).toEqual({});
  });

  it("puts the destination port and protocol in the upstream, and the internal URL matches it", () => {
    const compiled = compile([plain({ port: 8080, destinationProtocol: "https" })]);

    expect(compiled.services["shop_web-0"]?.loadBalancer.servers).toEqual([
      { url: "https://shop_web:8080/" },
    ]);
    expect(internalUrl("shop_web", 8080, "https", "/")).toBe("https://shop_web:8080/");
    expect(compiled.services["shop_web-0"]?.loadBalancer.serversTransport).toBe(BACKEND_TLS_TRANSPORT);
  });

  it("leaves plain HTTP upstreams on the default transport", () => {
    expect(compile([plain()]).services["shop_web-0"]?.loadBalancer.serversTransport).toBeUndefined();
  });

  it("makes the destination path real, by prefixing it for the backend", () => {
    const compiled = compile([plain({ path: "/api", destinationPath: "/internal" })]);

    expect(compiled.middlewares["opsifier-prefix-shop_web-0"]).toEqual({
      addPrefix: { prefix: "/internal" },
    });
    expect(compiled.routers["http-shop_web-0"]?.middlewares?.at(-1)).toBe("opsifier-prefix-shop_web-0");
    expect(compiled.services["shop_web-0"]?.loadBalancer.servers).toEqual([
      { url: "http://shop_web:80/internal" },
    ]);
  });

  it("adds nothing for the default destination path", () => {
    expect(compile([plain({ destinationPath: "/" })]).middlewares).toEqual({});
  });
});

describe("WRK-20 HTTPS, SSL options and middlewares", () => {
  it("uses the default resolver when none is named", () => {
    const compiled = compile([plain({ https: true, certificateResolver: null })]);

    expect(compiled.routers["https-shop_web-0"]?.tls).toEqual({
      certResolver: "letsencrypt",
      domains: [{ main: "whoami.example.test" }],
    });
  });

  it("uses a named resolver", () => {
    const compiled = compile([plain({ https: true, certificateResolver: "cloudflare" })]);
    expect(compiled.routers["https-shop_web-0"]?.tls?.certResolver).toBe("cloudflare");
  });

  it("issues a wildcard certificate and matches every direct subdomain", () => {
    const compiled = compile([plain({ https: true, wildcard: true, certificateResolver: "cloudflare" })]);

    expect(compiled.routers["https-shop_web-0"]?.rule).toBe(
      "HostRegexp(`^[a-z0-9-]+\\.whoami\\.example\\.test$`) && PathPrefix(`/`)",
    );
    expect(compiled.routers["https-shop_web-0"]?.tls?.domains).toEqual([{ main: "*.whoami.example.test" }]);
  });

  it("ranks a wildcard below any exact host, with an explicit low priority", () => {
    const compiled = compile([
      plain({ wildcard: true, certificateResolver: "cloudflare" }),
      plain({ wildcard: true, certificateResolver: "cloudflare", path: "/api" }),
    ]);
    const first = compiled.routers["http-shop_web-0"]?.priority ?? 0;
    const second = compiled.routers["http-shop_web-1"]?.priority ?? 0;

    expect(first).toBeLessThan(30);
    expect(first).toBeGreaterThan(1);
    expect(second).toBeGreaterThan(first);
  });

  it("leaves an exact host on Traefik's default priority", () => {
    expect(compile([plain()]).routers["http-shop_web-0"]?.priority).toBeUndefined();
  });

  it("attaches the middlewares named on a domain, in order, after the error pages", () => {
    const compiled = compile([plain({ middlewares: ["rate-limit", "compress@file"] })]);

    expect(compiled.routers["http-shop_web-0"]?.middlewares).toEqual([
      BAD_GATEWAY_MIDDLEWARE,
      "rate-limit",
      "compress@file",
    ]);
  });
});

describe("the bad gateway page", () => {
  it("is on every router, so a closed port shows the panel's page", () => {
    const compiled = compile([plain({ port: 9999, https: true })]);

    expect(compiled.routers["http-shop_web-0"]?.middlewares).toContain(BAD_GATEWAY_MIDDLEWARE);
    expect(compiled.routers["https-shop_web-0"]?.middlewares).toContain(BAD_GATEWAY_MIDDLEWARE);
  });
});

describe("a stopped service", () => {
  it("keeps its routers, has no servers, and shows the panel's stopped page", () => {
    const compiled = compile([plain({ https: true })], { stopped: true });

    expect(compiled.services["shop_web-0"]?.loadBalancer.servers).toEqual([]);
    expect(compiled.routers["https-shop_web-0"]?.middlewares).toContain(STOPPED_MIDDLEWARE);
    expect(compiled.routers["http-shop_web-0"]?.middlewares).toContain(STOPPED_MIDDLEWARE);
  });

  it("does not attach the stopped page to a running service", () => {
    const compiled = compile([plain()]);
    expect(compiled.routers["http-shop_web-0"]?.middlewares).not.toContain(STOPPED_MIDDLEWARE);
  });
});

describe("maintenance on the routers", () => {
  const middlewares = compileMiddlewares({
    qualifiedName: "shop_web",
    project: "shop",
    service: "web",
    maintenance: { enabled: true },
  });

  it("switches every router to the panel and keeps the redirect on HTTP", () => {
    const compiled = compile([plain({ https: true, destinationPath: "/internal" })], { middlewares });

    for (const router of Object.values(compiled.routers)) {
      expect(router.service).toBe(PANEL_SERVICE);
      expect(router.middlewares?.at(-1)).toBe("opsifier-maintenance-shop_web");
      expect(router.middlewares).not.toContain("opsifier-prefix-shop_web-0");
    }
    expect(compiled.routers["http-shop_web-0"]?.middlewares?.[0]).toBe(REDIRECT_HTTPS_MIDDLEWARE);
  });

  it("leaves the page to the panel even while the service is stopped", () => {
    const compiled = compile([plain()], { stopped: true, middlewares });

    expect(compiled.routers["http-shop_web-0"]?.service).toBe(PANEL_SERVICE);
    expect(compiled.routers["http-shop_web-0"]?.middlewares).not.toContain(STOPPED_MIDDLEWARE);
  });
});

describe("what the compiler refuses, whoever saved it", () => {
  const rejected = (overrides: Partial<DomainInput>) => () => compile([plain(overrides)]);

  it.each([
    ["evil`) || Host(`x"],
    ["a b.example.test"],
    ["UPPER.example.test"],
    ["trailing.example.test."],
    ["-leading.example.test"],
    ["example"],
    ["1.2.3.4"],
    [""],
    ["exa_mple.test"],
    ["*.example.test"],
    ["x".repeat(254)],
  ])("the host %j", (host) => {
    expect(rejected({ host })).toThrow(InvalidProxyInputError);
  });

  it.each([
    ["/no`tick"],
    ["noslash"],
    [""],
    ["/two//slashes"],
    ["/dot/../segment"],
    ["/spaces in path"],
    ["/%zz"],
    ['/quote"inside'],
    ["/line\nbreak"],
  ])("the path %j", (path) => {
    expect(rejected({ path })).toThrow(InvalidProxyInputError);
  });

  it.each([[0], [65536], [1.5], [-1]])("the port %j", (port) => {
    expect(rejected({ port })).toThrow(InvalidProxyInputError);
  });

  it.each([["bad resolver"], ["back`tick"], ["a/b"]])("the resolver %j", (certificateResolver) => {
    expect(rejected({ certificateResolver })).toThrow(InvalidProxyInputError);
  });

  it.each([["bad name"], ["back`tick"], [""], ["a b@file"]])("the middleware %j", (name) => {
    expect(rejected({ middlewares: [name] })).toThrow(InvalidProxyInputError);
  });

  it("the destination path", () => {
    expect(rejected({ destinationPath: "nope" })).toThrow(InvalidProxyInputError);
  });

  it("keeps every other service out of it: one bad domain only stops its own compile", () => {
    // Each service compiles to its own file, so this is all one domain can ever affect.
    expect(rejected({ host: "x y" })).toThrow(InvalidProxyInputError);
    expect(() => compile([plain()])).not.toThrow();
  });
});
