import { type ActionDetail, type ActionPage, apiError } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

function expectErrorShape(result: { body: unknown }) {
  expect(apiError.safeParse(result.body).success).toBe(true);
}

describe("the actions feature", () => {
  const run = (index: number) =>
    context.deps.actions.enqueue({
      type: "deploy",
      projectName: "shop",
      serviceName: `svc${index}`,
      title: `Deploy ${index}`,
      run: (ctx) => ctx.log(`output of ${index}`),
    });

  async function waitForFinished(id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await call<ActionDetail>(context.app, `/api/v1/actions/${id}`, { cookie });
      if (result.body.status !== "queued" && result.body.status !== "running") {
        return result.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The action did not finish");
  }

  it("pages newest first with a cursor", async () => {
    const created = [run(0), run(1), run(2), run(3), run(4)];
    await Promise.all(created.map((row) => waitForFinished(row.id)));

    const first = await call<ActionPage>(context.app, "/api/v1/actions?type=deploy&limit=2", { cookie });
    expect(first.body.items.map((item) => item.title)).toEqual(["Deploy 4", "Deploy 3"]);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await call<ActionPage>(
      context.app,
      `/api/v1/actions?type=deploy&limit=2&cursor=${first.body.nextCursor}`,
      { cookie },
    );
    expect(second.body.items.map((item) => item.title)).toEqual(["Deploy 2", "Deploy 1"]);

    const third = await call<ActionPage>(
      context.app,
      `/api/v1/actions?type=deploy&limit=2&cursor=${second.body.nextCursor}`,
      { cookie },
    );
    expect(third.body.items.map((item) => item.title)).toEqual(["Deploy 0"]);
    expect(third.body.nextCursor).toBeNull();
  });

  it("defaults to pages of 15 and filters by service", async () => {
    const created = Array.from({ length: 16 }, (_, index) => run(index));
    await Promise.all(created.map((row) => waitForFinished(row.id)));

    const page = await call<ActionPage>(context.app, "/api/v1/actions?type=deploy", { cookie });
    expect(page.body.items).toHaveLength(15);

    const filtered = await call<ActionPage>(
      context.app,
      "/api/v1/actions?projectName=shop&serviceName=svc3",
      {
        cookie,
      },
    );
    expect(filtered.body.items.map((item) => item.title)).toEqual(["Deploy 3"]);
  });

  it("rejects an invalid limit and bad filters with field messages", async () => {
    const limit = await call(context.app, "/api/v1/actions?limit=0", { cookie });
    expect(limit.status).toBe(400);
    expect(apiErrorOf(limit).fields).toHaveProperty("limit");

    const name = await call(context.app, "/api/v1/actions?projectName=..%2Fetc", { cookie });
    expect(name.status).toBe(400);
    expect(apiErrorOf(name).fields).toHaveProperty("projectName");
  });

  it("returns one action with its log", async () => {
    const row = run(0);
    const detail = await waitForFinished(row.id);

    expect(detail).toMatchObject({ status: "succeeded", hasLog: true, logTruncated: false });
    expect(detail.log).toContain("output of 0");
  });

  it("answers 404 for an unknown action and 400 for a hostile id", async () => {
    const missing = await call(context.app, "/api/v1/actions/nope", { cookie });
    expect(missing.status).toBe(404);
    expectErrorShape(missing);

    const hostile = await call(context.app, `/api/v1/actions/${encodeURIComponent("../../secret.key")}`, {
      cookie,
    });
    expect(hostile.status).toBe(400);
  });

  it("cancels through the API and needs the Origin check", async () => {
    let release: () => void = () => {};
    const blocker = context.deps.actions.enqueue({
      type: "deploy",
      projectName: "shop",
      serviceName: "web",
      title: "Blocker",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const queued = context.deps.actions.enqueue({
      type: "deploy",
      projectName: "shop",
      serviceName: "web",
      title: "Queued",
      run: () => {},
    });

    const refused = await call(context.app, `/api/v1/actions/${queued.id}/cancel`, {
      method: "POST",
      cookie,
    });
    expect(refused.status).toBe(403);

    const cancelled = await call<{ status: string }>(context.app, `/api/v1/actions/${queued.id}/cancel`, {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");

    release();
    await waitForFinished(blocker.id);
    const finished = await call(context.app, `/api/v1/actions/${blocker.id}/cancel`, {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
    });
    expect(finished.status).toBe(409);
  });
});
