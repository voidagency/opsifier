import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import type { ApiError, SessionState, TwoFactorEnabled, TwoFactorSetup } from "@opsifier/contract";
import { TOTP } from "otpauth";
import { type AuthLimits, defaultAuthLimits } from "../core/auth";
import { loadConfig } from "../core/config";
import type { ApiApp, AppDeps } from "../core/context";
import { FakeDriver, type RolloutTiming } from "../core/docker";
import { createRuntime, type Runtime } from "../runtime";

/** The origin of `app.request()` calls, which is what the Origin check compares against. */
export const TEST_ORIGIN = "http://localhost";
export const TEST_EMAIL = "admin@example.com";
export const TEST_PASSWORD = "correct horse battery staple";

/** Where each test app keeps its setup token, so `setupAdmin` can be handed just the app. */
const setupTokenFiles = new WeakMap<ApiApp, string>();

/** The setup token a test app printed at boot. */
export function setupTokenOf(app: ApiApp): string {
  const file = setupTokenFiles.get(app);
  if (file === undefined) {
    throw new Error("This app was not built by createTestContext.");
  }
  return readFileSync(file, "utf8").trim();
}

export interface TestContext {
  runtime: Runtime;
  deps: AppDeps;
  app: ApiApp;
  docker: FakeDriver;
  dataDir: string;
  /** Moves the injected clock forward. */
  advance(ms: number): void;
  close(): Promise<void>;
}

export interface TestContextOptions {
  authLimits?: Partial<AuthLimits>;
  env?: Record<string, string>;
  rollout?: Partial<RolloutTiming>;
}

/** Fast enough for a test, while still going through every state FakeDriver simulates. */
const TEST_ROLLOUT: RolloutTiming = { pollMs: 2, stableMs: 0, timeoutMs: 2000, maxTaskFailures: 3 };

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "opsifier-test-"));
  const config = loadConfig({
    NODE_ENV: "test",
    OPSIFIER_DATA_DIR: dataDir,
    OPSIFIER_DRIVER: "fake",
    ...options.env,
  });
  let clock = Date.now();
  const docker = new FakeDriver({ tickMs: 5 });
  const runtime = createRuntime(config, {
    docker,
    now: () => clock,
    authLimits: { ...defaultAuthLimits, ...options.authLimits },
    rollout: { ...TEST_ROLLOUT, ...options.rollout },
  });
  await runtime.boot();
  setupTokenFiles.set(runtime.app, config.setupTokenFile);

  let closed = false;
  return {
    runtime,
    deps: runtime.deps,
    app: runtime.app,
    docker,
    dataDir,
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      if (!closed) {
        closed = true;
        await runtime.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string;
  headers?: Record<string, string>;
  /** The address the request appears to come from, for what depends on a trusted proxy. */
  peer?: string;
}

export interface CallResult<T> {
  status: number;
  body: T;
  headers: Headers;
  /** `name=value` from Set-Cookie, ready to send back. */
  cookie: string | undefined;
  setCookie: string | null;
}

/** Sends a request through the app. Unsafe methods get a matching Origin unless overridden. */
export async function call<T = unknown>(
  app: ApiApp,
  path: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const method =
    options.method ?? (options.body === undefined && options.rawBody === undefined ? "GET" : "POST");
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.origin !== undefined) {
    headers.set("origin", options.origin);
  }

  const response = await app.request(
    path,
    {
      method,
      headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    },
    (options.peer === undefined
      ? undefined
      : { incoming: { socket: { remoteAddress: options.peer } } }) as unknown as HttpBindings,
  );

  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }

  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
    cookie: setCookie?.split(";", 1)[0],
    setCookie,
  };
}

export const authPost = <T = unknown>(app: ApiApp, path: string, body: unknown, cookie?: string) =>
  call<T>(app, `/api/v1/auth/${path}`, { method: "POST", body, cookie, origin: TEST_ORIGIN });

export function apiErrorOf(result: CallResult<unknown>): ApiError["error"] {
  return (result.body as ApiError).error;
}

/** Runs first-time setup and returns the admin's session cookie. */
export async function setupAdmin(
  app: ApiApp,
  credentials: { email?: string; password?: string } = {},
): Promise<string> {
  const result = await authPost<SessionState>(app, "setup", {
    token: setupTokenOf(app),
    email: credentials.email ?? TEST_EMAIL,
    password: credentials.password ?? TEST_PASSWORD,
  });
  if (result.status !== 201 || result.cookie === undefined) {
    throw new Error(`Setup failed with ${result.status}`);
  }
  return result.cookie;
}

export const totpAt = (secret: string, timestamp: number) => TOTP.generate({ secret, timestamp });

/** Turns on 2FA for the signed-in user and returns the secret and recovery codes. */
export async function enrollTwoFactor(
  context: TestContext,
  cookie: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const begin = await authPost<TwoFactorSetup>(
    context.app,
    "two-factor/begin",
    { currentPassword: TEST_PASSWORD },
    cookie,
  );
  if (begin.status !== 200) {
    throw new Error(`Begin failed with ${begin.status}`);
  }
  const { secret } = begin.body;
  const enable = await authPost<TwoFactorEnabled>(
    context.app,
    "two-factor/enable",
    { code: totpAt(secret, context.deps.now()) },
    cookie,
  );
  if (enable.status !== 200) {
    throw new Error(`Enable failed with ${enable.status}`);
  }
  return { secret, recoveryCodes: enable.body.recoveryCodes };
}

/** Turns on 2FA for the signed-in user and returns the secret. */
export async function enableTwoFactor(context: TestContext, cookie: string): Promise<string> {
  return (await enrollTwoFactor(context, cookie)).secret;
}
