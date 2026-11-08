import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const PATH = "/api/v1/projects/shop/services/web/environment";

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

describe("the environment tab", () => {
  it("starts empty, saves the text as typed and records the change", async () => {
    expect((await api<{ env: string }>(PATH)).body).toEqual({ env: "" });

    const text = 'FOO=bar\n# comment\nQUOTED="hello world"\n';
    expect((await api(PATH, "PUT", { env: text })).status).toBe(200);
    expect((await api<{ env: string }>(PATH)).body.env).toBe(text);

    const actions = await api<{ items: Array<{ type: string }> }>("/api/v1/actions?type=service.env");
    expect(actions.body.items).toHaveLength(1);
  });

  it("names the first line that is not a variable", async () => {
    const result = await api(PATH, "PUT", { env: "A=1\n\n=novalue" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toBe("Line 3 must look like NAME=value");
  });

  it("keeps the values out of the service's own response", async () => {
    await api(PATH, "PUT", { env: "SECRET=value-to-hide" });

    const service = await api("/api/v1/projects/shop/services/web");
    expect(JSON.stringify(service.body)).not.toContain("value-to-hide");
  });

  it("answers 404 for a service that does not exist", async () => {
    expect((await api("/api/v1/projects/shop/services/missing/environment")).status).toBe(404);
  });
});
