import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActionEntry,
  CreatedApiKey,
  DeploymentTrigger,
  IssuedDeploymentTrigger,
  IssuedDeploymentWebhook,
  ServiceSource,
  SourceSettings,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services, webhookDeliveries } from "../../../core/db/schema";
import { FAKE_GIT_SHA, type FakeTools } from "../../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_EMAIL,
  TEST_ORIGIN,
  type TestContext,
} from "../../../testing/harness";
import { upgradeDeploymentAuthority } from "./upgrade";

const SERVICE = "/projects/shop/services/web";
const SOURCE = `${SERVICE}/source`;
const TRIGGER = `${SERVICE}/deployments/trigger`;
const WEBHOOK = `${SERVICE}/deployments/webhook`;
const DEPLOY = "/api/v1/deploy";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
  await api(SOURCE, "PUT", { image: "nginx:1.28" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

const issue = async (service = SERVICE) =>
  (await api<IssuedDeploymentTrigger>(`${service}/deployments/trigger/rotate`, "POST")).body;
const issueWebhook = async () => (await api<IssuedDeploymentWebhook>(`${WEBHOOK}/rotate`, "POST")).body;
const status = async () => (await api<DeploymentTrigger>(TRIGGER)).body;
const anonymous = <T = unknown>(path: string, options: Parameters<typeof call>[2] = {}) =>
  call<T>(context.app, path, options);
const deployments = async () => (await api<{ items: ActionEntry[] }>(`${SERVICE}/deployments`)).body.items;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const trigger = <T = ActionEntry>(token: string, query = "") =>
  anonymous<T>(`${DEPLOY}${query}`, { method: "POST", headers: bearer(token) });
const rawSpec = (name = "web") =>
  JSON.stringify(context.deps.db.select().from(services).where(eq(services.name, name)).get()?.spec);

async function waitIdle(): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const items = await deployments();
    if (items.every((item) => item.status !== "queued" && item.status !== "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Deployments did not settle");
}

describe("the deployment token", () => {
  it("does not exist until someone asks for one, and reading the status makes none", async () => {
    const first = await status();

    expect(first).toEqual({
      path: "/api/v1/deploy",
      hasToken: false,
      legacyUrl: false,
      createdAt: null,
      webhook: null,
      webhookAvailable: false,
    });
    expect(JSON.parse(rawSpec()).build.deployToken).toBeNull();
  });

  it("is shown once, when it is made, and never again", async () => {
    const issued = await issue();

    expect(issued.token).toMatch(/^[0-9a-f]{48}$/);
    expect(issued.hasToken).toBe(true);
    expect(JSON.stringify(await status())).not.toContain(issued.token);
    expect(JSON.stringify((await api(SERVICE)).body)).not.toContain(issued.token);
    expect(JSON.stringify((await api(SOURCE)).body)).not.toContain(issued.token);
  });

  it("stays out of the database in any readable form", async () => {
    const { token } = await issue();

    expect(rawSpec()).not.toContain(token);
    expect(JSON.parse(rawSpec()).build.deployToken).not.toHaveProperty("sealed");
  });

  it("takes a session to read or replace, as an API key may not", async () => {
    const key = (await api<CreatedApiKey>("/me/api-keys", "POST", { name: "ci", level: "write" })).body.token;
    const withKey = { method: "POST", headers: bearer(key) };

    expect((await anonymous(`/api/v1${TRIGGER}`)).status).toBe(401);
    expect((await anonymous(`/api/v1${TRIGGER}`, { headers: bearer(key) })).status).toBe(403);
    expect((await anonymous(`/api/v1${TRIGGER}/rotate`, withKey)).status).toBe(403);
    expect((await anonymous(`/api/v1${WEBHOOK}/rotate`, withKey)).status).toBe(403);
  });

  it("starts a deployment when sent as a bearer token", async () => {
    const { token } = await issue();

    const posted = await trigger(token);

    expect(posted.status).toBe(202);
    expect(posted.body.type).toBe("service.deploy");
    await waitIdle();
    expect(await deployments()).toHaveLength(1);
  });

  it("does not work in the URL, where it would be written to every log along the way", async () => {
    const { token } = await issue();

    expect((await anonymous(`${DEPLOY}/${token}`, { method: "POST" })).status).toBe(404);
    expect((await anonymous(`${DEPLOY}/${token}`)).status).toBe(404);
    expect(await deployments()).toHaveLength(0);
  });

  it("refuses a missing or wrong token, and no anonymous call deploys", async () => {
    await issue();

    expect(apiErrorOf(await anonymous(DEPLOY, { method: "POST" })).code).toBe("invalid_token");
    expect((await trigger("0".repeat(48))).status).toBe(401);
    expect(await deployments()).toHaveLength(0);
  });

  it("deploys only the service it was issued for", async () => {
    await api("/projects/shop/services", "POST", { name: "other" });
    await api("/projects/shop/services/other/source", "PUT", { image: "nginx:1.28" });
    const token = (await issue("/projects/shop/services/other")).token;

    const posted = await trigger(token);

    expect(posted.body.serviceName).toBe("other");
    expect(await deployments()).toHaveLength(0);
  });

  it("is not an API key: the bearer value of a trigger opens no other route", async () => {
    const { token } = await issue();

    const refused = await anonymous("/api/v1/projects", { headers: bearer(token) });

    expect(refused.status).toBe(401);
    expect(apiErrorOf(refused).code).toBe("invalid_token");
  });

  it("queues a call made during a deployment, so that it is never lost", async () => {
    const { token } = await issue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = context.deps.actions.enqueue({
      type: "service.deploy",
      title: "Deploy shop/web",
      projectName: "shop",
      serviceName: "web",
      run: () => gate,
    });

    const first = await trigger(token);
    const second = await trigger(token);

    expect(first.status).toBe(202);
    expect(first.body.status).toBe("queued");
    expect(first.body.id).not.toBe(running.id);
    expect(second.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);

    release();
    await waitIdle();
    expect((await deployments()).map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("keeps a forced rebuild when it joins a deployment that is already waiting", async () => {
    const tools = context.deps.tools as FakeTools;
    await api(SOURCE, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });
    const { token } = await issue();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.deps.actions.enqueue({
      type: "backup",
      title: "Back up shop/web",
      projectName: "shop",
      serviceName: "web",
      run: () => gate,
    });

    await trigger(token);
    await trigger(token, "?forceRebuild");
    await trigger(token);

    release();
    await waitIdle();
    expect(await deployments()).toHaveLength(1);
    expect(tools.callsTo("docker").at(-1)?.args).toContain("--no-cache");
  });

  it("stops working the moment it is replaced", async () => {
    const before = await issue();

    const after = await issue();

    expect(after.token).not.toBe(before.token);
    expect((await trigger(before.token)).status).toBe(401);
    expect((await trigger(after.token)).status).toBe(202);
  });

  it("stops working the moment it is revoked", async () => {
    const { token } = await issue();

    const revoked = await api<DeploymentTrigger>(TRIGGER, "DELETE");

    expect(revoked.body.hasToken).toBe(false);
    expect((await trigger(token)).status).toBe(401);
    expect(await deployments()).toHaveLength(0);
  });

  it("refuses to deploy a service without a source", async () => {
    await api("/projects/shop/services", "POST", { name: "empty" });
    const { token } = await issue("/projects/shop/services/empty");

    expect((await trigger(token)).status).toBe(409);
  });

  it("rebuilds without the cache when asked", async () => {
    const tools = context.deps.tools as FakeTools;
    await api(SOURCE, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });
    const { token } = await issue();

    await trigger(token, "?forceRebuild");
    await waitIdle();
    expect(tools.callsTo("docker").at(-1)?.args).toContain("--no-cache");

    await trigger(token);
    await waitIdle();
    expect(tools.callsTo("docker").at(-1)?.args).not.toContain("--no-cache");
  });

  it("records the deployment as started by a trigger, on behalf of whoever issued it", async () => {
    const { token } = await issue();

    await trigger(token);
    await waitIdle();

    expect(await deployments()).toMatchObject([{ origin: "trigger", actorEmail: TEST_EMAIL }]);
  });
});

describe("what a change of source does", () => {
  const GIT = { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" };

  it("revokes the token when the repository changes, so that old access fails", async () => {
    await api(SOURCE, "PUT", GIT);
    const { token } = await issue();

    await api(SOURCE, "PUT", { ...GIT, url: "https://git.example.com/acme/other.git" });

    expect((await trigger(token)).status).toBe(401);
    expect((await status()).hasToken).toBe(false);
    expect(await deployments()).toHaveLength(0);
  });

  it("revokes the token when the branch changes", async () => {
    await api(SOURCE, "PUT", GIT);
    const { token } = await issue();

    await api(SOURCE, "PUT", { ...GIT, ref: "release" });

    expect((await trigger(token)).status).toBe(401);
  });

  it("leaves the token alone when the same image moves to another tag", async () => {
    const { token } = await issue();

    await api(SOURCE, "PUT", { image: "nginx:1.29" });

    expect((await trigger(token)).status).toBe(202);
  });

  it("revokes the token when the image moves to another repository", async () => {
    const { token } = await issue();

    await api(SOURCE, "PUT", { image: "ghcr.io/acme/app:1" });

    expect((await trigger(token)).status).toBe(401);
  });

  it("is noted in the activity log", async () => {
    await api(SOURCE, "PUT", GIT);
    await issue();

    await api(SOURCE, "PUT", { ...GIT, ref: "release" });

    const { items } = (await api<{ items: ActionEntry[] }>("/actions?type=service.trigger")).body;
    expect(items[0]?.title).toContain("its source changed");
  });
});

describe("a push webhook", () => {
  const REPOSITORY = "https://git.example.com/acme/shop.git";
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  const sign = (body: string, secret: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  const pushBody = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      ref: "refs/heads/main",
      after: COMMIT,
      repository: { clone_url: REPOSITORY },
      sender: { login: "octocat" },
      ...overrides,
    });

  let delivery = 0;

  /** Sends one delivery, with a fresh id unless a test is interested in it. */
  const deliver = (
    path: string,
    event: string,
    body: string,
    signature: string | undefined,
    options: { id?: string; contentType?: string } = {},
  ) => {
    delivery += 1;
    return anonymous<{ deployed?: boolean; reason?: string; actionId?: string; id?: string }>(path, {
      method: "POST",
      headers: {
        "x-github-event": event,
        "x-github-delivery": options.id ?? `delivery-${delivery}`,
        "content-type": options.contentType ?? "application/json",
        ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
      },
      rawBody: body,
    });
  };

  beforeEach(async () => {
    await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "main", path: "/" });
  });

  it("has its own secret, which is not the trigger token and is stored sealed", async () => {
    const { token } = await issue();
    const { secret, webhook } = await issueWebhook();

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(token);
    expect(rawSpec()).not.toContain(secret);
    expect(webhook.path).toMatch(/^\/api\/v1\/deploy\/hook\/[0-9a-f]{32}$/);
    expect(webhook).toMatchObject({ repository: "git.example.com/acme/shop", ref: "main", paused: false });
    // The id in the URL is not the credential.
    expect(webhook.path).not.toContain(secret);
  });

  it("is shown once: the secret is in no later answer", async () => {
    const { secret } = await issueWebhook();

    expect(JSON.stringify(await status())).not.toContain(secret);
  });

  it("needs a repository to watch", async () => {
    await api(SOURCE, "PUT", { image: "nginx:1.28" });

    const result = await api(`${WEBHOOK}/rotate`, "POST");

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("webhook_needs_git_source");
  });

  it("deploys a signed push to the registered repository and branch, at the commit it announced", async () => {
    const { secret, webhook } = await issueWebhook();
    const body = pushBody();
    const tools = context.deps.tools as FakeTools;

    const result = await deliver(webhook.path, "push", body, sign(body, secret as string));

    expect(result.status).toBe(202);
    await waitIdle();
    const fetched = tools.callsTo("git").find((request) => request.args.includes("fetch"));
    expect(fetched?.args.at(-1)).toBe(COMMIT);
    const [recorded] = await deployments();
    expect(recorded).toMatchObject({ origin: "webhook", status: "succeeded" });
    expect(recorded?.originDetail).toContain("Push to main at 0123456789ab");
    expect(recorded?.originDetail).toContain("octocat");
  });

  it("refuses a delivery that is not signed, whatever else it says", async () => {
    const { webhook } = await issueWebhook();

    const result = await deliver(webhook.path, "push", pushBody(), undefined);

    expect(result.status).toBe(401);
    expect(apiErrorOf(result).code).toBe("invalid_signature");
    expect(await deployments()).toHaveLength(0);
  });

  it("refuses a delivery signed with the wrong secret, or whose body was altered", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody();

    expect((await deliver(webhook.path, "push", body, sign(body, "wrong-secret"))).status).toBe(401);
    expect((await deliver(webhook.path, "push", `${body} `, sign(body, secret as string))).status).toBe(401);
    expect(await deployments()).toHaveLength(0);
  });

  it("checks the signature over the original bytes", async () => {
    const { webhook, secret } = await issueWebhook();
    // Same JSON, different bytes: this is what would break a check made on the parsed body.
    const body = `{"ref":"refs/heads/main",  "after":"${COMMIT}","repository":{"clone_url":"${REPOSITORY}"}}`;

    expect((await deliver(webhook.path, "push", body, sign(body, secret as string))).status).toBe(202);
  });

  it("does not exist for an unknown id", async () => {
    await issueWebhook();

    expect((await deliver("/api/v1/deploy/hook/not-a-webhook", "push", "{}", undefined)).status).toBe(404);
  });

  it.each([
    ["another repository", { repository: { clone_url: "https://git.example.com/evil/other.git" } }],
    ["a repository it can't read", { repository: "nope" }],
    ["no repository at all", { repository: undefined }],
  ])("ignores a push naming %s", async (_name, overrides) => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody(overrides);

    const result = await deliver(webhook.path, "push", body, sign(body, secret as string));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ deployed: false, reason: "other_repository" });
    expect(await deployments()).toHaveLength(0);
  });

  it("recognises the repository whichever form its address is sent in", async () => {
    await api(SOURCE, "PUT", {
      type: "git",
      url: "ssh://git@git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
    const { webhook, secret } = await issueWebhook();
    const body = pushBody({ repository: { ssh_url: "git@git.example.com:ACME/shop.git" } });

    expect((await deliver(webhook.path, "push", body, sign(body, secret as string))).status).toBe(202);
  });

  it("ignores a push to another branch", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody({ ref: "refs/heads/feature" });

    const result = await deliver(webhook.path, "push", body, sign(body, secret as string));

    expect(result.body).toEqual({ deployed: false, reason: "other_branch" });
    expect(await deployments()).toHaveLength(0);
  });

  it("deploys a push to a configured tag", async () => {
    await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "v1.2", path: "/" });
    const { webhook, secret } = await issueWebhook();
    const body = pushBody({ ref: "refs/tags/v1.2" });

    expect((await deliver(webhook.path, "push", body, sign(body, secret as string))).status).toBe(202);
  });

  it("ignores a ping and a deleted branch, signed or not as they may be", async () => {
    const { webhook, secret } = await issueWebhook();
    const deleted = pushBody({ deleted: true, after: "0".repeat(40) });

    expect((await deliver(webhook.path, "ping", "{}", sign("{}", secret as string))).body).toEqual({
      deployed: false,
      reason: "not_a_push",
    });
    expect((await deliver(webhook.path, "push", deleted, sign(deleted, secret as string))).body).toEqual({
      deployed: false,
      reason: "branch_deleted",
    });
    expect((await deliver(webhook.path, "ping", "{}", undefined)).status).toBe(401);
    expect(await deployments()).toHaveLength(0);
  });

  it("refuses a push it cannot read instead of building something else", async () => {
    const { webhook, secret } = await issueWebhook();
    const noCommit = pushBody({ after: undefined });
    const shortCommit = pushBody({ after: "abc123" });

    for (const body of ["not json", noCommit, shortCommit]) {
      const result = await deliver(webhook.path, "push", body, sign(body, secret as string));
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).code).toBe("invalid_delivery");
    }
    expect(await deployments()).toHaveLength(0);
  });

  it("reads the form encoding GitHub offers as an alternative", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = `payload=${encodeURIComponent(pushBody())}`;

    const result = await deliver(webhook.path, "push", body, sign(body, secret as string), {
      contentType: "application/x-www-form-urlencoded",
    });

    expect(result.status).toBe(202);
  });

  it("creates no second deployment for a delivery it has already taken", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody();
    const signature = sign(body, secret as string);

    const first = await deliver(webhook.path, "push", body, signature, { id: "abc" });
    await waitIdle();
    const second = await deliver(webhook.path, "push", body, signature, { id: "abc" });
    await waitIdle();

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ deployed: false, reason: "duplicate", actionId: first.body.id });
    expect(await deployments()).toHaveLength(1);
  });

  it("recognises a delivery replayed under a new id, since the id is not signed", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody();
    const signature = sign(body, secret as string);

    await deliver(webhook.path, "push", body, signature, { id: "first" });
    await waitIdle();
    const replay = await deliver(webhook.path, "push", body, signature, { id: "second" });

    expect(replay.body).toMatchObject({ deployed: false, reason: "duplicate" });
    expect(await deployments()).toHaveLength(1);
  });

  it("still recognises an old delivery after the webhook's secret is rotated", async () => {
    const first = await issueWebhook();
    const body = pushBody();
    await deliver(first.webhook.path, "push", body, sign(body, first.secret as string), { id: "abc" });
    await waitIdle();

    const rotated = await issueWebhook();
    const replay = await deliver(rotated.webhook.path, "push", body, sign(body, rotated.secret as string), {
      id: "abc",
    });

    expect(rotated.webhook.path).toBe(first.webhook.path);
    expect(replay.body).toMatchObject({ deployed: false, reason: "duplicate" });
    expect(await deployments()).toHaveLength(1);
  });

  it("does not let a refused delivery use up its one chance", async () => {
    const { webhook, secret } = await issueWebhook();
    const body = pushBody();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.deps.actions.enqueue({
      type: "service.destroy",
      title: "Destroy shop/web",
      projectName: "shop",
      serviceName: "web",
      run: () => gate,
    });
    const refused = await deliver(webhook.path, "push", body, sign(body, secret as string), { id: "abc" });
    release();
    for (let attempt = 0; attempt < 1000 && !context.deps.actions.isIdle(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const retried = await deliver(webhook.path, "push", body, sign(body, secret as string), { id: "abc" });

    expect(refused.status).toBe(409);
    expect(retried.status).toBe(202);
  });

  it("remembers what it has taken across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opsifier-restart-"));
    try {
      await context.close();
      context = await createTestContext({ env: { OPSIFIER_DATA_DIR: dir } });
      cookie = await setupAdmin(context.app);
      await api("/projects", "POST", { name: "shop" });
      await api("/projects/shop/services", "POST", { name: "web" });
      await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "main", path: "/" });
      const { webhook, secret } = await issueWebhook();
      const body = pushBody();
      const signature = sign(body, secret as string);
      await deliver(webhook.path, "push", body, signature, { id: "abc" });
      await waitIdle();
      await context.close();

      context = await createTestContext({ env: { OPSIFIER_DATA_DIR: dir } });

      const replay = await deliver(webhook.path, "push", body, signature, { id: "abc" });

      expect(replay.body).toMatchObject({ deployed: false, reason: "duplicate" });
      expect(context.deps.db.select().from(webhookDeliveries).all()).toHaveLength(1);
    } finally {
      await context.close();
      context = await createTestContext();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is limited to the size GitHub can send", async () => {
    const { webhook } = await issueWebhook();

    const result = await anonymous(webhook.path, {
      method: "POST",
      headers: { "x-github-event": "push", "content-length": String(27 * 1024 * 1024) },
      rawBody: "x",
    });

    expect(result.status).toBe(413);
  });

  it("makes the old secret fail once it is rotated", async () => {
    const before = await issueWebhook();
    const after = await issueWebhook();
    const body = pushBody();

    const stale = await deliver(before.webhook.path, "push", body, sign(body, before.secret as string));

    expect(stale.status).toBe(401);
    expect(await deployments()).toHaveLength(0);
    expect((await deliver(after.webhook.path, "push", body, sign(body, after.secret as string))).status).toBe(
      202,
    );
  });

  it("refuses deliveries once removed", async () => {
    const { webhook, secret } = await issueWebhook();

    await api(WEBHOOK, "DELETE");

    const body = pushBody();
    expect((await deliver(webhook.path, "push", body, sign(body, secret as string))).status).toBe(404);
  });

  describe("after the repository or branch changes", () => {
    it.each([
      ["branch", { ref: "release" }],
      ["repository", { url: "https://git.example.com/acme/other.git" }],
    ])("is paused until rotation when the %s changes", async (_name, change) => {
      const { webhook, secret } = await issueWebhook();
      await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "main", path: "/", ...change });
      const body = pushBody({
        ref: "refs/heads/release",
        repository: { clone_url: "https://git.example.com/acme/other.git" },
      });

      const refused = await deliver(webhook.path, "push", body, sign(body, secret as string));

      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("webhook_paused");
      expect((await status()).webhook?.paused).toBe(true);
      expect(await deployments()).toHaveLength(0);
    });

    it("is usable again after rotation, for the new repository and branch only", async () => {
      await issueWebhook();
      await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "release", path: "/" });

      const rotated = await issueWebhook();

      expect(rotated.webhook).toMatchObject({ paused: false, ref: "release" });
      const body = pushBody({ ref: "refs/heads/release" });
      expect(
        (await deliver(rotated.webhook.path, "push", body, sign(body, rotated.secret as string))).status,
      ).toBe(202);
      const old = pushBody({ after: "1111111111111111111111111111111111111111" });
      expect(
        (await deliver(rotated.webhook.path, "push", old, sign(old, rotated.secret as string))).body,
      ).toEqual({
        deployed: false,
        reason: "other_branch",
      });
    });

    it("still has to be signed while it is paused", async () => {
      const { webhook } = await issueWebhook();
      await api(SOURCE, "PUT", { image: "nginx:1.28" });
      const body = pushBody();

      const result = await deliver(webhook.path, "push", body, sign(body, "guess"));

      expect(result.status).toBe(401);
    });
  });

  describe("on a Compose stack", () => {
    const STACK = "/projects/shop/services/stack";

    it("deploys a push only to the stack's repository and branch", async () => {
      await api("/projects/shop/compose", "POST", { name: "stack" });
      const saved = await api(`${STACK}/compose/source`, "PUT", {
        type: "git",
        url: "https://git.example.com/acme/stack.git",
        ref: "main",
        path: "/",
        file: "compose.yaml",
      });
      expect(saved.status).toBe(200);
      const { webhook, secret } = (
        await api<IssuedDeploymentWebhook>(`${STACK}/deployments/webhook/rotate`, "POST")
      ).body;
      const push = (ref: string) =>
        JSON.stringify({
          ref,
          after: COMMIT,
          repository: { clone_url: "https://git.example.com/acme/stack.git" },
        });

      const other = await deliver(
        webhook.path,
        "push",
        push("refs/heads/dev"),
        sign(push("refs/heads/dev"), secret as string),
      );
      const main = await deliver(
        webhook.path,
        "push",
        push("refs/heads/main"),
        sign(push("refs/heads/main"), secret as string),
      );

      expect(other.body).toEqual({ deployed: false, reason: "other_branch" });
      expect(main.status).toBe(202);
      expect(main.body).toMatchObject({ type: "service.deploy", serviceName: "stack" });
    });
  });
});

describe("the commit a deployment builds", () => {
  it("is the one the latest request announced, when several wait together", async () => {
    await api(SOURCE, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
    const { webhook, secret } = (await api<IssuedDeploymentWebhook>(`${WEBHOOK}/rotate`, "POST")).body;
    const push = (after: string) =>
      JSON.stringify({
        ref: "refs/heads/main",
        after,
        repository: { clone_url: "https://git.example.com/acme/shop.git" },
      });
    const send = (after: string, id: string) =>
      anonymous<ActionEntry>(webhook.path, {
        method: "POST",
        headers: {
          "x-github-event": "push",
          "x-github-delivery": id,
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret as string)
            .update(push(after))
            .digest("hex")}`,
        },
        rawBody: push(after),
      });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.deps.actions.enqueue({
      type: "backup",
      title: "Back up shop/web",
      projectName: "shop",
      serviceName: "web",
      run: () => gate,
    });
    const tools = context.deps.tools as FakeTools;

    const first = await send("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "one");
    const second = await send("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "two");
    release();
    await waitIdle();

    expect(second.body.id).toBe(first.body.id);
    const fetched = tools.callsTo("git").filter((request) => request.args.includes("fetch"));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.args.at(-1)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("is the branch's latest for anything that names no commit", async () => {
    await api(SOURCE, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
    const { token } = (await api<IssuedDeploymentTrigger>(`${TRIGGER}/rotate`, "POST")).body;
    const tools = context.deps.tools as FakeTools;
    tools.calls.length = 0;

    await trigger(token);
    await waitIdle();

    const fetched = tools.callsTo("git").find((request) => request.args.includes("fetch"));
    expect(fetched?.args.at(-1)).toBe("main");
    expect((await deployments())[0]).toMatchObject({ status: "succeeded" });
    expect(FAKE_GIT_SHA).toHaveLength(40);
  });
});

describe("a token issued before this version", () => {
  const OLD_TOKEN = "a".repeat(48);

  const plantLegacyToken = () => {
    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    const spec = row?.spec as { build: Record<string, unknown> };
    spec.build.deployToken = {
      hash: createHash("sha256").update(OLD_TOKEN).digest("hex"),
      sealed: "v1.bogus.sealed.value",
    };
    context.deps.db.update(services).set({ spec }).where(eq(services.name, "web")).run();
    upgradeDeploymentAuthority(context.deps);
  };

  const deliverLegacy = (body: string, signature: string | undefined) =>
    anonymous<{ deployed?: boolean; reason?: string }>(`${DEPLOY}/${OLD_TOKEN}`, {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
      },
      rawBody: body,
    });

  it("loses its readable copy at boot and keeps working where its callers already have it", async () => {
    plantLegacyToken();

    expect(rawSpec()).not.toContain("sealed.value");
    expect(JSON.stringify(await status())).not.toContain(OLD_TOKEN);
    expect((await anonymous(`${DEPLOY}/${OLD_TOKEN}`, { method: "POST" })).status).toBe(202);
    await waitIdle();
    expect((await anonymous(`${DEPLOY}/${OLD_TOKEN}`)).status).toBe(202);
  });

  it("works as a bearer token too", async () => {
    plantLegacyToken();

    expect((await trigger(OLD_TOKEN)).status).toBe(202);
  });

  it("says so, until it is replaced, and then stops working in the URL", async () => {
    plantLegacyToken();
    expect((await status()).legacyUrl).toBe(true);

    const replaced = (await api<IssuedDeploymentTrigger>(`${TRIGGER}/rotate`, "POST")).body;

    expect(replaced.legacyUrl).toBe(false);
    expect((await status()).legacyUrl).toBe(false);
    expect((await anonymous(`${DEPLOY}/${OLD_TOKEN}`, { method: "POST" })).status).toBe(404);
    expect((await trigger(replaced.token)).status).toBe(202);
  });

  it("is safe to upgrade twice, and only ever acts once", async () => {
    plantLegacyToken();
    const before = rawSpec();

    upgradeDeploymentAuthority(context.deps);

    expect(rawSpec()).toBe(before);
  });

  describe("used by a hand-made webhook", () => {
    const REPOSITORY = "https://git.example.com/acme/shop.git";
    const push = (repository = REPOSITORY) =>
      JSON.stringify({
        ref: "refs/heads/main",
        after: "0123456789abcdef0123456789abcdef01234567",
        repository: { clone_url: repository },
      });
    const signed = (body: string) => `sha256=${createHmac("sha256", OLD_TOKEN).update(body).digest("hex")}`;

    beforeEach(async () => {
      await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "main", path: "/" });
      plantLegacyToken();
    });

    it("keeps being accepted, signed with the old token, at the old URL", async () => {
      expect((await deliverLegacy(push(), signed(push()))).status).toBe(202);
    });

    it("must be signed: an unsigned delivery is refused even with the token in the URL", async () => {
      const result = await deliverLegacy(push(), undefined);

      expect(result.status).toBe(401);
      expect(await deployments()).toHaveLength(0);
    });

    it("is held to the registered repository and branch like any other", async () => {
      const other = push("https://git.example.com/evil/other.git");

      expect((await deliverLegacy(other, signed(other))).body).toEqual({
        deployed: false,
        reason: "other_repository",
      });
    });

    it("is not deployed by a source change to something else, which revokes the old token", async () => {
      await api(SOURCE, "PUT", { type: "git", url: REPOSITORY, ref: "release", path: "/" });

      expect((await deliverLegacy(push(), signed(push()))).status).toBe(404);
      expect((await anonymous(`${DEPLOY}/${OLD_TOKEN}`, { method: "POST" })).status).toBe(404);
    });

    it("goes with the old token when that is replaced, to be set up afresh", async () => {
      await api(`${TRIGGER}/rotate`, "POST");

      expect((await status()).webhook).toBeNull();
    });
  });

  it("carries the service's Compose or image source through a boot unchanged", async () => {
    plantLegacyToken();

    expect((await api<SourceSettings>(SOURCE)).body.source).toMatchObject({ type: "image" });
    expect((await api<ServiceSource>(`${SOURCE}`)).status).toBe(200);
  });
});

describe("the reach of a public path", () => {
  it("does not make any other route public", async () => {
    expect((await anonymous("/api/v1/projects")).status).toBe(401);
  });

  it("keeps the source settings private", async () => {
    expect((await anonymous<SourceSettings>(`/api/v1${SERVICE}/source`)).status).toBe(401);
  });
});
