import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionEntry, ActionPage, ProjectList, ServiceDetail } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorOf, type CallResult } from "../../../apps/server/src/testing/harness";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";
import { COMMANDS } from "./commands";
import { englishMessages, frenchMessages } from "./messages";

let panel: LivePanel;
let fullKey: string;

beforeAll(async () => {
  panel = await startLivePanel();
  fullKey = (await panel.createKey({ name: "full", level: "write" })).token;
  await panel.deploy("shop", "web");
});

afterAll(async () => {
  await panel.close();
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  key: string | undefined,
  argv: string[],
  overrides: Partial<CliRuntime> = {},
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env: {
      OPSIFIER_URL: panel.url,
      ...(key === undefined ? {} : { OPSIFIER_API_KEY: key }),
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    signal: new AbortController().signal,
    // Never the user's own keys: a file that does not exist.
    credentialsFile: join(tmpdir(), `opsifier-no-credentials-${process.pid}`, "credentials.json"),
    ...overrides,
  });
  return { code, stdout, stderr };
}

const jsonOf = <T = unknown>(result: CliResult): T => JSON.parse(result.stdout) as T;
const errorOf = (result: CliResult) =>
  (JSON.parse(result.stderr) as { error: { code: string; message: string; status?: number; hint?: string } })
    .error;

const API = "/api/v1/projects";
const WEB = `${API}/shop/services/web`;

describe("the key comes from the environment", () => {
  it("and from nowhere else", async () => {
    const result = await run(undefined, ["projects"]);

    expect(result.code).toBe(3);
    expect(errorOf(result)).toMatchObject({ code: "not_configured" });
    expect(errorOf(result).message).toContain("OPSIFIER_API_KEY");
  });

  it("is refused as a flag, with a pointer to the environment", async () => {
    const result = await run(undefined, ["projects", "--api-key", "opsifier_x"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("OPSIFIER_API_KEY");
  });

  it("never appears in anything printed", async () => {
    const results = await Promise.all([
      run(fullKey, ["projects"]),
      run(fullKey, ["status", "nope/nope"]),
      run(fullKey, ["whoami"]),
    ]);
    for (const result of results) {
      expect(result.stdout).not.toContain(fullKey);
      expect(result.stderr).not.toContain(fullKey);
    }
  });
});

describe("output", () => {
  it("is JSON for anything that is not a terminal", async () => {
    const result = await run(fullKey, ["projects"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ProjectList>(result).projects.map((project) => project.name)).toEqual(["secret", "shop"]);
  });

  it("is text at a terminal, and JSON when asked for it there", async () => {
    const text = await run(fullKey, ["projects"], { isTTY: true });
    expect(() => JSON.parse(text.stdout)).toThrow();
    expect(text.stdout).toContain("shop");

    const forced = await run(fullKey, ["projects", "--json"], { isTTY: true });
    expect(jsonOf<ProjectList>(forced).projects).toHaveLength(2);
  });

  it("reports an error as JSON too, in the API's shape, on stderr", async () => {
    const result = await run(fullKey, ["status", "shop/missing"]);

    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
    expect(errorOf(result)).toMatchObject({ code: "not_found", status: 404 });
  });

  it("explains a mistake in text at a terminal", async () => {
    const result = await run(fullKey, ["status", "shop/missing"], { isTTY: true });

    expect(result.stderr).toContain("This service does not exist.");
    expect(result.stderr).toContain("Hint:");
  });

  it("is in French where the environment says so, with the API's own words left alone", async () => {
    const result = await run(fullKey, ["projects"], {
      isTTY: true,
      env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: fullKey, LANG: "fr_FR.UTF-8" },
    });
    expect(result.stdout).toContain("PROJET");
    expect(result.stdout).toContain("en marche");
  });

  it("exits with a code that says what happened", async () => {
    expect((await run(fullKey, ["status", "shop/missing"])).code).toBe(5);
    expect((await run(fullKey, ["nosuchcommand"])).code).toBe(2);
    expect((await run("not-a-valid-key", ["projects"])).code).toBe(3);
  });
});

describe("a command gives what the API gives", () => {
  it.each([
    [["projects"], API],
    [["status"], API],
    [["services", "shop"], `${API}/shop`],
    [["status", "shop"], `${API}/shop`],
    [["status", "shop/web"], WEB],
    [["deployments", "shop/web", "-n", "5"], `${WEB}/deployments?limit=5`],
    [["actions", "--project", "shop", "-n", "3"], "/api/v1/actions?projectName=shop&limit=3"],
    [["logs", "shop/web", "-n", "5"], `${WEB}/logs/search?limit=5`],
    [["whoami"], "/api/v1/auth/identity"],
  ])("%j is %s", async (argv, path) => {
    const viaCli = await run(fullKey, argv);
    const viaApi = await panel.direct(fullKey, "GET", path);

    expect(viaCli.code).toBe(0);
    expect(viaApi.status).toBe(200);
    expect(jsonOf(viaCli)).toEqual(viaApi.body);
  });

  it("deploying records the same thing the API would, under the key's own name", async () => {
    const result = await run(fullKey, ["deploy", "shop/web"]);
    const action = jsonOf<ActionEntry>(result);

    expect(result.code).toBe(0);
    expect(action).toMatchObject({ type: "service.deploy", projectName: "shop", serviceName: "web" });
    expect(action.origin).toBe("api_key");
    expect(action.actorEmail).toBe("admin@example.com");
    expect(action.originDetail).toBe("full");

    const viaApi = await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?projectName=shop&limit=1");
    expect(viaApi.body.items[0]?.id).toBe(action.id);
  });

  it("restarting returns the Action the API would", async () => {
    await idle();
    const result = await run(fullKey, ["restart", "shop/web"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ActionEntry>(result).type).toBe("service.restart");
  });

  it("the generic call is the same call", async () => {
    const viaCli = await run(fullKey, ["api", "GET", `${WEB}`]);
    const viaApi = await panel.direct<ServiceDetail>(fullKey, "GET", WEB);

    expect(jsonOf(viaCli)).toEqual(viaApi.body);
    expect(jsonOf(await run(fullKey, ["api", "GET", "/projects/shop/services/web"]))).toEqual(viaApi.body);
  });

  it("the catalogue shows what this key may call, read off the panel itself", async () => {
    const entries = jsonOf<Array<{ method: string; path: string; kind: string }>>(
      await run(fullKey, ["api", "list", "deploy"]),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: `${API}/{project}/services/{service}/deploy`,
        kind: "change",
      }),
    );
    expect(entries.every((entry) => !entry.path.startsWith("/api/v1/auth/"))).toBe(true);
  });
});

/** The CLI's answer has to be the API's own: same status, same code, same message. */
function expectSameRefusal(cli: CliResult, api: CallResult<unknown>) {
  const viaApi = apiErrorOf(api);
  const viaCli = errorOf(cli);
  expect(viaCli.code).toBe(viaApi.code);
  expect(viaCli.message).toBe(viaApi.message);
  expect(viaCli.status).toBe(api.status);
}

describe("a limited key", () => {
  it("that only reads cannot deploy, exactly as the API refuses it", async () => {
    const key = (await panel.createKey({ name: "reader", level: "read" })).token;
    const before = await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100");

    const viaCli = await run(key, ["deploy", "shop/web"]);
    const viaApi = await panel.direct(key, "POST", `${WEB}/deploy`, {});

    expect(viaCli.code).toBe(4);
    expectSameRefusal(viaCli, viaApi);
    const after = await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100");
    expect(after.body.items.map((item) => item.id)).toEqual(before.body.items.map((item) => item.id));
  });

  it("limited to some projects sees nothing of the others, exactly as the API", async () => {
    const key = (await panel.createKey({ name: "shop-only", level: "write", projects: ["shop"] })).token;

    const projects = await run(key, ["projects"]);
    expect(jsonOf<ProjectList>(projects).projects.map((project) => project.name)).toEqual(["shop"]);

    const viaCli = await run(key, ["status", "secret/web"]);
    const viaApi = await panel.direct(key, "GET", `${API}/secret/services/web`);
    expect(viaCli.code).toBe(5);
    expectSameRefusal(viaCli, viaApi);
  });

  it("of a viewer can see the inventory and nothing more, exactly as the API", async () => {
    const member = await panel.createMember("viewer@example.com", [{ project: "shop", role: "viewer" }]);
    const key = (await panel.createKey({ name: "viewer", level: "write" }, member)).token;

    expect((await run(key, ["status", "shop/web"])).code).toBe(0);

    const deploy = await run(key, ["deploy", "shop/web"]);
    expect(deploy.code).toBe(4);
    expectSameRefusal(deploy, await panel.direct(key, "POST", `${WEB}/deploy`, {}));

    const logs = await run(key, ["logs", "shop/web"]);
    expect(logs.code).toBe(4);
    expectSameRefusal(logs, await panel.direct(key, "GET", `${WEB}/logs/search`));
  });

  it("can never do what only a person at a browser can", async () => {
    const keys = await run(fullKey, ["api", "GET", "/me/api-keys"]);
    expect(keys.code).toBe(4);
    expectSameRefusal(keys, await panel.direct(fullKey, "GET", "/api/v1/me/api-keys"));

    const users = await run(fullKey, ["api", "POST", "/users", "-d", '{"email":"a@b.co","password":"x"}']);
    expect(users.code).toBe(4);
    expectSameRefusal(
      users,
      await panel.direct(fullKey, "POST", "/api/v1/users", { email: "a@b.co", password: "x" }),
    );
  });
});

describe("a key that has ended", () => {
  it("stops working through the CLI the moment it is revoked", async () => {
    const created = await panel.createKey({ name: "revoked", level: "write" });
    expect((await run(created.token, ["projects"])).code).toBe(0);

    await panel.session("DELETE", `/api/v1/me/api-keys/${created.id}`);

    const viaCli = await run(created.token, ["projects"]);
    const viaApi = await panel.direct(created.token, "GET", API);
    expect(viaCli.code).toBe(3);
    expect(errorOf(viaCli).code).toBe("invalid_token");
    expectSameRefusal(viaCli, viaApi);
  });

  it("stops working when it expires", async () => {
    const expiring = await panel.session<{ token: string }>("POST", "/api/v1/me/api-keys", {
      name: "short",
      level: "write",
      expiresInDays: 1,
    });
    expect((await run(expiring.body.token, ["projects"])).code).toBe(0);

    panel.context.advance(2 * 24 * 60 * 60 * 1000);

    const result = await run(expiring.body.token, ["projects"]);
    expect(result.code).toBe(3);
    expect(errorOf(result).code).toBe("invalid_token");
  });
});

describe("a redirect", () => {
  it("is refused, and the key does not follow it", async () => {
    const seen: Array<string | undefined> = [];
    const elsewhere = await listen((authorization) => seen.push(authorization));
    const redirecting = createServer((_request, response) => {
      response.writeHead(302, { location: `${elsewhere.url}/api/v1/projects` }).end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const { port } = redirecting.address() as { port: number };

    const result = await run(fullKey, ["projects"], {
      env: { OPSIFIER_URL: `http://127.0.0.1:${port}`, OPSIFIER_API_KEY: fullKey },
    });

    await new Promise((resolve) => redirecting.close(resolve));
    await elsewhere.close();
    expect(result.code).toBe(7);
    expect(errorOf(result).code).toBe("redirect_refused");
    expect(seen).toEqual([]);
  });
});

function listen(
  onRequest: (authorization: string | undefined) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      onRequest(request.headers.authorization);
      response.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("destructive commands", () => {
  const actionCount = async () =>
    (await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100")).body.items.length;

  it("refuse stop without --yes and send nothing", async () => {
    const before = await actionCount();

    const result = await run(fullKey, ["stop", "shop/web"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).code).toBe("confirmation_required");
    expect(await actionCount()).toBe(before);
  });

  it("refuse destroy without --confirm, and leave a wrong name to the server to refuse", async () => {
    const withoutConfirm = await run(fullKey, ["destroy", "secret/web"]);
    expect(withoutConfirm.code).toBe(2);
    expect(errorOf(withoutConfirm).code).toBe("confirmation_required");

    const wrong = await run(fullKey, ["destroy", "secret/web", "--confirm", "other"]);
    expect(wrong.code).toBe(6);
    expect(errorOf(wrong).code).toBe("confirmation_mismatch");

    expect((await panel.direct(fullKey, "GET", `${API}/secret/services/web`)).status).toBe(200);
  });

  it("refuse the generic DELETE without --yes", async () => {
    const result = await run(fullKey, ["api", "DELETE", `${API}/shop`, "-d", '{"confirm":"shop"}']);

    expect(result.code).toBe(2);
    expect(errorOf(result).code).toBe("confirmation_required");
    expect((await panel.direct(fullKey, "GET", `${API}/shop`)).status).toBe(200);
  });

  it("go through once confirmed", async () => {
    await idle();
    const stopped = await run(fullKey, ["stop", "shop/web", "--yes"]);
    expect(stopped.code).toBe(0);
    expect(jsonOf<ActionEntry>(stopped).type).toBe("service.stop");
  });
});

describe("logs", () => {
  it("passes the filters to the API as it wrote them", async () => {
    const seen: string[] = [];
    await run(
      fullKey,
      ["logs", "shop/web", "--since", "2h", "--grep", "boom", "--stream", "stderr", "-n", "7"],
      {
        fetch: (input, init) => {
          seen.push(String(input));
          return fetch(input, init);
        },
      },
    );

    const url = new URL(seen[0] as string);
    expect(url.pathname).toBe(`${WEB}/logs/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "boom",
      stream: "stderr",
      since: "7200",
      limit: "7",
    });
  });

  it("refuses a duration it cannot read", async () => {
    const result = await run(fullKey, ["logs", "shop/web", "--since", "soon"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).code).toBe("usage");
  });

  it("follows new lines as they are written, once each, until stopped", async () => {
    panel.context.docker.writeLog("shop_web", "before following");
    const abort = new AbortController();
    let output = "";
    const following = run(fullKey, ["logs", "shop/web", "--follow"], {
      signal: abort.signal,
      stdout: (text) => {
        output += text;
      },
    });

    await until(() => output.includes("before following"));
    panel.context.docker.writeLog("shop_web", "written while following");
    await until(() => output.includes("written while following"), 8_000);
    abort.abort();

    expect((await following).code).toBe(0);
    const lines = output.trim().split("\n");
    expect(lines.filter((line) => line.includes("written while following"))).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toHaveProperty("line");
  }, 20_000);
});

/** Waits out whatever is still running on shop/web, which would make the panel refuse the next thing. */
async function idle() {
  await untilAsync(async () => {
    const service = await panel.direct<ServiceDetail>(fullKey, "GET", WEB);
    return service.body.activeAction === null;
  });
}

async function untilAsync(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the messages", () => {
  it("exist in English and in French, every one of them", () => {
    expect(Object.keys(frenchMessages).sort()).toEqual(Object.keys(englishMessages).sort());
    for (const value of [...Object.values(englishMessages), ...Object.values(frenchMessages)]) {
      expect(value.length).toBeGreaterThan(0);
    }
    for (const command of COMMANDS) {
      expect(englishMessages, command.name).toHaveProperty(`cmd.${command.name}`);
    }
  });
});
