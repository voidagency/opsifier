import type { ResourcesSpec, ServiceDetail } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestContext } from "../../../testing/harness";
import { apiErrorOf, type DatabaseTestContext, setupDatabaseTests } from "../../databases/testing";

let suite: DatabaseTestContext;
let context: TestContext;

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
});

afterEach(async () => {
  await suite.close();
});

const path = () => `${suite.service()}/database-resources`;
const swarm = () => context.docker.inspectService("shop_db");

describe("DAT-08: resource limits", () => {
  it("only stores limits when saved: nothing restarts until a deployment", async () => {
    await suite.deployed({ engine: "redis" });
    const before = await swarm();
    const tasks = await context.docker.listTasks({ service: "shop_db" });
    const values = { memoryReservation: 64, memoryLimit: 128, cpuReservation: 0.1, cpuLimit: 0.5 };

    const saved = await suite.api<ResourcesSpec>(path(), "PUT", values);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(values);
    expect(await swarm()).toEqual(before);
    expect(await context.docker.listTasks({ service: "shop_db" })).toEqual(tasks);
    expect(context.deps.actions.isIdle()).toBe(true);
    expect((await suite.api<ResourcesSpec>(path())).body).toEqual(values);
  });

  it("applies limits at the next deployment, and reloads the saved values", async () => {
    await suite.deployed({ engine: "redis" });
    const before = (await swarm())?.spec.TaskTemplate.ForceUpdate ?? 0;
    const values = { memoryReservation: 64, memoryLimit: 128, cpuReservation: 0.1, cpuLimit: 0.5 };

    const action = await suite.saveThenDeploy(path(), values);

    expect(action.status).toBe("succeeded");
    const service = await swarm();
    expect(service?.spec.TaskTemplate.Resources).toEqual({
      Reservations: { NanoCPUs: 100_000_000, MemoryBytes: 67108864 },
      Limits: { NanoCPUs: 500_000_000, MemoryBytes: 134217728, Pids: 8192 },
    });
    expect(service?.spec.TaskTemplate.ForceUpdate).toBe(before + 1);
    expect((await suite.api<ResourcesSpec>(path())).body).toEqual(values);
  });

  it("clears limits with zeros", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.saveThenDeploy(path(), { memoryLimit: 128, cpuLimit: 1 });

    await suite.saveThenDeploy(path(), { memoryLimit: 0, cpuLimit: 0 });

    expect((await swarm())?.spec.TaskTemplate.Resources).toEqual({
      Limits: { Pids: 8192 },
      Reservations: {},
    });
  });

  it("rejects negative values", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { memoryLimit: -1 });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toEqual({ memoryLimit: "Must be 0 or more" });
  });

  it("rejects a reservation higher than its limit", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { memoryReservation: 256, memoryLimit: 128 });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toEqual({ memoryReservation: "Can't be more than the limit" });
    expect((await swarm())?.spec.TaskTemplate.Resources?.Limits).toEqual({ Pids: 8192 });
  });

  it("leaves a stopped database alone when limits are saved", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.run(`${suite.service()}/stop`);
    const before = await swarm();

    expect((await suite.api(path(), "PUT", { memoryLimit: 256 })).status).toBe(200);

    expect(await swarm()).toEqual(before);
    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("stopped");
  });
});
