import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HttpBindings, serve } from "@hono/node-server";
import type { ApiError, SessionState, TwoFactorEnabled, TwoFactorSetup } from "@opsifier/contract";
import { TOTP } from "otpauth";
import { type AuthLimits, BINDING_HEADER, defaultAuthLimits } from "../core/auth";
import { loadConfig } from "../core/config";
import type { ApiApp, AppDeps } from "../core/context";
import { FakeDriver, type RolloutTiming } from "../core/docker";
import { BINDING_PROTOCOL_PREFIX, PANEL_PROTOCOL } from "../core/realtime";
import { seedProtection } from "../features/server-purpose/repo";
import { createRuntime, type Runtime } from "../runtime";

/** The origin of `app.request()` calls, which is what the Origin check compares against. */
export const TEST_ORIGIN = "http://localhost";
export const TEST_NAME = "Ada Admin";
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
  /**
   * Boots a second process on the same data and the same Docker, as when the panel comes back after a
   * hard stop: the first one never got to say goodbye, and whatever it held in memory is out of reach.
   */
  restart(): Promise<Runtime>;
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
  const start = (lock?: { lockDataDirectory: () => () => void }) =>
    createRuntime(config, {
      ...lock,
      docker,
      now: () => clock,
      authLimits: { ...defaultAuthLimits, ...options.authLimits },
      rollout: { ...TEST_ROLLOUT, ...options.rollout },
    });
  const runtime = start();
  seedProtection(runtime.deps.db, "production", new Date(clock));
  await runtime.boot();
  setupTokenFiles.set(runtime.app, config.setupTokenFile);

  const restarted: Runtime[] = [];
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
    restart: async () => {
      // The panel before it stopped without a word, so the lock it held would be gone by now.
      const next = start({ lockDataDirectory: () => () => {} });
      restarted.push(next);
      await next.boot();
      return next;
    },
    close: async () => {
      if (!closed) {
        closed = true;
        for (const next of restarted) {
          await next.close();
        }
        await runtime.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Not a cookie: how a test keeps a session's second secret next to its cookie. Every test request
 * goes over plain HTTP, so every session a test opens through the API has one, and `call` sends it
 * the way the panel's pages do.
 */
const BINDING_PAIR = "test-binding=";

/** A session's credentials as tests keep them, for one a test opens itself with `insertSession`. */
export function credentialsOf(cookie: string, binding: string | null): string {
  return binding === null ? cookie : `${cookie}; ${BINDING_PAIR}${binding}`;
}

/** The session cookie and the second secret a test's credentials hold. */
export function splitCredentials(credentials: string): { cookie: string; binding: string | undefined } {
  const pairs = credentials.split(/;\s*/);
  return {
    cookie: pairs.filter((pair) => !pair.startsWith(BINDING_PAIR)).join("; "),
    binding: pairs.find((pair) => pair.startsWith(BINDING_PAIR))?.slice(BINDING_PAIR.length),
  };
}

/** The headers a page of the panel sends with these credentials, for a test that builds its own request. */
export function credentialHeaders(credentials: string): Record<string, string> {
  const { cookie, binding } = splitCredentials(credentials);
  return binding === undefined ? { cookie } : { cookie, [BINDING_HEADER]: binding };
}

/**
 * A link the browser opens by itself, a download, as the panel's pages write it: the session's second
 * secret in the address, and the cookie on its own.
 */
export function browserLink(
  url: string,
  credentials: string,
): { url: string; headers: Record<string, string> } {
  const { cookie, binding } = splitCredentials(credentials);
  if (binding === undefined) {
    return { url, headers: { cookie } };
  }
  const separator = url.includes("?") ? "&" : "?";
  return { url: `${url}${separator}binding=${encodeURIComponent(binding)}`, headers: { cookie } };
}

/**
 * What a page of the panel sends when it opens a WebSocket with these headers: the session cookie,
 * and the session's second secret as a subprotocol.
 */
export function socketHandshake(headers: Record<string, string>): {
  protocols: string[];
  headers: Record<string, string>;
} {
  const { Cookie: credentials, ...rest } = headers;
  const { cookie, binding } = splitCredentials(credentials ?? "");
  return {
    protocols: binding === undefined ? [] : [PANEL_PROTOCOL, `${BINDING_PROTOCOL_PREFIX}${binding}`],
    headers: cookie === "" ? rest : { ...rest, Cookie: cookie },
  };
}

function bindingOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("binding" in body)) {
    return undefined;
  }
  return typeof body.binding === "string" ? body.binding : undefined;
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
  /**
   * `name=value` from Set-Cookie, ready to send back, followed by the second secret when the answer
   * opened a session over plain HTTP.
   */
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
    const { cookie, binding } = splitCredentials(options.cookie);
    if (cookie !== "") {
      headers.set("cookie", cookie);
    }
    if (binding !== undefined && !headers.has(BINDING_HEADER)) {
      headers.set(BINDING_HEADER, binding);
    }
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
  const cookie = setCookie?.split(";", 1)[0];
  const binding = bindingOf(body);
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
    cookie: cookie === undefined || binding === undefined ? cookie : `${cookie}; ${BINDING_PAIR}${binding}`,
    setCookie,
  };
}

/** Puts an app on a real socket on the loopback interface, for clients that speak HTTP to it. */
export function listenOnLoopback(app: ApiApp): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export const authPost = <T = unknown>(app: ApiApp, path: string, body: unknown, cookie?: string) =>
  call<T>(app, `/api/v1/auth/${path}`, { method: "POST", body, cookie, origin: TEST_ORIGIN });

export function apiErrorOf(result: CallResult<unknown>): ApiError["error"] {
  return (result.body as ApiError).error;
}

/** Creates an account through the API, signs it in and returns its session cookie. */
export async function signInMember(
  app: ApiApp,
  admin: string,
  email: string,
  projects: Array<{ project: string; role: "viewer" | "operator" | "maintainer" }>,
): Promise<string> {
  await call(app, "/api/v1/users", {
    method: "POST",
    cookie: admin,
    origin: TEST_ORIGIN,
    body: { email, password: TEST_PASSWORD, role: "member", projects },
  });
  const login = await authPost(app, "login", { email, password: TEST_PASSWORD });
  if (login.cookie === undefined) {
    throw new Error(`Could not sign ${email} in`);
  }
  return login.cookie;
}

/** Runs first-time setup and returns the admin's session cookie. */
export async function setupAdmin(
  app: ApiApp,
  credentials: { email?: string; password?: string } = {},
): Promise<string> {
  const result = await authPost<SessionState>(app, "setup", {
    token: setupTokenOf(app),
    name: TEST_NAME,
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
