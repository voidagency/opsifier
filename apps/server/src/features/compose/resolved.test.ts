import { describe, expect, it } from "vitest";
import { accessFacts, accessFingerprint, inspectResolved } from "./resolved";

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

  it("finds nothing to confirm in a stack that keeps to itself", () => {
    const { issues: none } = inspectResolved(
      {
        services: {
          web: {
            build: { context: `${STACK_DIR}`, dockerfile: "Dockerfile" },
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
    expect(accessFingerprint(shuffled)).toBe(accessFingerprint(issues));
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
    expect(accessFingerprint(moved)).not.toBe(accessFingerprint(issues));
  });
});
