import type {
  DeploymentTrigger,
  GithubBranchList,
  GithubRepositoryList,
  GithubStatus,
  ServiceSource,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

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

  it("creates a push webhook that calls the trigger URL, signed with its token", async () => {
    stubGithub(expectHook);

    const enabled = await api<ServiceSource>(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });

    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ autoDeploy: true });
    const trigger = (await api<DeploymentTrigger>(`${SERVICE}/deployments/trigger`)).body.path;
    const token = trigger.split("/").at(-1);
    const sent = JSON.parse(String(requests[0]?.init.body));
    expect(sent.events).toEqual(["push"]);
    expect(sent.config).toMatchObject({
      url: `http://localhost${trigger}`,
      secret: token,
      content_type: "json",
    });
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

  it("moves the webhook when the token is rotated", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    stubGithub((url, init) =>
      url.pathname === "/repos/acme/shop/hooks/42" && init.method === "PATCH" ? json(200, {}) : json(404, {}),
    );

    const rotated = await api<DeploymentTrigger>(`${SERVICE}/deployments/trigger/rotate`, "POST");

    const sent = JSON.parse(String(requests[0]?.init.body));
    expect(sent.config.url).toContain(rotated.body.path);
    expect(sent.config.secret).toBe(rotated.body.path.split("/").at(-1));
  });

  it("keeps the old token when GitHub refuses to move the webhook", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    const before = (await api<DeploymentTrigger>(`${SERVICE}/deployments/trigger`)).body.path;
    stubGithub(() => json(403, { message: "Nope" }));

    const result = await api(`${SERVICE}/deployments/trigger/rotate`, "POST");

    expect(result.status).toBe(400);
    expect((await api<DeploymentTrigger>(`${SERVICE}/deployments/trigger`)).body.path).toBe(before);
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

  it("keeps the webhook when only the branch changes", async () => {
    stubGithub(expectHook);
    await api(`${SERVICE}/source/auto-deploy`, "PUT", { enabled: true });
    requests.length = 0;

    const saved = await api<ServiceSource>(`${SERVICE}/source`, "PUT", { ...source(), ref: "develop" });

    expect(saved.body).toMatchObject({ autoDeploy: true, ref: "develop" });
    expect(requests).toHaveLength(0);
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
