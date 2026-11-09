import type { ExposeSettings } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInfo } from "../../../core/docker";
import type { TestContext } from "../../../testing/harness";
import { apiErrorOf, type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../../databases/testing";

let suite: DatabaseTestContext;
let context: TestContext;

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
});

afterEach(async () => {
  await suite.close();
  vi.restoreAllMocks();
});

const exposePath = () => `${suite.service()}/expose`;
const endpointOf = async () => (await context.docker.inspectService("shop_db"))?.spec.EndpointSpec;

describe("DAT-07: exposing a database on a public port", () => {
  it("defaults to not exposed", async () => {
    await suite.deployed({ engine: "redis" });
    expect((await suite.api<ExposeSettings>(exposePath())).body).toEqual({ port: 0, publishedPort: 0 });
    expect(await endpointOf()).toEqual({ Mode: "dnsrr" });
  });

  it("only stores a port when saved: nothing is published and no restart happens until a deployment", async () => {
    await suite.deployed({ engine: "redis" });
    const before = await context.docker.inspectService("shop_db");
    const tasks = await context.docker.listTasks({ service: "shop_db" });

    const saved = await suite.api<ExposeSettings>(exposePath(), "PUT", { port: 16379 });

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ port: 16379 });
    expect(await context.docker.inspectService("shop_db")).toEqual(before);
    expect(await context.docker.listTasks({ service: "shop_db" })).toEqual(tasks);
    expect(context.deps.actions.isIdle()).toBe(true);
    expect((await suite.api<ExposeSettings>(exposePath())).body).toEqual({ port: 16379, publishedPort: 0 });

    expect((await suite.run(`${suite.service()}/deploy`)).status).toBe("succeeded");

    expect(await endpointOf()).toMatchObject({ Ports: [{ PublishedPort: 16379 }] });
    expect((await suite.api<ExposeSettings>(exposePath())).body).toEqual({
      port: 16379,
      publishedPort: 16379,
    });
  });

  it("publishes the engine port on the host in host mode, then reports it", async () => {
    await suite.deployed({ engine: "redis" });

    const action = await suite.saveThenDeploy(exposePath(), { port: 16379 });

    expect(action.status).toBe("succeeded");
    expect(await endpointOf()).toEqual({
      Mode: "dnsrr",
      Ports: [{ Protocol: "tcp", TargetPort: 6379, PublishedPort: 16379, PublishMode: "host" }],
    });
    expect((await suite.api<ExposeSettings>(exposePath())).body).toEqual({
      port: 16379,
      publishedPort: 16379,
    });
  });

  it("removes the published port on 0", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.saveThenDeploy(exposePath(), { port: 16379 });

    expect((await suite.saveThenDeploy(exposePath(), { port: 0 })).status).toBe("succeeded");
    expect(await endpointOf()).toEqual({ Mode: "dnsrr" });
  });

  it.each([
    [70000, "Use 0 or a port from 1024 to 65535"],
    [-1, "Use 0 or a port from 1024 to 65535"],
    [80, "Use 0 or a port from 1024 to 65535"],
    [1023, "Use 0 or a port from 1024 to 65535"],
    [12.5, "Use a whole number"],
  ])("rejects port %s with a field-level error", async (port, message) => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(exposePath(), "PUT", { port });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toEqual({ port: message });
    expect(await endpointOf()).toEqual({ Mode: "dnsrr" });
  });

  it("rejects a port that is not a number", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(exposePath(), "PUT", { port: "16379" });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.port).toBe("Enter a port number");
  });

  it("refuses the panel's own port", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(exposePath(), "PUT", { port: context.deps.config.port });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("port_reserved");
    expect(Object.keys(apiErrorOf(result).fields ?? {})).toEqual(["port"]);
  });

  it.each([2377, 7946, 4789])("refuses Docker's port %s", async (port) => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(exposePath(), "PUT", { port });
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("port_reserved");
  });

  it("detects a conflict with another database, even a stopped one", async () => {
    await suite.deployed({ engine: "redis", name: "other" });
    await suite.saveThenDeploy(`${suite.service("other")}/expose`, { port: 16379 });
    await suite.run(`${suite.service("other")}/stop`);
    await suite.deployed({ engine: "redis" });

    const result = await suite.api(exposePath(), "PUT", { port: 16379 });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("port_in_use");
    expect(apiErrorOf(result).fields).toEqual({ port: "Already used by shop/other" });
    expect(await endpointOf()).toEqual({ Mode: "dnsrr" });
  });

  it("never says what another project holds, only that the port is taken", async () => {
    await suite.api("/projects", "POST", { name: "beta" });
    const other = await suite.api<{ activeAction: { id: string } }>("/projects/beta/databases", "POST", {
      name: "cache",
      engine: "redis",
    });
    await suite.waitFor(other.body.activeAction.id);
    await suite.saveThenDeploy("/projects/beta/services/cache/expose", { port: 16379 });
    await suite.deployed({ engine: "redis" });

    const result = await suite.api(exposePath(), "PUT", { port: 16379 });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("port_in_use");
    expect(JSON.stringify(result.body)).not.toContain("beta");
    expect(JSON.stringify(result.body)).not.toContain("cache");
    expect(apiErrorOf(result).fields).toEqual({ port: "Already used by another service" });
  });

  it("detects a conflict with something published outside the panel", async () => {
    await context.docker.createService({
      Name: "foreign",
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      EndpointSpec: {
        Ports: [{ TargetPort: 80, PublishedPort: 18080, Protocol: "tcp", PublishMode: "host" }],
      },
    });
    await suite.deployed({ engine: "redis" });

    const result = await suite.api(exposePath(), "PUT", { port: 18080 });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).fields).toEqual({ port: "Already used by another service" });
  });

  it("allows re-saving its own port", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.saveThenDeploy(exposePath(), { port: 16379 });

    const action = await suite.saveThenDeploy(exposePath(), { port: 16379 });
    expect(action.status).toBe("succeeded");
  });

  it("leaves the running database alone when a port is refused at save time", async () => {
    await suite.deployed({ engine: "redis" });
    const before = await context.docker.inspectService("shop_db");

    await suite.api(exposePath(), "PUT", { port: context.deps.config.port });

    expect(await context.docker.inspectService("shop_db")).toEqual(before);
  });

  it("fails visibly and restores the previous state when the host has the port in use", async () => {
    await suite.deployed({ engine: "redis" });

    // Swarm keeps the task Pending and says why: the port is taken on the node.
    const listTasks = context.docker.listTasks.bind(context.docker);
    let attempted = false;
    vi.spyOn(context.docker, "updateService").mockImplementationOnce(async (name, spec, options) => {
      const updated = await Object.getPrototypeOf(context.docker).updateService.call(
        context.docker,
        name,
        spec,
        options,
      );
      attempted = true;
      return updated;
    });
    vi.spyOn(context.docker, "listTasks").mockImplementation(async (filter) => {
      const tasks = await listTasks(filter);
      return attempted && (await endpointOf())?.Ports !== undefined
        ? tasks.map(
            (task): TaskInfo => ({
              ...task,
              state: "pending",
              error: "no suitable node (host-mode port already in use on 1 node)",
            }),
          )
        : tasks;
    });

    const action = await suite.saveThenDeploy(exposePath(), { port: 16379 });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("Port 16379 is already in use on this server");
    expect(await endpointOf()).toEqual({ Mode: "dnsrr" });
    expect((await suite.api<ExposeSettings>(exposePath())).body).toEqual({ port: 0, publishedPort: 0 });
  });

  it("answers 404 for a service that is not a database", async () => {
    await suite.api(`/projects/${PROJECT}/services`, "POST", { name: "web" });
    expect((await suite.api(`${suite.service("web")}/expose`, "PUT", { port: 16379 })).status).toBe(404);
  });
});
