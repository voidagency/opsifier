import type { CliLoginSession, CliLoginStarted } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  enableTwoFactor,
  setupAdmin,
  TEST_EMAIL,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
  totpAt,
} from "../../testing/harness";
import { normalizeUserCode } from "./cli-login";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

const start = async () =>
  (
    await call<CliLoginStarted>(context.app, "/api/v1/auth/cli/start", {
      method: "POST",
      body: { client: "laptop" },
    })
  ).body;
const collect = (deviceCode: string) =>
  call<CliLoginSession>(context.app, "/api/v1/auth/cli/token", { method: "POST", body: { deviceCode } });
const view = (code: string, headers: Record<string, string> = {}) =>
  call(context.app, `/api/v1/auth/cli/requests/${code}`, {
    cookie: headers.authorization ? undefined : cookie,
    headers,
  });
const answer = (code: string, verb: "approve" | "deny", body: Record<string, unknown> = {}) =>
  call(context.app, `/api/v1/auth/cli/requests/${code}/${verb}`, {
    method: "POST",
    body,
    cookie,
    origin: TEST_ORIGIN,
  });
const asSession = (token: string, path: string, method = "GET") =>
  call(context.app, path, { method, headers: { authorization: `Session ${token}` } });

describe("signing the command line in as a person", () => {
  it("hands it a session once someone approves, and only once", async () => {
    const started = await start();
    expect(started.verificationPath).toBe(`/cli-login?code=${started.userCode}`);
    expect((await collect(started.deviceCode)).status).toBe(202);

    expect((await view(started.userCode)).body).toMatchObject({
      client: "laptop",
      userCode: started.userCode,
    });
    expect((await answer(started.userCode, "approve", { currentPassword: TEST_PASSWORD })).status).toBe(200);

    const session = await collect(started.deviceCode);
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(TEST_EMAIL);
    expect((await collect(started.deviceCode)).status).toBe(410);
  });

  it("gives a session that reaches account administration, which API keys never do", async () => {
    const started = await start();
    await answer(started.userCode, "approve", { currentPassword: TEST_PASSWORD });
    const { token } = (await collect(started.deviceCode)).body;

    expect((await asSession(token, "/api/v1/users")).status).toBe(200);
  });

  it("asks for the password again before approving", async () => {
    const started = await start();

    const without = await answer(started.userCode, "approve");
    expect(apiErrorOf(without).code).toBe("current_password_required");
    expect((await answer(started.userCode, "approve", { currentPassword: "not it" })).status).toBe(400);
    expect((await collect(started.deviceCode)).status).toBe(202);
  });

  it("asks for the code instead when the account has two-factor sign-in", async () => {
    const secret = await enableTwoFactor(context, cookie);
    const started = await start();

    const passwordOnly = await answer(started.userCode, "approve", { currentPassword: TEST_PASSWORD });
    expect(apiErrorOf(passwordOnly).code).toBe("invalid_two_factor_code");
    context.advance(30_000);
    expect(
      (await answer(started.userCode, "approve", { code: totpAt(secret, context.deps.now()) })).status,
    ).toBe(200);
    expect((await collect(started.deviceCode)).status).toBe(200);
  });

  it("tells the command line when the request is refused", async () => {
    const started = await start();
    expect((await answer(started.userCode, "deny")).status).toBe(200);

    const refused = await collect(started.deviceCode);
    expect(refused.status).toBe(410);
    expect(apiErrorOf(refused).message).toMatch(/refused/);
  });

  it("expires after ten minutes", async () => {
    const started = await start();
    context.advance(10 * 60 * 1000 + 1);

    expect((await view(started.userCode)).status).toBe(404);
    expect((await collect(started.deviceCode)).status).toBe(410);
  });

  it("takes the code as a person types it", async () => {
    const started = await start();
    const typed = started.userCode.replace("-", "").toLowerCase();
    expect(normalizeUserCode(typed)).toBe(started.userCode);
    expect((await view(typed)).status).toBe(200);
  });

  it("cannot be answered with an API key or without a session", async () => {
    const started = await start();
    const anonymous = await call(context.app, `/api/v1/auth/cli/requests/${started.userCode}`);
    expect(anonymous.status).toBe(401);
  });

  it("ends the command line's session when it signs out", async () => {
    const started = await start();
    await answer(started.userCode, "approve", { currentPassword: TEST_PASSWORD });
    const { token } = (await collect(started.deviceCode)).body;

    expect((await asSession(token, "/api/v1/auth/logout", "POST")).status).toBe(200);
    const after = await asSession(token, "/api/v1/users");
    expect(after.status).toBe(401);
    expect(apiErrorOf(after).code).toBe("invalid_session");
  });
});
