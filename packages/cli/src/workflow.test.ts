import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionDetail,
  type ActionPage,
  type EnvDocument,
  parseEnvText,
  type ReleaseList,
  type ServiceDetail,
  type ServiceEnvironment,
} from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorOf } from "../../../apps/server/src/testing/harness";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";
import { LINK_FILE } from "./link";

let panel: LivePanel;
let key: string;
let scratch: string;

beforeAll(async () => {
  panel = await startLivePanel();
  key = (await panel.createKey({ name: "workflow", level: "write" })).token;
  await panel.deploy("shop", "web");
  scratch = await mkdtemp(join(tmpdir(), "opsifier-cli-"));
});

afterAll(async () => {
  await panel.close();
  await rm(scratch, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A fresh, empty folder for each test that needs one, so that no link leaks between them. */
async function folder(name: string): Promise<string> {
  const path = join(scratch, name);
  await mkdir(path, { recursive: true });
  return path;
}

async function run(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    signal: new AbortController().signal,
    cwd: await folder("nowhere"),
    credentialsFile: join(scratch, "no-credentials.json"),
    ...overrides,
  });
  return { code, stdout, stderr };
}

const jsonOf = <T = unknown>(result: CliResult): T => JSON.parse(result.stdout) as T;
const errorOf = (result: CliResult) =>
  (JSON.parse(result.stderr) as { error: { code: string; message: string; status?: number } }).error;

const API = "/api/v1/projects";
const WEB = `${API}/shop/services/web`;
const origin = () => new URL(panel.url).origin;

async function idle(project = "shop") {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const service = await panel.direct<ServiceDetail>(key, "GET", `${API}/${project}/services/web`);
    if (service.body.activeAction === null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("The service never became idle.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const actionIds = async () =>
  (await panel.direct<ActionPage>(key, "GET", "/api/v1/actions?limit=100")).body.items.map((item) => item.id);

describe("a linked folder", () => {
  it("is linked once the panel knows the service, with the panel's address kept beside it", async () => {
    const here = await folder("linked");

    const result = await run(["link", "shop/web"], { cwd: here });

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual({ service: "shop/web", panel: origin(), file: join(here, LINK_FILE) });
    expect(JSON.parse(await readFile(join(here, LINK_FILE), "utf8"))).toEqual({
      service: "shop/web",
      panel: origin(),
    });
  });

  it("is not linked to a service that does not exist", async () => {
    const here = await folder("typo");

    const result = await run(["link", "shop/wbe"], { cwd: here });

    expect(result.code).toBe(5);
    await expect(readFile(join(here, LINK_FILE), "utf8")).rejects.toThrow();
  });

  it("gives its service to commands run in it or in a folder below it", async () => {
    const below = join(await folder("linked"), "src", "deep");
    await mkdir(below, { recursive: true });

    const result = await run(["deployments", "-n", "1"], { cwd: below });

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual((await panel.direct(key, "GET", `${WEB}/deployments?limit=1`)).body);
  });

  it("gives way to a service named on the command line, then to OPSIFIER_SERVICE", async () => {
    const here = await folder("linked");
    const secret = (await panel.direct(key, "GET", `${API}/secret/services/web/releases`)).body;

    expect(jsonOf(await run(["releases", "secret/web"], { cwd: here }))).toEqual(secret);
    const fromEnvironment = await run(["releases"], {
      cwd: here,
      env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key, OPSIFIER_SERVICE: "secret/web" },
    });
    expect(jsonOf(fromEnvironment)).toEqual(secret);
  });

  it("never acts on a service of another panel than the one it was linked on", async () => {
    const here = await folder("elsewhere");
    await writeFile(
      join(here, LINK_FILE),
      JSON.stringify({ service: "shop/web", panel: "https://panel.elsewhere.example" }),
    );
    const before = await actionIds();

    const result = await run(["deploy"], { cwd: here });

    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("panel.elsewhere.example");
    expect(await actionIds()).toEqual(before);
  });

  it("says how to name the service when nothing names it", async () => {
    const result = await run(["logs"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("opsifier link");
  });

  it("says a failure on this machine is not the panel's, with exit code 1", async () => {
    const locked = await folder("read-only");
    await chmod(locked, 0o555);

    const result = await run(["link", "shop/web"], { cwd: locked });

    await chmod(locked, 0o755);
    expect(result.code).toBe(1);
  });

  it("is unlinked from its own folder only, and without a panel", async () => {
    const here = await folder("unlinking");
    await run(["link", "shop/web"], { cwd: here });
    const below = join(here, "below");
    await mkdir(below, { recursive: true });

    const fromBelow = await run(["unlink"], { cwd: below, env: {} });
    expect(fromBelow.code).toBe(0);
    expect(jsonOf(fromBelow)).toMatchObject({ removed: false });

    const fromHere = await run(["unlink"], { cwd: here, env: {} });
    expect(jsonOf(fromHere)).toMatchObject({ removed: true });
    await expect(readFile(join(here, LINK_FILE), "utf8")).rejects.toThrow();
  });
});

describe("waiting for an action", () => {
  it("returns once the deployment has ended, with how it ended", async () => {
    await idle();

    const result = await run(["deploy", "shop/web", "--wait"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ActionDetail>(result)).toMatchObject({ type: "service.deploy", status: "succeeded" });
  }, 20_000);

  it("shows a person the output as it comes, then how long it took", async () => {
    await idle();

    const result = await run(["restart", "shop/web", "--wait"], { isTTY: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("on shop/web, action ");
    expect(result.stdout).toMatch(/succeeded in \d+s/);
  }, 20_000);

  it("ends with exit code 1 when the action fails, the action itself on standard output", async () => {
    await idle();
    panel.context.docker.failNext("pullImage");

    const result = await run(["deploy", "shop/web", "--wait"]);

    expect(result.code).toBe(1);
    expect(jsonOf<ActionDetail>(result).status).toBe("failed");
    expect(errorOf(result).code).toBe("action_failed");
  }, 20_000);
});

describe("releases and rollback", () => {
  it("lists the versions exactly as the API does", async () => {
    const result = await run(["releases", "shop/web"]);

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual((await panel.direct(key, "GET", `${WEB}/releases`)).body);
  });

  it("goes back to the version before the running one, once its name is confirmed", async () => {
    await idle();
    await panel.deploy("shop", "web");
    const before = (await panel.direct<ReleaseList>(key, "GET", `${WEB}/releases`)).body;
    const running = before.items.find((release) => release.active);
    const previous = before.items
      .filter(
        (release) => running !== undefined && release.number < running.number && release.refusal === null,
      )
      .sort((a, b) => b.number - a.number)[0];
    expect(previous).toBeDefined();

    const unconfirmed = await run(["rollback", "shop/web"]);
    expect(unconfirmed.code).toBe(2);
    expect(errorOf(unconfirmed).code).toBe("confirmation_required");
    expect(errorOf(unconfirmed).message).toContain(`v${previous?.number}`);
    expect(errorOf(unconfirmed).message).toContain("--confirm web");

    const result = await run(["rollback", "shop/web", "--confirm", "web", "--wait"]);
    expect(result.code).toBe(0);
    expect(jsonOf<ActionDetail>(result).status).toBe("succeeded");

    const after = (await panel.direct<ReleaseList>(key, "GET", `${WEB}/releases`)).body;
    expect(after.items.find((release) => release.active)?.rollbackOf).toBe(previous?.number);
  }, 30_000);

  it("leaves a wrong name to the panel to refuse", async () => {
    await idle();
    const list = (await panel.direct<ReleaseList>(key, "GET", `${WEB}/releases`)).body;
    const version = list.items.find((release) => !release.active)?.number ?? 1;

    const result = await run(["rollback", "shop/web", `v${version}`, "--confirm", "other"]);

    expect(result.code).toBe(6);
    expect(errorOf(result).code).toBe("confirmation_mismatch");
  });

  it("says when a version is not kept", async () => {
    const result = await run(["rollback", "shop/web", "v999", "--confirm", "web"]);

    expect(result.code).toBe(5);
  });
});

describe("variables", () => {
  const revealed = async (path: string) =>
    new Map(
      parseEnvText((await panel.direct<EnvDocument>(key, "POST", `${path}/reveal`)).body.env).map(
        ({ key: name, value }) => [name, value],
      ),
    );

  it("are set, read back and removed with their values exactly as typed", async () => {
    const set = await run(["config", "set", "shop/web", "A=1", "B=two words", 'C="quoted"', "D=x=y"]);
    expect(set.code).toBe(0);
    expect(jsonOf<ServiceEnvironment>(set).names).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));

    const values = await revealed(`${WEB}/environment`);
    expect(Object.fromEntries(values)).toMatchObject({ A: "1", B: "two words", C: '"quoted"', D: "x=y" });

    const got = await run(["config", "get", "shop/web", "B", "C", "--yes"]);
    expect(jsonOf(got)).toEqual({ B: "two words", C: '"quoted"' });

    const unset = await run(["config", "unset", "shop/web", "B", "--yes"]);
    expect(unset.code).toBe(0);
    expect(jsonOf<ServiceEnvironment>(unset).names).not.toContain("B");

    const listed = await run(["config", "shop/web"]);
    expect(jsonOf(listed)).toEqual((await panel.direct(key, "GET", `${WEB}/environment`)).body);
  });

  it("are only printed or removed once confirmed", async () => {
    const got = await run(["config", "get", "shop/web", "A"]);
    expect(got.code).toBe(2);
    expect(errorOf(got).code).toBe("confirmation_required");

    const unset = await run(["config", "unset", "shop/web", "A"]);
    expect(unset.code).toBe(2);
    expect((await revealed(`${WEB}/environment`)).has("A")).toBe(true);
  });

  it("refuse a line break in a value before anything is sent", async () => {
    const result = await run(["config", "set", "shop/web", "X=one\ntwo"]);

    expect(result.code).toBe(2);
    expect((await revealed(`${WEB}/environment`)).has("X")).toBe(false);
  });

  it("can be followed by a deployment that uses them", async () => {
    await idle();

    const result = await run(["config", "set", "shop/web", "E=5", "--deploy", "--wait"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ActionDetail>(result)).toMatchObject({ type: "service.deploy", status: "succeeded" });
  }, 20_000);

  it("include the ones a project shares with all its services", async () => {
    const set = await run(["config", "set", "--project", "shop", "SHARED=yes"]);
    expect(set.code).toBe(0);

    const listed = await run(["config", "--project", "shop"]);
    expect(jsonOf(listed)).toEqual((await panel.direct(key, "GET", `${API}/shop/env`)).body);
    expect((await revealed(`${API}/shop/env`)).get("SHARED")).toBe("yes");
  });

  it("are refused to a key that only reads, exactly as the API refuses it", async () => {
    const reader = (await panel.createKey({ name: "reader", level: "read" })).token;
    const env = { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: reader };

    expect((await run(["config", "shop/web"], { env })).code).toBe(0);

    const result = await run(["config", "set", "shop/web", "X=1"], { env });
    const viaApi = await panel.direct(reader, "POST", `${WEB}/environment/reveal`);
    expect(result.code).toBe(4);
    expect(errorOf(result).code).toBe(apiErrorOf(viaApi).code);
  });
});

describe("open", () => {
  it("gives the service's address, or says it has none", async () => {
    const service = (await panel.direct<ServiceDetail>(key, "GET", WEB)).body;

    const result = await run(["open", "shop/web"]);

    if (service.primaryUrl === null) {
      expect(result.code).toBe(5);
    } else {
      expect(result.code).toBe(0);
      expect(jsonOf(result)).toEqual({ url: service.primaryUrl });
    }
  });
});
