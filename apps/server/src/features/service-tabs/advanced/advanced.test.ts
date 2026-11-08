import type { ActionEntry, AdvancedDocument, PortList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const SERVICE = "/api/v1/projects/shop/services/web";
const PATH = `${SERVICE}/advanced`;
const PORTS = `${PATH}/ports`;
const DEPLOY = `${PATH}/deploy`;
const PORT = { protocol: "tcp", published: 30080, target: 80 };

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/api/v1/projects", "POST", { name: "shop" });
  await api("/api/v1/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, path, { method, body, cookie, origin: TEST_ORIGIN });
}

async function run(path: string, method = "POST", body?: unknown): Promise<ActionEntry> {
  const accepted = await api<ActionEntry>(path, method, body);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const { body: action } = await api<ActionEntry>(`/api/v1/actions/${accepted.body.id}`);
    if (action.status !== "queued" && action.status !== "running") {
      return action;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

describe("published ports", () => {
  it("adds, edits, deletes one and deletes all", async () => {
    const added = await api<PortList>(PORTS, "POST", PORT);
    expect(added.status).toBe(201);
    expect(added.body.ports).toEqual([PORT]);

    await api(PORTS, "POST", { protocol: "udp", published: 30053, target: 53 });
    const edited = await api<PortList>(`${PORTS}/0`, "PUT", { ...PORT, published: 30081 });
    expect(edited.body.ports[0]?.published).toBe(30081);

    const removed = await api<PortList>(`${PORTS}/0`, "DELETE");
    expect(removed.body.ports.map((port) => port.protocol)).toEqual(["udp"]);

    expect((await api<PortList>(PORTS, "DELETE")).body.ports).toEqual([]);
  });

  it.each([
    ["published 0", { published: 0, target: 80 }, "published"],
    ["target 0", { published: 30080, target: 0 }, "target"],
    ["a published port above the range", { published: 65536, target: 80 }, "published"],
    ["a target above the range", { published: 30080, target: 70000 }, "target"],
    ["a negative port", { published: -1, target: 80 }, "published"],
    ["a fractional port", { published: 30080.5, target: 80 }, "published"],
    ["a port that isn't a number", { published: "30080", target: 80 }, "published"],
    ["an unknown protocol", { protocol: "icmp", published: 30080, target: 80 }, "protocol"],
  ])("refuses %s", async (_label, body, field) => {
    const result = await api(PORTS, "POST", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeDefined();
  });

  it("refuses the same port twice, but tracks TCP and UDP apart", async () => {
    await api(PORTS, "POST", PORT);

    const duplicate = await api(PORTS, "POST", PORT);
    expect(duplicate.status).toBe(409);
    expect(apiErrorOf(duplicate).code).toBe("port_duplicate");
    expect(apiErrorOf(duplicate).fields?.published).toBeDefined();

    expect((await api(PORTS, "POST", { ...PORT, protocol: "udp" })).status).toBe(201);
  });

  it("refuses a port another service has saved, deployed or not", async () => {
    await api("/api/v1/projects/shop/services", "POST", { name: "api" });
    await api("/api/v1/projects/shop/services/api/advanced/ports", "POST", PORT);

    const clash = await api(PORTS, "POST", PORT);

    expect(clash.status).toBe(409);
    expect(apiErrorOf(clash).code).toBe("port_in_use");
    expect((await api(PORTS, "POST", { ...PORT, protocol: "udp" })).status).toBe(201);
  });

  it("refuses a port something else already publishes in Docker", async () => {
    await context.docker.createService({
      Name: "someone-else",
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      EndpointSpec: {
        Ports: [{ Protocol: "tcp", TargetPort: 80, PublishedPort: 30080, PublishMode: "host" }],
      },
    });

    expect(apiErrorOf(await api(PORTS, "POST", PORT)).code).toBe("port_in_use");
  });

  it("still saves when Docker doesn't answer", async () => {
    context.docker.failNext("listServices");

    expect((await api(PORTS, "POST", PORT)).status).toBe(201);
  });

  it.each([
    ["the proxy's HTTP port", { published: 80 }],
    ["the proxy's HTTPS port", { published: 443 }],
    ["the panel's own port", { published: 3000 }],
  ])("refuses %s", async (_label, overrides) => {
    const result = await api(PORTS, "POST", { ...PORT, ...overrides });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("port_reserved");
  });

  it("allows UDP on a port the proxy only holds in TCP", async () => {
    expect((await api(PORTS, "POST", { protocol: "udp", published: 443, target: 443 })).status).toBe(201);
  });

  it("lets a port keep its own number when it is edited", async () => {
    await api(PORTS, "POST", PORT);

    expect((await api(`${PORTS}/0`, "PUT", { ...PORT, target: 8080 })).status).toBe(200);
  });

  it("answers 404 for a position that does not exist", async () => {
    expect((await api(`${PORTS}/4`, "DELETE")).status).toBe(404);
  });
});

describe("deploy settings", () => {
  it("defaults to one replica with zero downtime", async () => {
    const { body } = await api<AdvancedDocument>(PATH);

    expect(body).toEqual({
      deploy: {
        replicas: 1,
        zeroDowntime: true,
        tiniInit: false,
        command: null,
        capAdd: [],
        capDrop: [],
        sysctls: {},
        groups: [],
      },
      ports: [],
      stopped: false,
    });
  });

  it("saves every field and records the change, without touching what is running", async () => {
    const settings = {
      replicas: 2,
      zeroDowntime: false,
      tiniInit: true,
      command: "nginx -g 'daemon off;'",
      capAdd: ["NET_ADMIN"],
      capDrop: ["MKNOD"],
      sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      groups: ["999"],
    };
    const before = await context.docker.listServices();

    expect((await api(DEPLOY, "PUT", settings)).status).toBe(200);

    expect((await api<AdvancedDocument>(PATH)).body.deploy).toEqual(settings);
    expect(await context.docker.listServices()).toEqual(before);
    const actions = await api<{ items: unknown[] }>("/api/v1/actions?type=service.deploy-settings");
    expect(actions.body.items).toHaveLength(1);
  });

  it.each([
    ["zero replicas on a running service", { replicas: 0 }, "replicas"],
    ["negative replicas", { replicas: -1 }, "replicas"],
    ["fractional replicas", { replicas: 1.5 }, "replicas"],
    ["too many replicas", { replicas: 101 }, "replicas"],
    ["an unknown capability", { capAdd: ["NET_ADMINN"] }, "capAdd.0"],
    ["a lowercase capability", { capDrop: ["net_admin"] }, "capDrop.0"],
    ["a capability listed twice", { capAdd: ["CHOWN", "CHOWN"] }, "capAdd"],
    ["a capability both added and dropped", { capAdd: ["CHOWN"], capDrop: ["CHOWN"] }, "capDrop"],
    ["a sysctl that is not namespaced", { sysctls: { "vm.swappiness": "1" } }, "sysctls.vm.swappiness"],
    ["a sysctl with no dot", { sysctls: { kernel: "1" } }, "sysctls.kernel"],
    ["a sysctl with spaces in its name", { sysctls: { "net.a b": "1" } }, "sysctls.net.a b"],
    ["a sysctl with no value", { sysctls: { "net.core.somaxconn": "" } }, "sysctls.net.core.somaxconn"],
    ["a sysctl value with a line break", { sysctls: { "net.core.x": "1\n2" } }, "sysctls.net.core.x"],
    ["a group that isn't numeric", { groups: ["wheel"] }, "groups.0"],
    ["a group beyond the range", { groups: ["4294967296"] }, "groups.0"],
    ["a blank command", { command: "   " }, "command"],
  ])("refuses %s", async (_label, body, field) => {
    const result = await api(DEPLOY, "PUT", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeDefined();
  });

  it("accepts zero replicas on a stopped service, and then refuses to start it", async () => {
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });
    expect((await run(`${SERVICE}/deploy`)).status).toBe("succeeded");
    expect((await run(`${SERVICE}/stop`)).status).toBe("succeeded");

    expect((await api(DEPLOY, "PUT", { replicas: 0 })).status).toBe(200);

    const start = await api(`${SERVICE}/start`, "POST");
    expect(start.status).toBe(409);
    expect(apiErrorOf(start).code).toBe("service_has_no_replicas");
    const redeploy = await api(`${SERVICE}/deploy`, "POST");
    expect(redeploy.status).toBe(409);
    expect(apiErrorOf(redeploy).code).toBe("service_has_no_replicas");
  });
});

describe("start-first updates with published ports", () => {
  it("refuses a second replica while ports are published", async () => {
    await api(PORTS, "POST", PORT);

    const result = await api(DEPLOY, "PUT", { replicas: 2 });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("replicas_with_ports");
    expect(apiErrorOf(result).fields?.replicas).toBeDefined();
  });

  it("refuses to publish a port while there are several replicas", async () => {
    await api(DEPLOY, "PUT", { replicas: 2 });

    const result = await api(PORTS, "POST", PORT);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("ports_with_replicas");
  });

  it("rolls out stop-first, even with zero downtime left on", async () => {
    await api(PORTS, "POST", PORT);
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" });

    expect((await run(`${SERVICE}/deploy`)).status).toBe("succeeded");

    const inspected = await context.docker.inspectService("shop_web");
    expect(inspected?.spec.UpdateConfig).toMatchObject({ Order: "stop-first" });
    expect(inspected?.spec.EndpointSpec?.Ports).toEqual([
      { Protocol: "tcp", TargetPort: 80, PublishedPort: 30080, PublishMode: "host" },
    ]);
  });
});
