import type { BuildEnvironment } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projects, services, settings } from "../../../core/db/schema";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { openEnv, sealEnv, sealStoredVariables } from "../../services/env-store";
import { findService } from "../../services/repo";

import { keepExistingInterpolation } from "./upgrade";

const SERVICE = "/api/v1/projects/shop/services/web";
const PATH = `${SERVICE}/environment`;
const BUILD = `${PATH}/build`;

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

const buildSource = () =>
  api(`${SERVICE}/source`, "PUT", {
    type: "git",
    url: "https://git.example.com/acme/shop.git",
    ref: "main",
    path: "/",
  });

const rawRow = () =>
  context.deps.db
    .select()
    .from(services)
    .where(and(eq(services.projectName, "shop"), eq(services.name, "web")))
    .get();

const reveals = async () =>
  (await api<{ items: Array<{ type: string }> }>("/api/v1/actions?type=service.env-reveal")).body.items;

describe("the environment tab", () => {
  it("starts empty, saves the text as typed and records the change", async () => {
    expect((await api(PATH)).body).toEqual({ names: [], interpolation: false });

    const text = 'FOO=bar\n# comment\nQUOTED="hello world"\n';
    const saved = await api(PATH, "PUT", { env: text });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ names: ["FOO", "QUOTED"], interpolation: false });
    expect((await api<{ env: string }>(`${PATH}/reveal`, "POST")).body.env).toBe(text);

    const actions = await api<{ items: Array<{ type: string }> }>("/api/v1/actions?type=service.env");
    expect(actions.body.items).toHaveLength(1);
  });

  it("names the first line that is not a variable", async () => {
    const result = await api(PATH, "PUT", { env: "A=1\n\n=novalue" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toBe("Line 3 must look like NAME=value");
  });

  it("keeps the values out of the service's own response", async () => {
    await api(PATH, "PUT", { env: "SECRET=value-to-hide" });

    const service = await api("/api/v1/projects/shop/services/web");
    expect(JSON.stringify(service.body)).not.toContain("value-to-hide");
  });

  describe("placeholders (REQ-477)", () => {
    it("are off unless asked for, and staying silent about them keeps the choice", async () => {
      expect((await api<{ interpolation: boolean }>(PATH)).body.interpolation).toBe(false);

      await api(PATH, "PUT", { env: "A=1", interpolation: true });
      expect((await api<{ interpolation: boolean }>(PATH)).body.interpolation).toBe(true);

      await api(PATH, "PUT", { env: "A=2" });
      expect((await api(PATH)).body).toEqual({ names: ["A"], interpolation: true });
      expect((await api<{ env: string }>(`${PATH}/reveal`, "POST")).body.env).toBe("A=2");

      await api(PATH, "PUT", { env: "A=3", interpolation: false });
      expect((await api<{ interpolation: boolean }>(PATH)).body.interpolation).toBe(false);
    });

    it("can be switched without sending the variables, which stay as they were", async () => {
      await api(PATH, "PUT", { env: "A=1" });

      const saved = await api(PATH, "PUT", { interpolation: true });

      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({ names: ["A"], interpolation: true });
      expect((await api<{ env: string }>(`${PATH}/reveal`, "POST")).body.env).toBe("A=1");
    });

    it("stay on for a service that relied on them before the switch existed, once", async () => {
      await api("/api/v1/projects/shop/services", "POST", { name: "old-style" });
      await api("/api/v1/projects/shop/services", "POST", { name: "plain" });
      const stripSwitch = (name: string, env: string) => {
        const row = context.deps.db
          .select()
          .from(services)
          .where(and(eq(services.projectName, "shop"), eq(services.name, name)))
          .get() as { spec: Record<string, unknown> };
        const { envInterpolation: _dropped, ...legacy } = row.spec;
        context.deps.db
          .update(services)
          .set({ spec: { ...legacy, sealedEnv: sealEnv(context.deps, env) } })
          .where(and(eq(services.projectName, "shop"), eq(services.name, name)))
          .run();
      };
      stripSwitch("old-style", "URL=https://$(PRIMARY_DOMAIN)/");
      stripSwitch("plain", "NOT=a placeholder");
      // Boot already ran this on an empty panel. An upgrade finds these rows there instead.
      context.deps.db.delete(settings).where(eq(settings.key, "env-interpolation-upgraded")).run();

      keepExistingInterpolation(context.deps);

      const state = async (name: string) =>
        (await api<{ interpolation: boolean }>(`/api/v1/projects/shop/services/${name}/environment`)).body
          .interpolation;
      expect(await state("old-style")).toBe(true);
      expect(await state("plain")).toBe(false);

      // Turned off by a person afterwards, it stays off through later restarts.
      await api("/api/v1/projects/shop/services/old-style/environment", "PUT", {
        env: "URL=https://$(PRIMARY_DOMAIN)/",
        interpolation: false,
      });
      keepExistingInterpolation(context.deps);
      expect(await state("old-style")).toBe(false);
    });
  });

  it("answers 404 for a service that does not exist", async () => {
    expect((await api("/api/v1/projects/shop/services/missing/environment")).status).toBe(404);
  });

  it("shows names on load, and values only to someone who asks, with a record of it", async () => {
    await api(PATH, "PUT", { env: "API_TOKEN=value-to-hide\n" });

    const page = await api(PATH);
    expect(page.body).toEqual({ names: ["API_TOKEN"], interpolation: false });
    expect(JSON.stringify(page.body)).not.toContain("value-to-hide");
    expect(await reveals()).toHaveLength(0);

    const revealed = await api<{ env: string }>(`${PATH}/reveal`, "POST");
    expect(revealed.body.env).toContain("value-to-hide");
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(await reveals()).toHaveLength(1);
  });

  it("keeps the values sealed in the database", async () => {
    await api(PATH, "PUT", { env: "API_TOKEN=value-to-hide\n" });

    const row = rawRow();
    expect(JSON.stringify(row?.spec)).not.toContain("value-to-hide");
    expect(JSON.stringify(row?.spec)).toMatch(/"sealedEnv":"v1\./);
  });
});

describe("build variables and build secrets", () => {
  beforeEach(async () => {
    await buildSource();
  });

  it("keeps build variables apart from runtime ones, and shows them by name", async () => {
    await api(PATH, "PUT", { env: "ONLY_AT_RUNTIME=1\n" });
    const saved = await api<BuildEnvironment>(BUILD, "PUT", { env: "ONLY_AT_BUILD=hello-world\n" });

    expect(saved.status).toBe(200);
    expect(saved.body.variables).toEqual(["ONLY_AT_BUILD"]);
    expect(JSON.stringify(saved.body)).not.toContain("hello-world");
    expect((await api(PATH)).body).toEqual({ names: ["ONLY_AT_RUNTIME"], interpolation: false });
    const revealed = await api<{ env: string }>(`${BUILD}/reveal`, "POST");
    expect(revealed.body.env).toBe("ONLY_AT_BUILD=hello-world\n");
    expect(await reveals()).toHaveLength(1);
  });

  it("is sealed in the database too", async () => {
    await api(BUILD, "PUT", { env: "ONLY_AT_BUILD=hello-world\n" });
    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "npm-secret-value" });

    const stored = JSON.stringify(rawRow()?.spec);
    expect(stored).not.toContain("hello-world");
    expect(stored).not.toContain("npm-secret-value");
  });

  it("refuses a sealed value in a build variable, since it would end up in the image", async () => {
    const result = await api(BUILD, "PUT", { env: "OK=1\nDB=$(db.main.url)\n" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toContain("Line 2");
  });

  it("refuses names that would steer the build tools", async () => {
    const variable = await api(BUILD, "PUT", { env: "DOCKER_HOST=tcp://elsewhere\n" });
    expect(variable.status).toBe(400);
    expect(apiErrorOf(variable).fields?.env).toContain("DOCKER_HOST");

    const secret = await api(`${BUILD}/secrets/BUILDKIT_HOST`, "PUT", { value: "elsewhere" });
    expect(secret.status).toBe(400);
    expect(apiErrorOf(secret).fields?.name).toContain("BUILDKIT_HOST");
  });

  it.each([
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "MALLOC_TRACE",
    "LOCPATH",
    "HOSTALIASES",
    "GODEBUG",
    "PACK_HOME",
    "XDG_CONFIG_HOME",
    "GIT_SSH_COMMAND",
    "GIT_CONFIG_COUNT",
    "SSH_AUTH_SOCK",
    "SSH_ASKPASS",
    "BASH_ENV",
    "OPENSSL_CONF",
    "SSL_CERT_FILE",
  ])("refuses %s, which the programs a build runs would act on themselves", async (name) => {
    const variable = await api(BUILD, "PUT", { env: `${name}=value\n` });
    expect(variable.status).toBe(400);
    expect(apiErrorOf(variable).fields?.env).toContain(name);

    const secret = await api(`${BUILD}/secrets/${name}`, "PUT", { value: "value" });
    expect(secret.status).toBe(400);
    expect(apiErrorOf(secret).fields?.name).toContain(name);
  });

  it("still takes ordinary names that only look close", async () => {
    const saved = await api(BUILD, "PUT", {
      env: "GITHUB_TOKEN_NAME=ci\nLDAP_URL=ldap://directory\nPACKAGE_NAME=shop\nNODE_ENV=production\nGOPROXY=https://proxy.golang.org\nLANG=C.UTF-8\n",
    });
    expect(saved.status).toBe(200);
  });

  it("won't hold the same name as both a variable and a secret", async () => {
    await api(BUILD, "PUT", { env: "SHARED=value\n" });
    const asSecret = await api(`${BUILD}/secrets/SHARED`, "PUT", { value: "secret-value" });
    expect(asSecret.status).toBe(400);
    expect(apiErrorOf(asSecret).fields?.name).toContain("already a build variable");

    await api(`${BUILD}/secrets/TAKEN`, "PUT", { value: "secret-value" });
    const asVariable = await api(BUILD, "PUT", { env: "TAKEN=value\n" });
    expect(asVariable.status).toBe(400);
    expect(apiErrorOf(asVariable).fields?.env).toContain("already a build secret");
  });

  it("can replace or remove a secret and has no way of giving one back", async () => {
    const saved = await api<BuildEnvironment>(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "first-value" });
    expect(saved.body.secrets).toEqual([{ name: "NPM_TOKEN", updatedAt: expect.stringMatching(/^\d{4}-/) }]);
    expect(JSON.stringify(saved.body)).not.toContain("first-value");
    expect((await api(`${BUILD}/secrets/NPM_TOKEN`)).status).toBe(404);

    await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "second-value" });
    const removed = await api<BuildEnvironment>(`${BUILD}/secrets/NPM_TOKEN`, "DELETE");
    expect(removed.body.secrets).toEqual([]);
    expect((await api(`${BUILD}/secrets/NPM_TOKEN`, "DELETE")).status).toBe(404);
  });

  it("validates a secret's name and value", async () => {
    expect((await api(`${BUILD}/secrets/not%20valid`, "PUT", { value: "x" })).status).toBe(400);
    expect((await api(`${BUILD}/secrets/NAME`, "PUT", { value: "" })).status).toBe(400);
  });

  it("does not apply to a service that is not built", async () => {
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:1.28" });

    expect((await api(BUILD, "PUT", { env: "A=1\n" })).status).toBe(400);
    expect((await api(`${BUILD}/secrets/NPM_TOKEN`, "PUT", { value: "secret" })).status).toBe(400);
  });
});

describe("a panel upgrading from when variables were stored in clear", () => {
  const NEW_FIELDS = [
    "sealedEnv",
    "sealedRetired",
    "sealedVariables",
    "secrets",
    "inheritsRuntime",
    "envFileInImage",
  ];
  const without = (fields: object) =>
    Object.fromEntries(Object.entries(fields).filter(([name]) => !NEW_FIELDS.includes(name)));

  function asStoredByOldVersion(env: string, oldBuild: Record<string, unknown> = {}): void {
    const { build, ...current } = (rawRow()?.spec ?? {}) as Record<string, unknown>;
    context.deps.db
      .update(services)
      .set({ spec: { ...without(current), env, build: { ...without(build as object), ...oldBuild } } })
      .where(and(eq(services.projectName, "shop"), eq(services.name, "web")))
      .run();
  }

  it("seals what it finds, and only once", async () => {
    await buildSource();
    asStoredByOldVersion("API_TOKEN=value-to-hide\n");
    context.deps.db.update(projects).set({ sealedEnv: "SHARED=project-value" }).run();

    sealStoredVariables(context.deps);

    const record = findService(context.deps.db, "shop", "web");
    expect(openEnv(context.deps, record?.spec.sealedEnv ?? "")).toBe("API_TOKEN=value-to-hide\n");
    expect(JSON.stringify(rawRow()?.spec)).not.toContain("value-to-hide");
    const project = context.deps.db.select().from(projects).get();
    expect(project?.sealedEnv).toMatch(/^v1\./);
    expect(openEnv(context.deps, project?.sealedEnv ?? "")).toBe("SHARED=project-value");

    const sealedOnce = rawRow()?.spec;
    const projectOnce = project?.sealedEnv;
    sealStoredVariables(context.deps);
    expect(rawRow()?.spec).toEqual(sealedOnce);
    expect(context.deps.db.select().from(projects).get()?.sealedEnv).toBe(projectOnce);
  });

  it("marks a service that builds as still inheriting, and one that does not as not", async () => {
    await buildSource();
    asStoredByOldVersion("A=1\n");
    sealStoredVariables(context.deps);
    expect(findService(context.deps.db, "shop", "web")?.spec.build.inheritsRuntime).toBe(true);
    expect((await api<BuildEnvironment>(BUILD)).body.inheritsRuntime).toBe(true);

    await api(`${SERVICE}/source`, "PUT", { image: "nginx:1.28" });
    asStoredByOldVersion("A=1\n");
    sealStoredVariables(context.deps);
    expect(findService(context.deps.db, "shop", "web")?.spec.build.inheritsRuntime).toBe(false);
  });

  it("keeps a generated file in the build context, where it has always been", async () => {
    await buildSource();
    asStoredByOldVersion("A=1\n", { envFilePath: ".env" });

    sealStoredVariables(context.deps);

    const { build } = findService(context.deps.db, "shop", "web")?.spec ?? {};
    expect(build?.envFileInImage).toBe(true);
  });

  it("gives a new service the closed default whatever it comes to be built from", async () => {
    await buildSource();

    expect((await api<BuildEnvironment>(BUILD)).body.inheritsRuntime).toBe(false);
  });

  it("stops inheriting when told to, and never starts again", async () => {
    await buildSource();
    asStoredByOldVersion("A=1\n");
    sealStoredVariables(context.deps);

    const stopped = await api<BuildEnvironment>(`${BUILD}/inherited`, "DELETE");

    expect(stopped.body.inheritsRuntime).toBe(false);
    sealStoredVariables(context.deps);
    expect((await api<BuildEnvironment>(BUILD)).body.inheritsRuntime).toBe(false);
  });
});
