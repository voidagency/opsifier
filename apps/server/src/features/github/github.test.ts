import { createHmac } from "node:crypto";
import type {
  DeploymentTrigger,
  GithubBranchList,
  GithubOauthStart,
  GithubRepositoryList,
  GithubStatus,
  IssuedDeploymentTrigger,
  IssuedDeploymentWebhook,
  PanelUser,
  ServiceSource,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services, settings } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { upgradeDeploymentAuthority } from "../service-tabs/deployments/upgrade";

const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
const SERVICE = "/projects/shop/services/web";

let context: TestContext;
let cookie: string;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let requests: Array<{ url: URL; init: RequestInit }>;

function stubGithub(handler: Handler): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return handler(url, init);
    }),
  );
}

const acceptToken: Handler = (url) =>
  url.pathname === "/user" ? json(200, { login: "octocat" }) : json(404, { message: "Not Found" });

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

async function saveToken() {
  stubGithub(acceptToken);
  const saved = await api<GithubStatus>("/settings/github", "PUT", { token: TOKEN });
  expect(saved.status).toBe(200);
}

describe("the GitHub token", () => {
  it("starts out absent", async () => {
    expect((await api<GithubStatus>("/settings/github")).body).toEqual({
      configured: false,
      login: null,
      updatedAt: null,
      method: null,
      oauthApp: null,
    });
  });

  it("is checked with GitHub, then stored sealed and never shown", async () => {
    stubGithub(acceptToken);

    const saved = await api<GithubStatus>("/settings/github", "PUT", { token: TOKEN });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, login: "octocat" });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    expect(requests[0]?.url.pathname).toBe("/user");
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });

    const row = context.deps.db.select().from(settings).where(eq(settings.key, "github_token")).get();
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("is refused and not stored when GitHub says no", async () => {
    stubGithub(() => json(401, { message: "Bad credentials" }));

    const result = await api("/settings/github", "PUT", { token: "nonsense" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("github_token_invalid");
    expect(apiErrorOf(result).fields?.token).toBeDefined();
    expect((await api<GithubStatus>("/settings/github")).body.configured).toBe(false);
  });

  it("requires a value", async () => {
    const result = await api("/settings/github", "PUT", { token: "  " });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.token).toBe("Required");
  });

  it("reports GitHub being unreachable apart from a bad token", async () => {
    stubGithub(() => {
      throw new TypeError("network");
    });

    const result = await api("/settings/github", "PUT", { token: TOKEN });

    expect(result.status).toBe(502);
    expect(apiErrorOf(result).code).toBe("github_unreachable");
  });

  it("can be removed", async () => {
    await saveToken();

    const removed = await api<GithubStatus>("/settings/github", "DELETE");

    expect(removed.body.configured).toBe(false);
  });

  it("is used for GitHub sources, through a private file", async () => {
    await saveToken();

    const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", {
      type: "github",
      repository: "acme/shop",
      ref: "main",
      path: "/",
    });

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      type: "github",
      repository: "acme/shop",
      ref: "main",
      path: "/",
      autoDeploy: false,
    });
    const probe = (context.deps.tools as FakeTools).callsTo("git").at(-1);
    expect(probe?.args).toContain("https://github.com/acme/shop.git");
    expect(probe?.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(probe?.env)).not.toContain(TOKEN);
    expect(probe?.env.GIT_CONFIG_VALUE_1).toContain("store --file=");
  });
});

describe("connecting through an OAuth app", () => {
  const OAUTH = "/settings/github/oauth";
  const APP = { clientId: "Iv1.abc123", clientSecret: "the-client-secret" };
  const GRANTED = "gho_granted0123456789abcdefghij";
  const CALLBACK = "/api/v1/settings/github/oauth/callback";

  const grants: Handler = (url, init) => {
    if (url.pathname === "/login/oauth/access_token" && init.method === "POST") {
      return json(200, { access_token: GRANTED, scope: "repo,admin:repo_hook", token_type: "bearer" });
    }
    return acceptToken(url, init);
  };

  const saveApp = () => api<GithubStatus>(OAUTH, "PUT", APP);
  async function start(): Promise<URL> {
    const started = await api<GithubOauthStart>(`${OAUTH}/start`, "POST");
    expect(started.status).toBe(200);
    return new URL(started.body.authorizationUrl);
  }

  /** As GitHub does it: the browser arrives with no cookie and nothing but what the address says. */
  async function returnFromGithub(query: string): Promise<URL> {
    const response = await context.app.request(`${CALLBACK}?${query}`);
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "", "http://panel.test");
  }

  it("keeps the client secret on the server", async () => {
    const saved = await saveApp();

    expect(saved.status).toBe(200);
    expect(saved.body.oauthApp).toEqual({ clientId: APP.clientId });
    expect(JSON.stringify(saved.body)).not.toContain(APP.clientSecret);
    const row = context.deps.db.select().from(settings).where(eq(settings.key, "github_oauth_app")).get();
    expect(JSON.stringify(row)).not.toContain(APP.clientSecret);
  });

  it("requires an administrator's session for all of it, like every server setting", async () => {
    for (const [path, method] of [
      [OAUTH, "PUT"],
      [OAUTH, "DELETE"],
      [`${OAUTH}/start`, "POST"],
    ] as const) {
      const result = await call(context.app, `/api/v1${path}`, { method, body: APP, origin: TEST_ORIGIN });
      expect(result.status, `${method} ${path}`).toBe(401);
    }
  });

  it("refuses to start with no app, and says what is missing", async () => {
    const started = await api(`${OAUTH}/start`, "POST");

    expect(started.status).toBe(400);
    expect(apiErrorOf(started).code).toBe("github_oauth_app_missing");
  });

  it("sends the browser to GitHub with the app, the callback, the scopes and a fresh state", async () => {
    await saveApp();

    const url = await start();

    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(APP.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost${CALLBACK}`);
    expect(url.searchParams.get("scope")).toBe("repo admin:repo_hook");
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{32,}$/);
  });

  it("stores what GitHub grants, checked and sealed, and says how it got here", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);

    const back = await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);

    expect(back.pathname).toBe("/settings/server/github");
    expect(back.searchParams.get("connected")).toBe("1");
    const exchange = JSON.parse(String(requests[0]?.init.body));
    expect(exchange).toMatchObject({
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
      code: "the-code",
      redirect_uri: `http://localhost${CALLBACK}`,
    });
    expect(requests[1]?.url.pathname).toBe("/user");
    const status = await api<GithubStatus>("/settings/github");
    expect(status.body).toMatchObject({ configured: true, login: "octocat", method: "oauth" });
    const row = context.deps.db.select().from(settings).where(eq(settings.key, "github_token")).get();
    expect(JSON.stringify(row)).not.toContain(GRANTED);
  });

  it("uses a granted token exactly as it would a pasted one", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);
    await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);

    stubGithub((url2) =>
      url2.pathname === "/user/repos"
        ? json(200, [{ full_name: "acme/shop", private: true, default_branch: "main" }])
        : json(404, {}),
    );
    const repositories = await api<GithubRepositoryList>("/github/repositories");

    expect(repositories.body.items).toHaveLength(1);
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${GRANTED}` });
  });

  it("answers only for a grant it started, and only once", async () => {
    await saveApp();
    const url = await start();
    const state = url.searchParams.get("state");
    stubGithub(grants);

    const forged = await returnFromGithub("code=stolen&state=made-up-state");
    expect(forged.searchParams.get("oauthError")).toBe("invalid_state");
    expect(requests).toHaveLength(0);

    await returnFromGithub(`code=the-code&state=${state}`);
    requests.length = 0;
    const replay = await returnFromGithub(`code=the-code&state=${state}`);
    expect(replay.searchParams.get("oauthError")).toBe("invalid_state");
    expect(requests).toHaveLength(0);
  });

  it("does not accept an answer once its ten minutes are up", async () => {
    await saveApp();
    const url = await start();
    context.advance(11 * 60 * 1000);
    stubGithub(grants);

    const back = await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);

    expect(back.searchParams.get("oauthError")).toBe("invalid_state");
    expect((await api<GithubStatus>("/settings/github")).body.configured).toBe(false);
  });

  it("stops when the person refuses, and keeps nothing", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);

    const back = await returnFromGithub(`error=access_denied&state=${url.searchParams.get("state")}`);

    expect(back.searchParams.get("oauthError")).toBe("denied");
    expect((await api<GithubStatus>("/settings/github")).body.configured).toBe(false);
  });

  it("stores nothing when GitHub won't trade the code for a token", async () => {
    await saveApp();
    const url = await start();
    stubGithub(() => json(200, { error: "bad_verification_code", error_description: "Expired" }));

    const back = await returnFromGithub(`code=stale&state=${url.searchParams.get("state")}`);

    expect(back.searchParams.get("oauthError")).toBe("exchange_failed");
    expect((await api<GithubStatus>("/settings/github")).body.configured).toBe(false);
  });

  it("gives the grant back when the token is removed", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);
    await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);
    stubGithub((url2, init) =>
      url2.pathname === `/applications/${APP.clientId}/grant` && init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(404, {}),
    );

    const removed = await api<GithubStatus>("/settings/github", "DELETE");

    expect(removed.body.configured).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString("base64")}`,
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ access_token: GRANTED });
  });

  it("forgets the token even when GitHub can't be told", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);
    await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);
    stubGithub(() => {
      throw new TypeError("network");
    });

    const removed = await api<GithubStatus>("/settings/github", "DELETE");

    expect(removed.body.configured).toBe(false);
  });

  it("leaves a pasted token out of any of that", async () => {
    await saveToken();
    await saveApp();
    stubGithub(() => new Response(null, { status: 204 }));

    await api("/settings/github", "DELETE");

    expect(requests).toHaveLength(0);
  });

  it("can have its app replaced or removed, and removing it keeps a token already granted", async () => {
    await saveApp();
    const url = await start();
    stubGithub(grants);
    await returnFromGithub(`code=the-code&state=${url.searchParams.get("state")}`);

    const removed = await api<GithubStatus>(OAUTH, "DELETE");

    expect(removed.body).toMatchObject({ configured: true, oauthApp: null });
    const retried = await api(`${OAUTH}/start`, "POST");
    expect(retried.status).toBe(400);
  });

  it("requires a client ID and a secret", async () => {
    const result = await api(OAUTH, "PUT", { clientId: "", clientSecret: " " });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toMatchObject({ clientId: "Required", clientSecret: "Required" });
  });
});

describe("searching GitHub", () => {
  it("lists repositories matching the search", async () => {
    await saveToken();
    stubGithub((url) =>
      url.pathname === "/user/repos"
        ? json(200, [
            { full_name: "acme/shop", private: true, default_branch: "main" },
            { full_name: "acme/blog", private: false, default_branch: "trunk" },
          ])
        : json(404, {}),
    );

    const found = await api<GithubRepositoryList>("/github/repositories?q=sho");

    expect(found.body.items).toEqual([{ fullName: "acme/shop", private: true, defaultBranch: "main" }]);
  });

  it("lists branches", async () => {
    await saveToken();
    stubGithub((url) =>
      url.pathname === "/repos/acme/shop/branches"
        ? json(200, [{ name: "main" }, { name: "develop" }])
        : json(404, {}),
    );

    const found = await api<GithubBranchList>("/github/repositories/acme/shop/branches?q=dev");

    expect(found.body.items).toEqual([{ name: "develop" }]);
  });

  it("needs a token", async () => {
    const result = await api("/github/repositories");

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("github_token_missing");
  });

  it("explains a refusal from GitHub", async () => {
    await saveToken();
    stubGithub(() => json(403, { message: "Resource not accessible" }));

    const result = await api("/github/repositories");

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).message).toContain("Resource not accessible");
  });
});

describe("auto-deploy", () => {
  const source = (repository = "acme/shop") => ({ type: "github", repository, ref: "main", path: "/" });

  beforeEach(async () => {
    await saveToken();
    await api(`${SERVICE}/source`, "PUT", source());
  });

  const expectHook: Handler = (url, init) => {
    if (url.pathname === "/repos/acme/shop/hooks" && init.method === "POST") {
      return json(201, { id: 42 });
    }
    return acceptToken(url, init);
  };

  const trigger = async () => (await api<DeploymentTrigger>(`${SERVICE}/deployments/trigger`)).body;

  it("creates a push webhook with a secret of its own, which is never shown", async () => {
    stubGithub(expectHook);

    const enabled = await api<ServiceSource>(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });

    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ autoDeploy: true });
    const { webhook } = await trigger();
    const sent = JSON.parse(String(requests[0]?.init.body));
    expect(sent.events).toEqual(["push"]);
    expect(sent.config).toMatchObject({ url: `http://localhost${webhook?.path}`, content_type: "json" });
    expect(sent.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(webhook).toMatchObject({ managed: true, repository: "github.com/acme/shop", ref: "main" });
    expect(JSON.stringify(await trigger())).not.toContain(sent.config.secret);
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    expect(JSON.stringify(row?.spec)).not.toContain(sent.config.secret);
  });

  it("uses a different secret from the trigger token", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });

    const issued = await api<IssuedDeploymentTrigger>(`${SERVICE}/deployments/trigger/rotate`, "POST");

    expect(JSON.parse(String(requests[0]?.init.body)).config.secret).not.toBe(issued.body.token);
  });

  it("removes the webhook when turned off", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(404, {}),
    );

    const disabled = await api<ServiceSource>(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: false });

    expect(disabled.body).toMatchObject({ autoDeploy: false });
    expect(requests).toHaveLength(1);
  });

  it("is a no-op when already in that state", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    requests.length = 0;

    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });

    expect(requests).toHaveLength(0);
  });

  it("gives the webhook a new secret when it is rotated, and shows it to nobody", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const before = JSON.parse(String(requests[0]?.init.body)).config.secret;
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "PATCH" ? json(200, {}) : json(404, {}),
    );

    const rotated = await api<IssuedDeploymentWebhook>(`${SERVICE}/deployments/webhook/rotate`, "POST");

    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toBeNull();
    const sent = JSON.parse(String(requests[0]?.init.body));
    expect(sent.config.url).toContain(rotated.body.webhook.path);
    expect(sent.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.config.secret).not.toBe(before);
  });

  it("is not touched when only the trigger token is replaced", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    requests.length = 0;

    const issued = await api(`${SERVICE}/deployments/trigger/rotate`, "POST");

    expect(issued.status).toBe(200);
    expect(requests).toHaveLength(0);
  });

  it("keeps the old secret when GitHub refuses to rotate it", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const before = await trigger();
    stubGithub(() => json(403, { message: "Nope" }));

    const result = await api(`${SERVICE}/deployments/webhook/rotate`, "POST");

    expect(result.status).toBe(400);
    expect(await trigger()).toEqual(before);
  });

  it("removes the webhook from GitHub when asked to", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(404, {}),
    );

    const removed = await api<DeploymentTrigger>(`${SERVICE}/deployments/webhook`, "DELETE");

    expect(removed.body.webhook).toBeNull();
    expect((await api<{ source: ServiceSource }>(`${SERVICE}/source`)).body.source).toMatchObject({
      autoDeploy: false,
    });
  });

  it("carries a webhook from before they had their own secret over to a new one", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const spec = row?.spec as { build: Record<string, unknown> };
    // As it was stored by an earlier version: its webhook signed with the trigger token.
    spec.build.deployToken = { hash: "b".repeat(64), sealed: "v1.old.sealed.token" };
    spec.build.webhook = null;
    context.deps.db.update(services).set({ spec }).where(eq(services.name, "web")).run();
    upgradeDeploymentAuthority(context.deps);
    expect((await trigger()).webhook?.legacy).toBe(true);
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "PATCH" ? json(200, {}) : json(404, {}),
    );

    const issued = await api<IssuedDeploymentTrigger>(`${SERVICE}/deployments/trigger/rotate`, "POST");

    expect(issued.body.legacyUrl).toBe(false);
    const sent = JSON.parse(String(requests[0]?.init.body));
    expect(sent.config.url).toContain(issued.body.webhook?.path);
    expect(sent.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.body.webhook?.legacy).toBe(false);
  });

  it("keeps the old token when GitHub refuses to move a webhook from before they had a secret", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const spec = row?.spec as { build: Record<string, unknown> };
    spec.build.deployToken = { hash: "c".repeat(64), sealed: "v1.old.sealed.token" };
    spec.build.webhook = null;
    context.deps.db.update(services).set({ spec }).where(eq(services.name, "web")).run();
    upgradeDeploymentAuthority(context.deps);
    stubGithub(() => json(403, { message: "Nope" }));

    const result = await api(`${SERVICE}/deployments/trigger/rotate`, "POST");

    expect(result.status).toBe(400);
    const after = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const stored = after?.spec as { build: { deployToken: { hash: string } } } | undefined;
    expect(stored?.build.deployToken.hash).toBe("c".repeat(64));
  });

  it("accepts a delivery signed with its own secret, at its own address", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const { config } = JSON.parse(String(requests[0]?.init.body));
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "0123456789abcdef0123456789abcdef01234567",
      repository: { full_name: "acme/shop" },
    });
    const signature = `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
    const path = new URL(config.url).pathname;

    const push = await call<{ reason?: string }>(context.app, path, {
      method: "POST",
      headers: { "x-github-event": "push", "x-hub-signature-256": signature },
      rawBody: body,
    });
    const elsewhere = JSON.stringify({
      ref: "refs/heads/main",
      after: "0123456789abcdef0123456789abcdef01234568",
      repository: { full_name: "evil/fork" },
    });
    const wrong = await call<{ reason?: string }>(context.app, path, {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${createHmac("sha256", config.secret).update(elsewhere).digest("hex")}`,
      },
      rawBody: elsewhere,
    });

    expect(push.status).toBe(202);
    expect(wrong.body.reason).toBe("other_repository");
  });

  it("removes the webhook when the service moves to another repository", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : acceptToken(url, init),
    );

    const moved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", source("acme/blog"));

    expect(moved.body).toMatchObject({ repository: "acme/blog", autoDeploy: false });
    expect(requests.map((request) => request.init.method)).toContain("DELETE");
  });

  it("pauses the webhook until it is rotated when only the branch changes", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    requests.length = 0;

    const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", { ...source(), ref: "develop" });

    expect(saved.body).toMatchObject({ autoDeploy: true, ref: "develop" });
    expect(requests).toHaveLength(0);
    expect((await trigger()).webhook).toMatchObject({ paused: true, ref: "main" });

    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "PATCH" ? json(200, {}) : json(404, {}),
    );
    const rotated = await api<IssuedDeploymentWebhook>(`${SERVICE}/deployments/webhook/rotate`, "POST");

    expect(rotated.body.webhook).toMatchObject({ paused: false, ref: "develop" });
  });

  it("removes the webhook when the service is destroyed", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    stubGithub((_url, init) =>
      init.method === "DELETE" ? new Response(null, { status: 204 }) : json(404, {}),
    );

    const destroyed = await api<{ id: string }>(SERVICE, "DELETE", { confirm: "web" });
    for (let attempt = 0; attempt < 500 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(destroyed.status).toBe(202);
    expect(requests[0]?.url.pathname).toBe("/repos/acme/shop/hooks/42");
  });

  it("needs a GitHub source and a token", async () => {
    await api(`${SERVICE}/source`, "PUT", { image: "nginx:1.28" });
    const noSource = await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    expect(noSource.status).toBe(400);

    await api(`${SERVICE}/source`, "PUT", source());
    await api("/settings/github", "DELETE");
    const noToken = await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    expect(noToken.status).toBe(400);
    expect(apiErrorOf(noToken).code).toBe("github_token_missing");
  });

  it("reports what GitHub said when it refuses the webhook", async () => {
    stubGithub(() => json(422, { message: "url is not reachable" }));

    const result = await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).message).toContain("url is not reachable");
  });
});

describe("removing the panel's token", () => {
  it("stops it being used, and a deployment that needed it fails with the reason", async () => {
    await saveToken();
    await api(`${SERVICE}/source`, "PUT", {
      type: "github",
      repository: "acme/shop",
      ref: "main",
      path: "/",
    });
    const tools = context.deps.tools as FakeTools;
    await api("/settings/github", "DELETE");
    tools.calls.length = 0;
    tools.handler = (request) =>
      request.args.includes("fetch")
        ? {
            exitCode: 128,
            tail: ["fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
          }
        : undefined;

    const accepted = await api<{ id: string }>(`${SERVICE}/deploy`, "POST");
    let finished: { status: string; error: string | null } = { status: "queued", error: null };
    for (let attempt = 0; attempt < 400 && ["queued", "running"].includes(finished.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = (await api<typeof finished>(`/actions/${accepted.body.id}`)).body;
    }

    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("could not read Username");
    const fetch = tools.callsTo("git").find((request) => request.args.includes("fetch"));
    expect(JSON.stringify(fetch?.env)).not.toContain("store --file");
    expect(JSON.stringify(fetch?.env)).not.toContain(TOKEN);
  });
});

describe("the reach of the panel's token", () => {
  const source = (repository: string) => ({ type: "github", repository, ref: "main", path: "/" });

  async function operator(): Promise<string> {
    const created = await api<PanelUser>("/users", "POST", {
      email: "op@example.com",
      password: TEST_PASSWORD,
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
    });
    expect(created.status).toBe(201);
    const login = await authPost(context.app, "login", { email: "op@example.com", password: TEST_PASSWORD });
    return login.cookie as string;
  }

  const putAs = (member: string, path: string, body: unknown) =>
    call(context.app, `/api/v1${path}`, { method: "PUT", body, cookie: member, origin: TEST_ORIGIN });

  const lastProbe = () => (context.deps.tools as FakeTools).callsTo("git").at(-1);

  beforeEach(saveToken);

  it("is only ever presented for the path of the repository an administrator saved", async () => {
    await api(`${SERVICE}/source`, "PUT", source("acme/shop"));

    const probe = lastProbe();
    expect(probe?.env.GIT_CONFIG_KEY_2).toBe("credential.useHttpPath");
    expect(probe?.env.GIT_CONFIG_VALUE_2).toBe("true");
    const file = /--file='([^']+)'/.exec(probe?.env.GIT_CONFIG_VALUE_1 ?? "")?.[1];
    expect(file).toBeDefined();
  });

  it("follows a source an operator moves to another repository no further", async () => {
    await api(`${SERVICE}/source`, "PUT", source("acme/shop"));
    const member = await operator();

    const moved = await putAs(member, `${SERVICE}/source`, source("acme/other"));

    expect(moved.status).toBe(200);
    expect(lastProbe()?.env.GIT_CONFIG_COUNT).toBe("2");
    expect(JSON.stringify(lastProbe()?.env)).not.toContain("store --file");
  });

  it("is kept when an operator only edits the branch of a repository already granted", async () => {
    await api(`${SERVICE}/source`, "PUT", source("acme/shop"));
    const member = await operator();

    await putAs(member, `${SERVICE}/source`, { ...source("acme/shop"), ref: "develop" });

    expect(lastProbe()?.env.GIT_CONFIG_VALUE_1).toContain("store --file=");
  });

  it("is granted to a repository when an administrator saves it", async () => {
    const member = await operator();
    await putAs(member, `${SERVICE}/source`, source("acme/shop"));
    expect(lastProbe()?.env.GIT_CONFIG_COUNT).toBe("2");

    await api(`${SERVICE}/source`, "PUT", source("acme/shop"));

    expect(lastProbe()?.env.GIT_CONFIG_VALUE_1).toContain("store --file=");
  });

  it("can't reach webhooks for a repository it was not granted", async () => {
    const member = await operator();
    await putAs(member, `${SERVICE}/source`, source("acme/shop"));

    const enabled = await putAs(member, `${SERVICE}/source/auto-deploy`, { enabled: true });

    expect(enabled.status).toBe(403);
    expect(apiErrorOf(enabled).code).toBe("github_token_not_granted");
  });

  it("stays granted to what a service used before grants existed", async () => {
    await api(`${SERVICE}/source`, "PUT", source("acme/shop"));
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const spec = row?.spec as { source: Record<string, unknown> };
    spec.source.tokenRepository = undefined;
    context.deps.db.update(services).set({ spec }).where(eq(services.name, "web")).run();

    upgradeDeploymentAuthority(context.deps);

    const after = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    expect(
      (after?.spec as { source?: { tokenRepository?: string } } | undefined)?.source?.tokenRepository,
    ).toBe("acme/shop");
  });
});
