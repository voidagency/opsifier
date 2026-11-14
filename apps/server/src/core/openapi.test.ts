import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../testing/harness";

type Schema = Record<string, unknown>;

interface OpenApiDocument {
  paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>>;
  components?: { schemas?: Record<string, Schema> };
}

/** Every object inside a schema, so a nested one that accepts anything can't hide behind its parent. */
function objectsIn(document: OpenApiDocument, schema: Schema, seen = new Set<Schema>()): Schema[] {
  if (seen.has(schema)) {
    return [];
  }
  seen.add(schema);
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1) as string;
    return objectsIn(document, document.components?.schemas?.[name] as Schema, seen);
  }
  const children = [
    schema.items,
    schema.additionalProperties,
    ...Object.values((schema.properties ?? {}) as Record<string, unknown>),
    ...((schema.oneOf ?? []) as unknown[]),
    ...((schema.anyOf ?? []) as unknown[]),
    ...((schema.allOf ?? []) as unknown[]),
  ].filter((child): child is Schema => typeof child === "object" && child !== null);
  const nested = children.flatMap((child) => objectsIn(document, child, seen));
  return schema.type === "object" && schema.properties !== undefined ? [schema, ...nested] : nested;
}

describe("request bodies", () => {
  let context: TestContext;
  let cookie: string;
  const post = (path: string, body: unknown, method = "POST") =>
    call(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

  beforeEach(async () => {
    context = await createTestContext();
    cookie = await setupAdmin(context.app);
    await post("/projects", { name: "shop" });
    await post("/projects/shop/services", { name: "web" });
  });

  afterEach(async () => {
    await context.close();
  });

  it("refuse a key they do not know, and name it", async () => {
    const result = await post("/projects", { name: "other", color: "red" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("validation_failed");
    expect(apiErrorOf(result).fields).toEqual({ color: "Not a field this request accepts" });
    expect((await post("/projects", { name: "other" })).status).toBe(201);
  });

  it("refuse one at any depth, with the path of the unknown key", async () => {
    const result = await post("/projects/shop/services/web/advanced/ports", {
      published: 30080,
      target: 80,
      extra: true,
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("extra");

    const nested = await post("/projects/shop/services/web/backups/configs", {
      kind: "database",
      schedule: "0 2 * * *",
      retention: null,
      storageProviderId: "x",
      path: "a",
      databaseName: "app",
      smuggled: 1,
    });
    expect(nested.status).toBe(400);
    expect(apiErrorOf(nested).fields).toHaveProperty("smuggled");
  });

  it("refuse one on a route whose body may be left out", async () => {
    await post("/projects/shop/services/web/source", { image: "nginx:alpine" }, "PUT");

    expect((await post("/projects/shop/services/web/deploy", { force: false, hurry: true })).status).toBe(
      400,
    );
  });

  it("are closed on every route the API has", async () => {
    const { body: document } = await call<OpenApiDocument>(context.app, "/api/v1/openapi.json", { cookie });
    const open: string[] = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const schema = operation.requestBody?.content["application/json"]?.schema;
        if (schema === undefined) {
          continue;
        }
        const objects = objectsIn(document, schema);
        if (objects.some((object) => object.additionalProperties !== false)) {
          open.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(open).toEqual([]);
  });
});
