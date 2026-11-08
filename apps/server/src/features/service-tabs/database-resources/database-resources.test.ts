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
  it("applies limits and restarts the task at once, and reloads the saved values", async () => {
    await suite.deployed({ engine: "redis" });
    const before = (await swarm())?.spec.TaskTemplate.ForceUpdate ?? 0;
    const values = { memoryReservation: 64, memoryLimit: 128, cpuReservation: 0.1, cpuLimit: 0.5 };

    const action = await suite.run(path(), "PUT", values);

    expect(action.status).toBe("succeeded");
    const service = await swarm();
    expect(service?.spec.TaskTemplate.Resources).toEqual({
      Reservations: { NanoCPUs: 100_000_000, MemoryBytes: 67108864 },
      Limits: { NanoCPUs: 500_000_000, MemoryBytes: 134217728 },
    });
    expect(service?.spec.TaskTemplate.ForceUpdate).toBe(before + 1);
    expect((await suite.api<ResourcesSpec>(path())).body).toEqual(values);
  });

  it("clears limits with zeros", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.run(path(), "PUT", { memoryLimit: 128, cpuLimit: 1 });

    await suite.run(path(), "PUT", { memoryLimit: 0, cpuLimit: 0 });

    expect((await swarm())?.spec.TaskTemplate.Resources).toEqual({ Limits: {}, Reservations: {} });
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
    expect((await swarm())?.spec.TaskTemplate.Resources?.Limits ?? {}).toEqual({});
  });

  it("does not start a stopped database, but its next start already has the limits", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.run(`${suite.service()}/stop`);

    const action = await suite.run(path(), "PUT", { memoryLimit: 256 });

    expect(action.status).toBe("succeeded");
    expect((await swarm())?.spec.Mode).toEqual({ Replicated: { Replicas: 0 } });
    expect((await swarm())?.spec.TaskTemplate.Resources?.Limits).toEqual({ MemoryBytes: 268435456 });

    await suite.run(`${suite.service()}/start`);
    expect((await swarm())?.spec.TaskTemplate.Resources?.Limits).toEqual({ MemoryBytes: 268435456 });
    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("running");
  });
});
