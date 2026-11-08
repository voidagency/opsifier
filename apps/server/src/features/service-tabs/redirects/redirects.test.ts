import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionEntry, RedirectList, RedirectRule } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1/projects/shop/services/web${path}`, {
    method,
    body,
    cookie,
    origin: TEST_ORIGIN,
  });

const proxyFile = () =>
  parse(readFileSync(join(context.dataDir, "traefik/dynamic/shop__web.yaml"), "utf8")) as {
    http: { routers: Record<string, { middlewares?: string[] }>; middlewares?: Record<string, unknown> };
  };

const list = async () => (await api<RedirectList>("/redirects")).body.redirects;

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
const replacement = "http://shop.example.test/new${1}";
const rule = { regex: "^http://shop.example.test/old(.*)", replacement };

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await call(context.app, "/api/v1/projects", {
    method: "POST",
    body: { name: "shop" },
    cookie,
    origin: TEST_ORIGIN,
  });
  await call(context.app, "/api/v1/projects/shop/services", {
    method: "POST",
    body: { name: "web" },
    cookie,
    origin: TEST_ORIGIN,
  });
});

afterEach(async () => {
  await context.close();
});

describe("the redirects tab", () => {
  it("starts empty", async () => {
    expect(await list()).toEqual([]);
  });

  it("creates a rule with defaults and applies it to every router at once", async () => {
    const created = await api<RedirectRule>("/redirects", "POST", rule);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ enabled: true, permanent: false, ...rule });
    expect(await list()).toHaveLength(1);

    const { http } = proxyFile();
    expect(http.middlewares?.["opsifier-redirect-shop_web-0"]).toEqual({
      redirectRegex: { regex: rule.regex, replacement, permanent: false },
    });
    for (const router of Object.values(http.routers)) {
      expect(router.middlewares).toContain("opsifier-redirect-shop_web-0");
    }
  });

  it("edits a rule, including to permanent", async () => {
    const created = await api<RedirectRule>("/redirects", "POST", rule);
    const updated = await api<RedirectRule>(`/redirects/${created.body.id}`, "PUT", {
      ...rule,
      permanent: true,
    });

    expect(updated.status).toBe(200);
    expect(proxyFile().http.middlewares?.["opsifier-redirect-shop_web-0"]).toMatchObject({
      redirectRegex: { permanent: true },
    });
  });

  it("disabling removes the middleware but keeps the rule, visibly disabled", async () => {
    const created = await api<RedirectRule>("/redirects", "POST", rule);
    const disabled = await api<RedirectRule>(`/redirects/${created.body.id}`, "PUT", {
      ...rule,
      enabled: false,
    });

    expect(disabled.body.enabled).toBe(false);
    expect(proxyFile().http.middlewares ?? {}).toEqual({});
    expect((await list())[0]?.enabled).toBe(false);
  });

  it("deleting removes the rule and its middleware", async () => {
    const created = await api<RedirectRule>("/redirects", "POST", rule);
    expect((await api(`/redirects/${created.body.id}`, "DELETE")).status).toBe(200);

    expect(await list()).toEqual([]);
    expect(proxyFile().http.middlewares ?? {}).toEqual({});
  });

  it("answers 404 for a rule that does not exist", async () => {
    expect((await api("/redirects/nope", "PUT", rule)).status).toBe(404);
    expect((await api("/redirects/nope", "DELETE")).status).toBe(404);
  });

  it("accepts the shapes of every example the dialog offers", async () => {
    const examples = [
      ["^https?://www\\.my-domain\\.com/(.*)", "https://my-domain.com/$${1}"],
      ["^https?://my-domain\\.com/(.*)", "https://www.my-domain.com/$${1}"],
      ["^https?://old-domain\\.com/(.*)", "https://new-domain.com/$${1}"],
      ["^(.*)/old-path", "$${1}/new-path"],
    ];
    for (const [regex, target] of examples) {
      const result = await api("/redirects", "POST", { regex, replacement: target });
      expect(result.status).toBe(201);
    }
  });

  it.each([
    [{ replacement: "x" }, "regex"],
    [{ regex: "", replacement: "x" }, "regex"],
    [{ regex: "a(b", replacement: "x" }, "regex"],
    [{ regex: "(?=lookahead)", replacement: "x" }, "regex"],
    [{ regex: "a\\1", replacement: "x" }, "regex"],
    [{ regex: "a**", replacement: "x" }, "regex"],
    [{ regex: "[z-a]", replacement: "x" }, "regex"],
    [{ regex: "a{2000}", replacement: "x" }, "regex"],
    [{ regex: "with space", replacement: "x" }, "regex"],
    [{ regex: "line\nbreak", replacement: "x" }, "regex"],
    [{ regex: "a" }, "replacement"],
    [{ regex: "a", replacement: "" }, "replacement"],
    [{ regex: "a", replacement: "two words" }, "replacement"],
    [{ regex: "a", replacement: "line\r\nbreak" }, "replacement"],
  ])("rejects %j", async (body, field) => {
    const result = await api("/redirects", "POST", body);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.[field]).toBeTruthy();
    expect(await list()).toEqual([]);
  });

  it("can't overrun the rule limit", async () => {
    for (let index = 0; index < 100; index += 1) {
      expect((await api("/redirects", "POST", { regex: `r${index}`, replacement: "x" })).status).toBe(201);
    }
    const result = await api("/redirects", "POST", { regex: "more", replacement: "x" });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("too_many_redirects");
  });

  it("never touches a deployed service", async () => {
    await api("/source", "PUT", { image: "traefik/whoami:v1.10" });
    const accepted = await api<ActionEntry>("/deploy", "POST");
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await call<ActionEntry>(context.app, `/api/v1/actions/${accepted.body.id}`, {
        cookie,
      });
      if (body.status === "succeeded") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const before = await context.docker.inspectService("shop_web");

    await api("/redirects", "POST", rule);

    expect((await context.docker.inspectService("shop_web"))?.version).toBe(before?.version);
  });
});
