import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertHostname,
  BACKEND_TLS_TRANSPORT,
  BAD_GATEWAY_MIDDLEWARE,
  BASE_FILE,
  InvalidProxyInputError,
  ProxyFiles,
  renderBaseConfig,
  STOPPED_MIDDLEWARE,
  serviceFileName,
} from "./index";

let directory: string;
let dynamicDir: string;
let files: ProxyFiles;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-proxy-"));
  dynamicDir = join(directory, "traefik", "dynamic");
  files = new ProxyFiles(dynamicDir);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const read = (name: string) => parse(readFileSync(join(dynamicDir, name), "utf8"));

describe("the base configuration", () => {
  it("always has the shared middlewares and the catch-all routes, even before a panel host is set", () => {
    const config = parse(renderBaseConfig());

    expect(Object.keys(config.http.middlewares)).toEqual(
      expect.arrayContaining([
        "opsifier-redirect-https",
        "opsifier-compress",
        BAD_GATEWAY_MIDDLEWARE,
        STOPPED_MIDDLEWARE,
      ]),
    );
    expect(Object.keys(config.http.routers).sort()).toEqual([
      "opsifier-not-found-http",
      "opsifier-not-found-https",
    ]);
    expect(config.http.services["opsifier-panel"].loadBalancer.servers).toEqual([
      { url: "http://opsifier:3000" },
    ]);
  });

  it("answers an unknown host below every real route, redirecting HTTP and showing the panel's page on HTTPS", () => {
    const config = parse(renderBaseConfig());

    expect(config.http.routers["opsifier-not-found-http"]).toEqual({
      rule: "HostRegexp(`.+`)",
      priority: 1,
      entryPoints: ["web"],
      middlewares: ["opsifier-redirect-https"],
      service: "opsifier-panel",
    });
    expect(config.http.routers["opsifier-not-found-https"]).toEqual({
      rule: "HostRegexp(`.+`)",
      priority: 1,
      entryPoints: ["websecure"],
      middlewares: ["opsifier-error-not-found"],
      service: "opsifier-panel",
      tls: {},
    });
    expect(config.http.middlewares["opsifier-error-not-found"]).toEqual({
      replacePath: { path: "/api/proxy-pages/not-found" },
    });
  });

  it("sends 502 and 503 from a backend to the panel's own pages", () => {
    const { middlewares } = parse(renderBaseConfig()).http;

    expect(middlewares[BAD_GATEWAY_MIDDLEWARE]).toEqual({
      errors: { status: ["502"], service: "opsifier-panel", query: "/api/proxy-pages/bad-gateway" },
    });
    expect(middlewares[STOPPED_MIDDLEWARE]).toEqual({
      errors: { status: ["503"], service: "opsifier-panel", query: "/api/proxy-pages/stopped" },
    });
  });

  it("defines a transport for backends speaking HTTPS on the private network", () => {
    const config = parse(renderBaseConfig());
    expect(config.http.serversTransports[BACKEND_TLS_TRANSPORT]).toEqual({ insecureSkipVerify: true });
  });

  it("reaches the panel where it is told to", () => {
    const config = parse(renderBaseConfig({ panelUpstream: "http://host.docker.internal:3202" }));
    expect(config.http.services["opsifier-panel"].loadBalancer.servers).toEqual([
      { url: "http://host.docker.internal:3202" },
    ]);
  });

  it("routes the panel's host to the panel over HTTPS, and redirects HTTP", () => {
    const config = parse(renderBaseConfig({ panelHost: "panel.example.com" }));

    expect(config.http.routers["opsifier-panel"]).toMatchObject({
      rule: "Host(`panel.example.com`)",
      entryPoints: ["websecure"],
      service: "opsifier-panel",
      tls: { certResolver: "letsencrypt" },
    });
    expect(config.http.routers["opsifier-panel-http"]).toMatchObject({
      entryPoints: ["web"],
      middlewares: ["opsifier-redirect-https"],
    });
    expect(config.http.services["opsifier-panel"].loadBalancer.servers).toEqual([
      { url: "http://opsifier:3000" },
    ]);
  });

  it.each([
    "evil`) || Host(`x",
    "a b.com",
    "-bad.example.com",
    "x",
    "1.2.3.4",
    "exa_mple.com",
    "UPPER.example.com",
    "",
  ])("refuses the hostname %j, which would otherwise reach a Traefik rule", (host) => {
    expect(() => renderBaseConfig({ panelHost: host })).toThrow(InvalidProxyInputError);
  });

  it("accepts ordinary hostnames", () => {
    for (const host of ["example.com", "panel.example.co.uk", "a-b.c-d.example", "xn--bcher-kva.example"]) {
      expect(() => assertHostname(host)).not.toThrow();
    }
  });

  it("refuses a bad upstream", () => {
    expect(() => renderBaseConfig({ panelUpstream: "not a url" })).toThrow(InvalidProxyInputError);
    expect(() => renderBaseConfig({ panelUpstream: "http://x/path" })).toThrow(InvalidProxyInputError);
  });
});

describe("the atomic writer", () => {
  it("creates the directory and writes _base.yaml", async () => {
    await files.writeBase({ panelHost: "panel.example.com" });
    expect(read(BASE_FILE).http.routers["opsifier-panel"].rule).toContain("panel.example.com");
  });

  it("writes one file per service with the documented name", async () => {
    await files.writeService("shop", "web", { http: { routers: {} } });
    expect(serviceFileName("shop", "web")).toBe("shop__web.yaml");
    expect(read("shop__web.yaml")).toEqual({ http: { routers: {} } });
  });

  it("leaves no temporary files behind, and none Traefik would load", async () => {
    await files.writeService("shop", "web", { a: 1 });
    await files.writeBase();
    expect(readdirSync(dynamicDir).sort()).toEqual([BASE_FILE, "shop__web.yaml"].sort());
  });

  it("does not make the file world-writable", async () => {
    await files.writeService("shop", "web", { a: 1 });
    expect(statSync(join(dynamicDir, "shop__web.yaml")).mode & 0o022).toBe(0);
  });

  it("applies concurrent writes to one file in order", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => files.writeService("shop", "web", { generation: index })),
    );
    expect(read("shop__web.yaml")).toEqual({ generation: 19 });
    expect(readdirSync(dynamicDir)).toEqual(["shop__web.yaml"]);
  });

  it("removes a service file, and tolerates one already gone", async () => {
    await files.writeService("shop", "web", { a: 1 });
    await files.removeService("shop", "web");
    await files.removeService("shop", "web");
    expect(readdirSync(dynamicDir)).toEqual([]);
  });

  it("cleans up and keeps what was there when the rename fails", async () => {
    // A directory at the target path makes the final rename fail.
    mkdirSync(join(dynamicDir, "broken__svc.yaml"), { recursive: true });

    await expect(files.writeService("broken", "svc", { a: 1 })).rejects.toThrow();
    expect(readdirSync(dynamicDir)).toEqual(["broken__svc.yaml"]);
    expect(statSync(join(dynamicDir, "broken__svc.yaml")).isDirectory()).toBe(true);
  });

  it("rejects an unsafe name without touching the disk", async () => {
    await files.writeService("shop", "web", { generation: 1 });
    await expect(files.writeService("../shop", "web", { generation: 2 })).rejects.toThrow(
      InvalidProxyInputError,
    );
    expect(read("shop__web.yaml")).toEqual({ generation: 1 });
  });

  it("does not let one failed write block the next", async () => {
    mkdirSync(join(dynamicDir, "shop__web.yaml"), { recursive: true });
    await expect(files.writeService("shop", "web", { a: 1 })).rejects.toThrow();
    rmSync(join(dynamicDir, "shop__web.yaml"), { recursive: true });
    await files.writeService("shop", "web", { generation: 2 });
    expect(read("shop__web.yaml")).toEqual({ generation: 2 });
  });
});

describe("service file names", () => {
  it.each([
    ["../etc", "web"],
    ["shop", "../../secret"],
    ["shop/x", "web"],
    ["", "web"],
    ["UPPER", "web"],
  ])("refuses the unsafe pair %j, %j", (project, service) => {
    expect(() => serviceFileName(project, service)).toThrow();
  });

  it("refuses names that would make two services collide on one file", () => {
    expect(() => serviceFileName("a__b", "c")).toThrow(InvalidProxyInputError);
    expect(() => serviceFileName("a", "b__c")).toThrow(InvalidProxyInputError);
  });
});
