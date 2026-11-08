import { existsSync, rmSync } from "node:fs";
import {
  passwordMaxLength,
  type SessionState,
  type TwoFactorSetup,
  twoFactorRequiredCode,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApiToken,
  findTokenPrincipal,
  hashToken,
  PLAIN_HTTP_SESSION_TTL_MS,
  REMEMBERED_SESSION_TTL_MS,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../../core/auth";
import { apiTokens, recoveryCodes, sessions, users } from "../../core/db/schema";
import {
  apiErrorOf,
  authPost,
  type CallOptions,
  call,
  createTestContext,
  enableTwoFactor,
  enrollTwoFactor,
  setupAdmin,
  setupTokenOf,
  TEST_EMAIL,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
  totpAt,
} from "../../testing/harness";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const NEXT_STEP = 31_000;
const PANEL = "https://panel.example.com";
const PROXY_PEER = "10.0.0.2";

let context: TestContext;
let app: TestContext["app"];

/** A request that reached the panel over HTTPS, with TLS ending in this process. */
function overHttps<T = unknown>(path: string, options: CallOptions = {}) {
  return call<T>(app, `${PANEL}${path}`, options);
}

/** Turns a plain session cookie into the one a browser would hold after signing in over HTTPS. */
function asSecureCookie(cookie: string): string {
  return cookie.replace(`${SESSION_COOKIE}=`, `${SECURE_SESSION_COOKIE}=`);
}

async function loginOverHttps(body: Record<string, unknown> = {}) {
  return overHttps<SessionState>("/api/v1/auth/login", {
    body: { email: TEST_EMAIL, password: TEST_PASSWORD, ...body },
    origin: PANEL,
  });
}

async function login(body: Record<string, unknown>) {
  return authPost<SessionState>(app, "login", { email: TEST_EMAIL, password: TEST_PASSWORD, ...body });
}

async function sessionOf(cookie?: string) {
  return call<SessionState>(app, "/api/v1/auth/session", { cookie });
}

function allUsers() {
  return context.deps.db.select().from(users).all();
}

beforeEach(async () => {
  context = await createTestContext();
  app = context.app;
});

afterEach(async () => {
  await context.close();
});

describe("first-time setup", () => {
  it("reports needs-setup until a user exists", async () => {
    expect((await sessionOf()).body).toEqual({ status: "needs-setup" });
  });

  it("creates an admin, signs them in and stores only a hash", async () => {
    const result = await authPost<SessionState>(app, "setup", {
      token: setupTokenOf(app),
      email: "Admin@Example.COM",
      password: TEST_PASSWORD,
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      status: "signed-in",
      user: { email: "admin@example.com", role: "admin", twoFactorEnabled: false },
    });

    const [user] = allUsers();
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toContain(TEST_PASSWORD);
    expect((await sessionOf(result.cookie)).body).toMatchObject({ status: "signed-in" });
  });

  it("cannot run a second time", async () => {
    await setupAdmin(app);
    const again = await authPost(app, "setup", {
      token: "x".repeat(43),
      email: "other@example.com",
      password: "another password here",
    });

    expect(again.status).toBe(409);
    expect(apiErrorOf(again).code).toBe("already_set_up");
    expect(allUsers()).toHaveLength(1);
  });

  it("lets exactly one of several concurrent requests win", async () => {
    const token = setupTokenOf(app);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        authPost(app, "setup", { token, email: `user${index}@example.com`, password: TEST_PASSWORD }),
      ),
    );

    const statuses = attempts.map((attempt) => attempt.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(allUsers()).toHaveLength(1);
    expect(context.deps.db.select().from(sessions).all()).toHaveLength(1);
  });

  it("rejects a blank password that only meets the length rule", async () => {
    const result = await authPost(app, "setup", {
      token: setupTokenOf(app),
      email: TEST_EMAIL,
      password: " ".repeat(16),
    });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("password");
    expect(allUsers()).toHaveLength(0);
  });

  it("rejects a short password and a malformed email, per field", async () => {
    const result = await authPost(app, "setup", {
      token: setupTokenOf(app),
      email: "not-an-email",
      password: "short",
    });
    expect(result.status).toBe(400);
    expect(Object.keys(apiErrorOf(result).fields ?? {}).sort()).toEqual(["email", "password"]);
  });
});

describe("the setup token", () => {
  const account = { email: TEST_EMAIL, password: TEST_PASSWORD };
  const tokenFile = () => context.deps.config.setupTokenFile;

  it("is required", async () => {
    const result = await authPost(app, "setup", account);
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("token");
    expect(allUsers()).toHaveLength(0);
  });

  it("has to be the one this server issued", async () => {
    const result = await authPost(app, "setup", { ...account, token: "a".repeat(43) });

    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("invalid_setup_token");
    expect(apiErrorOf(result).fields).toHaveProperty("token");
    expect(allUsers()).toHaveLength(0);
    expect(existsSync(tokenFile())).toBe(true);
  });

  it("rejects a guess of any length", async () => {
    for (const token of ["x", "y".repeat(128), `${setupTokenOf(app)}a`]) {
      expect((await authPost(app, "setup", { ...account, token })).status).toBe(403);
    }
    expect((await authPost(app, "setup", { ...account, token: "z".repeat(129) })).status).toBe(400);
    expect(allUsers()).toHaveLength(0);
  });

  it("stops a DNS-rebinding page, whose Origin matches the Host it reaches", async () => {
    const result = await call(app, "/api/v1/auth/setup", {
      body: { ...account, token: "a".repeat(43) },
      origin: "http://rebound.example",
      headers: { host: "rebound.example" },
    });
    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("invalid_setup_token");
    expect(allUsers()).toHaveLength(0);
  });

  it("works once, then is gone from the disk", async () => {
    const token = setupTokenOf(app);
    const first = await authPost(app, "setup", { ...account, token: ` ${token}\n` });

    expect(first.status).toBe(201);
    expect(existsSync(tokenFile())).toBe(false);

    const second = await authPost(app, "setup", { ...account, email: "other@example.com", token });
    expect(second.status).toBe(409);
    expect(allUsers()).toHaveLength(1);
  });

  it("fails closed if the file has gone missing", async () => {
    const token = setupTokenOf(app);
    rmSync(tokenFile());
    expect((await authPost(app, "setup", { ...account, token })).status).toBe(403);
    expect(allUsers()).toHaveLength(0);
  });

  it("counts wrong guesses against the rate limit", async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { loginPerAddress: { limit: 2, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;

    for (const expected of [403, 403, 429]) {
      expect((await authPost(app, "setup", { ...account, token: "a".repeat(43) })).status).toBe(expected);
    }
  });
});

describe("input limits", () => {
  const longEmail = `${"a".repeat(243)}@example.com`;
  const longPassword = "p".repeat(passwordMaxLength + 1);

  it("refuses an address over 254 characters everywhere one is accepted", async () => {
    expect(longEmail).toHaveLength(255);

    const setup = await authPost(app, "setup", {
      token: setupTokenOf(app),
      email: longEmail,
      password: TEST_PASSWORD,
    });
    expect(setup.status).toBe(400);
    expect(apiErrorOf(setup).fields).toHaveProperty("email");

    const cookie = await setupAdmin(app);
    const signIn = await login({ email: longEmail });
    expect(signIn.status).toBe(400);
    expect(apiErrorOf(signIn).fields).toHaveProperty("email");

    const change = await authPost(
      app,
      "credentials",
      { email: longEmail, currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      cookie,
    );
    expect(change.status).toBe(400);
    expect(apiErrorOf(change).fields).toHaveProperty("email");
  });

  it("refuses an over-long password before it can reach the hash", async () => {
    const setup = await authPost(app, "setup", {
      token: setupTokenOf(app),
      email: TEST_EMAIL,
      password: longPassword,
    });
    expect(setup.status).toBe(400);
    expect(apiErrorOf(setup).fields).toHaveProperty("password");

    const cookie = await setupAdmin(app);
    const signIn = await login({ password: longPassword });
    expect(signIn.status).toBe(400);
    expect(apiErrorOf(signIn).fields).toHaveProperty("password");

    const change = await authPost(
      app,
      "credentials",
      { email: TEST_EMAIL, currentPassword: longPassword, newPassword: longPassword },
      cookie,
    );
    expect(change.status).toBe(400);
    expect(Object.keys(apiErrorOf(change).fields ?? {}).sort()).toEqual(["currentPassword", "newPassword"]);
  });

  it("still accepts the longest allowed password", async () => {
    const longest = "p".repeat(passwordMaxLength);
    await setupAdmin(app, { password: longest });
    expect((await login({ password: longest })).status).toBe(200);
  });
});

describe("login", () => {
  beforeEach(async () => {
    await setupAdmin(app);
  });

  it("signs in and sets an HttpOnly, SameSite session cookie that expires with the browser", async () => {
    const result = await login({});

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "signed-in", user: { email: TEST_EMAIL } });
    expect(result.setCookie).toMatch(/^opsifier_session=/);
    expect(result.setCookie).toMatch(/HttpOnly/);
    expect(result.setCookie).toMatch(/SameSite=Strict/);
    expect(result.setCookie).not.toMatch(/Max-Age/);
    expect(result.setCookie).not.toMatch(/Secure/);
  });

  it("persists the cookie when asked to remember", async () => {
    const result = await loginOverHttps({ rememberMe: true });
    expect(result.setCookie).toMatch(/Max-Age=2592000/);
  });

  it("stores the session token only as a hash", async () => {
    const { cookie } = await login({});
    const token = cookie?.split("=", 2)[1] as string;
    const rows = context.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .all();
    expect(rows).toHaveLength(1);
    expect(
      context.deps.db
        .select()
        .from(sessions)
        .all()
        .some((row) => row.tokenHash === token),
    ).toBe(false);
  });

  it("treats the email case-insensitively", async () => {
    expect((await login({ email: TEST_EMAIL.toUpperCase() })).status).toBe(200);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrongPassword = await login({ password: "not the right password" });
    const unknownEmail = await login({ email: "nobody@example.com" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(apiErrorOf(unknownEmail)).toEqual(apiErrorOf(wrongPassword));
    expect(apiErrorOf(wrongPassword).code).toBe("invalid_credentials");
  });

  it("ends a non-remembered session after a day and a remembered one after 30 days", async () => {
    const state = (cookie?: string) => overHttps("/api/v1/auth/session", { cookie });
    const shortLived = (await loginOverHttps()).cookie;
    const remembered = (await loginOverHttps({ rememberMe: true })).cookie;

    context.advance(SESSION_TTL_MS + 1);
    expect((await state(shortLived)).body).toEqual({ status: "signed-out" });
    expect((await state(remembered)).body).toMatchObject({ status: "signed-in" });

    context.advance(REMEMBERED_SESSION_TTL_MS);
    expect((await state(remembered)).body).toEqual({ status: "signed-out" });
  });

  it("never returns the password hash or a two-factor secret", async () => {
    const cookie = (await login({})).cookie;
    const secret = await enableTwoFactor(context, cookie as string);
    const [user] = allUsers();

    context.advance(NEXT_STEP);
    const responses = [await login({ code: totpAt(secret, context.deps.now()) }), await sessionOf(cookie)];

    for (const response of responses) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(user?.passwordHash as string);
      expect(text).not.toContain(user?.totpSecret as string);
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/password|totp|secret/i);
    }
  });

  it("appears in the activity log with no log file behind it", async () => {
    await login({});
    const actions = await call<{ items: Array<{ type: string; hasLog: boolean; actorEmail: string }> }>(
      app,
      "/api/v1/actions?type=auth.login",
      { cookie: (await login({})).cookie },
    );
    expect(actions.body.items[0]).toMatchObject({
      type: "auth.login",
      hasLog: false,
      actorEmail: TEST_EMAIL,
    });
  });
});

describe("the session cookie", () => {
  const twelveHours = 12 * 60 * 60;

  /** A context whose proxy at PROXY_PEER is configured as trusted. */
  async function behindTrustedProxy() {
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_TRUSTED_PROXIES: "10.0.0.0/8" } });
    app = context.app;
    return setupAdmin(app);
  }

  const proxied = (peer: string, proto = "https") =>
    call(app, "/api/v1/auth/login", {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      origin: PANEL,
      headers: { host: "panel.example.com", "x-forwarded-proto": proto },
      peer,
    });

  it("is Secure and __Host- prefixed over direct HTTPS", async () => {
    await setupAdmin(app);
    const result = await loginOverHttps();

    expect(result.status).toBe(200);
    expect(result.setCookie).toMatch(new RegExp(`^${SECURE_SESSION_COOKIE}=`));
    expect(result.setCookie).toMatch(/; Secure/);
    expect(result.setCookie).toMatch(/; Path=\//);
    expect(result.setCookie).not.toMatch(/Domain=/);
  });

  it("is Secure and __Host- prefixed through a trusted HTTPS proxy", async () => {
    await behindTrustedProxy();
    const result = await proxied(PROXY_PEER);

    expect(result.status).toBe(200);
    expect(result.setCookie).toMatch(new RegExp(`^${SECURE_SESSION_COOKIE}=`));
    expect(result.setCookie).toMatch(/; Secure/);
  });

  it("does not believe X-Forwarded-Proto from anyone but a trusted proxy", async () => {
    await behindTrustedProxy();
    const spoofed = await call(app, "/api/v1/auth/login", {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD, rememberMe: true },
      origin: TEST_ORIGIN,
      headers: { "x-forwarded-proto": "https" },
      peer: "203.0.113.9",
    });

    expect(spoofed.status).toBe(200);
    expect(spoofed.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(spoofed.setCookie).not.toMatch(/Secure/);
    expect(spoofed.setCookie).toMatch(new RegExp(`Max-Age=${twelveHours}`));
  });

  it("stays a plain cookie when a trusted proxy says the request was HTTP", async () => {
    await behindTrustedProxy();
    const result = await call(app, "/api/v1/auth/login", {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      origin: "http://panel.example.com",
      headers: { host: "panel.example.com", "x-forwarded-proto": "http" },
      peer: PROXY_PEER,
    });
    expect(result.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it("caps sessions at 12 hours over plain HTTP, even when asked to remember", async () => {
    await setupAdmin(app);
    const shortLived = await login({});
    const remembered = await login({ rememberMe: true });

    expect(remembered.setCookie).toMatch(new RegExp(`Max-Age=${twelveHours}(;|$)`));
    expect(shortLived.setCookie).not.toMatch(/Max-Age/);

    context.advance(PLAIN_HTTP_SESSION_TTL_MS - 1);
    expect((await sessionOf(remembered.cookie)).body).toMatchObject({ status: "signed-in" });

    context.advance(2);
    expect((await sessionOf(shortLived.cookie)).body).toEqual({ status: "signed-out" });
    expect((await sessionOf(remembered.cookie)).body).toEqual({ status: "signed-out" });
  });

  it("caps the session opened by setup over plain HTTP too", async () => {
    const cookie = await setupAdmin(app);
    context.advance(PLAIN_HTTP_SESSION_TTL_MS + 1);
    expect((await sessionOf(cookie)).body).toEqual({ status: "signed-out" });
  });

  it("authenticates over HTTPS with the prefixed cookie and nothing else", async () => {
    const plain = await setupAdmin(app);
    const session = (cookie: string) => overHttps("/api/v1/auth/session", { cookie });

    expect((await session(asSecureCookie(plain))).body).toMatchObject({ status: "signed-in" });
    expect((await session(plain)).body).toEqual({ status: "signed-out" });
  });

  it("is not accepted under the prefixed name over plain HTTP", async () => {
    const plain = await setupAdmin(app);
    expect((await sessionOf(asSecureCookie(plain))).body).toEqual({ status: "signed-out" });
  });

  it("is cleared under the right name when signing out over HTTPS", async () => {
    await setupAdmin(app);
    const { cookie } = await loginOverHttps();

    const result = await overHttps("/api/v1/auth/logout", { method: "POST", cookie, origin: PANEL });

    expect(result.status).toBe(200);
    expect(result.setCookie).toMatch(new RegExp(`^${SECURE_SESSION_COOKIE}=; Max-Age=0`));
    expect((await overHttps("/api/v1/auth/session", { cookie })).body).toEqual({ status: "signed-out" });
  });
});

describe("logout", () => {
  it("ends the session on the server and clears the cookie", async () => {
    const cookie = await setupAdmin(app);
    const result = await authPost<SessionState>(app, "logout", undefined, cookie);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "signed-out" });
    expect(result.setCookie).toMatch(/Max-Age=0/);
    expect((await sessionOf(cookie)).body).toEqual({ status: "signed-out" });
  });

  it("is harmless without a session", async () => {
    await setupAdmin(app);
    expect((await authPost(app, "logout", undefined)).status).toBe(200);
  });
});

describe("two-factor authentication", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await setupAdmin(app);
  });

  const begin = (currentPassword = TEST_PASSWORD) =>
    authPost<TwoFactorSetup>(app, "two-factor/begin", { currentPassword }, cookie);
  const disable = (body: Record<string, unknown>) =>
    authPost<SessionState>(app, "two-factor/disable", { currentPassword: TEST_PASSWORD, ...body }, cookie);

  it("cannot be started from a session alone", async () => {
    const missing = await authPost(app, "two-factor/begin", {}, cookie);
    expect(missing.status).toBe(400);
    expect(apiErrorOf(missing).fields).toHaveProperty("currentPassword");

    const wrong = await begin("not the right password");
    expect(wrong.status).toBe(400);
    expect(apiErrorOf(wrong).code).toBe("invalid_current_password");
    expect(apiErrorOf(wrong).fields).toHaveProperty("currentPassword");
    expect(allUsers()[0]?.totpPendingSecret).toBeNull();
  });

  it("limits how many passwords a stolen session can try when starting setup", async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { sensitivePerUser: { limit: 2, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;
    cookie = await setupAdmin(app);

    expect((await begin("wrong guess here")).status).toBe(400);
    expect((await begin("wrong guess here")).status).toBe(400);
    expect((await begin()).status).toBe(429);
  });

  it("stores the setup secret sealed and leaves 2FA off until confirmed", async () => {
    const started = await begin();

    expect(started.status).toBe(200);
    expect(started.body.otpauthUri).toContain("otpauth://totp/");
    const [user] = allUsers();
    expect(user?.totpPendingSecret?.startsWith("v1.")).toBe(true);
    expect(user?.totpPendingSecret).not.toContain(started.body.secret);
    expect(user?.totpSecret).toBeNull();
    expect((await sessionOf(cookie)).body).toMatchObject({ user: { twoFactorEnabled: false } });
    expect((await login({})).status).toBe(200);
  });

  it("rejects a wrong code without enabling anything", async () => {
    await begin();
    const result = await authPost(app, "two-factor/enable", { code: "000000" }, cookie);

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).code).toBe("invalid_two_factor_code");
    expect(apiErrorOf(result).fields).toHaveProperty("code");
    expect(allUsers()[0]?.totpSecret).toBeNull();
  });

  it("cannot be finished after the setup has expired", async () => {
    const started = await begin();
    context.advance(15 * 60 * 1000 + 1);

    const result = await authPost(
      app,
      "two-factor/enable",
      { code: totpAt(started.body.secret, context.deps.now()) },
      cookie,
    );
    expect(result.status).toBe(409);
    expect(apiErrorOf(result).code).toBe("two_factor_not_started");
    expect(allUsers()[0]?.totpSecret).toBeNull();
  });

  it("cannot be enabled without being started", async () => {
    const result = await authPost(app, "two-factor/enable", { code: "123456" }, cookie);
    expect(result.status).toBe(409);
  });

  it("cannot have its secret replaced while enabled", async () => {
    await enableTwoFactor(context, cookie);
    expect((await begin()).status).toBe(409);
  });

  it("requires a code at login once enabled", async () => {
    await enableTwoFactor(context, cookie);
    const result = await login({});

    expect(result.status).toBe(401);
    expect(apiErrorOf(result).code).toBe(twoFactorRequiredCode);
    expect(result.setCookie).toBeNull();
  });

  it("does not ask for a code when the password is wrong", async () => {
    await enableTwoFactor(context, cookie);
    const result = await login({ password: "not the right password" });
    expect(apiErrorOf(result).code).toBe("invalid_credentials");
  });

  it("accepts a valid code and rejects a wrong one", async () => {
    const secret = await enableTwoFactor(context, cookie);
    context.advance(NEXT_STEP);

    const wrong = await login({ code: "000000" });
    expect(wrong.status).toBe(401);
    expect(apiErrorOf(wrong).code).toBe("invalid_two_factor_code");

    const right = await login({ code: totpAt(secret, context.deps.now()) });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ user: { twoFactorEnabled: true } });
  });

  it("refuses to accept the same code twice", async () => {
    const secret = await enableTwoFactor(context, cookie);
    context.advance(NEXT_STEP);
    const code = totpAt(secret, context.deps.now());

    expect((await login({ code })).status).toBe(200);
    const replay = await login({ code });
    expect(replay.status).toBe(401);
    expect(apiErrorOf(replay).code).toBe("invalid_two_factor_code");
  });

  it("lets only one of two concurrent logins use a code", async () => {
    const secret = await enableTwoFactor(context, cookie);
    context.advance(NEXT_STEP);
    const code = totpAt(secret, context.deps.now());

    const results = await Promise.all([login({ code }), login({ code })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });

  it("ends other sessions when enabled, because they did not prove the new factor", async () => {
    const other = (await login({})).cookie;
    await enableTwoFactor(context, cookie);

    expect((await sessionOf(other)).body).toEqual({ status: "signed-out" });
    expect((await sessionOf(cookie)).body).toMatchObject({ status: "signed-in" });
  });

  it("can be disabled only with a valid code", async () => {
    const secret = await enableTwoFactor(context, cookie);
    expect((await disable({ code: "000000" })).status).toBe(400);

    context.advance(NEXT_STEP);
    const disabled = await disable({ code: totpAt(secret, context.deps.now()) });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ user: { twoFactorEnabled: false } });
    expect((await login({})).status).toBe(200);
  });

  it("can be disabled only with the current password", async () => {
    const secret = await enableTwoFactor(context, cookie);
    context.advance(NEXT_STEP);
    const code = totpAt(secret, context.deps.now());

    const missing = await authPost(app, "two-factor/disable", { code }, cookie);
    expect(missing.status).toBe(400);
    expect(apiErrorOf(missing).fields).toHaveProperty("currentPassword");

    const wrong = await disable({ code, currentPassword: "not the right password" });
    expect(wrong.status).toBe(400);
    expect(apiErrorOf(wrong).code).toBe("invalid_current_password");
    expect(allUsers()[0]?.totpSecret).not.toBeNull();

    // A wrong password must not have used the code up.
    expect((await disable({ code })).status).toBe(200);
  });

  it("needs one of the two codes to be disabled", async () => {
    await enableTwoFactor(context, cookie);
    const result = await disable({});
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("code");
  });

  describe("recovery codes", () => {
    const stored = () => context.deps.db.select().from(recoveryCodes).all();

    it("are generated when 2FA is turned on: ten, once, and different each time", async () => {
      const { secret, recoveryCodes: first } = await enrollTwoFactor(context, cookie);

      expect(first).toHaveLength(10);
      expect(new Set(first).size).toBe(10);
      for (const code of first) {
        expect(code).toMatch(/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
      }

      // They appear in no other response.
      const session = await sessionOf(cookie);
      expect(JSON.stringify(session.body)).not.toContain(first[0]);

      context.advance(NEXT_STEP);
      await disable({ code: totpAt(secret, context.deps.now()) });
      const { recoveryCodes: second } = await enrollTwoFactor(context, cookie);
      expect(second.some((code) => first.includes(code))).toBe(false);
    });

    it("are stored only as hashes", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      const rows = stored();

      expect(rows).toHaveLength(10);
      for (const code of issued) {
        expect(JSON.stringify(rows)).not.toContain(code);
        expect(JSON.stringify(rows)).not.toContain(code.replaceAll("-", ""));
      }
    });

    it("are accepted at the login step in place of a code", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);

      const result = await login({ recoveryCode: issued[0] });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status: "signed-in", user: { twoFactorEnabled: true } });
      expect(result.cookie).toBeTruthy();
    });

    it("work once each", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      const recoveryCode = issued[0];

      expect((await login({ recoveryCode })).status).toBe(200);
      const replay = await login({ recoveryCode });

      expect(replay.status).toBe(401);
      expect(apiErrorOf(replay).code).toBe("invalid_recovery_code");
      expect(apiErrorOf(replay).fields).toHaveProperty("recoveryCode");
      expect(stored()).toHaveLength(9);
      expect((await login({ recoveryCode: issued[1] })).status).toBe(200);
    });

    it("are used up by exactly one of two concurrent logins", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      const results = await Promise.all([
        login({ recoveryCode: issued[0] }),
        login({ recoveryCode: issued[0] }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    });

    it("are accepted however they are typed", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      const code = issued[0] as string;

      expect((await login({ recoveryCode: `  ${code.toUpperCase()} ` })).status).toBe(200);
      expect((await login({ recoveryCode: (issued[1] as string).replaceAll("-", "") })).status).toBe(200);
    });

    it("do not stand in for the password", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      const result = await login({ password: "not the right password", recoveryCode: issued[0] });

      expect(apiErrorOf(result).code).toBe("invalid_credentials");
      expect(stored()).toHaveLength(10);
    });

    it("count as attempts when wrong", async () => {
      await context.close();
      context = await createTestContext({
        authLimits: { loginPerAddressAndEmail: { limit: 2, windowMs: FIFTEEN_MINUTES } },
      });
      app = context.app;
      await enableTwoFactor(context, await setupAdmin(app));
      const recoveryCode = "aaaa-aaaa-aaaa-aaaa";

      expect((await login({ recoveryCode })).status).toBe(401);
      expect((await login({ recoveryCode })).status).toBe(401);
      expect((await login({ recoveryCode })).status).toBe(429);
    });

    it("show up in the activity log when one is used", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);
      await login({ recoveryCode: issued[0] });

      const listed = await call<{ items: Array<{ title: string }> }>(app, "/api/v1/actions?type=auth.login", {
        cookie,
      });
      expect(listed.body.items[0]?.title).toContain("recovery code");
    });

    it("can stand in for the phone when turning 2FA off", async () => {
      const { recoveryCodes: issued } = await enrollTwoFactor(context, cookie);

      expect((await disable({ recoveryCode: "aaaa-aaaa-aaaa-aaaa" })).status).toBe(400);
      expect(allUsers()[0]?.totpSecret).not.toBeNull();

      const result = await disable({ recoveryCode: issued[0] });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ user: { twoFactorEnabled: false } });
    });

    it("are all deleted when 2FA is turned off", async () => {
      const { secret, recoveryCodes: issued } = await enrollTwoFactor(context, cookie);

      context.advance(NEXT_STEP);
      await disable({ code: totpAt(secret, context.deps.now()) });

      expect(stored()).toHaveLength(0);
      // With 2FA off a code is simply not needed, so an old one must not matter either way.
      expect((await login({ recoveryCode: issued[0] })).status).toBe(200);
    });

    it("are not issued for a setup that does not complete", async () => {
      await begin();
      await authPost(app, "two-factor/enable", { code: "000000" }, cookie);
      expect(stored()).toHaveLength(0);
    });

    it("cannot be used with the wrong format", async () => {
      await enableTwoFactor(context, cookie);
      const result = await login({ recoveryCode: "abc" });
      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields).toHaveProperty("recoveryCode");
    });
  });

  it("validates the code format per field", async () => {
    const result = await authPost(app, "two-factor/enable", { code: "12ab" }, cookie);
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("code");
  });
});

describe("changing credentials", () => {
  const newPassword = "a brand new passphrase";
  let cookie: string;

  beforeEach(async () => {
    cookie = await setupAdmin(app);
  });

  it("rejects a wrong current password and changes nothing", async () => {
    const result = await authPost(
      app,
      "credentials",
      { email: "new@example.com", currentPassword: "not my password", newPassword },
      cookie,
    );

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toHaveProperty("currentPassword");
    expect(allUsers()[0]?.email).toBe(TEST_EMAIL);
    expect((await login({})).status).toBe(200);
  });

  it("updates the account and ends the other sessions, keeping this one", async () => {
    const other = (await login({})).cookie;
    const result = await authPost<SessionState>(
      app,
      "credentials",
      { email: "new@example.com", currentPassword: TEST_PASSWORD, newPassword },
      cookie,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ user: { email: "new@example.com" } });
    expect((await sessionOf(other)).body).toEqual({ status: "signed-out" });
    expect((await sessionOf(cookie)).body).toMatchObject({ status: "signed-in" });
    expect((await login({ email: "new@example.com", password: newPassword })).status).toBe(200);
    expect((await login({ email: "new@example.com" })).status).toBe(401);
  });

  it("can be used to change only the email", async () => {
    const result = await authPost(
      app,
      "credentials",
      { email: "new@example.com", currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      cookie,
    );
    expect(result.status).toBe(200);
    expect((await login({ email: "new@example.com" })).status).toBe(200);
  });

  it("refuses an API token", async () => {
    const { token } = createApiToken(context.deps.db, {
      userId: allUsers()[0]?.id as string,
      name: "ci",
      now: context.deps.now(),
    });
    const result = await call(app, "/api/v1/auth/credentials", {
      body: { email: TEST_EMAIL, currentPassword: TEST_PASSWORD, newPassword },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("session_required");
  });

  it("limits how many passwords a stolen session can try", async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { sensitivePerUser: { limit: 2, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;
    const session = await setupAdmin(app);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await authPost(
        app,
        "credentials",
        { email: TEST_EMAIL, currentPassword: "wrong guess here", newPassword },
        session,
      );
      expect(result.status).toBe(400);
    }
    const blocked = await authPost(
      app,
      "credentials",
      { email: TEST_EMAIL, currentPassword: TEST_PASSWORD, newPassword },
      session,
    );
    expect(blocked.status).toBe(429);
  });
});

describe("login rate limiting", () => {
  const pairLimit = 3;

  beforeEach(async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { loginPerAddressAndEmail: { limit: pairLimit, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;
    await setupAdmin(app);
  });

  async function failLogins(times: number) {
    for (let attempt = 0; attempt < times; attempt += 1) {
      expect((await login({ password: "not the right password" })).status).toBe(401);
    }
  }

  it("blocks further attempts, even with the right password", async () => {
    await failLogins(pairLimit);
    const result = await login({});

    expect(result.status).toBe(429);
    expect(apiErrorOf(result).code).toBe("rate_limited");
    expect(Number(result.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("recovers after the window passes", async () => {
    await failLogins(pairLimit);
    context.advance(FIFTEEN_MINUTES + 1);
    expect((await login({})).status).toBe(200);
  });

  it("forgets past failures after a successful login", async () => {
    await failLogins(pairLimit - 1);
    expect((await login({})).status).toBe(200);
    await failLogins(pairLimit - 1);
    expect((await login({})).status).toBe(200);
  });

  it("counts concurrent attempts, so they cannot race past the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: pairLimit + 5 }, () => login({ password: "not the right password" })),
    );
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(pairLimit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  it("does not spend attempts on the code-required step", async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { loginPerAddressAndEmail: { limit: 2, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;
    await enableTwoFactor(context, await setupAdmin(app));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(apiErrorOf(await login({})).code).toBe(twoFactorRequiredCode);
    }
  });

  it("counts wrong two-factor codes", async () => {
    await context.close();
    context = await createTestContext({
      authLimits: { loginPerAddressAndEmail: { limit: 2, windowMs: FIFTEEN_MINUTES } },
    });
    app = context.app;
    await enableTwoFactor(context, await setupAdmin(app));

    expect((await login({ code: "000000" })).status).toBe(401);
    expect((await login({ code: "000000" })).status).toBe(401);
    expect((await login({ code: "000000" })).status).toBe(429);
  });
});

describe("the Origin check", () => {
  let cookie: string;
  const logout = (origin?: string) => call(app, "/api/v1/auth/logout", { method: "POST", cookie, origin });

  beforeEach(async () => {
    cookie = await setupAdmin(app);
  });

  it("rejects a cookie-authenticated mutation from another origin", async () => {
    const result = await logout("https://evil.example");
    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("origin_rejected");
    expect((await sessionOf(cookie)).body).toMatchObject({ status: "signed-in" });
  });

  it("rejects one with no Origin at all, or a null one", async () => {
    expect((await logout()).status).toBe(403);
    expect((await logout("null")).status).toBe(403);
  });

  it("accepts the panel's own origin, with or without its default port", async () => {
    expect((await call(app, "/api/v1/system/info", { cookie, origin: TEST_ORIGIN })).status).toBe(200);
    const result = await overHttps("/api/v1/auth/logout", {
      method: "POST",
      cookie: asSecureCookie(cookie),
      origin: PANEL,
      headers: { host: "panel.example.com:443" },
    });
    expect(result.status).toBe(200);
  });

  it("compares the scheme: a plain-HTTP page cannot act on the HTTPS panel", async () => {
    const result = await overHttps("/api/v1/auth/logout", {
      method: "POST",
      cookie: asSecureCookie(cookie),
      origin: "http://panel.example.com",
      headers: { host: "panel.example.com" },
    });
    expect(result.status).toBe(403);
    expect(apiErrorOf(result).code).toBe("origin_rejected");
  });

  it("compares the scheme the other way round too", async () => {
    const result = await call(app, "/api/v1/auth/logout", {
      method: "POST",
      cookie,
      origin: "https://localhost",
    });
    expect(result.status).toBe(403);
  });

  describe("behind a proxy", () => {
    const logoutVia = (peer: string, origin: string, proto: string) =>
      call(app, "/api/v1/auth/logout", {
        method: "POST",
        cookie: asSecureCookie(cookie),
        origin,
        headers: { host: "panel.example.com", "x-forwarded-proto": proto },
        peer,
      });

    beforeEach(async () => {
      await context.close();
      context = await createTestContext({ env: { OPSIFIER_TRUSTED_PROXIES: "10.0.0.0/8" } });
      app = context.app;
      cookie = await setupAdmin(app);
    });

    it("takes the scheme from a trusted proxy", async () => {
      expect((await logoutVia(PROXY_PEER, PANEL, "https")).status).toBe(200);
    });

    it("still compares it against the Origin", async () => {
      expect((await logoutVia(PROXY_PEER, "http://panel.example.com", "https")).status).toBe(403);
    });

    it("ignores the header from anyone else", async () => {
      expect((await logoutVia("203.0.113.9", PANEL, "https")).status).toBe(403);
    });
  });

  it("does not apply to reads", async () => {
    expect((await call(app, "/api/v1/auth/session", { cookie, origin: "https://evil.example" })).status).toBe(
      200,
    );
  });

  it("protects sign-in and setup from cross-site pages", async () => {
    const result = await call(app, "/api/v1/auth/login", {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      origin: "https://evil.example",
    });
    expect(result.status).toBe(403);
  });

  it("does not bother scripts that send no cookie", async () => {
    const result = await call(app, "/api/v1/auth/login", {
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(result.status).toBe(200);
  });

  it("accepts an explicitly configured origin", async () => {
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_ALLOWED_ORIGINS: "https://panel.example.com" } });
    app = context.app;
    const session = await setupAdmin(app);
    const result = await call(app, "/api/v1/auth/logout", {
      method: "POST",
      cookie: session,
      origin: "https://panel.example.com",
    });
    expect(result.status).toBe(200);
  });
});

describe("bearer tokens", () => {
  let userId: string;

  beforeEach(async () => {
    await setupAdmin(app);
    userId = allUsers()[0]?.id as string;
  });

  const withToken = (token: string, path = "/api/v1/system/info") =>
    call(app, path, { headers: { authorization: `Bearer ${token}` } });

  it("authenticates a request without any cookie", async () => {
    const { token } = createApiToken(context.deps.db, { userId, name: "ci", now: context.deps.now() });
    expect((await withToken(token)).status).toBe(200);
  });

  it("is stored only as a hash", () => {
    const { token, row } = createApiToken(context.deps.db, { userId, name: "ci", now: context.deps.now() });
    const stored = context.deps.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)).get();
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("is rejected when unknown or malformed, and never falls back to the cookie", async () => {
    const cookie = (await login({})).cookie;
    const unknown = await call(app, "/api/v1/system/info", {
      cookie,
      headers: { authorization: `Bearer opsifier_${"a".repeat(43)}` },
    });
    expect(unknown.status).toBe(401);
    expect(apiErrorOf(unknown).code).toBe("invalid_token");

    expect((await call(app, "/api/v1/system/info", { headers: { authorization: "Basic abc" } })).status).toBe(
      401,
    );
  });

  it("stops working once expired", async () => {
    const { token } = createApiToken(context.deps.db, {
      userId,
      name: "ci",
      now: context.deps.now(),
      expiresAt: new Date(context.deps.now() + 1000),
    });
    expect((await withToken(token)).status).toBe(200);
    context.advance(1001);
    expect((await withToken(token)).status).toBe(401);
  });

  it("does not need an Origin for mutations", async () => {
    const { token } = createApiToken(context.deps.db, { userId, name: "ci", now: context.deps.now() });
    const result = await call(app, "/api/v1/actions/does-not-exist/cancel", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(404);
  });

  it("records when it was last used", () => {
    const { token, row } = createApiToken(context.deps.db, { userId, name: "ci", now: context.deps.now() });
    expect(findTokenPrincipal(context.deps.db, token, context.deps.now())).toMatchObject({ kind: "token" });
    const stored = context.deps.db.select().from(apiTokens).where(eq(apiTokens.id, row.id)).get();
    expect(stored?.lastUsedAt).not.toBeNull();
  });
});

describe("private routes", () => {
  it("require authentication by default", async () => {
    await setupAdmin(app);
    const result = await call(app, "/api/v1/actions");
    expect(result.status).toBe(401);
    expect(apiErrorOf(result).code).toBe("unauthenticated");
  });
});
