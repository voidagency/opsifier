import type {
  CreatedApiKey,
  CreatedInvitations,
  SessionState,
  TwoFactorPolicyState,
} from "@opsifier/contract";
import { actionsTopic } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../core/db/schema";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  enableTwoFactor,
  enrollTwoFactor,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
  totpAt,
} from "../../testing/harness";
import { createTopicGuard } from "../access/guard";

const POLICY = "/api/v1/settings/two-factor";

let context: TestContext;
let owner: string;

beforeEach(async () => {
  context = await createTestContext();
  owner = await setupAdmin(context.app);
  expect((await api("POST", "/api/v1/projects", owner, { name: "shop" })).status).toBe(201);
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(method: string, path: string, cookie: string | undefined, body?: unknown) {
  return call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });
}

const withKey = (path: string, token: string) =>
  call(context.app, path, { headers: { authorization: `Bearer ${token}` } });

/** The owner turns on their own two-factor sign-in, then requires it of everyone. */
async function requireIt(): Promise<string> {
  const secret = await enableTwoFactor(context, owner);
  const saved = await api<TwoFactorPolicyState>("PUT", POLICY, owner, { required: true });
  expect(saved.status).toBe(200);
  expect(saved.body.required).toBe(true);
  return secret;
}

const userId = (email: string) =>
  context.deps.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()?.id ?? "";

describe("requiring two-factor sign-in", () => {
  it("is the owner's to set, and only once their own account uses it", async () => {
    const created = await api("POST", "/api/v1/users", owner, {
      email: "second@example.com",
      password: TEST_PASSWORD,
      role: "admin",
    });
    expect(created.status).toBe(201);
    const login = await authPost(context.app, "login", {
      email: "second@example.com",
      password: TEST_PASSWORD,
    });
    const otherAdmin = login.cookie as string;

    const before = await api<TwoFactorPolicyState>("GET", POLICY, owner);
    expect(before.body).toEqual({ required: false, accountsWithout: 2, canChange: true });
    expect((await api<TwoFactorPolicyState>("GET", POLICY, otherAdmin)).body.canChange).toBe(false);
    expect(apiErrorOf(await api("PUT", POLICY, otherAdmin, { required: true })).code).toBe("owner_required");
    expect(apiErrorOf(await api("PUT", POLICY, owner, { required: true })).code).toBe("two_factor_first");

    await requireIt();
    expect((await api<TwoFactorPolicyState>("GET", POLICY, owner)).body).toEqual({
      required: true,
      accountsWithout: 1,
      canChange: true,
    });
  });

  it("keeps an account without it to turning it on, from a browser or with a key", async () => {
    const member = await signInMember(context.app, owner, "member@example.com", [
      { project: "shop", role: "viewer" },
    ]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", member, { name: "ci" });
    expect(key.status).toBe(201);
    await requireIt();

    const refused = await api("GET", "/api/v1/projects", member);
    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("two_factor_setup_required");
    expect(apiErrorOf(await withKey("/api/v1/projects", key.body.token)).code).toBe(
      "two_factor_setup_required",
    );
    expect(apiErrorOf(await withKey("/api/v1/auth/identity", key.body.token)).code).toBe(
      "two_factor_setup_required",
    );
    expect((await api<SessionState>("GET", "/api/v1/auth/session", member)).body).toMatchObject({
      status: "signed-in",
      twoFactorSetupRequired: true,
    });
    const login = await authPost<SessionState>(context.app, "login", {
      email: "member@example.com",
      password: TEST_PASSWORD,
    });
    expect(login.body).toMatchObject({ status: "signed-in", twoFactorSetupRequired: true });

    // Turning it on is the one thing left open, and then everything else is again.
    await enrollTwoFactor(context, member);
    expect((await api("GET", "/api/v1/projects", member)).status).toBe(200);
    expect((await withKey("/api/v1/projects", key.body.token)).status).toBe(200);
    expect((await api<SessionState>("GET", "/api/v1/auth/session", member)).body).toMatchObject({
      twoFactorSetupRequired: false,
    });
  });

  it("won't let anyone turn theirs off while it is required, and lifting it gives access back", async () => {
    const member = await signInMember(context.app, owner, "member@example.com", []);
    const secret = await requireIt();
    expect((await api("GET", "/api/v1/projects", member)).status).toBe(403);

    const disable = await authPost(
      context.app,
      "two-factor/disable",
      { currentPassword: TEST_PASSWORD, code: totpAt(secret, context.deps.now()) },
      owner,
    );
    expect(apiErrorOf(disable).code).toBe("two_factor_required_by_policy");

    expect((await api<TwoFactorPolicyState>("PUT", POLICY, owner, { required: false })).body.required).toBe(
      false,
    );
    expect((await api("GET", "/api/v1/projects", member)).status).toBe(200);
  });

  it("starts an invited person out kept to it", async () => {
    await requireIt();
    const invited = await api<CreatedInvitations>("POST", "/api/v1/users/invitations", owner, {
      emails: ["new@example.com"],
    });
    const token = invited.body.results[0]?.link?.split("#")[1] ?? "";

    const accepted = await authPost<SessionState>(context.app, "invitation/accept", {
      token,
      name: "New Person",
      password: "a fine long password",
    });
    expect(accepted.body).toMatchObject({ status: "signed-in", twoFactorSetupRequired: true });
    expect((await api("GET", "/api/v1/projects", accepted.cookie)).status).toBe(403);
  });

  it("listens to nothing over the WebSocket until it has it", async () => {
    await signInMember(context.app, owner, "member@example.com", [{ project: "shop", role: "operator" }]);
    const guard = createTopicGuard(context.deps);
    const member = userId("member@example.com");
    expect(guard.allow(member, actionsTopic)).toBe(true);

    await requireIt();
    expect(guard.allow(member, actionsTopic)).toBe(false);
    expect(guard.deliver?.(member, actionsTopic, { projectName: "shop", actorEmail: null })).toBe(false);
    expect(guard.allow(userId("admin@example.com"), actionsTopic)).toBe(true);
  });
});
