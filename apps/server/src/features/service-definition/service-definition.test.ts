import type { ActionPage, DomainList, ServiceDetail, StorageDocument } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await call(context.app, "/api/v1/projects", {
    method: "POST",
    cookie,
    origin: TEST_ORIGIN,
    body: { name: "shop" },
  });
});

afterEach(async () => {
  await context.close();
});

const create = <T = unknown>(body: unknown) =>
  call<T>(context.app, "/api/v1/projects/shop/services/definition", {
    method: "POST",
    cookie,
    origin: TEST_ORIGIN,
    body,
  });
const get = <T = unknown>(path: string) => call<T>(context.app, path, { cookie });

describe("creating a service from a definition", () => {
  it("leaves a path on the host to an administrator, and refuses before anything exists", async () => {
    const operator = await signInMember(context.app, cookie, "op@example.com", [
      { project: "shop", role: "operator" },
    ]);

    const refused = await call(context.app, "/api/v1/projects/shop/services/definition", {
      method: "POST",
      cookie: operator,
      origin: TEST_ORIGIN,
      body: {
        name: "sneaky",
        source: { type: "image", image: "nginx:alpine" },
        mounts: [{ type: "bind", hostPath: "/var/run/docker.sock", mountPath: "/d", acknowledgeRisk: true }],
      },
    });

    expect(refused.status).toBe(403);
    expect((await get("/api/v1/projects/shop/services/sneaky")).status).toBe(404);
    expect(
      (await get<ActionPage>("/api/v1/actions?type=service.create")).body.items.map(
        (item) => item.serviceName,
      ),
    ).not.toContain("sneaky");
  });

  it("saves everything in one request and leaves nothing running unless asked", async () => {
    const result = await create<ServiceDetail>({
      name: "web",
      source: { type: "image", image: "traefik/whoami:latest" },
      env: "FOO=bar\n",
      domains: [{ host: "web.example.test" }],
      mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
    });
    expect(result.status).toBe(201);
    expect(result.body.source).toMatchObject({ type: "image", image: "traefik/whoami:latest" });
    expect(result.body.status).toBe("undeployed");

    const env = await get<{ names: string[] }>("/api/v1/projects/shop/services/web/environment");
    expect(env.body.names).toEqual(["FOO"]);
    const domains = await get<DomainList>("/api/v1/projects/shop/services/web/domains");
    expect(domains.body.domains.map((domain) => domain.host)).toContain("web.example.test");
    const storage = await get<StorageDocument>("/api/v1/projects/shop/services/web/storage");
    expect(storage.body.mounts).toHaveLength(1);
  });

  it("refuses unknown properties, and leaves no service behind when a part is refused", async () => {
    const unknown = await create({ name: "web", source: { type: "image", image: "a/b:1" }, surprise: true });
    expect(unknown.status).toBe(400);

    await create({
      name: "first",
      source: { type: "image", image: "a/b:1" },
      domains: [{ host: "taken.example.test" }],
    });
    const refused = await create({
      name: "second",
      source: { type: "image", image: "a/b:1" },
      domains: [{ host: "taken.example.test" }],
    });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("domain_taken");
    expect((await get("/api/v1/projects/shop/services/second")).status).toBe(404);
  });
});
