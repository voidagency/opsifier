import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Feature } from "./core/context";
import { AppError, conflict } from "./core/errors";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "./testing/harness";

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

/** Routes that fail in the ways no real feature would do on purpose. */
function appWithTestFeature() {
  const route = (path: string) =>
    createRoute({
      method: "post",
      path,
      request: {
        body: { required: true, content: { "application/json": { schema: z.object({ name: z.string() }) } } },
      },
      responses: { 200: { description: "ok" } },
    });

  const feature: Feature = {
    publicPaths: ["/api/v1/test/crash", "/api/v1/test/conflict", "/api/v1/test/nested"],
    register(app) {
      app.openapi(route("/api/v1/test/crash"), () => {
        throw new Error("secret internal detail");
      });
      app.openapi(route("/api/v1/test/conflict"), () => {
        throw conflict("name_taken", "That name is taken.", { name: "Already used" });
      });
      app.openapi(
        createRoute({
          method: "post",
          path: "/api/v1/test/nested",
          request: {
            body: {
              required: true,
              content: {
                "application/json": {
                  schema: z.object({
                    spec: z.object({ port: z.number().int().min(1).max(65535) }),
                    list: z.array(z.string()),
                  }),
                },
              },
            },
          },
          responses: { 200: { description: "ok" } },
        }),
        (c) => c.body(null, 200),
      );
    },
  };
  return createApp(context.deps, [feature]);
}

describe("the error shape", () => {
  it("is used for failed validation, with a message per field", async () => {
    const result = await authPost(context.app, "login", { email: "nope", password: "" });

    expect(result.status).toBe(400);
    expectErrorShape(result);
    expect(apiErrorOf(result)).toMatchObject({
      code: "validation_failed",
      fields: { email: expect.any(String), password: "Required" },
    });
  });

  it("reports missing fields as Required", async () => {
    const result = await authPost(context.app, "login", {});
    expect(apiErrorOf(result).fields).toEqual({ email: "Required", password: "Required" });
  });

  it("joins nested paths", async () => {
    const app = appWithTestFeature();
    const result = await call(app, "/api/v1/test/nested", {
      body: { spec: { port: 70000 }, list: "no" },
      origin: TEST_ORIGIN,
    });

    expect(result.status).toBe(400);
    expect(Object.keys(apiErrorOf(result).fields ?? {}).sort()).toEqual(["list", "spec.port"]);
  });

  it("is used for malformed JSON", async () => {
    const result = await call(context.app, "/api/v1/auth/login", {
      method: "POST",
      rawBody: "{ not json",
      headers: { "content-type": "application/json" },
    });
    expect(result.status).toBe(400);
    expectErrorShape(result);
    expect(apiErrorOf(result).code).toBe("bad_request");
  });

  it("is used for a body that is not a JSON object", async () => {
    const result = await call(context.app, "/api/v1/auth/login", {
      method: "POST",
      rawBody: '"just a string"',
      headers: { "content-type": "application/json" },
    });
    expect(result.status).toBe(400);
    expectErrorShape(result);
  });

  it("is used for a missing body, which never reaches the handler", async () => {
    const result = await call(context.app, "/api/v1/auth/login", { method: "POST" });
    expect(result.status).toBe(400);
    expectErrorShape(result);
    expect(apiErrorOf(result).fields).toHaveProperty("email");
  });

  it("is used for the wrong content type", async () => {
    const result = await call(context.app, "/api/v1/auth/login", {
      method: "POST",
      rawBody: "email=a",
      headers: { "content-type": "text/plain" },
    });
    expect(result.status).toBe(415);
    expectErrorShape(result);
    expect(apiErrorOf(result).code).toBe("unsupported_media_type");
  });

  it("is used for an oversized body", async () => {
    const result = await call(context.app, "/api/v1/auth/login", {
      body: { email: "a@example.com", password: "x".repeat(2 * 1024 * 1024) },
    });
    expect(result.status).toBe(413);
    expectErrorShape(result);
  });

  it("is used for unknown API routes and for missing authentication", async () => {
    const notFound = await call(context.app, "/api/v1/does-not-exist", { cookie });
    expect(notFound.status).toBe(404);
    expectErrorShape(notFound);

    const denied = await call(context.app, "/api/v1/does-not-exist");
    expect(denied.status).toBe(401);
    expectErrorShape(denied);
  });

  it("carries the code, message and fields of a deliberate error", async () => {
    const result = await call(appWithTestFeature(), "/api/v1/test/conflict", {
      body: { name: "a" },
      origin: TEST_ORIGIN,
    });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: { code: "name_taken", message: "That name is taken.", fields: { name: "Already used" } },
    });
  });

  it("hides the details of an unexpected failure", async () => {
    const result = await call(appWithTestFeature(), "/api/v1/test/crash", {
      body: { name: "a" },
      origin: TEST_ORIGIN,
    });
    expect(result.status).toBe(500);
    expectErrorShape(result);
    expect(apiErrorOf(result).code).toBe("internal_error");
    expect(JSON.stringify(result.body)).not.toContain("secret internal detail");
  });

  it("can add response headers", () => {
    expect(new AppError(429, "x", "y", undefined, { "Retry-After": "1" }).headers).toEqual({
      "Retry-After": "1",
    });
  });
});

describe("responses", () => {
  it("are never cached and carry security headers", async () => {
    const result = await call(context.app, "/api/v1/auth/session", { cookie });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("x-frame-options")).toBe("DENY");
    // Anything stricter would turn the Origin of the panel's own requests into "null".
    expect(result.headers.get("referrer-policy")).toBe("same-origin");
  });

  describe("over HTTPS", () => {
    const sts = async (url: string) =>
      (await context.app.request(url)).headers.get("strict-transport-security");

    beforeEach(async () => {
      const saved = await call(context.app, "/api/v1/server/panel-domain", {
        method: "PUT",
        cookie,
        origin: TEST_ORIGIN,
        body: { customDomain: "panel.example.com", serveOnIp: true },
      });
      expect(saved.status).toBe(200);
    });

    it("tell a browser to keep to HTTPS on the panel's own names", async () => {
      expect(await sts("https://panel.example.com/api/v1/health")).toBe("max-age=31536000");
      const names = await call<{ defaultDomain: string | null }>(context.app, "/api/v1/server/panel-domain", {
        cookie,
      });
      if (names.body.defaultDomain !== null) {
        expect(await sts(`https://${names.body.defaultDomain}/api/v1/health`)).toBe("max-age=31536000");
      }
    });

    it("say nothing over plain HTTP, on a bare address or on another name", async () => {
      expect(await sts("http://panel.example.com/api/v1/health")).toBeNull();
      expect(await sts("https://203.0.113.10/api/v1/health")).toBeNull();
      // Served on the IP, the panel can be reached under a name that is not its own.
      expect(await sts("https://shop.example.com/api/v1/health")).toBeNull();
    });

    it("leave the names of services alone, whose pages the panel serves for the proxy", async () => {
      expect(await sts("https://shop.example.com/api/proxy-pages/not-found")).toBeNull();
    });
  });
});

describe("the OpenAPI document", () => {
  it("is public and lists the routes of every feature", async () => {
    const result = await call<{ openapi: string; paths: Record<string, unknown> }>(
      context.app,
      "/api/v1/openapi.json",
    );

    expect(result.status).toBe(200);
    expect(result.body.openapi).toBe("3.1.0");
    expect(Object.keys(result.body.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/auth/session",
        "/api/v1/auth/login",
        "/api/v1/auth/setup",
        "/api/v1/auth/logout",
        "/api/v1/auth/credentials",
        "/api/v1/auth/two-factor/begin",
        "/api/v1/auth/two-factor/enable",
        "/api/v1/auth/two-factor/disable",
        "/api/v1/system/info",
        "/api/v1/actions",
        "/api/v1/actions/{id}",
        "/api/v1/actions/{id}/cancel",
      ]),
    );
  });
});

describe("serving the web app", () => {
  let web: TestContext;

  beforeEach(async () => {
    const webDir = join(context.dataDir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Opsifier</title>");
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log(1)");
    web = await createTestContext({ env: { OPSIFIER_WEB_DIR: webDir } });
  });

  afterEach(async () => {
    await web.close();
    rmSync(join(context.dataDir, "web"), { recursive: true, force: true });
  });

  it("serves files and caches hashed assets for a long time", async () => {
    const result = await call<string>(web.app, "/assets/app-abc123.js");
    expect(result.status).toBe(200);
    expect(result.body).toContain("console.log");
    expect(result.headers.get("cache-control")).toContain("immutable");
  });

  it("answers client-side routes with the app, uncached", async () => {
    const result = await call<string>(web.app, "/settings/users");
    expect(result.status).toBe(200);
    expect(result.body).toContain("<title>Opsifier</title>");
    expect(result.headers.get("cache-control")).toBe("no-cache");
    expect(result.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("keeps API 404s as JSON, not the app", async () => {
    const result = await call(web.app, "/api/v2/nope");
    expect(result.status).toBe(404);
    expectErrorShape(result);
  });

  it("does not leave the web directory", async () => {
    const result = await call<string>(web.app, "/..%2f..%2fsecret.key");
    expect(String(result.body)).not.toContain("secret");
    expect(String(result.body)).toContain("<title>Opsifier</title>");
  });

  it("refuses to boot without an index.html", async () => {
    await expect(
      createTestContext({ env: { OPSIFIER_WEB_DIR: join(context.dataDir, "missing") } }),
    ).rejects.toThrow(/index\.html/);
  });
});
