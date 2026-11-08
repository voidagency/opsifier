import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const PATH = "/api/v1/projects/shop/services/web/resources";

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

const valid = { memoryReservation: 64, memoryLimit: 128, cpuReservation: 0.1, cpuLimit: 0.5 };

describe("the resources tab", () => {
  it("starts at no limits, then keeps what was saved and records the change", async () => {
    expect((await api(PATH)).body).toEqual({
      memoryReservation: 0,
      memoryLimit: 0,
      cpuReservation: 0,
      cpuLimit: 0,
    });

    expect((await api(PATH, "PUT", valid)).status).toBe(200);
    expect((await api(PATH)).body).toEqual(valid);

    const actions = await api<{ items: unknown[] }>("/api/v1/actions?type=service.resources");
    expect(actions.body.items).toHaveLength(1);
  });

  it("does not touch what is running", async () => {
    const before = await context.docker.listServices();

    await api(PATH, "PUT", valid);

    expect(await context.docker.listServices()).toEqual(before);
  });

  it.each([
    ["a negative memory limit", { memoryLimit: -1 }, "memoryLimit"],
    ["a negative memory reservation", { memoryReservation: -64 }, "memoryReservation"],
    ["a negative CPU limit", { cpuLimit: -0.5 }, "cpuLimit"],
    ["a negative CPU reservation", { cpuReservation: -0.1 }, "cpuReservation"],
    ["a memory limit Docker would refuse", { memoryLimit: 3 }, "memoryLimit"],
    ["a CPU limit Docker would refuse", { cpuLimit: 0.001 }, "cpuLimit"],
    [
      "a memory reservation above the limit",
      { memoryLimit: 64, memoryReservation: 128 },
      "memoryReservation",
    ],
    ["a CPU reservation above the limit", { cpuLimit: 0.5, cpuReservation: 1 }, "cpuReservation"],
    ["text instead of a number", { memoryLimit: "128" }, "memoryLimit"],
  ])("refuses %s", async (_label, body, field) => {
    const result = await api(PATH, "PUT", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeDefined();
  });

  it("answers 404 for a service that does not exist", async () => {
    expect((await api("/api/v1/projects/shop/services/missing/resources")).status).toBe(404);
  });
});
