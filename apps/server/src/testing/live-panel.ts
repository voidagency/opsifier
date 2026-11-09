import type { ActionDetail, ActionEntry, CreatedApiKey } from "@opsifier/contract";
import {
  apiErrorOf,
  authPost,
  type CallResult,
  call,
  createTestContext,
  listenOnLoopback,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "./harness";

/**
 * A panel on the fake driver behind a real socket, seeded with two projects, for the API's own clients
 * to talk to the way they do in production. `shop` and `secret` each hold a deployable service `web`.
 */
export interface LivePanel {
  context: TestContext;
  url: string;
  /** An administrator's session cookie. */
  admin: string;
  /** A request as a browser session, for what only a person can do. */
  session<T = unknown>(method: string, path: string, body?: unknown, cookie?: string): Promise<CallResult<T>>;
  /** The same request a client would make with this key, sent with no client in between. */
  direct<T = unknown>(key: string, method: string, path: string, body?: unknown): Promise<CallResult<T>>;
  createKey(
    body: { name?: string; level?: "read" | "write"; projects?: string[] },
    cookie?: string,
  ): Promise<CreatedApiKey>;
  /** A signed-in member with these project roles. Returns its session cookie. */
  createMember(
    email: string,
    grants: Array<{ project: string; role: "viewer" | "operator" }>,
  ): Promise<string>;
  /** Deploys `shop/web` and waits for it, so that it has tasks and logs. */
  deploy(project: string, service: string): Promise<ActionEntry>;
  close(): Promise<void>;
}

const FINISHED = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

export async function startLivePanel(): Promise<LivePanel> {
  const context = await createTestContext();
  const admin = await setupAdmin(context.app);
  const server = await listenOnLoopback(context.app);

  const session = <T = unknown>(method: string, path: string, body?: unknown, cookie: string = admin) =>
    call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });

  for (const project of ["shop", "secret"]) {
    await session("POST", "/api/v1/projects", { name: project });
    await session("POST", `/api/v1/projects/${project}/services`, { name: "web" });
    await session("PUT", `/api/v1/projects/${project}/services/web/source`, {
      type: "image",
      image: "nginx:1.27",
    });
  }

  return {
    context,
    url: server.url,
    admin,
    session,
    direct: (key, method, path, body) =>
      call(context.app, path, { method, body, headers: { authorization: `Bearer ${key}` } }),
    async createKey(body, cookie = admin) {
      const created = await session<CreatedApiKey>(
        "POST",
        "/api/v1/me/api-keys",
        { name: "key", ...body },
        cookie,
      );
      if (created.status !== 201) {
        throw new Error(`Could not create a key: ${apiErrorOf(created).message}`);
      }
      return created.body;
    },
    async createMember(email, grants) {
      await session("POST", "/api/v1/users", {
        email,
        password: TEST_PASSWORD,
        role: "member",
        projects: grants,
      });
      const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
      return login.cookie as string;
    },
    async deploy(project, service) {
      const started = await session<ActionEntry>(
        "POST",
        `/api/v1/projects/${project}/services/${service}/deploy`,
        {},
      );
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const detail = await session<ActionDetail>("GET", `/api/v1/actions/${started.body.id}`);
        if (FINISHED.has(detail.body.status)) {
          return detail.body;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The deployment never finished.");
    },
    async close() {
      await server.close();
      await context.close();
    },
  };
}
