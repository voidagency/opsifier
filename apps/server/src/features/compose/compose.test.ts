import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createComposeLogsProvider } from "./feeds";
import { foreignNetworks, hasHostAccess, inspectComposeFile } from "./inspect";
import { renderComposeOverride } from "./override";
import { platformPorts } from "./ports";
import { composeStatus } from "./status";

const DATA_DIR = "/var/lib/opsifier";
const SCOPE = { project: "shop", stack: "shop_stack" };
const inspect = (text: string) => inspectComposeFile(text, { dataDir: DATA_DIR, ...SCOPE });

describe("reading a compose file", () => {
  it("reports container_name and ports, naming the service", () => {
    const { issues, services } = inspect(
      "services:\n  web:\n    image: nginx\n    container_name: w\n    ports:\n      - 80:80\n",
    );
    expect(services).toEqual(["web"]);
    expect(issues.map((issue) => [issue.code, issue.service])).toEqual(
      expect.arrayContaining([
        ["container_name", "web"],
        ["published_port", "web"],
      ]),
    );
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
      "a volume bound to a host path",
      "volumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: /\n",
      "host_path",
    ],
  ])("counts %s as reaching outside the stack", (_label, section, code) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n${section}`);
    expect(issues.find((issue) => issue.code === code)?.severity).toBe("host");
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
    ["build: { context: ., cache_to: ['type=local,dest=/var/lib/opsifier/cache'] }", "data_directory"],
    ["label_file: /etc/labels", "host_path"],
    ["credential_spec: { file: /etc/spec.json }", "host_path"],
  ])("counts %s as reaching the host", (line, code) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n    ${line}\n`);
    expect(issues.find((issue) => issue.code === code)?.severity).toBe("host");
  });

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
    ["a provider", "    provider:\n      type: /var/lib/opsifier/projects/shop/stack/code/tool\n", ""],
    ["a model", "    models: [llm]\n", "models:\n  llm:\n    model: ai/smollm2\n"],
  ])("refuses a service that hands work to %s, a program run beside the panel", (_label, lines, top) => {
    const { issues } = inspect(`services:\n  web:\n    image: nginx\n    restart: always\n${lines}${top}`);
    expect(issues.find((issue) => issue.code === "runs_program")?.severity).toBe("error");
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
      expect(changed.status).toBe(200);
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

    it("counts a mount inside the stack for where a link the stack wrote there leads", async () => {
      const mounts =
        "services:\n  web:\n    image: nginx\n    restart: always\n    volumes: ['./data:/data']\n";
      symlinkSync("/", join(code(), "data"));
      await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: mounts });

      const refused = await deploy();

      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(/nobody has confirmed \(host_path web .*data -> \/\)/);
      expect(upRan()).toBe(false);
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
