import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ComposeDetail,
  ComposeRuntime,
  LogSearchResult,
  ServiceDetail,
  ServiceLogEvent,
  ServiceMetrics,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ComposeContainerInfo, LogOptions } from "../../core/docker";
import type { TopicFeed } from "../../core/realtime";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { DOCKERFILE_FRONTEND } from "../service-tabs/source/build/builders";
import { createComposeLogsProvider } from "./feeds";
import { isForeignImage } from "./images";
import { foreignNetworks, hasHostAccess, inspectComposeFile } from "./inspect";
import { renderComposeOverride, resolvedOverrideChildren } from "./override";
import { platformPorts } from "./ports";
import { runCompose } from "./run";
import { composeStatus } from "./status";

const DATA_DIR = "/var/lib/opsifier";
const SCOPE = { project: "shop", stack: "shop_stack" };
const inspect = (text: string) => inspectComposeFile(text, { dataDir: DATA_DIR, ...SCOPE });

describe("reading a compose file", () => {
  it("reports container_name and ports, naming the service", () => {
    const { issues, services } = inspect(
      "services:\n  web:\n    image: nginx\n    container_name: shop_stack-w\n    ports:\n      - 80:80\n",
    );
    expect(services).toEqual(["web"]);
    expect(issues.map((issue) => [issue.code, issue.service])).toEqual(
      expect.arrayContaining([
        ["container_name", "web"],
        ["published_port", "web"],
      ]),
    );
  });

  const PROXY_NETWORK = "networks:\n  px:\n    name: opsifier-shop_proxy\n    external: true\n";

  it.each([
    ["a child named like another project's service", "  beta_web:\n    image: nginx\n", "", "beta_web"],
    ["a child named like the panel", "  opsifier:\n    image: nginx\n", "", "opsifier"],
    [
      "a child named like the panel, in capitals",
      "  Opsifier-Panel:\n    image: nginx\n",
      "",
      "Opsifier-Panel",
    ],
    [
      "a container named like another project's service",
      "  web:\n    image: nginx\n    container_name: beta_web\n",
      "",
      "container_name: beta_web",
    ],
    [
      "a container named like the proxy",
      "  web:\n    image: nginx\n    container_name: opsifier-traefik\n",
      "",
      "container_name: opsifier-traefik",
    ],
    [
      "a container name outside the stack's own",
      "  web:\n    image: nginx\n    container_name: web\n",
      "",
      "container_name: web",
    ],
    [
      "an alias on the proxy's network, declared by its name",
      "  web:\n    image: nginx\n    networks:\n      px:\n        aliases: [front]\n",
      PROXY_NETWORK,
      "aliases: front",
    ],
    [
      "an alias on the proxy's network, under the panel's own key",
      `  web:\n    image: nginx\n    networks:\n      opsifier_proxy_network:\n        aliases: ['\${FRONT}']\n`,
      "",
      `aliases: \${FRONT}`,
    ],
    [
      "an alias like another project's service on the stack's own network",
      "  web:\n    image: nginx\n    networks:\n      default:\n        aliases: [beta_web]\n",
      "",
      "aliases: beta_web",
    ],
    [
      "an alias like the panel on the stack's own network",
      "  web:\n    image: nginx\n    networks:\n      default:\n        aliases: [opsifier]\n",
      "",
      "aliases: opsifier",
    ],
    [
      "a hostname like another project's service",
      "  web:\n    image: nginx\n    hostname: beta_web\n",
      "",
      "hostname: beta_web",
    ],
    [
      "a hostname like the panel",
      "  web:\n    image: nginx\n    hostname: opsifier\n",
      "",
      "hostname: opsifier",
    ],
  ])("refuses %s, which the proxy could be looking for elsewhere", (_label, services, top, detail) => {
    const { issues } = inspect(`services:\n${services}${top}`);
    expect(issues.filter((issue) => issue.code === "foreign_name")).toEqual([
      expect.objectContaining({ severity: "error", detail }),
    ]);
  });

  it("lets a child take names of its own", () => {
    const { issues } = inspect(
      "services:\n  web-2:\n    image: nginx\n    restart: always\n    hostname: rabbit\n    container_name: shop_stack-web\n    networks:\n      default:\n        aliases: [front, cache.internal]\n",
    );
    expect(issues).toEqual([
      { severity: "warning", code: "container_name", service: "web-2", detail: "shop_stack-web" },
    ]);
  });

  it("reports the parser's error for invalid YAML", () => {
    const result = inspect("services: [");
    expect(result.parseError).not.toBeNull();
    expect(result.issues).toEqual([]);
  });

  it("has nothing to say about a clean file", () => {
    const { issues, parseError } = inspect(
      "services:\n  web:\n    image: nginx\n    restart: unless-stopped\n",
    );
    expect(issues).toEqual([]);
    expect(parseError).toBeNull();
  });

  it.each([
    ["privileged: true", "privileged"],
    ["network_mode: host", "host_namespace"],
    ["pid: host", "host_namespace"],
    ["cap_add: [SYS_ADMIN]", "capabilities"],
    ["devices: ['/dev/kvm:/dev/kvm']", "devices"],
    ["security_opt: ['seccomp=unconfined']", "security_options"],
    ["volumes: ['/var/run/docker.sock:/var/run/docker.sock']", "docker_socket"],
    [`volumes: ['${DATA_DIR}/x:/x']`, "data_directory"],
    ["volumes: ['/etc:/etc']", "host_path"],
    ["volumes: ['/:/host']", "docker_socket"],
    [`volumes: ['\${HOST_DIR}:/host']`, "host_path"],
    [`volumes: ['\${WHOLE_MOUNT}']`, "host_path"],
    [`volumes: [{ type: bind, source: '\${HOST_DIR}', target: /host }]`, "host_path"],
    [`volumes: [{ type: '\${KIND}', source: /etc, target: /host }]`, "host_path"],
    [`privileged: '\${PRIVILEGED}'`, "privileged"],
    [`pid: '\${PID_MODE}'`, "host_namespace"],
    ["pid: 'container:shop_db'", "host_namespace"],
    ["ipc: 'container:shop_db'", "host_namespace"],
    [`security_opt: ['\${OPTION}']`, "security_options"],
    ["volumes_from: ['container:other_project_db']", "external_resource"],
    ["external_links: ['other_project_db:db']", "external_resource"],
    [`build: '\${CONTEXT}'`, "host_path"],
    [`env_file: ['\${ENV_FILE}']`, "host_path"],
  ])("warns about host access: %s", (line, code) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n    ${line}\n`);
    expect(issues.find((issue) => issue.code === code)?.severity).toBe("host");
  });

  it.each([
    ["an external volume", "volumes:\n  v:\n    external: true\n", "external_resource"],
    ["a volume with a fixed name", "volumes:\n  v:\n    name: other_db_data\n", "external_resource"],
    [
      "a volume on a network share named by a variable",
      `volumes:\n  v:\n    driver_opts:\n      type: nfs\n      device: ':\${EXPORT}'\n      o: addr=10.0.0.5\n`,
      "host_path",
    ],
  ])("counts %s as reaching outside the stack", (_label, section, code) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n${section}`);
    expect(issues.find((issue) => issue.code === code)?.severity).toBe("host");
  });

  it.each([
    ["a host path", "{ type: none, o: bind, device: /srv/data }"],
    ["the server's root", "{ type: none, o: bind, device: / }"],
    ["a folder of the stack", "{ type: none, o: bind, device: ./data }"],
    ["a folder, with more options", "{ type: none, o: 'rbind,ro', device: ./data }"],
    ["the server's root as an overlay's layer", "{ type: overlay, device: overlay, o: 'lowerdir=/:/etc' }"],
    ["a disk of the server", "{ type: ext4, device: /dev/sdb1 }"],
    ["a network share's type with a local device", "{ type: nfs, device: /srv/data }"],
  ])("refuses a local volume that binds %s through its options", (_label, options) => {
    const { issues } = inspect(
      `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['v:/v']\nvolumes:\n  v:\n    driver_opts: ${options}\n`,
    );
    expect(issues).toEqual([{ severity: "error", code: "bind_volume", service: null, detail: "v" }]);
  });

  it.each([
    ["a tmpfs", "{ type: tmpfs, device: tmpfs, o: 'size=64m' }"],
    ["an NFS share", "{ type: nfs, device: ':/exports/data', o: 'addr=10.0.0.5,rw' }"],
    ["a CIFS share", "{ type: cifs, device: '//nas/share', o: 'username=app' }"],
  ])("takes a local volume that is %s", (_label, options) => {
    const { issues } = inspect(
      `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['v:/v']\nvolumes:\n  v:\n    driver_opts: ${options}\n`,
    );
    expect(issues.filter((issue) => issue.code === "bind_volume")).toEqual([]);
  });

  const stack = (lines: string, top = "") =>
    inspect(`services:\n  web:\n    image: nginx\n    restart: always\n${lines}${top}`).issues;
  /** A service the stack builds, which takes the stack's own image name rather than `nginx`. */
  const built = (lines: string) => inspect(`services:\n  web:\n    restart: always\n${lines}`).issues;

  it.each([
    ["an external network", "    networks: [n]\n", "networks:\n  n:\n    external: true\n", "n"],
    [
      "the panel's own network",
      "    networks: [n]\n",
      "networks:\n  n:\n    external: true\n    name: opsifier\n",
      "opsifier",
    ],
    ["a network with a fixed name", "", "networks:\n  n:\n    name: opsifier-other\n", "opsifier-other"],
    [
      "the old spelling of external",
      "",
      "networks:\n  n:\n    external: { name: opsifier-x }\n",
      "opsifier-x",
    ],
    [
      "a name only known at deploy time",
      "",
      `networks:\n  n:\n    external: true\n    name: '\${NET}'\n`,
      `\${NET}`,
    ],
  ])("refuses to join %s", (_label, lines, top, detail) => {
    expect(stack(lines, top).filter((issue) => issue.code === "foreign_network")).toEqual([
      { severity: "error", code: "foreign_network", service: null, detail },
    ]);
  });

  it.each([
    ["another container's network", "network_mode: 'container:shop_db'"],
    ["Docker's default bridge", "network_mode: bridge"],
    ["a network by name", "network_mode: somebodys-net"],
    ["a mode only known at deploy time", `network_mode: '\${NET}'`],
    ["a build on someone else's network", "build: { context: ., network: opsifier-other }"],
  ])("refuses %s", (_label, line) => {
    expect(stack(`    ${line}\n`).map((issue) => issue.code)).toContain("foreign_network");
  });

  it("reads a file as Compose resolved it, where only what it made for the stack is the stack's", () => {
    expect(
      foreignNetworks(
        {
          networks: {
            default: { name: "shop_stack_default" },
            mine: { name: "shop_stack_mine" },
            project: { name: "opsifier-shop", external: true },
            proxy: { name: "opsifier-shop_proxy", external: true },
            theirs: { name: "opsifier-rival", external: true },
          },
          services: { web: { network_mode: "bridge" }, tool: { networks: { default: null } } },
        },
        SCOPE,
      ),
    ).toEqual([
      { service: null, detail: "opsifier-rival" },
      { service: "web", detail: "network_mode: bridge" },
    ]);
  });

  it("does not take a confirmation for the host as an answer to joining another network", () => {
    expect(
      hasHostAccess(
        inspect("services:\n  web:\n    image: x\n    restart: always\n    network_mode: host\n"),
      ),
    ).toBe(true);
    expect(stack("    network_mode: 'container:x'\n").filter((issue) => issue.severity === "host")).toEqual(
      [],
    );
  });

  it.each([
    ["the project's own network", "networks:\n  n:\n    external: true\n    name: opsifier-shop\n"],
    ["the project's proxy network", "networks:\n  n:\n    external: true\n    name: opsifier-shop_proxy\n"],
    ["a network of its own", "networks:\n  n:\n    driver: bridge\n"],
    ["its own network, named as Compose would", "networks:\n  n:\n    name: shop_stack_n\n"],
  ])("lets a stack use %s", (_label, top) => {
    expect(stack("", top)).toEqual([]);
  });

  it.each([
    ["none", "network_mode"],
    ["service:db", "network_mode"],
  ])("only warns about network_mode %s", (mode, code) => {
    expect(stack(`    network_mode: '${mode}'\n`).map((issue) => [issue.severity, issue.code])).toEqual([
      ["warning", code],
    ]);
  });

  it("leaves a build alone on its own network, and flags one on the host's", () => {
    expect(built("    build: { context: ., network: default }\n")).toEqual([]);
    expect(built("    build: { context: ., network: none }\n")).toEqual([]);
    expect(built("    build: { context: ., network: host }\n")).toEqual([
      { severity: "host", code: "host_namespace", service: "web", detail: "build.network: host" },
    ]);
  });

  it("refuses a path that leaves the stack and a dependency that doesn't exist", () => {
    const { issues } = inspect(
      "services:\n  web:\n    image: nginx\n    restart: always\n    depends_on: [db]\n    volumes: ['../x:/x']\n",
    );
    expect(
      issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code)
        .sort(),
    ).toEqual(["escapes_stack", "unknown_dependency"]);
  });

  it("accepts relative mounts inside the stack and named volumes", () => {
    const { issues } = inspect(
      "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['./data:/data', 'cache:/cache']\nvolumes:\n  cache: {}\n",
    );
    expect(issues).toEqual([]);
  });

  it.each([
    ["a mount through a folder whose name starts with a dot", "volumes: ['.x/../../../../../..:/host']"],
    [
      "a mount by its long form, without a dot",
      "volumes: [{ type: bind, source: 'x/../../..', target: /h }]",
    ],
    ["a build context without a dot", "build: 'sub/../../../..'"],
    ["a Dockerfile beside the context", "build: { context: ./sub, dockerfile: '../../../Dockerfile' }"],
    ["an env file without a dot", "env_file: ['sub/../../../../other/web/code/.env']"],
    ["an env file in its long form", "env_file: [{ path: 'x/../../..', required: false }]"],
    ["a label file", "label_file: 'x/../../../labels'"],
    ["an extended file", "extends: { file: 'x/../../../base.yml', service: web }"],
    [
      "a build context added beside the main one",
      "build: { context: ., additional_contexts: { up: 'a/../..' } }",
    ],
    ["a local cache", "build: { context: ., cache_from: ['type=local,src=x/../../..'] }"],
  ])("refuses %s that leaves the stack", (_label, line) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n    ${line}\n`);
    expect(issues.find((issue) => issue.code === "escapes_stack")?.severity).toBe("error");
  });

  it("still accepts paths that go up and come back inside the stack", () => {
    const { issues } = inspect(
      "services:\n  web:\n    restart: always\n    build: { context: ./sub, dockerfile: ../Dockerfile }\n    env_file: [sub/../.env]\n    volumes: ['.data/../data:/data']\n",
    );
    expect(issues).toEqual([]);
  });

  it.each([
    ["use_api_socket: true", "docker_socket"],
    ["device_cgroup_rules: ['c 1:3 mr']", "devices"],
    ["gpus: all", "devices"],
    ["deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } }", "devices"],
    ["cgroup_parent: /system.slice", "host_namespace"],
    ["runtime: runc", "security_options"],
    ["security_opt: ['seccomp=./permissive.json']", "security_options"],
    ["security_opt: ['label=type:spc_t']", "security_options"],
    ["post_start: [{ command: [sh, -c, id], privileged: true }]", "privileged"],
    ["pre_stop: [{ command: [sh, -c, id], privileged: true }]", "privileged"],
    ["build: { context: ., privileged: true }", "privileged"],
    ["build: { context: ., entitlements: [network.host] }", "privileged"],
    ["build: { context: ., additional_contexts: { panel: /var/lib/opsifier } }", "data_directory"],
    ["build: { context: ., additional_contexts: { etc: /etc } }", "host_path"],
    ["build: { context: ., ssh: ['key=/root/.ssh/id_ed25519'] }", "host_path"],
    ["build: { context: ., ssh: { key: /root/.ssh/id_ed25519 } }", "host_path"],
    ["build: { context: ., ssh: 'key=./keys/id,/root/.ssh/id_ed25519' }", "host_path"],
    ["build: { context: ., cache_to: ['type=local,dest=/var/lib/opsifier/cache'] }", "data_directory"],
    [
      "build: { context: ., additional_contexts: { base: 'oci-layout:///srv/images@sha256:abc' } }",
      "host_path",
    ],
    ["build: { context: ., additional_contexts: { base: 'oci-layout://./layout' } }", "host_path"],
    ["label_file: /etc/labels", "host_path"],
    ["credential_spec: { file: /etc/spec.json }", "host_path"],
  ])("counts %s as reaching the host", (line, code) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n    ${line}\n`);
    expect(issues.find((issue) => issue.code === code)?.severity).toBe("host");
  });

  it.each([
    ["a list inside a mapping", "{ key: [./id] }", 'build.ssh: {"key":["./id"]}'],
    ["a number", "[1]", "build.ssh: [1]"],
  ])(
    "refuses the SSH keys of a build written as %s, which can't tell what they read",
    (_label, ssh, detail) => {
      const { issues } = inspect(
        `services:\n  web:\n    restart: always\n    build: { context: ., ssh: ${ssh} }\n`,
      );
      expect(issues).toEqual([{ severity: "error", code: "escapes_stack", service: "web", detail }]);
    },
  );

  it("keeps the options that only tighten a container to themselves", () => {
    expect(stack("    security_opt: ['no-new-privileges:true']\n")).toEqual([]);
    expect(
      built("    build: { context: ., additional_contexts: { base: 'docker-image://alpine:3' } }\n"),
    ).toEqual([]);
  });

  it.each([
    ["the panel's own image", "    build: .\n    image: ghcr.io/voidagency/opsifier:0.2.2\n"],
    ["the proxy's image", "    build: .\n    image: traefik:3.6\n"],
    [
      "a builder another project uses",
      "    build: .\n    image: paketobuildpacks/builder-jammy-base:0.4.469\n",
    ],
    ["what another project built", "    build: .\n    image: opsifier/beta/web:latest\n"],
    ["a name added as a tag", "    build: { context: ., tags: ['postgres:16.4'] }\n"],
  ])("refuses a build that would name its image after %s", (_label, lines) => {
    const { issues } = inspect(`services:\n  web:\n    restart: always\n${lines}`);
    expect(issues.find((issue) => issue.code === "foreign_image")?.severity).toBe("error");
  });

  it.each([
    ["an image another project built", "    image: opsifier/beta/web:latest\n"],
    ["a release another service kept", "    image: opsifier/releases/0a1b2c:3\n"],
    [
      "another project's image as a mount",
      "    image: nginx\n    volumes: [{ type: image, source: 'opsifier/beta/web:latest', target: /x }]\n",
    ],
    [
      "another project's image as a build context",
      "    build: { context: ., additional_contexts: { app: 'docker-image://opsifier/beta/web:latest' } }\n",
    ],
  ])("refuses %s, which only lives on this server", (_label, lines) => {
    const { issues } = inspect(`services:\n  web:\n    restart: always\n${lines}`);
    expect(issues.find((issue) => issue.code === "foreign_image")?.severity).toBe("error");
  });

  it.each([
    ["what another project's stack built", "beta_stack-web:latest"],
    ["what another project's stack built, under Docker Hub's full name", "docker.io/library/beta_stack-web"],
    ["what another project's stack tagged by digest", "beta_stack-web@sha256:0123456789abcdef"],
    ["a name of the panel's that holds no project", "opsifier/helper:1"],
  ])("refuses to run %s", (_label, image) => {
    const { issues } = inspect(`services:\n  web:\n    image: '${image}'\n    restart: always\n`);
    expect(issues).toEqual([{ severity: "error", code: "foreign_image", service: "web", detail: image }]);
  });

  it("refuses every kept release, even to a project that happens to be called releases", () => {
    const { issues } = inspectComposeFile(
      "services:\n  web:\n    image: opsifier/releases/0a1b2c:3\n    restart: always\n",
      { dataDir: DATA_DIR, project: "releases", stack: "releases_stack" },
    );
    expect(issues.map((issue) => issue.code)).toEqual(["foreign_image"]);
  });

  it("lets a stack run what another stack of its own project built", () => {
    expect(inspect("services:\n  web:\n    image: shop_other-web:1\n    restart: always\n").issues).toEqual(
      [],
    );
  });

  it("lets a build name its image after the stack, and use what its own project built", () => {
    expect(built("    build: .\n    image: shop_stack-web:1\n")).toEqual([]);
    expect(built("    build: { context: ., tags: ['shop_stack/web:edge'] }\n")).toEqual([]);
    expect(built("    build: .\n")).toEqual([]);
    expect(
      inspect("services:\n  web:\n    image: opsifier/shop/api:latest\n    restart: always\n").issues,
    ).toEqual([]);
  });

  it.each([
    ["a remote include", "include:\n  - https://example.test/owner/repo.git#main:compose.yaml\n"],
    ["an include over SSH", "include:\n  - git@example.test:owner/repo.git\n"],
    ["an include from a registry", "include:\n  - oci://registry.example.test/stack:1\n"],
    ["an include that leaves the stack", "include:\n  - path: x/../../../other/compose.yml\n"],
    ["the env file of an include", "include:\n  - path: ./a.yml\n    env_file: x/../../../other/.env\n"],
    ["the folder of an include", "include:\n  - path: ./a.yml\n    project_directory: x/../../..\n"],
  ])("refuses %s, which Compose would fetch or read before anything checks it", (_label, top) => {
    const { issues } = inspect(`${top}services:\n  web:\n    image: nginx\n    restart: always\n`);
    expect(issues.find((issue) => issue.code === "escapes_stack")?.severity).toBe("error");
  });

  it.each([
    ["an absolute one", "/srv/other", "/srv/other"],
    [
      "the panel's data",
      "/var/lib/opsifier/projects/other/web/code",
      "/var/lib/opsifier/projects/other/web/code",
    ],
    ["one under the home folder", "~/stacks", "~/stacks"],
    ["one above the stack", "x/../..", "x/../.."],
  ])("refuses an include read from %s, which Compose takes as it is", (_label, folder, path) => {
    const { issues } = inspect(
      `include:\n  - path: ./a.yml\n    project_directory: '${folder}'\nservices:\n  web:\n    image: nginx\n    restart: always\n`,
    );
    expect(issues).toEqual([
      {
        severity: "error",
        code: "escapes_stack",
        service: null,
        detail: `include project_directory: ${path}`,
      },
    ]);
  });

  it.each([
    ["an include", `include:\n  - '\${INC}'\n`, `include: \${INC}`],
    ["one of an include's files", `include:\n  - path: ['a.yml', '\${MORE}']\n`, `include: \${MORE}`],
    [
      "an include's folder",
      `include:\n  - path: a.yml\n    project_directory: '\${DIR}'\n`,
      `include project_directory: \${DIR}`,
    ],
    [
      "an include's env file",
      `include:\n  - path: a.yml\n    env_file: ['\${ENV}']\n`,
      `include env_file: \${ENV}`,
    ],
  ])(
    "refuses %s named through a variable, which Compose would read before anything follows it",
    (_label, top, detail) => {
      const { issues } = inspect(`${top}services:\n  web:\n    image: nginx\n    restart: always\n`);
      expect(issues).toEqual([{ severity: "error", code: "escapes_stack", service: null, detail }]);
    },
  );

  it("refuses a file a service extends, named through a variable", () => {
    const { issues } = inspect(
      `services:\n  web:\n    image: nginx\n    restart: always\n    extends: { file: '\${BASE}', service: base }\n`,
    );
    expect(issues).toEqual([
      { severity: "error", code: "escapes_stack", service: "web", detail: `extends file: \${BASE}` },
    ]);
  });

  it.each([
    ["a provider", "    provider:\n      type: /var/lib/opsifier/projects/shop/stack/code/tool\n", ""],
    ["a model", "    models: [llm]\n", "models:\n  llm:\n    model: ai/smollm2\n"],
  ])("refuses a service that hands work to %s, a program run beside the panel", (_label, lines, top) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n${lines}${top}`);
    expect(issues.find((issue) => issue.code === "runs_program")?.severity).toBe("error");
  });

  it.each([
    ["an SBOM", "sbom: true", "build.sbom: true"],
    [
      "an SBOM made by an image it names",
      "sbom: 'generator=example/scanner:1'",
      "build.sbom: generator=example/scanner:1",
    ],
    [
      "a provenance that names a generator",
      "provenance: 'mode=max,type=sbom,generator=example/scanner:1'",
      "build.provenance: mode=max,type=sbom,generator=example/scanner:1",
    ],
  ])("refuses a build that asks for %s, which an image no check sees would make", (_label, key, detail) => {
    const { issues } = inspect(
      `services:\n  web:\n    restart: always\n    build:\n      context: .\n      ${key}\n`,
    );
    expect(issues.filter((issue) => issue.code === "build_attestation")).toEqual([
      { severity: "error", code: "build_attestation", service: "web", detail },
    ]);
  });

  it("lets a build turn its attestations off", () => {
    const { issues } = inspect(
      "services:\n  web:\n    restart: always\n    build:\n      context: .\n      sbom: false\n      provenance: 'false'\n",
    );
    expect(issues.some((issue) => issue.code === "build_attestation")).toBe(false);
  });

  it.each([
    ["2377:2377", "Swarm's cluster management"],
    ["7946:7946/udp", "Swarm's node discovery"],
    ["2375:2375", "Docker's API"],
  ])("refuses a port the platform itself needs: %s", (port, holder) => {
    const { issues } = inspectComposeFile(
      `services:\n  web:\n    image: nginx\n    restart: always\n    ports: ['${port}']\n`,
      { ...SCOPE, dataDir: DATA_DIR, takenPorts: platformPorts(3000) },
    );
    expect(issues).toEqual([
      { severity: "error", code: "port_taken", service: "web", detail: `${port} (${holder})` },
    ]);
  });

  it("names the holder of a host port that is already in use", () => {
    const { issues } = inspectComposeFile(
      "services:\n  web:\n    image: nginx\n    restart: always\n    ports: ['443:443']\n",
      {
        ...SCOPE,
        dataDir: DATA_DIR,
        takenPorts: new Map([[443, "the proxy"]]),
      },
    );
    expect(issues).toEqual([
      { severity: "error", code: "port_taken", service: "web", detail: "443:443 (the proxy)" },
    ]);
  });
});

describe("the generated override", () => {
  it("joins the project network, and keeps declared networks", () => {
    const text = renderComposeOverride({
      project: "shop",
      service: "stack",
      qualified: "shop_stack",
      children: [
        { name: "web", declaresNetworks: false, networkMode: null },
        { name: "api", declaresNetworks: true, networkMode: null },
        { name: "host", declaresNetworks: false, networkMode: "host" },
      ],
    });
    expect(text).toContain("aliases:");
    expect(text).toContain("shop_stack__web");
    expect(text).toContain("name: opsifier-shop");
    expect(text).toContain("name: opsifier-shop_proxy");
    expect(text).not.toContain("shop_stack_host");
    const { services } = parse(text) as { services: Record<string, { networks?: Record<string, unknown> }> };
    expect(Object.keys(services.web?.networks ?? {}).sort()).toEqual([
      "default",
      "opsifier_project_network",
      "opsifier_proxy_network",
    ]);
    expect(Object.keys(services.api?.networks ?? {}).sort()).toEqual([
      "opsifier_project_network",
      "opsifier_proxy_network",
    ]);
    expect(services.host?.networks).toBeUndefined();
  });

  it("pulls again every image the stack does not build, an included child's among them", () => {
    const children = resolvedOverrideChildren(
      {
        services: {
          web: { build: { context: "/x" }, image: "shop_stack-web", networks: { default: null } },
          worker: { image: "shop_stack-web", networks: { default: null } },
          cache: { image: "redis:7", networks: { back: null } },
          included: { image: "registry.example.test/private/tool:1", network_mode: "none" },
        },
      },
      "shop_stack",
    );
    expect(children).toEqual([
      { name: "web", declaresNetworks: false, networkMode: null, pullAlways: false, builds: true },
      { name: "worker", declaresNetworks: false, networkMode: null, pullAlways: false, builds: false },
      { name: "cache", declaresNetworks: true, networkMode: null, pullAlways: true, builds: false },
      { name: "included", declaresNetworks: true, networkMode: "none", pullAlways: true, builds: false },
    ]);
    const { services } = parse(
      renderComposeOverride({ project: "shop", service: "stack", qualified: "shop_stack", children }),
    ) as { services: Record<string, { pull_policy?: string; networks?: Record<string, unknown> }> };
    expect(
      Object.fromEntries(Object.entries(services).map(([name, child]) => [name, child.pull_policy])),
    ).toEqual({ web: undefined, worker: undefined, cache: "always", included: "always" });
    expect(Object.keys(services.worker?.networks ?? {})).toContain("default");
    expect(Object.keys(services.cache?.networks ?? {})).not.toContain("default");
  });

  it("gives every build the pinned frontend and its project's caches, and nothing else a build", () => {
    const { services } = parse(
      renderComposeOverride({
        project: "shop",
        service: "stack",
        qualified: "shop_stack",
        children: [
          { name: "web", declaresNetworks: false, networkMode: null, builds: true },
          { name: "cache", declaresNetworks: false, networkMode: null, pullAlways: true },
        ],
      }),
    ) as { services: Record<string, { build?: unknown }> };
    expect(services.web?.build).toEqual({
      pull: true,
      args: { BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND, BUILDKIT_CACHE_MOUNT_NS: "shop" },
    });
    expect(services.cache?.build).toBeUndefined();
  });
});

describe("whose image a stack may run", () => {
  it.each([
    ["opsifier/beta/web:latest", true],
    ["opsifier/releases/0b1c:1", true],
    ["opsifier/shop", true],
    ["beta_stack-web", true],
    ["beta_stack/web:edge", true],
    ["index.docker.io/beta_stack-web:1", true],
    ["opsifier/shop/api:latest", false],
    ["shop_other-web", false],
    ["nginx:1.27", false],
    ["library/nginx", false],
    ["ghcr.io/owner/image:1", false],
    ["registry.example.test:5000/team/app", false],
  ])("%s, for the project shop, is another's: %s", (image, foreign) => {
    expect(isForeignImage(image, "shop")).toBe(foreign);
  });
});

describe("the state of a stack", () => {
  const container = (over: Partial<ComposeContainerInfo>): ComposeContainerInfo => ({
    id: "x",
    name: "x",
    image: "x",
    project: "p_s",
    child: "web",
    number: 1,
    state: "running",
    status: "Up",
    exitCode: null,
    health: null,
    ports: [],
    ...over,
  });
  const facts = { stopped: false, completedChildren: [] };

  it("is running only when every child is", () => {
    expect(composeStatus([container({}), container({ child: "api" })], facts).status).toBe("running");
  });

  it("does not stay running when a child stops or fails", () => {
    const stopped = container({ child: "api", state: "exited", exitCode: 0, status: "Exited (0)" });
    expect(composeStatus([container({}), stopped], facts).status).toBe("failing");
    const failed = container({ child: "api", state: "exited", exitCode: 1, status: "Exited (1)" });
    expect(composeStatus([container({}), failed], facts).status).toBe("failing");
  });

  it("ignores a child that finished its job during the deploy", () => {
    const job = container({ child: "migrate", state: "exited", exitCode: 0, status: "Exited (0)" });
    expect(
      composeStatus([container({}), job], { stopped: false, completedChildren: ["migrate"] }).status,
    ).toBe("running");
  });

  it("reports a stack stopped on purpose as stopped", () => {
    const down = container({ state: "exited", exitCode: 137 });
    expect(composeStatus([down], { stopped: true, completedChildren: [] }).status).toBe("stopped");
  });

  it("counts a crash loop as failing and an unhealthy child as degraded", () => {
    const loop = container({ state: "restarting", exitCode: 1, status: "Restarting (1) 1 second ago" });
    expect(composeStatus([loop], facts).status).toBe("failing");
    expect(composeStatus([container({ health: "unhealthy" })], facts).status).toBe("failing");
  });
});

describe("the Compose API", () => {
  let context: TestContext;
  let cookie: string;

  const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
    call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

  const STACK = "/projects/shop/services/stack";
  const FILE =
    "services:\n  web:\n    image: traefik/whoami:v1.10\n    restart: unless-stopped\n  cache:\n    image: redis:7-alpine\n    restart: unless-stopped\n";

  async function waitFor(id: string): Promise<{ status: string; error: string | null; log: string }> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const { body } = await api<{ status: string; error: string | null; log: string }>(`/actions/${id}`);
      if (body.status !== "queued" && body.status !== "running") {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The action did not finish.");
  }

  beforeEach(async () => {
    context = await createTestContext();
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/compose", "POST", { name: "stack" });
  });

  afterEach(async () => {
    await context.close();
  });

  it("leaves confirming host access to an administrator, and an operator can't deploy without it", async () => {
    const operator = await signInMember(context.app, cookie, "op@example.com", [
      { project: "shop", role: "operator" },
    ]);
    const asOperator = (path: string, method: string, body?: unknown) =>
      call(context.app, `/api/v1${path}`, { method, body, cookie: operator, origin: TEST_ORIGIN });
    const dangerous = `${FILE}  socket:\n    image: alpine:3\n    restart: always\n    volumes: ['/var/run/docker.sock:/s']\n`;
    expect(
      (await asOperator(`${STACK}/compose/source`, "PUT", { type: "inline", content: dangerous })).status,
    ).toBe(200);

    const confirmed = await asOperator(`${STACK}/compose/acknowledge`, "POST", { content: dangerous });
    expect(confirmed.status).toBe(403);
    expect(apiErrorOf(confirmed).code).toBe("admin_required");
    expect((await asOperator(`${STACK}/deploy`, "POST", {})).status).toBe(409);

    expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: dangerous })).status).toBe(200);
    expect((await asOperator(`${STACK}/deploy`, "POST", {})).status).toBe(202);
  });

  it("says a port is taken without naming what another project runs on it", async () => {
    await api("/projects", "POST", { name: "beta" });
    await api("/projects/beta/services", "POST", { name: "web" });
    await api("/projects/beta/services/web/advanced/ports", "POST", { published: 30081, target: 80 });
    await api("/projects/shop/services", "POST", { name: "neighbour" });
    await api("/projects/shop/services/neighbour/advanced/ports", "POST", { published: 30082, target: 80 });
    const content =
      "services:\n  web:\n    image: nginx\n    restart: always\n    ports: ['30081:80', '30082:80']\n";

    const { body } = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", { type: "inline", content });

    const details = body.issues.filter((issue) => issue.code === "port_taken").map((issue) => issue.detail);
    expect(details).toEqual(["30081:80", "30082:80 (shop/neighbour)"]);
    expect(JSON.stringify(body.issues)).not.toContain("beta");
  });

  describe("the logs of a stack", () => {
    const TOPIC = "service-logs:shop/stack";
    const child = (id: string, name: string, state = "running"): ComposeContainerInfo => ({
      id,
      name: `shop_stack-${name}-1`,
      image: "redis:7-alpine",
      project: "shop_stack",
      child: name,
      number: 1,
      state,
      status: state === "running" ? "Up" : "Exited (0)",
      exitCode: state === "running" ? null : 0,
      health: null,
      ports: [],
    });
    const open = () => {
      const events: ServiceLogEvent[] = [];
      const feed = createComposeLogsProvider(context.deps).open(TOPIC, {
        publish: (event) => events.push(event as ServiceLogEvent),
        pressure: () => 0,
      });
      feeds.push(feed);
      return { events, feed };
    };
    const linesOf = (events: readonly ServiceLogEvent[]) =>
      events.flatMap((event) => (event.kind === "lines" ? event.lines : []));
    const feeds: TopicFeed[] = [];

    async function until(condition: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Timed out");
    }

    afterEach(() => {
      for (const feed of feeds.splice(0)) {
        feed.close();
      }
    });

    it("labels each child's standard error apart from its standard output", async () => {
      context.docker.composeContainers.push(child("c-web", "web"), child("c-api", "api"));
      context.docker.writeContainerLog("c-web", "web says hello");
      context.docker.writeContainerLog("c-web", "web is unhappy", "stderr");
      context.docker.writeContainerLog("c-api", "api is unhappy", "stderr");

      const { events } = open();
      await until(() => linesOf(events).length >= 3);

      expect(linesOf(events).map((line) => [line.line, line.stream])).toEqual(
        expect.arrayContaining([
          ["web-1 | web says hello", "stdout"],
          ["web-1 | web is unhappy", "stderr"],
          ["api-1 | api is unhappy", "stderr"],
        ]),
      );
    });

    it("keeps following lines as they are printed, with their stream", async () => {
      context.docker.composeContainers.push(child("c-web", "web"));
      const { events } = open();
      await new Promise((resolve) => setTimeout(resolve, 30));

      context.docker.writeContainerLog("c-web", "an error, printed later", "stderr");

      await until(() => linesOf(events).some((line) => line.line.includes("printed later")));
      expect(linesOf(events).find((line) => line.line.includes("printed later"))?.stream).toBe("stderr");
    });

    it("picks up a child that appears after the feed opened", async () => {
      const { events } = open();
      await until(() => events.some((event) => event.kind === "state" && event.state === "waiting"));
      context.docker.composeContainers.push(child("c-late", "late"));
      context.docker.writeContainerLog("c-late", "here at last");

      await until(() => linesOf(events).some((line) => line.line === "late-1 | here at last"));
    });

    it("reads a child that has stopped once, so its last words are not missed", async () => {
      const finished = child("c-job", "migrate", "exited");
      context.docker.composeContainers.push(finished, child("c-web", "web"));
      context.docker.writeContainerLog("c-job", "migration done");
      const seen: LogOptions[] = [];
      const original = context.docker.containerLogs.bind(context.docker);
      context.docker.containerLogs = (id, options = {}) => {
        if (id === "c-job") {
          seen.push(options);
        }
        return original(id, options);
      };

      const { events } = open();
      await until(() => linesOf(events).some((line) => line.line === "migrate-1 | migration done"));
      await new Promise((resolve) => setTimeout(resolve, 2300));

      expect(seen).toHaveLength(1);
      expect(seen[0]?.follow).toBe(false);
    }, 8000);

    it("repeats nothing when a child restarts and its follow begins again", async () => {
      const web = child("c-web", "web");
      context.docker.composeContainers.push(web);
      context.docker.writeContainerLog("c-web", "before the restart");
      const { events } = open();
      await until(() => linesOf(events).length === 1);

      // The container stops, so its follow ends, and then it comes back.
      web.state = "exited";
      context.docker.writeContainerLog("c-web", "wakes the follow so that it notices");
      await new Promise((resolve) => setTimeout(resolve, 2300));
      web.state = "running";
      context.docker.writeContainerLog("c-web", "after the restart");

      await until(() => linesOf(events).some((line) => line.line === "web-1 | after the restart"));
      const printed = linesOf(events).map((line) => line.line);
      expect(printed.filter((line) => line === "web-1 | before the restart")).toHaveLength(1);
    }, 8000);

    it("says how far back it reads and how much it keeps", async () => {
      const { feed } = open();

      expect(feed.replay?.()[0]).toMatchObject({ kind: "snapshot", tailLines: 200, ringLines: 1000 });
    });

    it("is searched one stream at a time", async () => {
      context.docker.composeContainers.push(child("c-web", "web"), child("c-api", "api"));
      context.docker.writeContainerLog("c-web", "all fine");
      context.docker.writeContainerLog("c-web", "fails on web", "stderr");
      context.docker.writeContainerLog("c-api", "fails on api", "stderr");

      const search = async (query: string) =>
        (await api<LogSearchResult>(`${STACK}/logs/search?since=3600&${query}`)).body.lines.map(
          (line) => line.line,
        );

      expect(await search("stream=stderr")).toEqual(["web-1 | fails on web", "api-1 | fails on api"]);
      expect(await search("stream=stdout")).toEqual(["web-1 | all fine"]);
      expect((await search("stream=all")).length).toBe(3);
    });

    it("is readings too, through the same call as any other service", async () => {
      context.docker.composeContainers.push(child("c-web", "web"));

      const reading = await api<ServiceMetrics>(`${STACK}/metrics`);

      expect(reading.body).toMatchObject({ available: true, tasks: 1, scope: "service" });
      expect(reading.body.memoryUsedBytes).toBeGreaterThan(0);
    });

    it("are unavailable, not zero, when Docker doesn't answer about a stack", async () => {
      context.docker.failNext("listComposeContainers");

      const reading = await api<ServiceMetrics>(`${STACK}/metrics`);

      expect(reading.body).toMatchObject({ available: false, memoryUsedBytes: null, readAt: null });
    });
  });

  it("creates an empty stack with one default domain", async () => {
    const detail = await api<ComposeDetail>(`${STACK}/compose`);
    expect(detail.body).toMatchObject({ source: null, services: [] });
    const domains = await api<{ domains: Array<{ primary: boolean; composeService: string | null }> }>(
      `${STACK}/domains`,
    );
    expect(domains.body.domains).toEqual([expect.objectContaining({ primary: true, composeService: "" })]);
    const summary = await api<ServiceDetail>(STACK);
    expect(summary.body.type).toBe("compose");
    expect(summary.body.status).toBe("undeployed");
  });

  it("saves a source, reports issues and refuses to deploy bad YAML", async () => {
    const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: "services: [",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.parseError).not.toBeNull();
    const deploy = await api(`${STACK}/deploy`, "POST", {});
    expect(deploy.status).toBe(409);
  });

  it("refuses at the door a container named outside the stack, and says how to name it", async () => {
    const named = "services:\n  web:\n    image: nginx\n    restart: always\n    container_name: shop_web\n";
    const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: named,
    });
    expect(saved.body.issues).toEqual([
      { severity: "error", code: "foreign_name", service: "web", detail: "container_name: shop_web" },
    ]);

    const refused = await api(`${STACK}/deploy`, "POST", {});

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("compose_invalid");
    expect(apiErrorOf(refused).message).toMatch(/Leave container_name out, or start it with shop_stack-/);
  });

  describe("a network its project doesn't own", () => {
    const JOINS_THE_PANEL =
      "services:\n  web:\n    image: nginx\n    restart: always\n    networks: [panel]\nnetworks:\n  panel:\n    external: true\n    name: opsifier\n";

    it("shows on the Source tab as what stops the deploy, and can't be confirmed away", async () => {
      const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
        type: "inline",
        content: JOINS_THE_PANEL,
      });

      expect(saved.body.issues).toEqual([
        { severity: "error", code: "foreign_network", service: null, detail: "opsifier" },
      ]);
      expect(saved.body.acknowledgementRequired).toBe(false);
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: JOINS_THE_PANEL })).status).toBe(
        200,
      );

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("compose_foreign_network");
      expect(apiErrorOf(refused).message).toMatch(/uses opsifier, a network its project does not own/);
      expect(apiErrorOf(refused).message).toMatch(/publish its port on its Expose tab/);
    });

    it("refuses what Compose itself resolved, which the file on the page doesn't show", async () => {
      const tools = context.deps.tools as FakeTools;
      const simulate = tools.handler;
      tools.handler = async (request) => {
        const output = request.args.indexOf("--output");
        if (output === -1) {
          return simulate?.(request);
        }
        writeFileSync(
          request.args[output + 1] ?? "",
          JSON.stringify({
            networks: { hidden: { name: "opsifier-other", external: true } },
            services: {},
          }),
        );
        return { exitCode: 0, tail: [] };
      };
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      const finished = await waitFor(action.body.id);

      expect(finished.status).toBe("failed");
      expect(finished.error).toMatch(/uses opsifier-other, a network/);
      expect(tools.calls.some((request) => request.args.includes("up"))).toBe(false);
    });

    it("passes the check with what the panel adds itself", async () => {
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});

      expect(await waitFor(action.body.id)).toMatchObject({ status: "succeeded", error: null });
      const tools = context.deps.tools as FakeTools;
      const output = tools.calls.find((request) => request.args.includes("--output"));
      expect(output?.args).toEqual(expect.arrayContaining(["config", "--format", "json"]));
      expect(context.docker.composeContainers[0]?.networks).toEqual(
        expect.arrayContaining(["opsifier-shop", "opsifier-shop_proxy"]),
      );
    });

    it("keeps the stack as it was, and says so, when a file already running asks for one", async () => {
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
      const first = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      expect((await waitFor(first.body.id)).status).toBe("succeeded");
      const running = context.docker.composeContainers.map((container) => container.id);

      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: JOINS_THE_PANEL });
      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(context.docker.composeContainers.map((container) => container.id)).toEqual(running);
      expect(context.docker.composeContainers.every((container) => container.state === "running")).toBe(true);
    });
  });

  it("keeps what the loader, Git and SSH read out of the Compose CLI it runs", async () => {
    const steering = ["LD_PRELOAD", "LD_LIBRARY_PATH", "GLIBC_TUNABLES", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK"];
    await api(`${STACK}/environment`, "PUT", {
      env: `IMAGE_TAG=v1\n${steering.map((name) => `${name}=/var/lib/opsifier/projects/shop/stack/code/x\n`).join("")}`,
    });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

    const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    const finished = await waitFor(action.body.id);

    expect(finished.status).toBe("succeeded");
    const compose = (context.deps.tools as FakeTools).calls.filter(
      (request) => request.args[0] === "compose",
    );
    expect(compose.find((request) => request.args.includes("up"))?.env.IMAGE_TAG).toBe("v1");
    for (const request of compose) {
      for (const name of steering) {
        expect(request.env[name]).toBeUndefined();
      }
    }
    expect(finished.log).toContain("Not passing these variables, they steer Compose itself");
  });

  it("gives every Compose command an empty source policy, set last, whatever the stack says", async () => {
    await api(`${STACK}/environment`, "PUT", {
      env: "EXPERIMENTAL_BUILDKIT_SOURCE_POLICY=/var/lib/opsifier/projects/shop/stack/code/policy.json\nOTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\n",
    });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const tools = context.deps.tools as FakeTools;

    const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", { force: true });

    expect((await waitFor(action.body.id)).status).toBe("succeeded");
    const compose = tools.calls.filter((request) => request.args[0] === "compose");
    expect(
      compose.map((request) => request.args.find((arg) => ["config", "build", "up"].includes(arg))),
    ).toEqual(expect.arrayContaining(["config", "build", "up"]));
    for (const request of compose) {
      expect(request.env.EXPERIMENTAL_BUILDKIT_SOURCE_POLICY).toBe("");
      expect(request.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    }

    // Even a caller that hands the name on gets the empty one.
    tools.calls.length = 0;
    await runCompose(context.deps, { projectName: "shop", serviceName: "stack" }, ["ls"], {
      variables: { EXPERIMENTAL_BUILDKIT_SOURCE_POLICY: "/srv/policy.json" },
    });
    expect(
      tools.calls.find((request) => request.args[0] === "compose")?.env.EXPERIMENTAL_BUILDKIT_SOURCE_POLICY,
    ).toBe("");
  });

  it("does not deploy without a file", async () => {
    const deploy = await api(`${STACK}/deploy`, "POST", {});
    expect(deploy.status).toBe(409);
    expect(apiErrorOf(deploy).code).toBe("service_has_no_source");
  });

  it("deploys through the Compose CLI as an argument vector and tracks the children", async () => {
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    expect(action.status).toBe(202);
    const finished = await waitFor(action.body.id);
    expect(finished).toMatchObject({ status: "succeeded", error: null });

    const tools = context.deps.tools as unknown as { calls: Array<{ command: string; args: string[] }> };
    const up = tools.calls.find((request) => request.args.includes("up"));
    expect(up?.command).toBe("docker");
    expect(up?.args).toEqual(
      expect.arrayContaining([
        "compose",
        "--project-name",
        "shop_stack",
        "up",
        "--detach",
        "--build",
        "--remove-orphans",
      ]),
    );

    const summary = await api<ServiceDetail>(STACK);
    expect(summary.body.status).toBe("running");
    const runtime = await api<ComposeRuntime>(`${STACK}/compose/children`);
    expect(runtime.body.children.map((child) => [child.name, child.state])).toEqual([
      ["cache", "running"],
      ["web", "running"],
    ]);
    expect(await context.docker.inspectService("shop_stack")).toBeNull();
  });

  it("targets a child from a domain, and stops and starts", async () => {
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const domains = await api<{ domains: Array<{ id: string; host: string }> }>(`${STACK}/domains`);
    const [domain] = domains.body.domains;
    const updated = await api<{ internalUrl: string; composeService: string }>(
      `${STACK}/domains/${domain?.id}`,
      "PUT",
      {
        host: domain?.host,
        port: 80,
        composeService: "web",
      },
    );
    expect(updated.body.internalUrl).toBe("http://shop_stack__web:80/");

    const deployed = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    await waitFor(deployed.body.id);

    const stop = await api<{ id: string }>(`${STACK}/stop`, "POST");
    expect((await waitFor(stop.body.id)).status).toBe("succeeded");
    expect((await api<ServiceDetail>(STACK)).body.status).toBe("stopped");

    const start = await api<{ id: string }>(`${STACK}/start`, "POST");
    expect((await waitFor(start.body.id)).status).toBe("succeeded");
    expect((await api<ServiceDetail>(STACK)).body.status).toBe("running");
  });

  it("needs someone to confirm access to the host, for this exact file", async () => {
    const dangerous = `${FILE}  socket:\n    image: alpine:3\n    restart: always\n    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n`;
    const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: dangerous,
    });
    expect(saved.body.acknowledgementRequired).toBe(true);

    const refused = await api(`${STACK}/deploy`, "POST", {});
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("compose_needs_confirmation");

    const stale = await api(`${STACK}/compose/acknowledge`, "POST", { content: "something else" });
    expect(stale.status).toBe(409);

    const acknowledged = await api<ComposeDetail>(`${STACK}/compose/acknowledge`, "POST", {
      content: dangerous,
    });
    expect(acknowledged.body).toMatchObject({ acknowledged: true, acknowledgementRequired: false });
    expect((await api(`${STACK}/deploy`, "POST", {})).status).toBe(202);

    // Editing the file puts it back in front of a person.
    const edited = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: `${dangerous}# changed\n`,
    });
    expect(edited.body.acknowledged).toBe(false);
  });

  describe("what Compose brings in beyond the file on the page", () => {
    const code = () => join(context.dataDir, "projects", "shop", "stack", "code");
    const fake = () => context.deps.tools as FakeTools;
    const composeRan = () => fake().calls.some((request) => request.args[0] === "compose");
    const upRan = () => fake().calls.some((request) => request.args.includes("up"));
    const INCLUDES = "include:\n  - ./more.yml\nservices:\n  web:\n    image: nginx\n    restart: always\n";
    const PRIVILEGED_TOOL =
      "services:\n  tool:\n    image: alpine:3\n    restart: always\n    privileged: true\n";

    async function deploy(as = cookie) {
      const accepted = await call<{ id: string }>(context.app, `/api/v1${STACK}/deploy`, {
        method: "POST",
        body: {},
        cookie: as,
        origin: TEST_ORIGIN,
      });
      expect(accepted.status).toBe(202);
      return waitFor(accepted.body.id);
    }

    it("asks an administrator about what an included file reaches, and again once that changes", async () => {
      writeFileSync(join(code(), "more.yml"), PRIVILEGED_TOOL);
      const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
        type: "inline",
        content: INCLUDES,
      });
      // The page alone can't show it: the file it reads is somewhere else.
      expect(saved.body.acknowledgementRequired).toBe(false);

      const refused = await deploy();
      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/nobody has confirmed \(privileged tool\)/);
      expect(upRan()).toBe(false);
      const shown = await api<ComposeDetail>(`${STACK}/compose`);
      expect(shown.body).toMatchObject({ acknowledgementRequired: true, acknowledged: false });
      expect(shown.body.issues).toEqual(
        expect.arrayContaining([{ severity: "host", code: "privileged", service: "tool", detail: null }]),
      );

      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: INCLUDES })).status).toBe(200);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledged).toBe(true);
      expect((await deploy()).status).toBe("succeeded");

      // The file on the page stays the same. What it includes does not.
      writeFileSync(join(code(), "more.yml"), `${PRIVILEGED_TOOL}    volumes: ['/:/host']\n`);
      const again = await deploy();
      expect(again.status).toBe("failed");
      expect(again.error).toMatch(/nobody has confirmed/);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.issues).toEqual(
        expect.arrayContaining([{ severity: "host", code: "docker_socket", service: "tool", detail: "/" }]),
      );
    });

    it("asks again when an included file changes what runs in a child that reaches the server", async () => {
      writeFileSync(join(code(), "more.yml"), PRIVILEGED_TOOL);
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: INCLUDES })).status).toBe(200);
      expect((await deploy()).status).toBe("succeeded");

      // What the child reaches stays the same: only the image that runs with it changes.
      writeFileSync(join(code(), "more.yml"), PRIVILEGED_TOOL.replace("alpine:3", "alpine:edge"));
      fake().calls.length = 0;
      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /nobody has confirmed \(privileged tool\), or what runs with that access/,
      );
      expect(upRan()).toBe(false);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledgementRequired).toBe(true);
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: INCLUDES })).status).toBe(200);
      expect((await deploy()).status).toBe("succeeded");
    });

    it("asks again when a variable changes the image of a child that reaches the server", async () => {
      const file = `services:\n  tool:\n    image: '\${TOOL_IMAGE}'\n    restart: always\n    privileged: true\n`;
      await api(`${STACK}/environment`, "PUT", { env: "TOOL_IMAGE=alpine:3\n" });
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: file });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: file })).status).toBe(200);
      expect((await deploy()).status).toBe("succeeded");

      await api(`${STACK}/environment`, "PUT", { env: "TOOL_IMAGE=registry.example.test/anything:1\n" });
      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/or what runs with that access/);
    });

    it("binds a confirmation to the .env file the deploy writes", async () => {
      const file = "services:\n  tool:\n    image: alpine:3\n    restart: always\n    privileged: true\n";
      await api(`${STACK}/environment`, "PUT", { env: "MODE=safe\n" });
      await api(`${STACK}/compose/env-file`, "PUT", { enabled: true });
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: file });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: file })).status).toBe(200);
      expect((await deploy()).status).toBe("succeeded");

      await api(`${STACK}/environment`, "PUT", { env: "MODE=anything\n" });
      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/a file the stack is read from, changed since someone did/);
    });

    it("asks again when a variable moves a confirmed mount somewhere else on the server", async () => {
      const mounts = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['\${DATA}:/data:ro']\n`;
      await api(`${STACK}/environment`, "PUT", { env: "DATA=/srv/shared\n" });
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: mounts })).status).toBe(200);
      expect((await deploy()).status).toBe("succeeded");

      const operator = await signInMember(context.app, cookie, "op@example.com", [
        { project: "shop", role: "operator" },
      ]);
      const changed = await call(context.app, `/api/v1${STACK}/environment`, {
        method: "PUT",
        body: { env: "DATA=/etc\n" },
        cookie: operator,
        origin: TEST_ORIGIN,
      });
      // A confirmed stack reaches the server: what runs in it, its variables included, is an administrator's.
      expect(changed.status).toBe(403);
      expect(apiErrorOf(changed).code).toBe("service_reaches_server");
      expect((await api(`${STACK}/environment`, "PUT", { env: "DATA=/etc\n" })).status).toBe(200);
      fake().calls.length = 0;

      const refused = await deploy(operator);
      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/host_path web \/etc/);
      expect(upRan()).toBe(false);
      const confirm = await call(context.app, `/api/v1${STACK}/compose/acknowledge`, {
        method: "POST",
        body: { content: mounts },
        cookie: operator,
        origin: TEST_ORIGIN,
      });
      expect(confirm.status).toBe(403);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledgementRequired).toBe(true);
    });

    it("keeps a confirmed stack's file, where it comes from and its .env option to administrators", async () => {
      const mounts = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['/srv/shared:/data:ro']\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: mounts })).status).toBe(200);
      const operator = await signInMember(context.app, cookie, "op@example.com", [
        { project: "shop", role: "operator" },
      ]);
      const asOperator = (path: string, body: unknown) =>
        call(context.app, `/api/v1${STACK}${path}`, {
          method: "PUT",
          body,
          cookie: operator,
          origin: TEST_ORIGIN,
        });

      const repointed = await asOperator("/compose/source", {
        type: "git",
        url: "https://git.example.com/someone-else/stack.git",
        ref: "main",
        path: "/",
      });
      expect(repointed.status).toBe(403);
      expect(apiErrorOf(repointed).code).toBe("service_reaches_server");
      expect((await asOperator("/compose/env-file", { enabled: true })).status).toBe(403);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledged).toBe(true);
      expect((await api(`${STACK}/compose/env-file`, "PUT", { enabled: true })).status).toBe(200);
    });

    it("refuses a source an operator saves while an administrator confirms the stack", async () => {
      const mounts = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['/srv/shared:/data:ro']\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      const operator = await signInMember(context.app, cookie, "op@example.com", [
        { project: "shop", role: "operator" },
      ]);
      const tools = context.deps.tools as FakeTools;
      const simulate = tools.handler;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let probing = false;
      tools.handler = async (request) => {
        if (request.command === "git" && request.args.includes("ls-remote")) {
          probing = true;
          await gate;
        }
        return simulate?.(request);
      };

      const pending = call(context.app, `/api/v1${STACK}/compose/source`, {
        method: "PUT",
        body: { type: "git", url: "https://git.example.com/operator/stack.git", ref: "main", path: "/" },
        cookie: operator,
        origin: TEST_ORIGIN,
      });
      for (let attempt = 0; attempt < 400 && !probing; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(probing).toBe(true);
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: mounts })).status).toBe(200);
      release();

      const answer = await pending;
      expect(answer.status).toBe(403);
      expect(apiErrorOf(answer).code).toBe("service_reaches_server");
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledged).toBe(true);
    });

    it("asks again once the file comes from somewhere else, even the same file", async () => {
      const mounts = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['/srv/shared:/data:ro']\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content: mounts })).status).toBe(200);

      const moved = await api(`${STACK}/compose/source`, "PUT", {
        type: "git",
        url: "https://git.example.com/acme/stack.git",
        ref: "main",
        path: "/",
      });

      expect(moved.status).toBe(200);
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledged).toBe(false);
    });

    it("refuses a confirmation a save landed in the middle of", async () => {
      const mounts = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['/srv/shared:/data:ro']\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      const tools = context.deps.tools as FakeTools;
      const simulate = tools.handler;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading = false;
      tools.handler = async (request) => {
        if (request.args[0] === "compose" && request.args.includes("config") && !reading) {
          reading = true;
          await gate;
        }
        return simulate?.(request);
      };

      const confirming = api(`${STACK}/compose/acknowledge`, "POST", { content: mounts });
      for (let attempt = 0; attempt < 400 && !reading; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reading).toBe(true);
      const other = `${mounts}  more:\n    image: alpine:3\n    restart: always\n`;
      expect((await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: other })).status).toBe(
        200,
      );
      release();

      const answer = await confirming;
      expect(answer.status).toBe(409);
      expect(apiErrorOf(answer).code).toBe("compose_changed");
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.acknowledged).toBe(false);
    });

    it("refuses a mount through a link the stack wrote in its own folder, whatever an administrator says", async () => {
      const mounts =
        "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['./data/inner:/data']\n";
      symlinkSync("/", join(code(), "data"));
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      await api(`${STACK}/compose/acknowledge`, "POST", { content: mounts });

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/web mounts \.\/data\/inner, but \.\/data is a link/);
      expect(upRan()).toBe(false);
    });

    it("refuses a build that reads its context through a link, whatever an administrator says", async () => {
      const content = "services:\n  web:\n    build: ./site/app\n    restart: always\n";
      symlinkSync("/", join(code(), "site"));
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/web builds from \.\/site\/app, its context, but \.\/site is a link/);
      expect(upRan()).toBe(false);
    });

    it("refuses a pipe in place of .env at once, rather than wait on it", async () => {
      execFileSync("mkfifo", [join(code(), ".env")]);
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /\.\/\.env, a file the stack is read from, is neither a folder nor a file/,
      );
      expect(composeRan()).toBe(false);
    });

    it("refuses at the door a local volume that binds a folder, and says to bind it in the service", async () => {
      const content =
        "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['v:/v']\nvolumes:\n  v:\n    driver_opts: { type: none, o: bind, device: ./vol }\n";
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).message).toMatch(
        /its volume v binds a folder of the server through its driver options.*Mount the folder with a bind in the service's volumes instead/,
      );
    });

    it("refuses at the door SSH keys written in a form it can't read, and says how to write them", async () => {
      const content =
        "services:\n  web:\n    restart: always\n    build: { context: ., ssh: { deploy: [./keys/id] } }\n";
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).message).toMatch(
        /the build of web names the SSH keys it forwards in a form the panel can't read.*Write them as a list of id=path entries/,
      );
    });

    describe("the volumes the stack already has", () => {
      const volume = (name: string, options: Record<string, string>) =>
        context.docker.createVolume({
          name,
          driverOptions: options,
          labels: {
            "com.docker.compose.project": "shop_stack",
            "com.docker.compose.volume": name.slice("shop_stack_".length),
          },
        });

      it("can't include one that binds a folder of the server, which a container mounts as a plain volume", async () => {
        await volume("shop_stack_old", { type: "none", o: "bind", device: "/" });
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
        fake().calls.length = 0;

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while its volume shop_stack_old binds a folder of the server \(\/\).*Stop the stack and remove that volume, then deploy/,
        );
        expect(upRan()).toBe(false);
      });

      it("can't include one made with other options than the file now gives it", async () => {
        const declares = (size: string) =>
          `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['scratch:/s']\nvolumes:\n  scratch:\n    driver_opts: { type: tmpfs, device: tmpfs, o: 'size=${size}' }\n`;
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: declares("10m") });
        await api(`${STACK}/compose/acknowledge`, "POST", { content: declares("10m") });
        expect((await deploy()).status).toBe("succeeded");
        expect((await context.docker.inspectVolume("shop_stack_scratch"))?.options).toEqual({
          type: "tmpfs",
          device: "tmpfs",
          o: "size=10m",
        });
        // The same file deploys again: the volume is as it says.
        expect((await deploy()).status).toBe("succeeded");

        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: declares("20m") });
        await api(`${STACK}/compose/acknowledge`, "POST", { content: declares("20m") });
        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while its volume shop_stack_scratch was made with other options than the file now gives it/,
        );
      });
    });

    describe("a build from the stack's folder beside a folder a child mounts", () => {
      const BESIDE = "services:\n  web:\n    build: .\n    restart: always\n    volumes: ['./data:/data']\n";

      beforeEach(() => {
        writeFileSync(join(code(), "Dockerfile"), "FROM alpine:3\n");
      });

      it("is refused while the build would walk a folder a container writes, saying how to fix it", async () => {
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BESIDE });
        fake().calls.length = 0;

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /web builds from a context that holds \.\/data, a folder web mounts read-write.*Add data to the \.dockerignore of that context, or mount it read-only/,
        );
        expect(upRan()).toBe(false);
      });

      it.each([
        ["data", "a plain line"],
        ["/data/", "a line with slashes around it"],
        ["# what the build leaves out\nnode_modules\ndata\n", "a line among others"],
      ])("deploys once the context's .dockerignore leaves the folder out: %s (%s)", async (lines) => {
        writeFileSync(join(code(), ".dockerignore"), `${lines}\n`);
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BESIDE });

        expect((await deploy()).status).toBe("succeeded");
      });

      it("deploys once the folder is mounted read-only", async () => {
        await api(`${STACK}/compose/source`, "PUT", {
          type: "inline",
          content: BESIDE.replace("'./data:/data'", "'./data:/data:ro'"),
        });

        expect((await deploy()).status).toBe("succeeded");
      });

      it("reads the .dockerignore beside the Dockerfile first, as the build does", async () => {
        writeFileSync(join(code(), ".dockerignore"), "data\n");
        writeFileSync(join(code(), "Dockerfile.dockerignore"), "node_modules\n");
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BESIDE });

        expect((await deploy()).status).toBe("failed");
      });

      it.each([
        ["an exception anywhere in the file", "data\n!data/keep\n"],
        ["a pattern rather than a name", "dat*\n"],
        ["a folder above the context's own", "../data\n"],
      ])("counts nothing as left out with %s", async (_label, lines) => {
        writeFileSync(join(code(), ".dockerignore"), lines);
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BESIDE });

        expect((await deploy()).status).toBe("failed");
      });

      it("refuses an ignore file the panel can't read as a plain file", async () => {
        symlinkSync(join(code(), "elsewhere"), join(code(), ".dockerignore"));
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BESIDE });

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /\.\/\.dockerignore, which says what the build of web leaves out, is not a plain file/,
        );
      });
    });

    it("looks at what a mount goes through again right before the stack starts", async () => {
      const mounts =
        "services:\n  web:\n    build: ./app\n    restart: always\n    volumes: ['./data/inner:/data']\n";
      mkdirSync(join(code(), "app"));
      writeFileSync(join(code(), "app", "Dockerfile"), "FROM alpine:3\n");
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });
      const simulate = fake().handler;
      // Whatever might change the folder while the images build, after the stack was checked.
      fake().handler = async (request) => {
        if (request.args.includes("build")) {
          symlinkSync("/", join(code(), "data"));
        }
        return simulate?.(request);
      };

      const accepted = await call<{ id: string }>(context.app, `/api/v1${STACK}/deploy`, {
        method: "POST",
        body: { force: true },
        cookie,
        origin: TEST_ORIGIN,
      });
      const refused = await waitFor(accepted.body.id);

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/\.\/data is a link/);
      expect(upRan()).toBe(false);
    });

    it.each([
      ["the stack's own folder", "volumes: ['.:/stack']", "", /Mount a subfolder of the stack instead/],
      [
        "a folder that holds what another child mounts",
        "volumes: ['./data:/data']",
        "  other:\n    image: alpine:3\n    restart: always\n    volumes: ['./data/sub:/sub']\n",
        /mounts \.\/data, which holds \.\/data\/sub/,
      ],
      [
        "a folder that holds a file the stack is read from",
        "volumes: ['./conf:/conf']\n    env_file: [conf/app.env]",
        "",
        /mounts \.\/conf, which holds \.\/conf\/app\.env/,
      ],
      [
        "the file the stack starts from",
        "volumes: ['./docker-compose.yml:/compose.yml']",
        "",
        /a file the stack is read from/,
      ],
    ])("refuses at the door a child that mounts %s", async (_label, lines, more, message) => {
      writeFileSync(join(code(), "app.env"), "A=1\n");
      const file = `services:\n  web:\n    image: nginx\n    restart: always\n    ${lines}\n${more}`;
      const saved = await api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
        type: "inline",
        content: file,
      });
      expect(saved.body.issues.map((issue) => [issue.severity, issue.code])).toContainEqual([
        "error",
        "mounts_stack",
      ]);

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("compose_invalid");
      expect(apiErrorOf(refused).message).toMatch(message);
    });

    it("refuses what an included file mounts above another child's mount, before Compose reads anything", async () => {
      writeFileSync(
        join(code(), "more.yml"),
        "services:\n  tool:\n    image: alpine:3\n    restart: always\n    volumes: ['./web:/w']\n",
      );
      const content = `${INCLUDES}    volumes: ['./web/data:/data']\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/tool mounts \.\/web, which holds \.\/web\/data/);
      expect(composeRan()).toBe(false);
    });

    it("refuses a mount Compose resolved to the stack's own folder, from a variable", async () => {
      const content = `services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['\${HERE}:/stack']\n`;
      await api(`${STACK}/environment`, "PUT", { env: `HERE=${realpathSync(code())}\n` });
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
      expect((await api(`${STACK}/compose/acknowledge`, "POST", { content })).status).toBe(200);
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/web mounts the stack's own folder/);
      expect(upRan()).toBe(false);
    });

    it("lets two children share a folder of the stack, which neither can replace", async () => {
      const content =
        "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['./shared:/srv']\n  worker:\n    image: alpine:3\n    restart: always\n    volumes: ['./shared:/data', './nginx.conf:/etc/nginx.conf:ro']\n";
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

      expect((await deploy()).status).toBe("succeeded");
    });

    describe("the containers of the last deploy", () => {
      const stop = async () => {
        const stopped = await api<{ id: string }>(`${STACK}/stop`, "POST");
        expect((await waitFor(stopped.body.id)).status).toBe("succeeded");
      };

      it("can't hold what the new configuration mounts while they run, and can once stopped", async () => {
        const first =
          "services:\n  w:\n    image: alpine:3\n    restart: always\n    volumes: ['./data:/data']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: first });
        expect((await deploy()).status).toBe("succeeded");

        // The new file alone is fine: w is gone. Its container still runs until Compose replaces it.
        const second =
          "services:\n  b:\n    image: alpine:3\n    restart: always\n    volumes: ['./data/sub:/sub']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: second });
        fake().calls.length = 0;
        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while w \(shop_stack-w-1\) runs: since its last deploy it mounts \.\/data, which holds \.\/data\/sub .* Stop the stack, then deploy/,
        );
        expect(upRan()).toBe(false);

        await stop();
        const deployed = await deploy();
        expect(deployed.status).toBe("succeeded");
        expect(context.docker.composeContainers.map((container) => container.child)).toEqual(["b"]);
      });

      it("can't hold a file the new configuration is read from", async () => {
        const first =
          "services:\n  w:\n    image: alpine:3\n    restart: always\n    volumes: ['./conf:/conf']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: first });
        expect((await deploy()).status).toBe("succeeded");

        mkdirSync(join(code(), "conf"), { recursive: true });
        writeFileSync(
          join(code(), "conf", "x.yml"),
          "services:\n  x:\n    image: alpine:3\n    restart: always\n",
        );
        const second = "include:\n  - conf/x.yml\nservices:\n  web:\n    image: nginx\n    restart: always\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: second });
        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(/mounts \.\/conf, which holds \.\/conf\/x\.yml/);
      });

      it.each([
        ["read-write, refused", "./app/uploads:/u", "", "failed"],
        ["read-only, allowed", "./app/uploads:/u:ro", "", "succeeded"],
        [
          "read-write in a folder the context's .dockerignore leaves out, allowed",
          "./app/uploads:/u",
          "uploads\n",
          "succeeded",
        ],
      ])(
        "may write inside what a new build walks only when it can't change what it reads: %s",
        async (_label, bind, ignore, status) => {
          const first = `services:\n  w:\n    image: alpine:3\n    restart: always\n    volumes: ['${bind}']\n`;
          await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: first });
          expect((await deploy()).status).toBe("succeeded");

          const second = "services:\n  web:\n    build: ./app\n    restart: always\n";
          mkdirSync(join(code(), "app"), { recursive: true });
          writeFileSync(join(code(), "app", "Dockerfile"), "FROM alpine:3\n");
          if (ignore !== "") {
            writeFileSync(join(code(), "app", ".dockerignore"), ignore);
          }
          await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: second });
          const deployed = await deploy();

          expect(deployed.status).toBe(status);
          if (status === "failed") {
            expect(deployed.error).toMatch(
              /since its last deploy it writes in \.\/app\/uploads, inside \.\/app, which a build of the stack as it is now walks.*Add uploads to the \.dockerignore of that context, mount it read-only, or stop the stack/,
            );
          }
        },
      );

      it("can't mount a folder inside a local cache a new build reads, which it opens through links", async () => {
        const first =
          "services:\n  w:\n    image: alpine:3\n    restart: always\n    volumes: ['./cache/blobs:/b']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: first });
        expect((await deploy()).status).toBe("succeeded");

        const second =
          "services:\n  web:\n    build: { context: ./app, cache_from: ['type=local,src=./cache'] }\n    restart: always\n";
        mkdirSync(join(code(), "app"), { recursive: true });
        writeFileSync(join(code(), "app", "Dockerfile"), "FROM alpine:3\n");
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: second });
        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /it mounts \.\/cache\/blobs, inside \.\/cache, which a build of the stack as it is now reads/,
        );
      });

      it("are looked at again right before the stack starts, once the images are built", async () => {
        const content =
          "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['./data/sub:/sub']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
        const simulate = fake().handler;
        // One that starts while the images build, after the first look found nothing running.
        fake().handler = async (request) => {
          if (request.args.includes("build")) {
            context.docker.composeContainers.push({
              id: "late",
              name: "shop_stack-late-1",
              image: "alpine:3",
              project: "shop_stack",
              child: "late",
              number: 1,
              state: "running",
              status: "Up 1 second",
              exitCode: null,
              health: null,
              ports: [],
              labels: { "opsifier.project": "shop", "opsifier.service": "stack", "opsifier.type": "compose" },
              binds: [{ source: join(realpathSync(code()), "data"), rw: true }],
            });
          }
          return simulate?.(request);
        };
        fake().calls.length = 0;

        const accepted = await call<{ id: string }>(context.app, `/api/v1${STACK}/deploy`, {
          method: "POST",
          body: { force: true },
          cookie,
          origin: TEST_ORIGIN,
        });
        const refused = await waitFor(accepted.body.id);

        expect(fake().calls.some((request) => request.args.includes("build"))).toBe(true);
        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while late \(shop_stack-late-1\) runs: since its last deploy it mounts \.\/data, which holds \.\/data\/sub/,
        );
        expect(upRan()).toBe(false);
      });

      it("can't be one started through a link on its bind's path, which holds what the link led to", async () => {
        mkdirSync(join(code(), "data"), { recursive: true });
        symlinkSync("..", join(code(), "data", "sub"));
        context.docker.composeContainers.push({
          id: "linked",
          name: "shop_stack-linked-1",
          image: "alpine:3",
          project: "shop_stack",
          child: "linked",
          number: 1,
          state: "running",
          status: "Up 3 days",
          exitCode: null,
          health: null,
          ports: [],
          labels: { "opsifier.project": "shop", "opsifier.service": "stack", "opsifier.type": "compose" },
          binds: [{ source: join(realpathSync(code()), "data", "sub"), rw: false }],
        });
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while linked \(shop_stack-linked-1\) runs: it mounts \.\/data\/sub, which goes through a link at \.\/data\/sub/,
        );
      });

      it("can't be one deployed before these rules that mounts the stack's own folder", async () => {
        context.docker.composeContainers.push({
          id: "old",
          name: "shop_stack-old-1",
          image: "alpine:3",
          project: "shop_stack",
          child: "old",
          number: 1,
          state: "running",
          status: "Up 3 days",
          exitCode: null,
          health: null,
          ports: [],
          labels: { "opsifier.project": "shop", "opsifier.service": "stack", "opsifier.type": "compose" },
          binds: [
            { source: realpathSync(code()), rw: true },
            { source: "/srv/elsewhere", rw: true },
          ],
        });
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /while old \(shop_stack-old-1\) runs: since its last deploy it mounts the stack's own folder/,
        );
      });
    });

    it.each([
      ["an env file outside the stack", "    env_file: [x/../../../../other/web/code/.env]\n"],
      ["a remote include of its own", "include:\n  - git@example.test:owner/repo.git\n"],
      ["a provider", "    provider:\n      type: /var/lib/opsifier/projects/shop/stack/code/tool\n"],
    ])("refuses an included file with %s before Compose reads anything", async (_label, lines) => {
      const nested = lines.startsWith("include")
        ? `${lines}services:\n  tool:\n    image: alpine:3\n    restart: always\n`
        : `services:\n  tool:\n    image: alpine:3\n    restart: always\n${lines}`;
      writeFileSync(join(code(), "more.yml"), nested);
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/can't run: (escapes_stack|runs_program)/);
      expect(composeRan()).toBe(false);
    });

    it("refuses a build in an included file that would take another image's name", async () => {
      writeFileSync(
        join(code(), "more.yml"),
        "services:\n  tool:\n    build: .\n    image: ghcr.io/voidagency/opsifier:0.2.2\n    restart: always\n",
      );
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/can't run: foreign_image \(ghcr.io\/voidagency\/opsifier:0.2.2\)/);
      expect(upRan()).toBe(false);
    });

    describe("its builds", () => {
      const BUILDS = "services:\n  web:\n    build: ./app\n    restart: always\n";
      const dockerfile = (text: string) => {
        mkdirSync(join(code(), "app"), { recursive: true });
        writeFileSync(join(code(), "app", "Dockerfile"), text);
      };

      it.each([
        [
          "an image of another project",
          "FROM opsifier/beta/web:latest\n",
          /in the build of web: .*another project/,
        ],
        [
          "what another project's stack built, through a build argument",
          "ARG BASE=beta_stack-web\nFROM $BASE\n",
          /in the build of web: .*beta_stack-web/,
        ],
        [
          "another frontend",
          "# syntax=registry.example.test/frontend:1\nFROM alpine:3\n",
          /in the build of web: .*frontend registry\.example\.test\/frontend:1/,
        ],
      ])("refuses a Dockerfile that names %s, before anything runs", async (_label, text, message) => {
        dockerfile(text);
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BUILDS });
        fake().calls.length = 0;

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(message);
        expect(upRan()).toBe(false);
      });

      it.each([
        [
          "another frontend in a build argument",
          "    build: { context: ./app, args: { BUILDKIT_SYNTAX: 'registry.example.test/frontend:1' } }\n",
          /passes BUILDKIT_SYNTAX=registry\.example\.test\/frontend:1/,
        ],
        [
          "an inline Dockerfile that names another project's image",
          "    build: { context: ./app, dockerfile_inline: 'FROM opsifier/beta/web:latest' }\n",
          /in the build of web: .*opsifier\/beta\/web/,
        ],
        [
          "a context BuildKit would fetch for itself",
          "    build: https://example.test/owner/repo.git#main\n",
          /builds from https:\/\/example\.test\/owner\/repo\.git#main, which BuildKit would fetch/,
        ],
      ])("refuses %s, before anything runs", async (_label, build, message) => {
        dockerfile("FROM alpine:3\n");
        const content = `services:\n  web:\n    restart: always\n${build}`;
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
        fake().calls.length = 0;

        const refused = await deploy();

        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(message);
        expect(upRan()).toBe(false);
      });

      it("builds from what another child builds through Compose's own service context", async () => {
        mkdirSync(join(code(), "base"), { recursive: true });
        writeFileSync(join(code(), "base", "Dockerfile"), "FROM alpine:3\n");
        dockerfile("FROM base\nRUN true\n");
        const content =
          "services:\n  base:\n    build: ./base\n    restart: always\n  web:\n    restart: always\n    build:\n      context: ./app\n      additional_contexts: { base: 'service:base' }\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

        const deployed = await deploy();

        expect(deployed.error).toBeNull();
        expect(deployed.status).toBe("succeeded");
        expect(deployed.log).not.toMatch(/which only this server has/);
      });

      it("pulls what a build starts from, and says when that is an image only this server has", async () => {
        dockerfile("FROM shop_stack-base:1\nRUN true\n");
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: BUILDS });

        const deployed = await deploy();

        expect(deployed.status).toBe("succeeded");
        expect(deployed.log).toMatch(/names shop_stack-base:1, which only this server has/);
        const override = parse(
          readFileSync(
            join(context.dataDir, "projects", "shop", "stack", "docker-compose.override.yml"),
            "utf8",
          ),
        ) as { services: Record<string, { build?: unknown }> };
        expect(override.services.web?.build).toEqual({
          pull: true,
          args: { BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND, BUILDKIT_CACHE_MOUNT_NS: "shop" },
        });
      });

      it("builds with the pinned frontend over the file's own, and keeps the file's other arguments", async () => {
        dockerfile("# syntax=docker/dockerfile:1.4\nFROM alpine:3\nARG NODE_ENV\n");
        const content =
          "services:\n  web:\n    restart: always\n    build:\n      context: ./app\n      args: ['NODE_ENV=production', 'BUILDKIT_SYNTAX=docker/dockerfile:1.4', 'BUILDKIT_CACHE_MOUNT_NS=beta']\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
        const simulate = fake().handler;
        const output = join(context.dataDir, "resolved-at-up.json");
        fake().handler = async (request) => {
          const up = request.args.indexOf("up");
          if (up !== -1) {
            // What Compose makes of the files it starts the stack with, the override among them.
            await fake().run({
              ...request,
              args: [...request.args.slice(0, up), "config", "--format", "json", "--output", output],
            });
          }
          return simulate?.(request);
        };

        const deployed = await deploy();

        expect(deployed.status).toBe("succeeded");
        const resolved = JSON.parse(readFileSync(output, "utf8")) as {
          services: Record<string, { build?: { args?: unknown } }>;
        };
        expect(resolved.services.web?.build?.args).toEqual({
          NODE_ENV: "production",
          BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND,
          BUILDKIT_CACHE_MOUNT_NS: "shop",
        });
      });

      it("pulls an image a child mounts before the stack starts, and stops when that fails", async () => {
        const pulled: string[] = [];
        const original = context.docker.pullImage.bind(context.docker);
        context.docker.pullImage = async (ref, options) => {
          pulled.push(ref);
          return original(ref, options);
        };
        const content =
          "services:\n  web:\n    image: nginx:1\n    restart: always\n    volumes: [{ type: image, source: 'registry.example.test/assets:1', target: /assets }]\n";
        await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

        expect((await deploy()).status).toBe("succeeded");
        expect(pulled).toEqual(["registry.example.test/assets:1"]);

        context.docker.failNext("pullImage");
        fake().calls.length = 0;
        const refused = await deploy();
        expect(refused.status).toBe("failed");
        expect(refused.error).toMatch(
          /registry\.example\.test\/assets:1, which web mounts, could not be pulled/,
        );
        expect(upRan()).toBe(false);
      });
    });

    it("refuses an included file the panel can't read as Compose does, before Compose reads anything", async () => {
      const references = Array.from({ length: 201 }, () => "*word").join(", ");
      writeFileSync(
        join(code(), "more.yml"),
        `x-word: &word hello\nservices:\n  tool:\n    image: alpine:3\n    restart: always\n    command: [${references}]\n`,
      );
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/\.\/more\.yml can't be read the way Compose would read it/);
      expect(composeRan()).toBe(false);
    });

    it("refuses an included file that extends a file named through a variable, before Compose reads anything", async () => {
      writeFileSync(
        join(code(), "more.yml"),
        `services:\n  tool:\n    image: alpine:3\n    restart: always\n    extends: { file: '\${BASE}', service: base }\n`,
      );
      await api(`${STACK}/environment`, "PUT", { env: "BASE=base.yml\n" });
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /names what it brings in through a variable \(extends file: \$\{BASE\}\)/,
      );
      expect(composeRan()).toBe(false);
    });

    it("refuses an include of several files at once, which Compose reads from the first one's folder", async () => {
      mkdirSync(join(code(), "a"), { recursive: true });
      writeFileSync(
        join(code(), "a", "one.yml"),
        "services:\n  one:\n    image: alpine:3\n    restart: always\n",
      );
      writeFileSync(join(code(), "two.yml"), "services:\n  one:\n    restart: always\n");
      const content = `include:\n  - path: [a/one.yml, two.yml]\nservices:\n  web:\n    image: nginx\n    restart: always\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/includes several files at once \(a\/one\.yml, two\.yml\)/);
    });

    it("refuses an include read from an absolute folder, and follows nothing from there", async () => {
      const elsewhere = join(code(), "..", "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(
        join(code(), "more.yml"),
        "include:\n  - inner.yml\nservices:\n  tool:\n    image: alpine:3\n    restart: always\n",
      );
      const content = `include:\n  - path: more.yml\n    project_directory: ${elsewhere}\nservices:\n  web:\n    image: nginx\n    restart: always\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
      fake().calls.length = 0;

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).message).toMatch(
        /an include reads the paths of its file from .*elsewhere, outside the stack's folder.*Name a folder of the stack, relative to the file that includes it/,
      );
      expect(composeRan()).toBe(false);
    });

    it("refuses an included file whose own includes could be read from two places", async () => {
      mkdirSync(join(code(), "parts"), { recursive: true });
      writeFileSync(
        join(code(), "parts", "more.yml"),
        "include:\n  - inner.yml\nservices:\n  tool:\n    image: alpine:3\n    restart: always\n",
      );
      const content = `include:\n  - path: parts/more.yml\n    project_directory: .\nservices:\n  web:\n    image: nginx\n    restart: always\n`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /\.\/parts\/more\.yml can't be followed: it includes or extends files by a relative path/,
      );
    });

    it.each([
      ["its .env", ".env", "FILE"],
      ["an env file", "app.env", "    env_file: [app.env]\n"],
      ["an included file", "more.yml", "INCLUDES"],
    ])("refuses %s reached through a link, before Compose reads anything", async (_label, name, lines) => {
      mkdirSync(join(code(), "vars"), { recursive: true });
      writeFileSync(
        join(code(), "vars", "real"),
        "services:\n  tool:\n    image: alpine:3\n    restart: always\n",
      );
      symlinkSync(join(code(), "vars", "real"), join(code(), name));
      const content =
        lines === "FILE"
          ? FILE
          : lines === "INCLUDES"
            ? INCLUDES
            : `${FILE.replace("redis:7-alpine", "redis:7")}${lines}`;
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        new RegExp(
          `\\./${name.replace(".", "\\.")}, a file the stack is read from, is reached through a link at \\./${name.replace(".", "\\.")}`,
        ),
      );
      expect(composeRan()).toBe(false);
    });

    it("refuses a child an included file names like another project's service, before anything starts", async () => {
      writeFileSync(
        join(code(), "more.yml"),
        "services:\n  beta_web:\n    image: nginx:1\n    restart: always\n",
      );
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /beta_web is a name another project's service or the panel may answer to/,
      );
      expect(refused.error).toMatch(/such as beta-web/);
      expect(upRan()).toBe(false);
    });

    it("marks an included child as the panel's, and has Compose pull its image again", async () => {
      writeFileSync(
        join(code(), "more.yml"),
        "services:\n  tool:\n    image: alpine:3\n    restart: always\n",
      );
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });

      expect((await deploy()).status).toBe("succeeded");

      const override = parse(
        readFileSync(
          join(context.dataDir, "projects", "shop", "stack", "docker-compose.override.yml"),
          "utf8",
        ),
      ) as { services: Record<string, { labels: Record<string, string>; pull_policy?: string }> };
      expect(override.services.tool).toMatchObject({
        labels: { "opsifier.project": "shop", "opsifier.service": "stack" },
        pull_policy: "always",
      });
      expect(override.services.web?.pull_policy).toBe("always");
    });

    it("still reads a stack with a Compose that doesn't know how to keep env files as paths", async () => {
      const simulate = fake().handler;
      fake().handler = async (request) =>
        request.args.includes("--no-env-resolution")
          ? { exitCode: 1, tail: ["unknown flag: --no-env-resolution"] }
          : simulate?.(request);
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });

      expect((await deploy()).status).toBe("succeeded");
      expect(upRan()).toBe(true);
    });

    it("refuses a host port another project holds, published through an included file", async () => {
      await api("/projects", "POST", { name: "beta" });
      await api("/projects/beta/services", "POST", { name: "web" });
      await api("/projects/beta/services/web/advanced/ports", "POST", { published: 30081, target: 80 });
      writeFileSync(
        join(code(), "more.yml"),
        "services:\n  tool:\n    image: alpine:3\n    restart: always\n    ports: ['30081:80']\n",
      );
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: INCLUDES });
      fake().calls.length = 0;

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/30081 is already used on this server/);
      expect(refused.error).not.toMatch(/beta/);
      expect(upRan()).toBe(false);
    });

    it("refuses a host port a container outside the stack holds, and not one the stack holds itself", async () => {
      const file = "services:\n  web:\n    image: nginx\n    restart: always\n    ports: ['30090:80']\n";
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: file });
      context.docker.containers.push({
        id: "other",
        name: "someone-else",
        image: "nginx",
        imageId: "sha256:x",
        state: "running",
        labels: {},
        sizeBytes: null,
        ports: [{ protocol: "tcp", port: 30090 }],
      });

      const refused = await deploy();
      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/30090 is already used on this server/);

      context.docker.containers.splice(0, context.docker.containers.length, {
        id: "own",
        name: "shop_stack-web-1",
        image: "nginx",
        imageId: "sha256:x",
        state: "running",
        labels: { "com.docker.compose.project": "shop_stack" },
        sizeBytes: null,
        ports: [{ protocol: "tcp", port: 30090 }],
      });
      expect((await deploy()).status).toBe("succeeded");
    });

    it("refuses a remote include on the page before anything is queued", async () => {
      const remote =
        "include:\n  - https://example.test/owner/repo.git#main:compose.yaml\nservices:\n  web:\n    image: nginx\n    restart: always\n";
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: remote });
      fake().calls.length = 0;

      const refused = await api(`${STACK}/deploy`, "POST", {});

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("compose_invalid");
      expect(composeRan()).toBe(false);
    });
  });

  describe("from a Git source", () => {
    const tools = () =>
      context.deps.tools as unknown as FakeTools & { checkoutFiles: Record<string, string> };

    beforeEach(() => {
      tools().checkoutFiles = { "deploy/compose.yaml": FILE, "deploy/.env.example": "NAME=value\n" };
    });

    const saveGit = () =>
      api<ComposeDetail>(`${STACK}/compose/source`, "PUT", {
        type: "git",
        url: "https://example.test/owner/repo.git",
        ref: "main",
        path: "/deploy",
        file: "compose.yaml",
      });

    it("refuses a file in a subfolder of its build path that includes others by a relative path", async () => {
      tools().checkoutFiles = {
        "deploy/compose.yaml":
          "include:\n  - more.yml\nservices:\n  web:\n    image: nginx\n    restart: always\n",
        "deploy/more.yml": "services:\n  tool:\n    image: alpine:3\n    restart: always\n",
        "more.yml": "services:\n  tool:\n    image: alpine:3\n    restart: always\n    privileged: true\n",
      };
      await api(`${STACK}/compose/source`, "PUT", {
        type: "git",
        url: "https://example.test/owner/repo.git",
        ref: "main",
        path: "/",
        file: "deploy/compose.yaml",
      });

      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      const refused = await waitFor(action.body.id);

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /\.\/deploy\/compose\.yaml can't be followed: .* set the build path to the folder that holds it/,
      );
    });

    it("deploys the file from the repository, and keeps what the stack wrote there", async () => {
      expect((await saveGit()).status).toBe(200);
      const first = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      expect((await waitFor(first.body.id)).status).toBe("succeeded");

      const code = join(context.dataDir, "projects", "shop", "stack", "code");
      writeFileSync(join(code, "deploy", "written-by-stack.txt"), "keep me");

      // The next deploy replaces what the checkout brought, not what the stack wrote.
      tools().checkoutFiles = { "deploy/compose.yaml": `${FILE}\n# changed\n` };
      const second = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      expect((await waitFor(second.body.id)).status).toBe("succeeded");
      expect(readFileSync(join(code, "deploy", "written-by-stack.txt"), "utf8")).toBe("keep me");
      expect(readFileSync(join(code, "deploy", "compose.yaml"), "utf8")).toContain("# changed");
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.content).toContain("# changed");
    });

    it("starts from the repository's .env.example on a stack with no variables yet", async () => {
      await saveGit();
      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      expect((await waitFor(action.body.id)).status).toBe("succeeded");
      const environment = await api<{ env: string }>(`${STACK}/environment/reveal`, "POST");
      expect(environment.body.env).toBe("NAME=value\n");
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.envFile).toBe(true);
    });

    it("removes what the last checkout brought without following a link the stack left in its place", async () => {
      const code = join(context.dataDir, "projects", "shop", "stack", "code");
      const elsewhere = join(context.dataDir, "elsewhere");
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, "keep.db"), "not the stack's");
      tools().checkoutFiles = { "deploy/compose.yaml": FILE, "deploy/a/keep.db": "from the repository" };
      await saveGit();
      const first = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      expect((await waitFor(first.body.id)).status).toBe("succeeded");

      rmSync(join(code, "deploy", "a"), { recursive: true });
      symlinkSync(elsewhere, join(code, "deploy", "a"));
      tools().checkoutFiles = { "deploy/compose.yaml": FILE };
      const second = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});

      expect((await waitFor(second.body.id)).status).toBe("succeeded");
      expect(readFileSync(join(elsewhere, "keep.db"), "utf8")).toBe("not the stack's");
    });

    it("takes no .env.example that is a link, wherever it points", async () => {
      const code = join(context.dataDir, "projects", "shop", "stack", "code");
      const secret = join(context.dataDir, "other.env");
      writeFileSync(secret, "SECRET=not-for-this-stack\n");
      mkdirSync(join(code, "deploy"), { recursive: true });
      symlinkSync(secret, join(code, "deploy", ".env.example"));
      tools().checkoutFiles = { "deploy/compose.yaml": FILE };
      await saveGit();

      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});

      expect((await waitFor(action.body.id)).status).toBe("succeeded");
      const environment = await api<{ env: string }>(`${STACK}/environment/reveal`, "POST");
      expect(environment.body.env).toBe("");
      expect((await api<ComposeDetail>(`${STACK}/compose`)).body.envFile).toBe(false);
    });

    it("stops at the host-access check for a file only known after fetching it", async () => {
      tools().checkoutFiles = {
        "deploy/compose.yaml": `${FILE}    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n`,
      };
      await saveGit();
      const action = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
      const finished = await waitFor(action.body.id);
      expect(finished.status).toBe("failed");
      expect(finished.error).toContain("confirm");
    });
  });

  it("refuses to rename a stack", async () => {
    const { status } = await api(`${STACK}/rename`, "POST", { projectName: "shop", name: "other" });
    expect(status).toBe(409);
  });

  it("destroys the stack without touching its volumes", async () => {
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const deployed = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    await waitFor(deployed.body.id);
    const destroy = await api<{ id: string }>(STACK, "DELETE", { confirm: "stack" });
    expect((await waitFor(destroy.body.id)).status).toBe("succeeded");
    expect((await api(STACK)).status).toBe(404);
    const tools = context.deps.tools as unknown as { calls: Array<{ args: string[] }> };
    const down = tools.calls.find((request) => request.args.includes("down"));
    expect(down?.args).toEqual(expect.arrayContaining(["down", "--remove-orphans"]));
    expect(down?.args).not.toContain("--volumes");
    expect((await context.docker.listComposeContainers("shop_stack")).length).toBe(0);
  });

  it("records the stack's named volumes as kept, and names them in its log", async () => {
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const deployed = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    await waitFor(deployed.body.id);
    await context.docker.createVolume({
      name: "shop_stack_data",
      labels: { "com.docker.compose.project": "shop_stack" },
    });

    const destroy = await api<{ id: string }>(STACK, "DELETE", { confirm: "stack" });

    expect((await waitFor(destroy.body.id)).log).toContain("Keeping the volume shop_stack_data");
    expect(await context.docker.inspectVolume("shop_stack_data")).not.toBeNull();
  });

  it("fails a destroy that can't take the stack down, and keeps the stack", async () => {
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
    const deployed = await api<{ id: string }>(`${STACK}/deploy`, "POST", {});
    await waitFor(deployed.body.id);
    (context.deps.tools as FakeTools).handler = (request) =>
      request.args.includes("down") ? { exitCode: 1, tail: ["cannot reach the daemon"] } : undefined;

    const destroy = await api<{ id: string }>(STACK, "DELETE", { confirm: "stack" });
    const finished = await waitFor(destroy.body.id);

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Taking the stack down failed");
    expect((await api(STACK)).status).toBe(200);
  });
});
