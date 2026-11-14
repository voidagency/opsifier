import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, ProjectList, ProjectSummary } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { projects } from "../../core/db/schema";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { insertService } from "../services/repo";
import { appServiceSpec } from "../services/spec";
import { PROXY_SERVICE } from "./network";
import { enqueueProjectDestroy } from "./service";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

async function waitForAction(id: string): Promise<ActionEntry> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { body } = await api<ActionEntry>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The action did not finish");
}

describe("creating a project", () => {
  it("creates an attachable overlay network named after it", async () => {
    const result = await api<ProjectSummary>("/projects", "POST", { name: "probe-app" });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ name: "probe-app", services: [] });
    expect(await context.docker.inspectNetwork("opsifier-probe-app")).toMatchObject({
      driver: "overlay",
      scope: "swarm",
      attachable: true,
    });
  });

  it("rejects names with an underscore, capitals or spaces, and stores nothing", async () => {
    for (const name of ["Bad Name!", "my_project", "UPPER", "-leading", "trailing-"]) {
      const result = await api("/projects", "POST", { name });
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields).toHaveProperty("name");
    }
    expect((await api<ProjectList>("/projects")).body.projects).toEqual([]);
  });

  it("says a missing or empty name is required", async () => {
    expect(apiErrorOf(await api("/projects", "POST", { name: "" })).fields?.name).toBe("Required");
    expect(apiErrorOf(await api("/projects", "POST", {})).fields?.name).toBe("Required");
  });

  it("refuses a duplicate, with a message on the field", async () => {
    await api("/projects", "POST", { name: "shop" });
    const again = await api("/projects", "POST", { name: "shop" });

    expect(again.status).toBe(409);
    expect(apiErrorOf(again)).toMatchObject({ code: "project_exists" });
    expect(apiErrorOf(again).fields).toHaveProperty("name");
  });

  it("lets only one of two identical requests win", async () => {
    const results = await Promise.all([
      api("/projects", "POST", { name: "shop" }),
      api("/projects", "POST", { name: "shop" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect((await api<ProjectList>("/projects")).body.projects).toHaveLength(1);
  });

  it("stores nothing if Docker refuses the network", async () => {
    context.docker.failNext("createNetwork");
    const result = await api("/projects", "POST", { name: "shop" });

    expect(result.status).toBe(502);
    expect(apiErrorOf(result).code).toBe("docker_error");
    expect((await api<ProjectList>("/projects")).body.projects).toEqual([]);
  });

  it("reuses a network left behind by an earlier attempt", async () => {
    await context.docker.createNetwork({ name: "opsifier-shop", attachable: true });
    expect((await api("/projects", "POST", { name: "shop" })).status).toBe(201);
  });

  it("puts the proxy on the project's proxy network, and only once", async () => {
    await context.docker.createService({
      Name: PROXY_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" } },
    });

    await api("/projects", "POST", { name: "shop" });
    const proxy = await context.docker.inspectService(PROXY_SERVICE);
    const network = await context.docker.inspectNetwork("opsifier-shop_proxy");
    expect(proxy?.spec.TaskTemplate.Networks).toEqual([{ Target: network?.id }]);

    const version = proxy?.version;
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/source", "PUT", { image: "nginx:1.27" });
    await waitForAction((await api<ActionEntry>("/projects/shop/services/web/deploy", "POST")).body.id);
    expect((await context.docker.inspectService(PROXY_SERVICE))?.version).toBe(version);
  });

  it("appears in the list with its creation time, and records the event", async () => {
    await api("/projects", "POST", { name: "shop" });

    const list = await api<ProjectList>("/projects");
    expect(list.body.projects.map((project) => project.name)).toEqual(["shop"]);
    expect(list.body.projects[0]?.createdAt).toMatch(/\dT\d/);

    const actions = await api<{ items: ActionEntry[] }>("/actions?type=project.create");
    expect(actions.body.items[0]).toMatchObject({ projectName: "shop", hasLog: false });
  });
});

describe("the project's environment", () => {
  beforeEach(async () => {
    await api("/projects", "POST", { name: "shop" });
  });

  it("saves the text, shows only its names, and gives the values to whoever asks", async () => {
    const saved = await api<{ names: string[] }>("/projects/shop/env", "PUT", {
      env: "SHARED_ONE=project-value",
    });

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ names: ["SHARED_ONE"] });
    const page = await api("/projects/shop/env");
    expect(page.body).toEqual({ names: ["SHARED_ONE"] });
    expect(JSON.stringify(page.body)).not.toContain("project-value");

    const revealed = await api<{ env: string }>("/projects/shop/env/reveal", "POST");
    expect(revealed.body.env).toBe("SHARED_ONE=project-value");
    expect(revealed.headers.get("cache-control")).toBe("no-store");

    const actions = await api<{ items: Array<{ type: string }> }>("/actions?type=project.env-reveal");
    expect(actions.body.items).toHaveLength(1);
  });

  it("keeps the values sealed in the database", async () => {
    await api("/projects/shop/env", "PUT", { env: "SHARED_ONE=project-value" });

    const row = context.deps.db.select().from(projects).where(eq(projects.name, "shop")).get();
    expect(row?.sealedEnv).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("project-value");
  });

  it("names the line that is not a variable", async () => {
    const result = await api("/projects/shop/env", "PUT", { env: "OK=1\nnot a variable" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toContain("Line 2");
  });

  it("never lists the variables with the project", async () => {
    await api("/projects/shop/env", "PUT", { env: "SECRET=hidden" });
    expect(JSON.stringify((await api("/projects")).body)).not.toContain("hidden");
    expect(JSON.stringify((await api("/projects/shop")).body)).not.toContain("hidden");
  });
});

describe("the project schema", () => {
  beforeEach(async () => {
    await api("/projects", "POST", { name: "shop" });
  });

  it("is an empty list for an empty project", async () => {
    expect((await api("/projects/shop/schema")).body).toEqual({ services: [] });
  });

  it("describes each service and never contains a password", async () => {
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/source", "PUT", {
      image: "registry.example.com/team/web:1",
      username: "deployer",
      password: "hunter2-secret",
    });

    const schema = await api("/projects/shop/schema");

    expect(schema.body).toEqual({
      services: [
        {
          type: "app",
          data: {
            projectName: "shop",
            serviceName: "web",
            source: { type: "image", image: "registry.example.com/team/web:1", username: "deployer" },
            deploy: { command: null, replicas: 1, zeroDowntime: true },
            domains: [
              {
                host: "shop-web.203.0.113.10.sslip.io",
                https: true,
                path: "/",
                port: 80,
                internalProtocol: "http",
                middlewares: [],
                certificateResolver: "",
                wildcard: false,
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(schema.body)).not.toContain("hunter2");
  });
});

describe("destroying a project", () => {
  beforeEach(async () => {
    await api("/projects", "POST", { name: "shop" });
  });

  it("needs the exact name, checked on the server", async () => {
    const wrong = await api("/projects/shop", "DELETE", { confirm: "other" });
    expect(wrong.status).toBe(409);
    expect(apiErrorOf(wrong).code).toBe("confirmation_mismatch");
    expect((await api("/projects/shop", "DELETE", {})).status).toBe(400);
    expect((await api<ProjectList>("/projects")).body.projects).toHaveLength(1);
  });

  it("is refused while the project holds a service, and leaves it all running", async () => {
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/source", "PUT", { image: "nginx:1.27" });
    await waitForAction((await api<ActionEntry>("/projects/shop/services/web/deploy", "POST")).body.id);

    const refused = await api("/projects/shop", "DELETE", { confirm: "shop" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused)).toMatchObject({
      code: "project_not_empty",
      message: expect.stringContaining("1 service"),
    });
    expect((await api("/projects/shop")).status).toBe(200);
    expect(await context.docker.inspectService("shop_web")).not.toBeNull();
    expect(await context.docker.inspectNetwork("opsifier-shop")).not.toBeNull();
    expect(readdirSync(context.deps.config.traefikDynamicDir)).toContain("shop__web.yaml");
  });

  it("removes an empty project and its network", async () => {
    const accepted = await api<ActionEntry>("/projects/shop", "DELETE", { confirm: "shop" });
    expect(accepted.status).toBe(202);
    expect((await waitForAction(accepted.body.id)).status).toBe("succeeded");

    expect((await api("/projects/shop")).status).toBe(404);
    expect(await context.docker.inspectNetwork("opsifier-shop")).toBeNull();
  });

  it("can follow the removal of its last service, and keeps what that service kept", async () => {
    await api("/projects/shop/services", "POST", { name: "web" });
    await api("/projects/shop/services/web/storage/mounts", "POST", {
      type: "volume",
      name: "uploads",
      mountPath: "/data/uploads",
    });
    await api("/projects/shop/services/web/source", "PUT", { image: "nginx:1.27" });
    await waitForAction((await api<ActionEntry>("/projects/shop/services/web/deploy", "POST")).body.id);
    const data = join(context.dataDir, "projects/shop/web/volumes/uploads");
    writeFileSync(join(data, "kept.txt"), "precious");

    const destroyed = await api<ActionEntry>("/projects/shop/services/web", "DELETE", { confirm: "web" });
    expect((await waitForAction(destroyed.body.id)).status).toBe("succeeded");
    const gone = await api<ActionEntry>("/projects/shop", "DELETE", { confirm: "shop" });
    expect((await waitForAction(gone.body.id)).status).toBe("succeeded");

    expect((await api("/projects/shop")).status).toBe(404);
    expect(readFileSync(join(data, "kept.txt"), "utf8")).toBe("precious");
    expect(await context.docker.inspectVolume("shop_web_uploads")).not.toBeNull();
  });

  it("removes the project's empty folder and nothing that is still in it", async () => {
    const emptyProject = join(context.dataDir, "projects", "shop");
    mkdirSync(emptyProject, { recursive: true });
    await waitForAction((await api<ActionEntry>("/projects/shop", "DELETE", { confirm: "shop" })).body.id);
    expect(existsSync(emptyProject)).toBe(false);
  });

  it("is checked again when it runs, so a service created in the meantime is not swept away", async () => {
    const action = enqueueProjectDestroy(context.deps, "shop", "shop", undefined);
    insertService(context.deps.db, "shop", "late", "app", appServiceSpec.parse({}), new Date());

    const finished = await waitForAction(action.id);

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("1 service");
    expect((await api("/projects/shop")).status).toBe(200);
    expect(await context.docker.inspectNetwork("opsifier-shop")).not.toBeNull();
  });

  it("keeps the record of what happened after the project has gone", async () => {
    await waitForAction((await api<ActionEntry>("/projects/shop", "DELETE", { confirm: "shop" })).body.id);
    const actions = await api<{ items: ActionEntry[] }>("/actions?projectName=shop");
    expect(actions.body.items.map((item) => item.type)).toContain("project.destroy");
  });

  it("waits for work in progress to finish", async () => {
    let release: () => void = () => {};
    context.deps.actions.enqueue({
      type: "test",
      title: "Long job",
      projectName: "shop",
      serviceName: "web",
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const refused = await api("/projects/shop", "DELETE", { confirm: "shop" });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("project_busy");
    release();
  });

  it("keeps the proxy's networks right when projects change at the same moment", async () => {
    await context.docker.createService({
      Name: PROXY_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" }, Networks: [] },
    });
    await Promise.all(["a", "b", "c"].map((name) => api("/projects", "POST", { name })));
    expect((await context.docker.inspectService(PROXY_SERVICE))?.spec.TaskTemplate.Networks).toHaveLength(3);

    const destroying = await Promise.all(
      ["a", "b", "c"].map((name) => api<ActionEntry>(`/projects/${name}`, "DELETE", { confirm: name })),
    );
    await Promise.all(destroying.map((result) => waitForAction(result.body.id)));

    expect((await context.docker.inspectService(PROXY_SERVICE))?.spec.TaskTemplate.Networks).toEqual([]);
  });

  it("drops proxy attachments to networks that no longer exist", async () => {
    await context.docker.createService({
      Name: PROXY_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" }, Networks: [{ Target: "long-gone-network-id" }] },
    });

    await api("/projects", "POST", { name: "next" });

    const network = await context.docker.inspectNetwork("opsifier-next_proxy");
    expect((await context.docker.inspectService(PROXY_SERVICE))?.spec.TaskTemplate.Networks).toEqual([
      { Target: network?.id },
    ]);
  });

  it("detaches the proxy before removing the network", async () => {
    await context.docker.createService({
      Name: PROXY_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" }, Networks: [] },
    });
    await api("/projects", "POST", { name: "other" });
    expect((await context.docker.inspectService(PROXY_SERVICE))?.spec.TaskTemplate.Networks).toHaveLength(1);

    await waitForAction((await api<ActionEntry>("/projects/other", "DELETE", { confirm: "other" })).body.id);

    expect((await context.docker.inspectService(PROXY_SERVICE))?.spec.TaskTemplate.Networks).toEqual([]);
  });
});

describe("the API document", () => {
  it("describes the new routes", async () => {
    const document = await call<{ paths: Record<string, unknown> }>(context.app, "/api/v1/openapi.json", {
      cookie,
    });

    expect(document.status).toBe(200);
    expect(Object.keys(document.body.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/projects",
        "/api/v1/projects/{project}/schema",
        "/api/v1/projects/{project}/services/{service}/deploy",
        "/api/v1/projects/{project}/services/{service}/environment",
      ]),
    );
  });
});

describe("the routes file", () => {
  it("is written under the documented name when a service is created", async () => {
    await api("/projects", "POST", { name: "shop" });
    await api("/projects/shop/services", "POST", { name: "web" });

    const config = parse(readFileSync(join(context.deps.config.traefikDynamicDir, "shop__web.yaml"), "utf8"));
    expect(Object.keys(config.http.routers)).toEqual(["http-shop_web-0", "https-shop_web-0"]);
  });
});
