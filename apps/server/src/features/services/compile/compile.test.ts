import { deploySettings, parseEnvText, resourcesSpec } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { BAD_GATEWAY_MIDDLEWARE, InvalidProxyInputError } from "../../../core/proxy";
import { type AppServiceSpec, appServiceSpec } from "../spec";
import { compileDeploy } from "./deploy";
import { compileDomains } from "./domains";
import { compileEnv } from "./env";
import { type CompileDomain, compileService } from "./index";
import { compileMiddlewares, REDIRECT_HTTPS_MIDDLEWARE } from "./middlewares";
import { bindMountRisk, compileMounts, UnacknowledgedMountError } from "./mounts";
import { compilePorts } from "./ports";
import { compileResources } from "./resources";

const image = { type: "image" as const, image: "traefik/whoami:v1.10", username: null, sealedPassword: null };
const defaultDomain: CompileDomain = {
  host: "shop-web.203.0.113.10.sslip.io",
  path: "/",
  port: 80,
  https: true,
  primary: true,
};

function spec(overrides: Partial<AppServiceSpec> = {}): AppServiceSpec {
  return { ...appServiceSpec.parse({}), source: image, ...overrides };
}

function compile(
  overrides: Partial<AppServiceSpec> = {},
  options: { env?: string; domains?: CompileDomain[]; forceUpdate?: number } = {},
) {
  return compileService({
    project: { name: "shop", env: options.env ?? "" },
    service: { name: "web", spec: spec(overrides) },
    domains: options.domains ?? [defaultDomain],
    dataDir: "/var/lib/opsifier",
    forceUpdate: options.forceUpdate ?? 0,
  });
}

function container(result: ReturnType<typeof compile>) {
  const swarm = result.swarmSpec;
  if (swarm === null) {
    throw new Error("Expected a Swarm spec");
  }
  return swarm.TaskTemplate.ContainerSpec;
}

describe("the env compiler", () => {
  const env = (serviceEnv: string, overrides: Partial<Parameters<typeof compileEnv>[0]> = {}) =>
    compileEnv({
      project: "probe-app",
      service: "whoami",
      projectEnv: "",
      serviceEnv,
      primaryHost: "whoami.example.test",
      port: 80,
      ...overrides,
    });

  it("turns the sample file into exactly the expected variables, in order", () => {
    const sample = [
      "FOO=bar",
      'QUOTED="hello world"',
      "WITH_SPACE=hello world",
      "# a comment",
      "REF_PROJECT=$(PROJECT_NAME)",
      "REF_SERVICE=$(SERVICE_NAME)",
      "REF_PRIMARY=$(PRIMARY_DOMAIN)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
      "SHARED_REF=${SHARED_ONE}",
      "SHARED_REF2=$(SHARED_ONE)",
      "EMPTY_VAL=",
    ].join("\n");

    expect(env(sample, { projectEnv: "SHARED_ONE=project-value" })).toEqual([
      "PORT=80",
      "SHARED_ONE=project-value",
      "FOO=bar",
      "QUOTED=hello world",
      "WITH_SPACE=hello world",
      "REF_PROJECT=probe-app",
      "REF_SERVICE=whoami",
      "REF_PRIMARY=whoami.example.test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
      "SHARED_REF=${SHARED_ONE}",
      "SHARED_REF2=$(SHARED_ONE)",
      "EMPTY_VAL=",
    ]);
  });

  it("injects PORT first, from the primary domain's target port", () => {
    expect(env("", { port: 8080 })).toEqual(["PORT=8080"]);
  });

  it("drops comments, including indented ones, and blank lines", () => {
    expect(env("# one\n\n   # two\n  \nKEY=value\r\n")).toEqual(["PORT=80", "KEY=value"]);
  });

  it("lets a service variable come after the same project variable, so the service wins", () => {
    expect(env("MODE=service", { projectEnv: "MODE=project" })).toEqual([
      "PORT=80",
      "MODE=project",
      "MODE=service",
    ]);
  });

  it("does not expand a variable from the project into a service value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
    expect(env("REF=${A} $(A)", { projectEnv: "A=1" })).toContain("REF=${A} $(A)");
  });

  it("removes only surrounding double quotes", () => {
    expect(parseEnvText(`A="x"\nB='y'\nC="un\nD="\nE=a"b"c`)).toEqual([
      { key: "A", value: "x" },
      { key: "B", value: "'y'" },
      { key: "C", value: '"un' },
      { key: "D", value: '"' },
      { key: "E", value: 'a"b"c' },
    ]);
  });

  it("never adds a timestamp or a Git revision", () => {
    expect(env("").join("\n")).not.toMatch(/DEPLOY_TIMESTAMP|GIT_SHA/);
  });
});

describe("the mounts compiler", () => {
  const compileThese = (mounts: Parameters<typeof compileMounts>[0]["mounts"]) =>
    compileMounts({ mounts, project: "shop", service: "web", dataDir: "/var/lib/opsifier" });

  it("compiles bind, named volume and file mounts", () => {
    const compiled = compileThese([
      { type: "bind", hostPath: "/tmp", mountPath: "/mnt/bind", acknowledgeRisk: false },
      { type: "volume", name: "data", mountPath: "/data/vol" },
      { type: "file", mountPath: "/etc/app/config.txt", content: "hello" },
    ]);

    expect(compiled.mounts).toEqual([
      { Type: "bind", Source: "/tmp", Target: "/mnt/bind" },
      { Type: "volume", Source: "shop_web_data", Target: "/data/vol" },
      {
        Type: "bind",
        Source: "/var/lib/opsifier/projects/shop/web/files/2.txt",
        Target: "/etc/app/config.txt",
      },
    ]);
    expect(compiled.files).toEqual([
      { path: "/var/lib/opsifier/projects/shop/web/files/2.txt", content: "hello", mode: 0o644 },
    ]);
    expect(compiled.volumes).toEqual([
      {
        name: "shop_web_data",
        directory: "/var/lib/opsifier/projects/shop/web/volumes/data",
        labels: { "opsifier.project": "shop", "opsifier.service": "web" },
      },
    ]);
    expect(compiled.constraints).toEqual(["node.role==manager"]);
  });

  it("adds nothing for a service without mounts", () => {
    expect(compileThese([])).toEqual({ mounts: [], files: [], volumes: [], constraints: [] });
  });

  it.each([
    ["the data directory", "/var/lib/opsifier"],
    ["a folder inside the data directory", "/var/lib/opsifier/traefik"],
    ["a parent of the data directory", "/var/lib"],
    ["the whole disk", "/"],
    ["the Docker socket", "/var/run/docker.sock"],
    ["the Docker socket by its other path", "/run/docker.sock"],
    ["the directory holding the socket", "/var/run"],
  ])("refuses to compile an unconfirmed bind mount of %s", (_what, hostPath) => {
    expect(() => compileThese([{ type: "bind", hostPath, mountPath: "/x", acknowledgeRisk: false }])).toThrow(
      UnacknowledgedMountError,
    );
  });

  it("compiles a dangerous bind mount that was confirmed", () => {
    expect(
      compileThese([
        {
          type: "bind",
          hostPath: "/var/run/docker.sock",
          mountPath: "/var/run/docker.sock",
          acknowledgeRisk: true,
        },
      ]).mounts,
    ).toEqual([{ Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" }]);
  });

  it("does not take a sibling of the data directory for the data directory", () => {
    expect(bindMountRisk("/var/lib/opsifier-backups", "/var/lib/opsifier")).toBeNull();
    expect(bindMountRisk("/srv/app", "/var/lib/opsifier")).toBeNull();
  });

  it("names what a dangerous bind mount exposes, the worst first", () => {
    expect(bindMountRisk("/", "/var/lib/opsifier")).toBe("docker-socket");
    expect(bindMountRisk("/var/lib/opsifier/x", "/var/lib/opsifier")).toBe("data-directory");
    expect(bindMountRisk("/var/run/docker.sock", "/var/lib/opsifier")).toBe("docker-socket");
    expect(bindMountRisk("/custom/d.sock", "/var/lib/opsifier", ["/custom/d.sock"])).toBe("docker-socket");
  });
});

describe("the ports compiler", () => {
  it("publishes each port in host mode and keeps the virtual IP", () => {
    expect(
      compilePorts([
        { protocol: "tcp", published: 30080, target: 80 },
        { protocol: "udp", published: 30053, target: 53 },
      ]),
    ).toEqual({
      Mode: "vip",
      Ports: [
        { Protocol: "tcp", TargetPort: 80, PublishedPort: 30080, PublishMode: "host" },
        { Protocol: "udp", TargetPort: 53, PublishedPort: 30053, PublishMode: "host" },
      ],
    });
  });

  it("omits the list when nothing is published", () => {
    expect(compilePorts([])).toEqual({ Mode: "vip" });
  });
});

describe("the resources compiler", () => {
  it("converts megabytes and cores to Docker's units", () => {
    expect(
      compileResources(
        resourcesSpec.parse({ memoryReservation: 64, memoryLimit: 128, cpuReservation: 0.1, cpuLimit: 0.5 }),
      ),
    ).toEqual({
      Limits: { MemoryBytes: 134217728, NanoCPUs: 500000000 },
      Reservations: { MemoryBytes: 67108864, NanoCPUs: 100000000 },
    });
  });

  it("leaves zero values out", () => {
    expect(compileResources(resourcesSpec.parse({}))).toEqual({ Limits: {}, Reservations: {} });
  });
});

describe("the deploy settings compiler", () => {
  const settings = (overrides = {}) => deploySettings.parse(overrides);

  it("defaults to a zero-downtime rolling update with the fixed restart policy", () => {
    const compiled = compileDeploy({ settings: settings(), stopped: false, forceUpdate: 0 });

    expect(compiled.UpdateConfig).toEqual({
      Parallelism: 1,
      FailureAction: "pause",
      Monitor: 5_000_000_000,
      MaxFailureRatio: 0,
      Order: "start-first",
    });
    expect(compiled.RollbackConfig).toMatchObject({ Order: "stop-first", FailureAction: "pause" });
    expect(compiled.task.RestartPolicy).toEqual({
      Condition: "on-failure",
      Delay: 5_000_000_000,
      MaxAttempts: 0,
    });
    expect(compiled.task.LogDriver).toEqual({
      Name: "json-file",
      Options: { "max-file": "3", "max-size": "10m" },
    });
    expect(compiled.container).toMatchObject({ Init: false, StopGracePeriod: 10_000_000_000 });
  });

  it("stops first when zero downtime is off", () => {
    const compiled = compileDeploy({
      settings: settings({ zeroDowntime: false }),
      stopped: false,
      forceUpdate: 0,
    });
    expect(compiled.UpdateConfig.Order).toBe("stop-first");
  });

  it("stops first while ports are published, so a new task can bind them", () => {
    expect(
      compileDeploy({ settings: settings(), stopped: false, forceUpdate: 0, publishesPorts: true })
        .UpdateConfig.Order,
    ).toBe("stop-first");
  });

  it("uses the replica count, and zero when stopped", () => {
    expect(
      compileDeploy({ settings: settings({ replicas: 2 }), stopped: false, forceUpdate: 0 }).Mode,
    ).toEqual({
      Replicated: { Replicas: 2 },
    });
    expect(
      compileDeploy({ settings: settings({ replicas: 2 }), stopped: true, forceUpdate: 0 }).Mode,
    ).toEqual({
      Replicated: { Replicas: 0 },
    });
  });

  it("wraps a command in a shell and passes the rest through", () => {
    const { container: options } = compileDeploy({
      settings: settings({
        command: "/whoami -port 80",
        tiniInit: true,
        capAdd: ["NET_ADMIN"],
        capDrop: ["MKNOD"],
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
        groups: ["999"],
      }),
      stopped: false,
      forceUpdate: 0,
    });

    expect(options).toMatchObject({
      Command: ["/bin/sh"],
      Args: ["-c", "/whoami -port 80"],
      Init: true,
      CapabilityAdd: ["NET_ADMIN"],
      CapabilityDrop: ["MKNOD"],
      Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      Groups: ["999"],
    });
  });

  it("carries the force-update counter", () => {
    expect(compileDeploy({ settings: settings(), stopped: false, forceUpdate: 7 }).task.ForceUpdate).toBe(7);
  });
});

describe("the domains and middlewares compilers", () => {
  const middlewares = compileMiddlewares({ qualifiedName: "shop_web" });
  const domains = (input: Parameters<typeof compileDomains>[0]["domains"], stopped = false) =>
    compileDomains({ qualifiedName: "shop_web", domains: input, stopped, middlewares });

  it("gives an HTTPS domain two routers, a redirect and a certificate", () => {
    const compiled = domains([defaultDomain]);

    expect(compiled.routers["http-shop_web-0"]).toEqual({
      rule: "Host(`shop-web.203.0.113.10.sslip.io`) && PathPrefix(`/`)",
      entryPoints: ["web"],
      service: "shop_web-0",
      middlewares: [REDIRECT_HTTPS_MIDDLEWARE, BAD_GATEWAY_MIDDLEWARE],
    });
    expect(compiled.routers["https-shop_web-0"]).toEqual({
      rule: "Host(`shop-web.203.0.113.10.sslip.io`) && PathPrefix(`/`)",
      entryPoints: ["websecure"],
      service: "shop_web-0",
      middlewares: [BAD_GATEWAY_MIDDLEWARE],
      tls: { certResolver: "letsencrypt", domains: [{ main: "shop-web.203.0.113.10.sslip.io" }] },
    });
    expect(compiled.services["shop_web-0"]).toEqual({
      loadBalancer: { passHostHeader: true, servers: [{ url: "http://shop_web:80/" }] },
    });
  });

  it("gives an HTTP-only domain one router and no redirect", () => {
    const compiled = domains([{ host: "app.example.test", path: "/api", port: 8080, https: false }]);

    expect(compiled.routers).toEqual({
      "http-shop_web-0": {
        rule: "Host(`app.example.test`) && PathPrefix(`/api`)",
        entryPoints: ["web"],
        service: "shop_web-0",
        middlewares: [BAD_GATEWAY_MIDDLEWARE],
      },
    });
  });

  it("numbers routers by position, and keeps routers while a stopped service has no servers", () => {
    const compiled = domains(
      [
        { host: "a.example.test", path: "/", port: 80, https: true },
        { host: "b.example.test", path: "/", port: 80, https: false },
      ],
      true,
    );

    expect(Object.keys(compiled.routers)).toEqual(["http-shop_web-0", "https-shop_web-0", "http-shop_web-1"]);
    expect(compiled.services["shop_web-0"]?.loadBalancer.servers).toEqual([]);
  });

  it.each([
    ["evil`) || Host(`x", "/"],
    ["a b.example.test", "/"],
    ["ok.example.test", "/no`tick"],
    ["ok.example.test", "noslash"],
  ])("refuses a host or path that would break the rule: %j %j", (host, path) => {
    expect(() => domains([{ host, path, port: 80, https: true }])).toThrow(InvalidProxyInputError);
  });
});

describe("compileService", () => {
  it("names the service, its network and its labels", () => {
    const swarm = compile().swarmSpec;

    expect(swarm?.Name).toBe("shop_web");
    expect(swarm?.TaskTemplate.ContainerSpec.Image).toBe("traefik/whoami:v1.10");
    expect(swarm?.TaskTemplate.Networks).toEqual([{ Target: "opsifier-shop", Aliases: ["shop-web", "web"] }]);
    expect(swarm?.Labels).toEqual({
      "opsifier.project": "shop",
      "opsifier.service": "web",
      "opsifier.type": "app",
    });
    expect(swarm?.EndpointSpec).toEqual({ Mode: "vip" });
  });

  it("composes the env from the project, the service and the primary domain", () => {
    const result = compile(
      { env: "HOST=$(PRIMARY_DOMAIN)" },
      {
        env: "SHARED=1",
        domains: [
          { host: "b.example.test", path: "/", port: 3000, https: false, primary: false },
          { host: "a.example.test", path: "/", port: 8080, https: true, primary: true },
        ],
      },
    );

    expect(container(result).Env).toEqual(["PORT=8080", "SHARED=1", "HOST=a.example.test"]);
  });

  it("falls back to port 80 and an empty host with no domain", () => {
    expect(container(compile({ env: "HOST=$(PRIMARY_DOMAIN)" }, { domains: [] })).Env).toEqual([
      "PORT=80",
      "HOST=",
    ]);
  });

  it("puts each concern where it belongs", () => {
    const result = compile({
      mounts: [{ type: "bind", hostPath: "/srv", mountPath: "/data", acknowledgeRisk: false }],
      resources: resourcesSpec.parse({ memoryLimit: 128 }),
      ports: [{ protocol: "tcp", published: 30080, target: 80 }],
      deploy: deploySettings.parse({ replicas: 3 }),
    });

    expect(result.swarmSpec?.TaskTemplate.Placement).toEqual({ Constraints: ["node.role==manager"] });
    expect(container(result).Mounts).toEqual([{ Type: "bind", Source: "/srv", Target: "/data" }]);
    expect(result.swarmSpec?.TaskTemplate.Resources?.Limits).toEqual({ MemoryBytes: 134217728 });
    expect(result.swarmSpec?.EndpointSpec?.Ports?.[0]).toMatchObject({ PublishedPort: 30080 });
    expect(result.swarmSpec?.Mode).toEqual({ Replicated: { Replicas: 3 } });
  });

  it("compiles every setting into the spec as the acceptance criteria describe", () => {
    const result = compile({
      resources: resourcesSpec.parse({
        memoryReservation: 64,
        memoryLimit: 128,
        cpuReservation: 0.1,
        cpuLimit: 0.5,
      }),
      ports: [
        { protocol: "tcp", published: 30080, target: 80 },
        { protocol: "udp", published: 30053, target: 53 },
      ],
      deploy: deploySettings.parse({
        replicas: 2,
        zeroDowntime: false,
        tiniInit: true,
        command: "nginx -g 'daemon off;'",
        capAdd: ["NET_ADMIN"],
        capDrop: ["MKNOD"],
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
        groups: ["999"],
      }),
    });
    const swarm = result.swarmSpec;

    expect(swarm?.TaskTemplate.Resources).toEqual({
      Limits: { NanoCPUs: 500_000_000, MemoryBytes: 134_217_728 },
      Reservations: { NanoCPUs: 100_000_000, MemoryBytes: 67_108_864 },
    });
    expect(swarm?.Mode).toEqual({ Replicated: { Replicas: 2 } });
    expect(swarm?.UpdateConfig).toMatchObject({ Order: "stop-first" });
    expect(swarm?.EndpointSpec).toEqual({
      Mode: "vip",
      Ports: [
        { Protocol: "tcp", TargetPort: 80, PublishedPort: 30080, PublishMode: "host" },
        { Protocol: "udp", TargetPort: 53, PublishedPort: 30053, PublishMode: "host" },
      ],
    });
    expect(container(result)).toMatchObject({
      Command: ["/bin/sh"],
      Args: ["-c", "nginx -g 'daemon off;'"],
      Init: true,
      CapabilityAdd: ["NET_ADMIN"],
      CapabilityDrop: ["MKNOD"],
      Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      Groups: ["999"],
    });
  });

  it("goes back to the image's own behaviour once the settings are cleared", () => {
    const options = container(compile({ deploy: deploySettings.parse({}) }));

    expect(options.Command).toBeUndefined();
    expect(options.Args).toBeUndefined();
    expect(options.CapabilityAdd).toBeUndefined();
    expect(options.Sysctls).toBeUndefined();
    expect(options.Groups).toBeUndefined();
  });

  it("uses Docker's counter to force a rollout and never changes the env for it", () => {
    const first = compile({}, { forceUpdate: 1 });
    const second = compile({}, { forceUpdate: 2 });

    expect(first.swarmSpec?.TaskTemplate.ForceUpdate).toBe(1);
    expect(second.swarmSpec?.TaskTemplate.ForceUpdate).toBe(2);
    expect(container(first).Env).toEqual(container(second).Env);
  });

  it("still routes a service without a source, and has no Swarm spec for it", () => {
    const result = compile({ source: null });

    expect(result.swarmSpec).toBeNull();
    expect(Object.keys(result.proxyConfig.http.routers)).toEqual(["http-shop_web-0", "https-shop_web-0"]);
  });

  it("is pure: the same input gives the same output", () => {
    expect(compile({ env: "A=1" })).toEqual(compile({ env: "A=1" }));
  });
});
