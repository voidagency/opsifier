import type { ActionPage } from "@opsifier/contract";
import { deployActionType } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../../testing/harness";

const PATH = "/api/v1/projects/shop/services/web/deployments";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await call(context.app, "/api/v1/projects", {
    method: "POST",
    body: { name: "shop" },
    cookie,
    origin: TEST_ORIGIN,
  });
  await call(context.app, "/api/v1/projects/shop/services", {
    method: "POST",
    body: { name: "web" },
    cookie,
    origin: TEST_ORIGIN,
  });
});

afterEach(async () => {
  await context.close();
});

const page = (query = "") => call<ActionPage>(context.app, `${PATH}${query}`, { cookie });

const record = (status: "succeeded" | "failed", type = deployActionType, serviceName = "web") =>
  context.deps.actions.record({ type, title: "Deploy", projectName: "shop", serviceName, status });

describe("the deployments tab", () => {
  it("is empty before the first deployment", async () => {
    expect((await page()).body).toEqual({ items: [], nextCursor: null });
  });

  it("lists this service's deployments only, newest first", async () => {
    record("succeeded");
    record("failed");
    record("succeeded", "service.stop");
    record("succeeded", deployActionType, "other");

    expect((await page()).body.items.map((item) => item.status)).toEqual(["failed", "succeeded"]);
  });

  it("shows the last ten by default and pages with a cursor", async () => {
    for (let index = 0; index < 12; index += 1) {
      record("succeeded");
    }

    const first = await page();
    expect(first.body.items).toHaveLength(10);

    const rest = await page(`?cursor=${first.body.nextCursor}`);
    expect(rest.body.items).toHaveLength(2);
    expect(rest.body.nextCursor).toBeNull();
  });

  it("answers 404 for a service that does not exist", async () => {
    expect(
      (await call(context.app, "/api/v1/projects/shop/services/nope/deployments", { cookie })).status,
    ).toBe(404);
  });
});
