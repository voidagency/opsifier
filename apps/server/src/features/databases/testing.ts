import { Duplex } from "node:stream";
import type { ActionEntry, CreateDatabaseRequest, ServiceDetail } from "@opsifier/contract";
import { expect, vi } from "vitest";
import type { ExecOptions, ExecSession } from "../../core/docker";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";

export const PROJECT = "shop";

export interface DatabaseTestContext {
  context: TestContext;
  cookie: string;
  api<T = unknown>(path: string, method?: string, body?: unknown): ReturnType<typeof call<T>>;
  /** Sends a request whose answer is an Action, and returns the Action once it has finished. */
  run(path: string, method?: string, body?: unknown): Promise<ActionEntry & { log: string }>;
  waitFor(id: string): Promise<ActionEntry & { log: string }>;
  create(
    body: Partial<CreateDatabaseRequest> & { engine: CreateDatabaseRequest["engine"] },
  ): Promise<ServiceDetail>;
  /** Creates a database and waits for its first deploy. */
  deployed(
    body: Partial<CreateDatabaseRequest> & { engine: CreateDatabaseRequest["engine"] },
  ): Promise<ServiceDetail>;
  service(name?: string): string;
  close(): Promise<void>;
}

export async function setupDatabaseTests(): Promise<DatabaseTestContext> {
  const context = await createTestContext();
  const cookie = await setupAdmin(context.app);

  const api: DatabaseTestContext["api"] = (path, method = "GET", body) =>
    call(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

  const waitFor = async (id: string) => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const { body } = await api<ActionEntry & { log: string }>(`/actions/${id}`);
      if (body.status !== "queued" && body.status !== "running") {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("The action did not finish");
  };

  const run: DatabaseTestContext["run"] = async (path, method = "POST", body) => {
    const accepted = await api<ActionEntry>(path, method, body);
    if (accepted.status !== 202) {
      throw new Error(`${method} ${path} answered ${accepted.status}: ${JSON.stringify(accepted.body)}`);
    }
    return waitFor(accepted.body.id);
  };

  const service = (name = "db") => `/projects/${PROJECT}/services/${name}`;

  const create: DatabaseTestContext["create"] = async (body) => {
    const created = await api<ServiceDetail>(`/projects/${PROJECT}/databases`, "POST", {
      name: "db",
      ...body,
    });
    if (created.status !== 201) {
      throw new Error(`Create answered ${created.status}: ${JSON.stringify(created.body)}`);
    }
    return created.body;
  };

  const deployed: DatabaseTestContext["deployed"] = async (body) => {
    const detail = await create(body);
    const action = detail.activeAction;
    if (action === null) {
      throw new Error("Creating a database should have started a deploy");
    }
    const finished = await waitFor(action.id);
    expect(finished.status).toBe("succeeded");
    return (await api<ServiceDetail>(service(detail.name))).body;
  };

  await api("/projects", "POST", { name: PROJECT });

  return {
    context,
    cookie,
    api,
    run,
    waitFor,
    create,
    deployed,
    service,
    close: () => context.close(),
  };
}

export { apiErrorOf };

export interface ExecCall {
  options: ExecOptions;
  stdin: string;
}

/** What one exec does, decided from what was sent to it. Output goes to stdout. */
export type ExecScript = (call: ExecCall) => { exitCode: number; output: string };

/** Replaces exec with a scripted one and records every call. Output is unframed, as with a TTY. */
export function scriptExec(context: TestContext, script: ExecScript): ExecCall[] {
  const calls: ExecCall[] = [];
  vi.spyOn(context.docker, "execAttach").mockImplementation(
    async (options: ExecOptions): Promise<ExecSession> => {
      let stdin = "";
      let settle: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => {
        settle = resolve;
      });
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          stdin += chunk.toString("utf8");
          callback();
        },
        final(callback) {
          const entry: ExecCall = { options, stdin };
          calls.push(entry);
          const { exitCode, output } = script(entry);
          this.push(output);
          this.push(null);
          settle(exitCode);
          callback();
        },
      });
      return { stream, resize: async () => {}, exited: () => exited };
    },
  );
  return calls;
}
