import type { CreatedApiKey } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  type CallResult,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { holdToRequester } from "./guard";
import type { Access } from "./rules";

/**
 * A service an administrator gave a path on the host, the Docker socket or a capability reaches the
 * server, and whatever runs in it does too. Deciding what that is stays with those who could have given
 * it that access: these are the ways round the console's refusal that would otherwise stay open.
 */

const PROJECT = "/api/v1/projects/shop";
const SERVICE = `${PROJECT}/services/web`;
const BOX = `${PROJECT}/services/dev`;
const SHARED = { type: "bind", hostPath: "/srv/shared", mountPath: "/shared" };

let context: TestContext;
let admin: string;

type Send = (path: string, method: string, body?: unknown) => Promise<CallResult<unknown>>;

const asCookie =
  (cookie: string): Send =>
  (path, method, body) =>
    call(context.app, path, { method, body, cookie, origin: TEST_ORIGIN });

const asKey =
  (token: string): Send =>
  (path, method, body) =>
    call(context.app, path, { method, body, headers: { authorization: `Bearer ${token}` } });

const asAdmin: Send = (path, method, body) => asCookie(admin)(path, method, body);

async function keyOf(cookie: string, projects: string[] | null = null): Promise<string> {
  const created = await call<CreatedApiKey>(context.app, "/api/v1/me/api-keys", {
    method: "POST",
    cookie,
    origin: TEST_ORIGIN,
    body: { name: "ci", level: "write", projects },
  });
  expect(created.status).toBe(201);
  return created.body.token;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function deploy(send: Send = asAdmin): Promise<void> {
  const accepted = await send(`${SERVICE}/deploy`, "POST");
  expect(accepted.status).toBe(202);
  const id = (accepted.body as { id: string }).id;
  await until(async () => {
    context.docker.advance(1);
    return (
      ((await asAdmin(`/api/v1/actions/${id}`, "GET")).body as { status: string }).status === "succeeded"
    );
  }, "the deployment");
}

const inBoth = (role: "operator" | "maintainer") => [
  { project: "shop", role },
  { project: "other", role },
];

/** Everyone who works on the project without an administrator's own rights. */
async function people() {
  const operator = await signInMember(context.app, admin, "operator@example.com", inBoth("operator"));
  const maintainer = await signInMember(context.app, admin, "maintainer@example.com", inBoth("maintainer"));
  return {
    "an operator at a browser": asCookie(operator),
    "a maintainer at a browser": asCookie(maintainer),
    "an operator's API key": asKey(await keyOf(operator)),
    "an administrator's key narrowed to projects": asKey(await keyOf(admin, ["shop", "other"])),
  };
}

interface Change {
  what: string;
  method: string;
  path: string;
  body?: unknown;
}

/** Everything that decides what runs in the service, as anyone working on the project could ask it. */
const CHANGES: Change[] = [
  { what: "save a script", method: "POST", path: `${SERVICE}/scripts`, body: { name: "new", script: "id" } },
  { what: "edit a script", method: "PUT", path: `${SERVICE}/scripts/0`, body: { name: "job", script: "id" } },
  { what: "remove a script", method: "DELETE", path: `${SERVICE}/scripts/0` },
  { what: "run a script", method: "POST", path: `${SERVICE}/script-runs`, body: { script: "job" } },
  { what: "change the image", method: "PUT", path: `${SERVICE}/source`, body: { image: "nginx:1.27" } },
  { what: "change the build", method: "PUT", path: `${SERVICE}/source/build`, body: { build: null } },
  {
    what: "choose a file of variables",
    method: "PUT",
    path: `${SERVICE}/source/env-file`,
    body: { path: null },
  },
  { what: "upload an archive", method: "PUT", path: `${SERVICE}/source/upload?fileName=app.tar&path=/` },
  { what: "change the command", method: "PUT", path: `${SERVICE}/advanced/deploy`, body: { command: "id" } },
  { what: "add a group", method: "PUT", path: `${SERVICE}/advanced/deploy`, body: { groups: ["999"] } },
  { what: "change the variables", method: "PUT", path: `${SERVICE}/environment`, body: { env: "A=1" } },
  {
    what: "change the build variables",
    method: "PUT",
    path: `${SERVICE}/environment/build`,
    body: { env: "A=1" },
  },
  {
    what: "set a build secret",
    method: "PUT",
    path: `${SERVICE}/environment/build/secrets/TOKEN`,
    body: { value: "x" },
  },
  { what: "remove a build secret", method: "DELETE", path: `${SERVICE}/environment/build/secrets/TOKEN` },
  {
    what: "stop passing variables to builds",
    method: "DELETE",
    path: `${SERVICE}/environment/build/inherited`,
  },
  { what: "change the project's variables", method: "PUT", path: `${PROJECT}/env`, body: { env: "A=1" } },
  {
    what: "add a volume",
    method: "POST",
    path: `${SERVICE}/storage/mounts`,
    body: { type: "volume", name: "more", mountPath: "/more" },
  },
  {
    what: "move a mount",
    method: "PUT",
    path: `${SERVICE}/storage/mounts/0`,
    body: { type: "volume", name: "data", mountPath: "/elsewhere" },
  },
  { what: "roll back", method: "POST", path: `${SERVICE}/releases/1/rollback`, body: { confirm: "web" } },
  {
    what: "restore a backup",
    method: "POST",
    path: `${SERVICE}/backups/b1/restore`,
    body: { confirm: "data" },
  },
  {
    what: "restore a file by its path",
    method: "POST",
    path: `${SERVICE}/backups/restore`,
    body: { storageProviderId: "p1", path: "shop/web.tar.gz", databaseName: "data", confirm: "data" },
  },
  {
    what: "move it to another project",
    method: "POST",
    path: `${SERVICE}/rename`,
    body: { projectName: "other", name: "web" },
  },
];

interface Given {
  method: string;
  path: string;
  body: unknown;
  /** How whoever works on the service takes it away again. */
  takeAway: Change;
}

const removeMount: Change = { what: "remove it", method: "DELETE", path: `${SERVICE}/storage/mounts/1` };

const ACCESS: Array<[string, Given]> = [
  [
    "a path on the host",
    { method: "POST", path: `${SERVICE}/storage/mounts`, body: SHARED, takeAway: removeMount },
  ],
  [
    "the Docker socket",
    {
      method: "POST",
      path: `${SERVICE}/storage/mounts`,
      body: {
        type: "bind",
        hostPath: "/var/run/docker.sock",
        mountPath: "/var/run/docker.sock",
        acknowledgeRisk: true,
      },
      takeAway: removeMount,
    },
  ],
  [
    "an added capability",
    {
      method: "PUT",
      path: `${SERVICE}/advanced/deploy`,
      body: { capAdd: ["NET_ADMIN"] },
      takeAway: { what: "drop it", method: "PUT", path: `${SERVICE}/advanced/deploy`, body: { capAdd: [] } },
    },
  ],
];

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  expect((await asAdmin("/api/v1/projects", "POST", { name: "shop" })).status).toBe(201);
  expect((await asAdmin("/api/v1/projects", "POST", { name: "other" })).status).toBe(201);
  expect((await asAdmin(`${PROJECT}/services`, "POST", { name: "web" })).status).toBe(201);
  expect((await asAdmin(`${SERVICE}/source`, "PUT", { image: "nginx:alpine" })).status).toBe(200);
  const volume = { type: "volume", name: "data", mountPath: "/data" };
  expect((await asAdmin(`${SERVICE}/storage/mounts`, "POST", volume)).status).toBe(201);
  expect((await asAdmin(`${SERVICE}/scripts`, "POST", { name: "job", script: "echo hi" })).status).toBe(201);
});

afterEach(async () => {
  await context.close();
});

describe.each(ACCESS)("a service given %s", (_label, given) => {
  beforeEach(async () => {
    expect((await asAdmin(given.path, given.method, given.body)).status).toBeLessThan(300);
  });

  it("refuses everyone but an administrator anything that decides what runs in it", async () => {
    for (const [who, send] of Object.entries(await people())) {
      for (const change of CHANGES) {
        const answer = await send(change.path, change.method, change.body);
        expect(answer.status, `${who} asking to ${change.what}`).toBe(403);
        expect(apiErrorOf(answer).code, `${who} asking to ${change.what}`).toBe("service_reaches_server");
      }
    }
    expect(context.docker.execs).toHaveLength(0);
    const { scripts } = (await asAdmin(`${SERVICE}/scripts`, "GET")).body as {
      scripts: Array<{ name: string }>;
    };
    expect(scripts.map((script) => script.name)).toEqual(["job"]);
  });

  it("leaves it to an administrator, at a browser or with a key of their own", async () => {
    for (const send of [asAdmin, asKey(await keyOf(admin))]) {
      expect((await send(`${SERVICE}/environment`, "PUT", { env: "A=1" })).status).toBe(200);
      expect((await send(`${SERVICE}/source`, "PUT", { image: "nginx:1.27" })).status).toBe(200);
      const deploySettings = { command: "id", capAdd: ["NET_ADMIN"] };
      expect((await send(`${SERVICE}/advanced/deploy`, "PUT", deploySettings)).status).toBe(200);
      expect((await send(`${PROJECT}/env`, "PUT", { env: "A=1" })).status).toBe(200);
      expect((await send(`${SERVICE}/scripts/0`, "PUT", { name: "job", script: "echo again" })).status).toBe(
        200,
      );
    }
  });

  it("still lets the project's people deploy it, read it, and take away what it was given", async () => {
    const operator = (await people())["an operator at a browser"];
    await deploy();
    await deploy(operator);
    expect((await operator(`${SERVICE}/environment`, "GET")).status).toBe(200);
    expect((await operator(`${SERVICE}/script-runs`, "GET")).status).toBe(200);

    const { takeAway } = given;
    expect((await operator(takeAway.path, takeAway.method, takeAway.body)).status).toBe(200);
    expect((await operator(`${SERVICE}/environment`, "PUT", { env: "A=1" })).status).toBe(200);
  });
});

describe("a service that does not reach the server", () => {
  it("lets its operators change what runs in it, as before", async () => {
    const everyone = await people();
    for (const send of [everyone["an operator at a browser"], everyone["an operator's API key"]]) {
      expect((await send(`${SERVICE}/scripts/0`, "PUT", { name: "job", script: "echo mine" })).status).toBe(
        200,
      );
      expect((await send(`${SERVICE}/script-runs`, "POST", { script: "job" })).status).toBe(202);
      await until(async () => {
        const runs = (await send(`${SERVICE}/script-runs`, "GET")).body as {
          items: Array<{ status: string }>;
        };
        return runs.items.every((run) => run.status !== "queued" && run.status !== "running");
      }, "the run to end");
      expect((await send(`${SERVICE}/source`, "PUT", { image: "nginx:1.27" })).status).toBe(200);
      expect((await send(`${SERVICE}/advanced/deploy`, "PUT", { command: "id" })).status).toBe(200);
      expect((await send(`${SERVICE}/environment`, "PUT", { env: "A=1" })).status).toBe(200);
      expect((await send(`${PROJECT}/env`, "PUT", { env: "A=1" })).status).toBe(200);
      const moved = { type: "volume", name: "data", mountPath: "/elsewhere" };
      expect((await send(`${SERVICE}/storage/mounts/0`, "PUT", moved)).status).toBe(200);
    }
  });
});

describe("a box that reaches the server", () => {
  beforeEach(async () => {
    expect((await asAdmin(`${PROJECT}/box`, "POST", { name: "dev" })).status).toBe(201);
    expect((await asAdmin(`${BOX}/storage/mounts`, "POST", SHARED)).status).toBe(201);
  });

  const BOX_CHANGES: Change[] = [
    { what: "save its hooks", method: "PUT", path: `${BOX}/box/hooks`, body: { build: "", start: "id" } },
    { what: "save its processes", method: "PUT", path: `${BOX}/box/processes`, body: { processes: [] } },
    { what: "save its modules", method: "PUT", path: `${BOX}/box/modules`, body: {} },
    { what: "apply a preset", method: "POST", path: `${BOX}/box/preset`, body: { preset: "static-site" } },
    { what: "turn its IDE on", method: "PUT", path: `${BOX}/box/ide`, body: { enabled: true } },
    { what: "issue an IDE token", method: "POST", path: `${BOX}/box/ide/token`, body: { expiresInHours: 1 } },
  ];

  it("keeps what it builds, starts and edits to an administrator", async () => {
    const operator = (await people())["an operator at a browser"];
    for (const change of BOX_CHANGES) {
      const answer = await operator(change.path, change.method, change.body);
      expect(answer.status, change.what).toBe(403);
      expect(apiErrorOf(answer).code, change.what).toBe("service_reaches_server");
    }
    expect((await operator(`${BOX}/box/ide`, "PUT", { enabled: false })).status).toBe(200);

    for (const change of BOX_CHANGES) {
      expect((await asAdmin(change.path, change.method, change.body)).status, change.what).toBe(200);
    }
  });
});

describe("a source saved while its remote takes its time", () => {
  it("is refused when an administrator gave the service a path on the host meanwhile", async () => {
    const tools = context.deps.tools as FakeTools;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let probing = false;
    tools.handler = async (request) => {
      if (request.command === "git" && request.args.includes("ls-remote")) {
        probing = true;
        await gate;
      }
      return undefined;
    };
    const operator = (await people())["an operator at a browser"];
    const pending = operator(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/operator/app.git",
      ref: "main",
      path: "/",
    });
    await until(() => probing, "the probe of the operator's remote");
    expect((await asAdmin(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    release();

    const answer = await pending;
    expect(answer.status).toBe(403);
    expect(apiErrorOf(answer).code).toBe("service_reaches_server");
    expect(JSON.stringify((await asAdmin(`${SERVICE}/source`, "GET")).body)).not.toContain(
      "operator/app.git",
    );
  });
});

describe("a box whose running task keeps a path on the host its settings no longer give", () => {
  it("keeps its IDE, its processes and its workspace to an administrator until a deploy replaces it", async () => {
    expect((await asAdmin(`${PROJECT}/box`, "POST", { name: "dev", preset: "node-service" })).status).toBe(
      201,
    );
    expect((await asAdmin(`${BOX}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    const deployed = await asAdmin(`${BOX}/deploy`, "POST", {});
    expect(deployed.status).toBe(202);
    const id = (deployed.body as { id: string }).id;
    await until(async () => {
      context.docker.advance(1);
      return (
        ((await asAdmin(`/api/v1/actions/${id}`, "GET")).body as { status: string }).status === "succeeded"
      );
    }, "the box's deployment");

    // Taking the path out is allowed: the task keeps it until the next deploy.
    const operator = (await people())["an operator at a browser"];
    const { mounts } = (await asAdmin(`${BOX}/storage`, "GET")).body as { mounts: Array<{ type: string }> };
    const index = mounts.findIndex((mount) => mount.type === "bind");
    expect((await operator(`${BOX}/storage/mounts/${index}`, "DELETE")).status).toBe(200);
    const { processes } = (await asAdmin(`${BOX}/box`, "GET")).body as { processes: Array<{ name: string }> };

    for (const change of [
      { what: "turn its IDE on", method: "PUT", path: `${BOX}/box/ide`, body: { enabled: true } },
      {
        what: "issue an IDE token",
        method: "POST",
        path: `${BOX}/box/ide/token`,
        body: { expiresInHours: 1 },
      },
      {
        what: "restart a process",
        method: "POST",
        path: `${BOX}/box/processes/${processes[0]?.name}/restart`,
      },
      { what: "apply a preset", method: "POST", path: `${BOX}/box/preset`, body: { preset: "static-site" } },
    ]) {
      const answer = await operator(change.path, change.method, change.body);
      expect(answer.status, change.what).toBe(403);
      expect(apiErrorOf(answer).code, change.what).toBe("service_reaches_server");
    }

    // A token an administrator issues opens the IDE; the operator's own would not.
    expect((await asAdmin(`${BOX}/box/ide`, "PUT", { enabled: true })).status).toBe(200);
    const issued = await asAdmin(`${BOX}/box/ide/token`, "POST", { expiresInHours: 1 });
    const token = (issued.body as { token: string }).token;
    const session = await call(context.app, "/api/v1/ide/shop/dev/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
  });
});

describe("a stopped box whose Swarm spec keeps a path on the host its settings no longer give", () => {
  it("keeps its IDE and workspace to an administrator, since starting it brings the path back", async () => {
    expect((await asAdmin(`${PROJECT}/box`, "POST", { name: "dev", preset: "node-service" })).status).toBe(
      201,
    );
    expect((await asAdmin(`${BOX}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    const settled = async (accepted: CallResult<unknown>) => {
      expect(accepted.status).toBe(202);
      const id = (accepted.body as { id: string }).id;
      await until(async () => {
        context.docker.advance(1);
        const { status } = (await asAdmin(`/api/v1/actions/${id}`, "GET")).body as { status: string };
        return status !== "queued" && status !== "running";
      }, "the action");
    };
    await settled(await asAdmin(`${BOX}/deploy`, "POST", {}));
    const operator = (await people())["an operator at a browser"];
    const { mounts } = (await asAdmin(`${BOX}/storage`, "GET")).body as { mounts: Array<{ type: string }> };
    const index = mounts.findIndex((mount) => mount.type === "bind");
    expect((await operator(`${BOX}/storage/mounts/${index}`, "DELETE")).status).toBe(200);
    await settled(await operator(`${BOX}/stop`, "POST"));

    for (const change of [
      { what: "turn its IDE on", method: "PUT", path: `${BOX}/box/ide`, body: { enabled: true } },
      {
        what: "issue an IDE token",
        method: "POST",
        path: `${BOX}/box/ide/token`,
        body: { expiresInHours: 1 },
      },
      { what: "apply a preset", method: "POST", path: `${BOX}/box/preset`, body: { preset: "static-site" } },
    ]) {
      const answer = await operator(change.path, change.method, change.body);
      expect(answer.status, change.what).toBe(403);
      expect(apiErrorOf(answer).code, change.what).toBe("service_reaches_server");
    }
  });
});

describe("an IDE token in a box given a path on the host since", () => {
  const session = (token: string) =>
    call(context.app, "/api/v1/ide/shop/dev/session", { headers: { authorization: `Bearer ${token}` } });

  async function issue(send: Send): Promise<string> {
    expect((await send(`${BOX}/box/ide`, "PUT", { enabled: true })).status).toBe(200);
    const issued = await send(`${BOX}/box/ide/token`, "POST", { expiresInHours: 1 });
    expect(issued.status).toBe(200);
    return (issued.body as { token: string }).token;
  }

  beforeEach(async () => {
    expect((await asAdmin(`${PROJECT}/box`, "POST", { name: "dev" })).status).toBe(201);
  });

  it("stops working when an operator issued it", async () => {
    const token = await issue((await people())["an operator at a browser"]);
    expect((await session(token)).status).toBe(200);

    expect((await asAdmin(`${BOX}/storage/mounts`, "POST", SHARED)).status).toBe(201);

    const refused = await session(token);
    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("service_reaches_server");
    const written = await call(context.app, "/api/v1/ide/shop/dev/file", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: { path: "start.sh", content: "id\n" },
    });
    expect(written.status).toBe(403);
  });

  it("keeps working when an administrator issued it", async () => {
    const token = await issue(asAdmin);
    expect((await asAdmin(`${BOX}/storage/mounts`, "POST", SHARED)).status).toBe(201);

    expect((await session(token)).status).toBe(200);
  });
});

describe("a database given a path on the host", () => {
  const DATABASE = `${PROJECT}/services/cache`;
  const ADVANCED = `${DATABASE}/database-advanced`;

  beforeEach(async () => {
    expect((await asAdmin(`${PROJECT}/databases`, "POST", { name: "cache", engine: "redis" })).status).toBe(
      201,
    );
    expect((await asAdmin(`${DATABASE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
  });

  it("leaves its image, command, variables and config file to an administrator", async () => {
    const {
      image,
      command: saved,
      configFile,
    } = (await asAdmin(ADVANCED, "GET")).body as {
      image: string;
      command: string;
      configFile: string;
    };
    const current = { image, command: saved, configFile };
    const command = 'redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 64mb';
    const operator = (await people())["an operator's API key"];

    for (const change of [{ command }, { image: "redis:7.4.9" }, { env: "TZ=UTC" }, { configFile: "x" }]) {
      const refused = await operator(ADVANCED, "PUT", { ...current, ...change });
      expect(refused.status, JSON.stringify(change)).toBe(403);
      expect(apiErrorOf(refused).code).toBe("service_reaches_server");
    }
    expect((await operator(ADVANCED, "PUT", current)).status).toBe(200);
    expect((await asAdmin(ADVANCED, "PUT", { ...current, command })).status).toBe(200);
  });

  it("keeps its superuser's password to an administrator", async () => {
    const operator = (await people())["an operator at a browser"];
    const CREDENTIALS = `${DATABASE}/credentials`;

    const revealed = await operator(`${CREDENTIALS}/reveal`, "POST", { secret: "password" });
    expect(revealed.status).toBe(403);
    expect(apiErrorOf(revealed).code).toBe("service_reaches_server");
    const changed = await operator(CREDENTIALS, "PUT", { password: "AnotherPassword4Tests" });
    expect(changed.status).toBe(403);
    expect((await asAdmin(`${CREDENTIALS}/reveal`, "POST", { secret: "password" })).status).toBe(200);
  });
});

describe("work queued now that acts on the service later", () => {
  it("is asked again when it starts, against the service and the person as they are then", async () => {
    const [adminRow, operatorRow] = await Promise.all(
      ["admin@example.com", "op2@example.com"].map(async (email) => {
        if (email !== "admin@example.com") {
          await signInMember(context.app, admin, email, [{ project: "shop", role: "operator" }]);
        }
        return context.deps.db.select().from(users).where(eq(users.email, email)).get();
      }),
    );
    const accessOfUser = (id: string, isAdmin: boolean) =>
      ({ admin: isAdmin, scoped: false, principal: { user: { id } } }) as unknown as Access;
    const target = { projectName: "shop", serviceName: "web" };
    const byOperator = holdToRequester(context.deps, accessOfUser(operatorRow?.id as string, false), target);
    const byAdmin = holdToRequester(context.deps, accessOfUser(adminRow?.id as string, true), target);

    await expect(byOperator()).resolves.toBeUndefined();
    expect((await asAdmin(`${SERVICE}/storage/mounts`, "POST", SHARED)).status).toBe(201);
    await expect(byOperator()).rejects.toMatchObject({ code: "service_reaches_server" });
    await expect(byAdmin()).resolves.toBeUndefined();
  });
});
