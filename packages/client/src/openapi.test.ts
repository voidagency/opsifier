import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  call,
  createTestContext,
  setupAdmin,
  type TestContext,
} from "../../../apps/server/src/testing/harness";
import { ROUTES } from "./api";
import { classifyOperation, describeOperation, type OpenApiDocument } from "./catalogue";

let context: TestContext;
let document: OpenApiDocument;

beforeAll(async () => {
  context = await createTestContext();
  const cookie = await setupAdmin(context.app);
  document = (await call<OpenApiDocument>(context.app, "/api/v1/openapi.json", { cookie })).body;
});

afterAll(async () => {
  await context.close();
});

interface Parameter {
  name: string;
  in: string;
}

const operationOf = (method: string, path: string) => document.paths[path]?.[method.toLowerCase()];

describe("the routes the clients use", () => {
  // The document does not list the route it is served from.
  const inDocument = Object.entries(ROUTES).filter(([name]) => name !== "openapi");

  it.each(inDocument)("%s exists on the server with those parameters", (_name, route) => {
    const operation = operationOf(route.method, route.path);
    expect(operation, `${route.method} ${route.path} is not in the API`).toBeDefined();
    const inTemplate = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    const parameters = ((operation as { parameters?: Parameter[] }).parameters ?? [])
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name);
    expect(parameters.sort()).toEqual(inTemplate.sort());
  });
});

describe("what an operation is called", () => {
  it("is read for every GET, and destructive for every DELETE", () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item)) {
        const { kind } = classifyOperation(method, path);
        if (method === "get") {
          expect(kind, `GET ${path}`).toBe("read");
        }
        if (method === "delete") {
          expect(kind, `DELETE ${path}`).toBe("destructive");
        }
      }
    }
  });

  it("is destructive for everything the server itself asks to confirm by name", () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const schema = operation.requestBody?.content?.["application/json"]?.schema as
          | { properties?: Record<string, unknown>; required?: string[] }
          | undefined;
        if (schema?.properties?.confirm !== undefined && schema.required?.includes("confirm") === true) {
          expect(classifyOperation(method, path).kind, `${method} ${path}`).toBe("destructive");
        }
      }
    }
  });

  it("is high risk for a stop, a restore and a secret revealed, and low for a plain read", () => {
    const service = "/api/v1/projects/{project}/services/{service}";
    expect(classifyOperation("POST", `${service}/stop`)).toEqual({ kind: "destructive", risk: "high" });
    expect(classifyOperation("POST", `${service}/backups/restore`).risk).toBe("high");
    expect(classifyOperation("POST", `${service}/credentials/reveal`).risk).toBe("high");
    expect(classifyOperation("GET", `${service}/environment`).risk).toBe("medium");
    expect(classifyOperation("GET", "/api/v1/projects")).toEqual({ kind: "read", risk: "low" });
    expect(classifyOperation("POST", `${service}/deploy`)).toEqual({ kind: "change", risk: "medium" });
  });

  it("is destructive for a secret revealed, which can't be taken back", () => {
    const service = "/api/v1/projects/shop/services/web";
    for (const path of [`${service}/environment/reveal`, `${service}/credentials/reveal`]) {
      expect(classifyOperation("POST", path), path).toEqual({ kind: "destructive", risk: "high" });
    }
  });

  it("is judged on the path the panel routes, however it is spelled", () => {
    const service = "/api/v1/projects/shop/services/web";
    for (const path of [
      `${service}/st%6Fp`,
      `${service}/%73top`,
      `${service}/STOP`,
      `${service}/environment/rev%65al`,
      "/api/v1/projects/shop/services/web/backups/abc/r%65store",
    ]) {
      expect(classifyOperation("POST", path).kind, path).toBe("destructive");
    }
  });
});

describe("describing an operation", () => {
  it("gives its parameters and body, for a template or a filled-in path", () => {
    const described = describeOperation(document, "post", "/api/v1/projects/shop/services/web/deploy");

    expect(described.path).toBe("/api/v1/projects/{project}/services/{service}/deploy");
    expect(described.parameters.map((parameter) => parameter.name).sort()).toEqual(["project", "service"]);
    expect(described.body).toMatchObject({ properties: { force: { type: "boolean" } } });
  });

  it("names an operation that does not exist", () => {
    expect(() => describeOperation(document, "GET", "/api/v1/nothing/here")).toThrow(/no operation/);
  });
});
