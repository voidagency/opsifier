import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROXY_CONTAINER } from "../../bootstrap/proxy-container";
import type { TestContext } from "../../testing/harness";
import { type DatabaseTestContext, setupDatabaseTests } from "../databases/testing";

let suite: DatabaseTestContext;
let context: TestContext;

const NEW = "bakery";
const IMAGE = "traefik/whoami:v1.10";

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
  await context.docker.createPlainContainer({
    name: PROXY_CONTAINER,
    image: "traefik:3",
    env: [],
    labels: { "opsifier.managed": "true" },
    binds: [],
    ports: [80, 443],
    networks: ["opsifier"],
    stopTimeoutSeconds: 3,
  });
  await context.docker.startContainer(PROXY_CONTAINER);
});

afterEach(async () => {
  await suite.close();
});

const proxy = async () => {
  const found = await context.docker.inspectPlainContainer(PROXY_CONTAINER);
  if (found === null) {
    throw new Error("The proxy has gone");
  }
  return found;
};
const proxyNetworks = async () => (await proxy()).networks.map((network) => network.name);

describe("the proxy's container and the projects' networks", () => {
  it("joins a new project's network while it runs, and leaves it before the project goes", async () => {
    const before = await proxy();

    expect((await suite.api("/projects", "POST", { name: NEW })).status).toBe(201);

    expect(await proxyNetworks()).toContain(`opsifier-${NEW}_proxy`);
    expect(await proxyNetworks()).not.toContain(`opsifier-${NEW}`);

    expect((await suite.api(`/projects/${NEW}/services`, "POST", { name: "web" })).status).toBe(201);
    expect((await suite.api(`/projects/${NEW}/services/web/source`, "PUT", { image: IMAGE })).status).toBe(
      200,
    );
    expect((await suite.run(`/projects/${NEW}/services/web/deploy`)).status).toBe("succeeded");

    expect((await suite.run(`/projects/${NEW}/services/web`, "DELETE", { confirm: "web" })).error).toBeNull();
    const destroyed = await suite.run(`/projects/${NEW}`, "DELETE", { confirm: NEW });
    expect(destroyed.error).toBeNull();
    expect(await proxyNetworks()).not.toContain(`opsifier-${NEW}_proxy`);
    expect(await context.docker.inspectNetwork(`opsifier-${NEW}_proxy`)).toBeNull();

    // The same container all along: no site noticed any of it.
    const after = await proxy();
    expect(after.id).toBe(before.id);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.state).toBe("running");
  });

  it("joins the network of a project made before it, at that project's next deployment", async () => {
    expect(await proxyNetworks()).not.toContain("opsifier-shop_proxy");

    expect((await suite.api("/projects/shop/services", "POST", { name: "web" })).status).toBe(201);
    expect((await suite.api("/projects/shop/services/web/source", "PUT", { image: IMAGE })).status).toBe(200);
    expect((await suite.run("/projects/shop/services/web/deploy")).status).toBe("succeeded");

    expect(await proxyNetworks()).toContain("opsifier-shop_proxy");
  });
});
