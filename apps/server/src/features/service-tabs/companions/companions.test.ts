import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompanionList, companionsByEngine, databaseEngines } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../../../testing/harness";
import {
  apiErrorOf,
  type DatabaseTestContext,
  PROJECT,
  scriptExec,
  setupDatabaseTests,
} from "../../databases/testing";
import { rehostCompanions } from "./service";

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

const path = () => `${suite.service()}/companions`;
const list = async () => (await suite.api<CompanionList>(path())).body.companions;
const routeFile = (tool: string) => join(context.deps.config.traefikDynamicDir, `shop__db-${tool}.yaml`);

describe("a tool's own address", () => {
  const HOST = "shop-db-pgweb.203.0.113.10.sslip.io";
  const claim = (body: Record<string, unknown>) =>
    suite.api("/projects/beta/services/web/domains", "POST", { https: false, ...body });

  beforeEach(async () => {
    await suite.deployed({ engine: "postgres" });
    expect((await suite.run(`${path()}/pgweb`)).status).toBe("succeeded");
    await suite.api("/projects", "POST", { name: "beta" });
    await suite.api("/projects/beta/services", "POST", { name: "web" });
  });

  it.each([
    ["the same address", { host: HOST }],
    ["a path under it, which would win over the tool's route", { host: HOST, path: "/login" }],
  ])("can't be taken by another project's service with %s", async (_label, body) => {
    const taken = await claim(body);

    expect(taken.status).toBe(409);
    expect(apiErrorOf(taken).code).toBe("domain_taken");
    expect(JSON.stringify(taken.body)).not.toMatch(/shop|pgweb/);
  });
});

describe("DAT-13: web admin companions", () => {
  it.each(databaseEngines)("offers %s its two tools, both off", async (engine) => {
    await suite.deployed({ engine });
    const companions = await list();

    expect(companions.map((item) => item.tool)).toEqual(companionsByEngine[engine]);
    expect(companions.every((item) => !item.enabled && item.url === null)).toBe(true);
  });

  it("enables one tool without touching the other", async () => {
    await suite.deployed({ engine: "postgres" });

    const action = await suite.run(`${path()}/pgweb`);

    expect(action.status).toBe("succeeded");
    const [pgweb, dbgate] = await list();
    expect(pgweb).toMatchObject({
      tool: "pgweb",
      enabled: true,
      url: "https://shop-db-pgweb.203.0.113.10.sslip.io/",
      username: "opsifier",
    });
    expect(dbgate).toMatchObject({ tool: "dbgate", enabled: false, url: null });
    expect(await context.docker.inspectService("shop_db-pgweb")).not.toBeNull();
    expect(await context.docker.inspectService("shop_db-dbgate")).toBeNull();
    expect(existsSync(routeFile("pgweb"))).toBe(true);
    expect(existsSync(routeFile("dbgate"))).toBe(false);
  });

  it("moves a tool with the server's address, and rewrites its route", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);

    await rehostCompanions(context.deps, ".203.0.113.10.sslip.io", ".bcdfghjk.opsifier.dev");

    expect((await list())[0]?.url).toBe("https://shop-db-pgweb.bcdfghjk.opsifier.dev/");
    expect(readFileSync(routeFile("pgweb"), "utf8")).toContain("shop-db-pgweb.bcdfghjk.opsifier.dev");
  });

  it("returns the access token only through the audited reveal", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);

    const revealed = await suite.api<{ token: string }>(`${path()}/pgweb/reveal`, "POST");
    expect(revealed.status).toBe(200);
    expect(revealed.body.token).toMatch(/^[a-z0-9]{32}$/);
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await list())).not.toContain(revealed.body.token);

    const { items } = (
      await suite.api<{ items: Array<{ type: string; actorEmail: string }> }>("/actions?limit=50")
    ).body;
    expect(items.some((action) => action.type === "database.companion-reveal")).toBe(true);
  });

  it("disables and removes the tool, service and route", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);

    const action = await suite.run(`${path()}/pgweb`, "DELETE");

    expect(action.status).toBe("succeeded");
    expect((await list())[0]?.enabled).toBe(false);
    expect(await context.docker.inspectService("shop_db-pgweb")).toBeNull();
    expect(existsSync(routeFile("pgweb"))).toBe(false);
  });

  it("refuses a tool the engine does not offer", async () => {
    await suite.deployed({ engine: "postgres" });
    expect((await suite.api(`${path()}/phpmyadmin`, "POST")).status).toBe(404);
    expect((await suite.api(`${path()}/bogus`, "POST")).status).toBe(400);
  });

  it("refuses to enable a tool twice", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);
    const result = await suite.api(`${path()}/pgweb`, "POST");

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("companion_enabled");
  });

  it("refuses to disable a tool that is not on", async () => {
    await suite.deployed({ engine: "postgres" });
    expect((await suite.api(`${path()}/pgweb`, "DELETE")).status).toBe(409);
  });

  it("leaves nothing behind when the tool does not come up", async () => {
    await suite.deployed({ engine: "postgres" });
    context.docker.failNext("pullImage");

    const action = await suite.run(`${path()}/pgweb`);

    expect(action.status).toBe("failed");
    expect((await list())[0]?.enabled).toBe(false);
    expect(await context.docker.inspectService("shop_db-pgweb")).toBeNull();
    expect(existsSync(routeFile("pgweb"))).toBe(false);
  });

  it("refuses to rename a database while a tool is on", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);
    await suite.run(`${suite.service()}/stop`);

    const result = await suite.api(`${suite.service()}/rename`, "POST", {
      projectName: PROJECT,
      name: "renamed",
    });

    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("companions_enabled");
  });

  it("removes every tool with the database", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.run(`${path()}/pgweb`);

    const destroyed = await suite.run(suite.service(), "DELETE", { confirm: "db" });

    expect(destroyed.status).toBe("succeeded");
    expect(await context.docker.inspectService("shop_db-pgweb")).toBeNull();
    expect(existsSync(routeFile("pgweb"))).toBe(false);
  });

  it("redeploys an enabled tool after a password change", async () => {
    await suite.deployed({ engine: "postgres", password: "old-pass", user: "app" });
    await suite.run(`${path()}/pgweb`);
    scriptExec(context, () => ({ exitCode: 0, output: "opsifier-ok\n" }));

    const action = await suite.run(`${suite.service()}/credentials`, "PUT", { password: "new-pass" });

    expect(action.status).toBe("succeeded");
    const env = (await context.docker.inspectService("shop_db-pgweb"))?.spec.TaskTemplate.ContainerSpec.Env;
    expect(env).toEqual(["PGWEB_DATABASE_URL=postgres://app:new-pass@shop_db:5432/shop?sslmode=disable"]);
  });
});
