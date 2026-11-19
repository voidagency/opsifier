import { describe, expect, it } from "vitest";
import { accessFacts, confirmationFingerprint, inspectResolved } from "./resolved";

const STACK_DIR = "/var/lib/opsifier/projects/shop/stack/code";
const SCOPE = {
  project: "shop",
  stack: "shop_stack",
  dataDir: "/var/lib/opsifier",
  projectDirectory: STACK_DIR,
};

/**
 * What `docker compose config --format json --no-env-resolution` (Compose 5.1) printed for a file that
 * includes another, extends a base, takes a path from a variable and uses the newer keys. Only the
 * folder names were changed.
 */
const RESOLVED = {
  name: "shop_stack",
  networks: { default: { name: "shop_stack_default", ipam: {} } },
  services: {
    child: {
      command: null,
      entrypoint: null,
      image: "alpine",
      networks: { default: null },
      privileged: true,
      volumes: [{ type: "bind", source: "/", target: "/host", bind: {} }],
    },
    web: {
      build: {
        context: `${STACK_DIR}/sub`,
        dockerfile: "Dockerfile",
        entitlements: ["network.host"],
        ssh: ["default"],
        cache_from: ["type=local,src=/tmp/cache"],
        additional_contexts: { extra: "/var/lib/opsifier", img: "docker-image://alpine:3" },
        privileged: true,
      },
      cap_add: ["SYS_ADMIN"],
      cgroup_parent: "/system.slice",
      device_cgroup_rules: ["c 1:3 mr"],
      devices: [{ source: "/dev/kvm", target: "/dev/kvm", permissions: "rwm" }],
      env_file: [{ path: "/var/lib/opsifier/projects/other/web/code/.env" }],
      gpus: [{ count: -1 }],
      image: "nginx",
      networks: { default: null },
      pid: "host",
      security_opt: ["seccomp=unconfined"],
      use_api_socket: true,
      volumes: [
        { type: "bind", source: `${STACK_DIR}/data`, target: "/data", bind: {} },
        { type: "bind", source: "/etc", target: "/d2", read_only: true, bind: {} },
        { type: "volume", source: "named", target: "/n", volume: {} },
        { type: "image", source: "opsifier/other/web:latest", target: "/img" },
      ],
    },
  },
  secrets: { key: { name: "shop_stack_key", file: "/var/lib/opsifier/secret.key" } },
  volumes: { named: { name: "shop_stack_named" } },
};

describe("what Compose resolved for a stack", () => {
  const { issues, insidePaths } = inspectResolved(RESOLVED, SCOPE);
  const codes = (service: string | null) =>
    issues
      .filter((issue) => issue.service === service)
      .map((issue) => [issue.code, issue.detail])
      .sort();

  it("sees what an included file brings in", () => {
    expect(codes("child")).toEqual([
      ["docker_socket", "/"],
      ["privileged", null],
    ]);
  });

  it("judges every path where it really leads, and keeps the stack's own to itself", () => {
    expect(codes("web")).toEqual(
      expect.arrayContaining([
        ["host_path", "/etc"],
        ["data_directory", "/var/lib/opsifier/projects/other/web/code/.env"],
        ["data_directory", "/var/lib/opsifier"],
        ["host_path", "/tmp/cache"],
      ]),
    );
    expect(insidePaths.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([`${STACK_DIR}/data`, `${STACK_DIR}/sub`, `${STACK_DIR}/sub/Dockerfile`]),
    );
    expect(codes(null)).toEqual([["data_directory", "/var/lib/opsifier/secret.key"]]);
  });

  it("sees every newer way to reach the server", () => {
    expect(codes("web")).toEqual(
      expect.arrayContaining([
        ["capabilities", "SYS_ADMIN"],
        ["devices", "/dev/kvm"],
        ["devices", "device_cgroup_rules: c 1:3 mr"],
        ["devices", "gpus"],
        ["docker_socket", "use_api_socket"],
        ["host_namespace", "cgroup_parent: /system.slice"],
        ["host_namespace", "pid: host"],
        ["privileged", "build.entitlements: network.host"],
        ["privileged", "build.privileged"],
        ["security_options", "seccomp=unconfined"],
        ["foreign_image", "opsifier/other/web:latest"],
      ]),
    );
  });

  it("refuses a build that asks for an attestation, and lets one turn them off", () => {
    const attestations = (extra: Record<string, unknown>) =>
      inspectResolved(
        { services: { web: { build: { context: `${STACK_DIR}/sub`, ...extra } } } },
        SCOPE,
      ).issues.filter((issue) => issue.code === "build_attestation");
    expect(
      attestations({ sbom: "true", provenance: "mode=max,type=sbom,generator=example/scanner:1" }),
    ).toEqual([
      { severity: "error", code: "build_attestation", service: "web", detail: "build.sbom: true" },
      {
        severity: "error",
        code: "build_attestation",
        service: "web",
        detail: "build.provenance: mode=max,type=sbom,generator=example/scanner:1",
      },
    ]);
    expect(attestations({ sbom: "false", provenance: "false" })).toEqual([]);
  });

  it("takes a volume Compose made for the stack as the stack's own", () => {
    expect(issues.some((issue) => issue.detail === "named")).toBe(false);
    const foreign = inspectResolved(
      {
        services: { web: { volumes: [{ type: "volume", source: "data", target: "/d" }] } },
        volumes: { data: { name: "other_project_data", external: true } },
      },
      SCOPE,
    ).issues;
    expect(foreign.map((issue) => [issue.code, issue.service, issue.detail])).toEqual([
      ["external_resource", "web", "data"],
      ["external_resource", null, "data"],
    ]);
  });

  it("counts a layout of images a build reads from the disk as reaching the server", () => {
    const { issues: found } = inspectResolved(
      {
        services: {
          web: {
            build: {
              context: `${STACK_DIR}/app`,
              additional_contexts: { base: "oci-layout:///srv/images@sha256:abc" },
            },
          },
        },
      },
      SCOPE,
    );
    expect(found).toEqual([
      {
        severity: "host",
        code: "host_path",
        service: "web",
        detail: "additional_contexts: oci-layout:///srv/images@sha256:abc",
      },
    ]);
  });

  it.each([
    ["a list of id=path", ["deploy=/root/.ssh/id"]],
    ["one id=path", "deploy=/root/.ssh/id"],
    ["id: path", ["deploy: /root/.ssh/id"]],
    ["an id and a path", [{ id: "deploy", path: "/root/.ssh/id" }]],
    ["a mapping", { deploy: "/root/.ssh/id" }],
    ["paths split at commas", ["deploy=./keys/id,/root/.ssh/id"]],
  ])("reads the SSH keys a build forwards, written as %s", (_label, ssh) => {
    const { issues: found } = inspectResolved(
      { services: { web: { build: { context: STACK_DIR, ssh } } } },
      SCOPE,
    );
    expect(found.map((issue) => [issue.code, issue.detail])).toContainEqual(["host_path", "/root/.ssh/id"]);
  });

  it("refuses SSH keys written in a form it can't read", () => {
    const { issues: refused } = inspectResolved(
      {
        services: {
          web: { build: { context: STACK_DIR, ssh: [{ id: "deploy", path: ["/root/.ssh/id"] }] } },
        },
      },
      SCOPE,
    );
    expect(refused).toEqual([
      {
        severity: "error",
        code: "escapes_stack",
        service: "web",
        detail: 'build.ssh: [{"id":"deploy","path":["/root/.ssh/id"]}]',
      },
    ]);
  });

  it("refuses a service Compose would hand to a program of its own", () => {
    const { issues: refused } = inspectResolved(
      { services: { web: { provider: { type: `${STACK_DIR}/tool`, options: {} } } } },
      SCOPE,
    );
    expect(refused).toEqual([
      { severity: "error", code: "runs_program", service: "web", detail: `provider: ${STACK_DIR}/tool` },
    ]);
  });

  it("refuses a build whose image would take a name outside the stack, however it got there", () => {
    const { issues: refused } = inspectResolved(
      {
        services: {
          tool: {
            build: { context: STACK_DIR, tags: ["traefik:3.6"] },
            image: "ghcr.io/voidagency/opsifier:0.2.2",
          },
          own: { build: { context: STACK_DIR }, image: "shop_stack-own:1" },
          plain: { build: { context: STACK_DIR } },
          borrowed: { image: "opsifier/beta/web:latest" },
        },
      },
      SCOPE,
    );
    expect(refused.filter((issue) => issue.severity === "error")).toEqual([
      {
        severity: "error",
        code: "foreign_image",
        service: "tool",
        detail: "ghcr.io/voidagency/opsifier:0.2.2",
      },
      { severity: "error", code: "foreign_image", service: "tool", detail: "traefik:3.6" },
      { severity: "error", code: "foreign_image", service: "borrowed", detail: "opsifier/beta/web:latest" },
    ]);
  });

  it("refuses every name a child could take from another project or the panel, wherever it came from", () => {
    const { issues: refused } = inspectResolved(
      {
        networks: {
          default: { name: "shop_stack_default" },
          opsifier_proxy_network: { name: "opsifier-shop_proxy", external: true },
          front: { name: "opsifier-shop_proxy", external: true },
        },
        services: {
          beta_web: { image: "nginx" },
          opsifier: { image: "nginx" },
          web: {
            image: "nginx",
            container_name: "beta_web",
            networks: {
              default: { aliases: ["cache", "beta_api"] },
              opsifier_proxy_network: { aliases: ["shop_stack__web", "beta_web"] },
              front: { aliases: ["plain"] },
            },
          },
          own: { image: "nginx", container_name: "shop_stack-own-1", hostname: "rabbit" },
          named: { image: "nginx", hostname: "beta_web" },
        },
      },
      SCOPE,
    );
    expect(
      refused.filter((issue) => issue.code === "foreign_name").map((issue) => [issue.service, issue.detail]),
    ).toEqual([
      ["beta_web", "beta_web"],
      ["opsifier", "opsifier"],
      ["web", "container_name: beta_web"],
      ["web", "aliases: beta_api"],
      ["web", "aliases: beta_web"],
      ["web", "aliases: plain"],
      ["named", "hostname: beta_web"],
    ]);
    expect(refused.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("finds nothing to confirm in a stack that keeps to itself", () => {
    const { issues: none } = inspectResolved(
      {
        services: {
          web: {
            build: { context: `${STACK_DIR}/app`, dockerfile: "Dockerfile" },
            volumes: [{ type: "bind", source: `${STACK_DIR}/data`, target: "/data" }],
            security_opt: ["no-new-privileges:true"],
            pid: "service:db",
          },
        },
      },
      SCOPE,
    );
    expect(none).toEqual([]);
  });

  it("binds a confirmation to the facts, not to the order they came in", () => {
    const shuffled = [...issues].reverse();
    const fingerprint = (found: typeof issues) => confirmationFingerprint(found, RESOLVED, []);
    expect(fingerprint(shuffled)).toBe(fingerprint(issues));
    expect(accessFacts(issues)).toContain("privileged|child|");
    const moved = inspectResolved(
      {
        ...RESOLVED,
        services: {
          ...RESOLVED.services,
          web: {
            ...RESOLVED.services.web,
            volumes: [{ type: "bind", source: "/root", target: "/d2", read_only: true, bind: {} }],
          },
        },
      },
      SCOPE,
    ).issues;
    expect(fingerprint(moved)).not.toBe(fingerprint(issues));
  });

  describe("what a confirmation covers besides what the stack reaches", () => {
    const STACK = {
      services: {
        tool: {
          image: "alpine:3",
          command: ["sh", "-c", "run"],
          privileged: true,
          environment: { MODE: "safe" },
        },
        web: { image: "nginx:1", command: null },
      },
    };
    const access = inspectResolved(STACK, SCOPE).issues;
    const FILES = [
      ["docker-compose.yml", "a1"],
      ["parts/more.yml", "b2"],
    ] as const;
    const base = confirmationFingerprint(access, STACK, FILES);
    const changed = (tool: Record<string, unknown>, files = FILES) =>
      confirmationFingerprint(access, { services: { ...STACK.services, tool } }, files);

    it.each([
      ["its image", { image: "alpine:3.21" }],
      ["its command", { command: ["sh", "-c", "something else"] }],
      ["its entrypoint", { entrypoint: ["/bin/other"] }],
      ["what builds it", { build: { context: `${STACK_DIR}/tool` } }],
      ["what it is told", { environment: { MODE: "anything" } }],
      ["a hook it runs", { post_start: [{ command: ["sh", "-c", "x"] }] }],
      ["a hook it runs as it stops", { pre_stop: [{ command: ["sh", "-c", "x"] }] }],
      ["the env files it is told to read", { env_file: [{ path: `${STACK_DIR}/other.env` }] }],
      ["the folder it starts in", { working_dir: "/elsewhere" }],
      ["the user it runs as", { user: "0:0" }],
      ["the command it checks its health with", { healthcheck: { test: ["CMD", "sh", "-c", "x"] } }],
    ])("changes with %s, in a child that reaches the server", (_label, change) => {
      expect(changed({ ...STACK.services.tool, ...change })).not.toBe(base);
    });

    it("changes with any file the stack is read from, and not with their order", () => {
      expect(confirmationFingerprint(access, STACK, [FILES[0], ["parts/more.yml", "c3"]])).not.toBe(base);
      expect(confirmationFingerprint(access, STACK, [FILES[1], FILES[0]])).toBe(base);
    });

    it("stays the same when only a child that reaches nothing changes", () => {
      const web = { image: "nginx:2", command: ["other"] };
      expect(confirmationFingerprint(access, { services: { ...STACK.services, web } }, FILES)).toBe(base);
    });

    it("covers every child when the stack as a whole reaches the server", () => {
      const secret = [
        { severity: "host" as const, code: "host_path" as const, service: null, detail: "/etc/x" },
      ];
      const web = { image: "nginx:2" };
      expect(confirmationFingerprint(secret, { services: { ...STACK.services, web } }, FILES)).not.toBe(
        confirmationFingerprint(secret, STACK, FILES),
      );
    });
  });
});
