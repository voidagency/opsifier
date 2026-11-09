import type { TemplateDocument, TemplateInstall } from "@opsifier/contract";
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
import { listDomainRows } from "../service-tabs/domains/service";
import { openEnv } from "../services/env-store";
import { findService } from "../services/repo";

let context: TestContext;
let cookie: string;

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects", "POST", { name: "other" });
});

afterEach(async () => {
  await context.close();
});

const catalogue = (id: string) => ({ source: { type: "catalogue", id } });

async function install(project: string, id: string, overrides: Record<string, unknown> = {}) {
  const defaults = (await api<{ templates: TemplateDocument[] }>("/templates")).body.templates.find(
    (template) => template.id === id,
  ) as TemplateDocument;
  return api<TemplateInstall>(`/projects/${project}/templates`, "POST", {
    ...catalogue(id),
    services: Object.fromEntries(defaults.services.map((service) => [service.key, { name: service.name }])),
    params: {},
    ...overrides,
  });
}

async function waitForAction(id: string): Promise<{ status: string; error: string | null; log: string }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { body } = await api<{ status: string; error: string | null; log: string }>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The action did not finish.");
}

describe("template installs", () => {
  it("lists the catalogue", async () => {
    const { status, body } = await api<{ templates: TemplateDocument[] }>("/templates");
    expect(status).toBe(200);
    expect(body.templates.length).toBeGreaterThanOrEqual(30);
  });

  it("creates configuration only, and deployment stays explicit", async () => {
    const { status, body } = await install("shop", "uptime-kuma");
    expect(status).toBe(201);
    expect(body.components.map((component) => component.service.name)).toEqual(["uptime-kuma"]);
    expect(body.components[0]?.service.status).toBe("undeployed");
    expect(await context.docker.inspectService("shop_uptime-kuma")).toBeNull();

    const record = findService(context.deps.db, "shop", "uptime-kuma");
    expect(record?.spec.mounts).toEqual([{ type: "volume", name: "data", mountPath: "/app/data" }]);
    const [domain] = listDomainRows(context.deps.db, { projectName: "shop", serviceName: "uptime-kuma" });
    expect(domain).toMatchObject({ port: 3001, isPrimary: true });
  });

  it("creates a database, seals generated secrets and references them", async () => {
    const { status, body } = await install("shop", "miniflux", { params: { adminUser: "owner" } });
    expect(status).toBe(201);
    expect(body.components.map((component) => [component.kind, component.service.type])).toEqual([
      ["database", "postgres"],
      ["app", "app"],
    ]);

    const app = findService(context.deps.db, "shop", "miniflux");
    const env = openEnv(context.deps, app?.spec.sealedEnv ?? "");
    expect(env).toContain("ADMIN_USERNAME=owner");
    expect(env).toContain("ADMIN_PASSWORD=$(secret.adminPassword)");
    expect(env).toContain("DATABASE_URL=$(db.db.url)");
    expect(env).toContain("BASE_URL=https://$(PRIMARY_DOMAIN)");
    expect(app?.spec.references.databases).toEqual({ db: { service: "miniflux-db" } });
    expect(JSON.stringify(app?.spec)).not.toContain("postgres://");
    const secret = app?.spec.references.secrets.adminPassword;
    expect(secret?.sealed).toMatch(/^v1\./);
    expect(body.secrets).toEqual([expect.objectContaining({ service: "miniflux", name: "adminPassword" })]);
  });

  it("deploys in dependency order and resolves references at deploy time", async () => {
    const created = (await install("shop", "miniflux")).body;
    const action = await api<{ id: string }>(`/projects/shop/templates/${created.id}/deploy`, "POST", {});
    expect(action.status).toBe(202);
    const finished = await waitForAction(action.body.id);
    expect(finished).toMatchObject({ status: "succeeded", error: null });
    expect(finished.log).toMatch(/miniflux-db[\s\S]*Deploying miniflux/);

    const swarm = await context.docker.inspectService("shop_miniflux");
    const env = swarm?.spec.TaskTemplate.ContainerSpec.Env ?? [];
    const url = env.find((entry) => entry.startsWith("DATABASE_URL="));
    expect(url).toMatch(
      /^DATABASE_URL=postgres:\/\/miniflux:[a-z0-9]+@shop-miniflux-db:5432\/miniflux\?sslmode=disable$/,
    );
    expect(env.find((entry) => entry.startsWith("ADMIN_PASSWORD="))).toMatch(/^ADMIN_PASSWORD=[a-z0-9]{24}$/);
    expect(env.join(" ")).not.toContain("$(");
  });

  it("resumes without touching what is already running", async () => {
    const created = (await install("shop", "gotify")).body;
    const first = await api<{ id: string }>(`/projects/shop/templates/${created.id}/deploy`, "POST", {});
    await waitForAction(first.body.id);
    const version = (await context.docker.inspectService("shop_gotify"))?.version;
    const again = await api<{ id: string }>(`/projects/shop/templates/${created.id}/deploy`, "POST", {});
    const finished = await waitForAction(again.body.id);
    expect(finished.log).toContain("gotify is already running");
    expect((await context.docker.inspectService("shop_gotify"))?.version).toBe(version);
  });

  it("gives each project its own names, secrets and addresses", async () => {
    const a = (await install("shop", "grafana")).body;
    const b = (await install("other", "grafana")).body;
    expect(a.id).not.toBe(b.id);
    const sealedA = findService(context.deps.db, "shop", "grafana")?.spec.references.secrets.secretKey
      ?.sealed;
    const sealedB = findService(context.deps.db, "other", "grafana")?.spec.references.secrets.secretKey
      ?.sealed;
    expect(sealedA).not.toBe(sealedB);
    const reveal = (project: string, id: string) =>
      api<{ value: string }>(`/projects/${project}/templates/${id}/secrets/reveal`, "POST", {
        service: "grafana",
        name: "adminPassword",
      });
    expect((await reveal("shop", a.id)).body.value).not.toBe((await reveal("other", b.id)).body.value);
  });

  it("reveals one secret at a time and records it", async () => {
    const created = (await install("shop", "gotify")).body;
    const { status, body } = await api<{ value: string }>(
      `/projects/shop/templates/${created.id}/secrets/reveal`,
      "POST",
      { service: "gotify", name: "adminPassword" },
    );
    expect(status).toBe(200);
    expect(body.value).toMatch(/^[a-z0-9]{24}$/);
    const page = await api<{ items: Array<{ type: string }> }>("/actions?type=template.reveal");
    expect(page.body.items).toHaveLength(1);
  });

  it("refuses a name that is taken and creates nothing", async () => {
    await install("shop", "gotify");
    const again = await install("shop", "gotify");
    expect(again.status).toBe(400);
    expect(apiErrorOf(again).fields).toMatchObject({
      "services.app.name": "This name is taken in this project",
    });
    expect(context.deps.db).toBeDefined();
  });

  it("uses an existing database instead of creating one", async () => {
    await api("/projects/shop/databases", "POST", { name: "main", engine: "postgres" });
    const { status, body } = await install("shop", "miniflux", {
      services: { db: { name: "miniflux-db", existing: "main" }, app: { name: "miniflux" } },
    });
    expect(status).toBe(201);
    expect(findService(context.deps.db, "shop", "miniflux-db")).toBeUndefined();
    expect(body.components.map((component) => component.service.name)).toEqual(["miniflux"]);
    expect(findService(context.deps.db, "shop", "miniflux")?.spec.references.databases).toEqual({
      db: { service: "main" },
    });
  });

  it("rejects an existing database of the wrong engine", async () => {
    await api("/projects/shop/databases", "POST", { name: "main", engine: "mysql" });
    const { status } = await install("shop", "miniflux", {
      services: { db: { name: "x", existing: "main" }, app: { name: "miniflux" } },
    });
    expect(status).toBe(400);
  });

  it("leaves that confirmation to an administrator", async () => {
    const operator = await signInMember(context.app, cookie, "op@example.com", [
      { project: "shop", role: "operator" },
    ]);
    const defaults = await install("shop", "dozzle");
    const body = defaults.body as unknown as { error: { fields: Record<string, string> } };
    expect(body.error.fields).toHaveProperty("acknowledgeHostAccess");
    const template = (await api<{ templates: TemplateDocument[] }>("/templates")).body.templates.find(
      (candidate) => candidate.id === "dozzle",
    ) as TemplateDocument;
    const services = Object.fromEntries(
      template.services.map((service) => [service.key, { name: service.name }]),
    );

    const refused = await call(context.app, "/api/v1/projects/shop/templates", {
      method: "POST",
      cookie: operator,
      origin: TEST_ORIGIN,
      body: { ...catalogue("dozzle"), services, params: {}, acknowledgeHostAccess: true },
    });

    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("admin_required");
    expect(findService(context.deps.db, "shop", "dozzle")).toBeUndefined();
  });

  it("asks for confirmation before granting access to the server", async () => {
    const refused = await install("shop", "dozzle");
    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).fields).toHaveProperty("acknowledgeHostAccess");
    expect(findService(context.deps.db, "shop", "dozzle")).toBeUndefined();

    const accepted = await install("shop", "dozzle", { acknowledgeHostAccess: true });
    expect(accepted.status).toBe(201);
    expect(findService(context.deps.db, "shop", "dozzle")?.spec.mounts[0]).toEqual({
      type: "bind",
      hostPath: "/var/run/docker.sock",
      mountPath: "/var/run/docker.sock",
      acknowledgeRisk: true,
    });
  });

  it("removes only what the install created", async () => {
    const created = (await install("shop", "gotify")).body;
    await install("other", "gotify");
    const wrong = await api(`/projects/shop/templates/${created.id}`, "DELETE", { confirm: "nope" });
    expect(wrong.status).toBe(409);
    const action = await api<{ id: string }>(`/projects/shop/templates/${created.id}`, "DELETE", {
      confirm: "Gotify",
    });
    expect(action.status).toBe(202);
    expect((await waitForAction(action.body.id)).status).toBe("succeeded");
    expect(findService(context.deps.db, "shop", "gotify")).toBeUndefined();
    expect(findService(context.deps.db, "other", "gotify")).toBeDefined();
    expect((await api(`/projects/shop/templates/${created.id}`)).status).toBe(404);
  });
});

describe("create from a schema", () => {
  const schema = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "my-app",
      version: "1.0.0",
      name: "My app",
      summary: { en: "An app", fr: "Une appli" },
      description: { en: "An app", fr: "Une appli" },
      category: "development",
      services: [
        {
          key: "app",
          name: "web",
          kind: "app",
          source: { type: "image", image: "traefik/whoami:v1.10" },
          domain: { port: 80 },
          startup: { path: "/", expect: [200] },
        },
      ],
      ...overrides,
    });

  const submit = (schemaText: string) =>
    api<TemplateInstall>("/projects/shop/templates", "POST", {
      source: { type: "schema", schema: schemaText },
      services: { app: { name: "web" } },
    });

  it("creates services from a pasted document", async () => {
    const { status, body } = await submit(schema());
    expect(status).toBe(201);
    expect(body.custom).toBe(true);
    expect(body.components[0]?.service.name).toBe("web");
  });

  it("rejects text that is not JSON with the parser's own words", async () => {
    const { status, body } = await submit("{ not json");
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('"schema"');
  });

  it("refuses a document that names another project", async () => {
    const preview = await api("/templates/preview", "POST", { schema: schema({ project: "other" }) });
    expect(preview.status).toBe(400);
  });

  it("refuses a dependency cycle", async () => {
    const preview = await api("/templates/preview", "POST", {
      schema: schema({
        services: [
          {
            key: "a",
            name: "a",
            kind: "app",
            source: { type: "image", image: "x:1" },
            dependsOn: ["b"],
          },
          {
            key: "b",
            name: "b",
            kind: "app",
            source: { type: "image", image: "x:1" },
            dependsOn: ["a"],
          },
        ],
      }),
    });
    expect(preview.status).toBe(400);
    expect(JSON.stringify(preview.body)).toContain("cycle");
  });

  it("refuses an image that isn't pinned", async () => {
    const preview = await api("/templates/preview", "POST", {
      schema: schema({
        services: [
          { key: "app", name: "web", kind: "app", source: { type: "image", image: "nginx:latest" } },
        ],
      }),
    });
    expect(preview.status).toBe(400);
  });

  it("refuses a token that points nowhere", async () => {
    const preview = await api("/templates/preview", "POST", {
      schema: schema({
        services: [
          {
            key: "app",
            name: "web",
            kind: "app",
            source: { type: "image", image: "x:1" },
            env: { TOKEN: "{{secrets.nope}}" },
          },
        ],
      }),
    });
    expect(preview.status).toBe(400);
    expect(JSON.stringify(preview.body)).toContain("Unknown secret");
  });
});
