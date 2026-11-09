import type { ScriptList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

const PATH = "/api/v1/projects/shop/services/web/scripts";

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

describe("the scripts tab", () => {
  it("adds, edits and deletes scripts", async () => {
    expect((await api<ScriptList>(PATH)).body).toEqual({ scripts: [] });

    const added = await api<ScriptList>(PATH, "POST", { name: "Clear cache", script: "rm -rf /tmp/cache" });
    expect(added.status).toBe(201);
    expect(added.body.scripts).toMatchObject([
      {
        name: "Clear cache",
        script: "rm -rf /tmp/cache",
        maxDurationSeconds: 3600,
        schedule: null,
        runAfterDeploy: false,
        nextRunAt: null,
        lastRun: null,
      },
    ]);

    await api(`${PATH}/0`, "PUT", { name: "Clear cache", script: "rm -rf /var/cache" });
    expect((await api<ScriptList>(PATH)).body.scripts[0]?.script).toBe("rm -rf /var/cache");

    expect((await api<ScriptList>(`${PATH}/0`, "DELETE")).body.scripts).toEqual([]);
  });

  it("accepts a script with no body", async () => {
    expect((await api(PATH, "POST", { name: "empty" })).status).toBe(201);
  });

  it.each([
    ["an empty name", { name: "", script: "ls" }],
    ["a blank name", { name: "   ", script: "ls" }],
    ["a name with a line break", { name: "a\nb", script: "ls" }],
    ["a name that is too long", { name: "a".repeat(65), script: "ls" }],
    ["a script too long for one exec argument", { name: "big", script: "a".repeat(64 * 1024 + 1) }],
  ])("refuses %s", async (_label, body) => {
    const result = await api(PATH, "POST", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("validation_failed");
  });

  it("refuses a name that is already used, whatever the case", async () => {
    await api(PATH, "POST", { name: "Backup", script: "tar" });

    const result = await api(PATH, "POST", { name: "backup", script: "zip" });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("script_name_taken");
    expect(apiErrorOf(result).fields?.name).toBeDefined();
  });

  it("lets a script keep its own name when it is edited", async () => {
    await api(PATH, "POST", { name: "Backup", script: "tar" });

    expect((await api(`${PATH}/0`, "PUT", { name: "Backup", script: "zip" })).status).toBe(200);
  });

  it.each([
    ["hexadecimal", "0x0"],
    ["an exponent", "0e0"],
    ["a negative number", "-1"],
    ["a fraction", "0.5"],
    ["past the maximum", "1000"],
    ["a word", "first"],
  ])("refuses %s as a position", async (_label, value) => {
    await api(PATH, "POST", { name: "one", script: "ls" });

    expect((await api(`${PATH}/${value}`, "DELETE")).status).toBe(400);
  });

  it("answers 404 for a position that does not exist", async () => {
    expect((await api(`${PATH}/3`, "PUT", { name: "x", script: "" })).status).toBe(404);
    expect((await api(`${PATH}/3`, "DELETE")).status).toBe(404);
  });
});
