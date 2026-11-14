import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActionEntry,
  DomainEntry,
  DomainList,
  MaintenanceSettings,
  ScriptList,
  ScriptRunDetail,
  ServiceDetail,
} from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";

let panel: LivePanel;
let key: string;
let scratch: string;

const API = "/api/v1/projects";
const WEB = `${API}/shop/services/web`;
const PG = `${API}/shop/services/pg`;

beforeAll(async () => {
  panel = await startLivePanel();
  key = (await panel.createKey({ name: "operate", level: "write" })).token;
  await panel.deploy("shop", "web");
  await panel.session("POST", `${API}/shop/databases`, { name: "pg", engine: "postgres" });
  scratch = await mkdtemp(join(tmpdir(), "opsifier-operate-"));
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
    cwd: scratch,
    credentialsFile: join(scratch, "no-credentials.json"),
    ...overrides,
  });
  return { code, stdout, stderr };
}

const jsonOf = <T = unknown>(result: CliResult): T => JSON.parse(result.stdout) as T;
const errorOf = (result: CliResult) =>
  (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error;

describe("domains", () => {
  it("are listed as the API lists them", async () => {
    const result = await run(["domains", "shop/web"]);

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual((await panel.direct(key, "GET", `${WEB}/domains`)).body);
  });

  it("are added with the port the service listens on, and made primary when asked", async () => {
    const result = await run([
      "domains",
      "add",
      "shop/web",
      "www.example.test",
      "--port",
      "8080",
      "--primary",
    ]);

    expect(result.code).toBe(0);
    expect(jsonOf<DomainEntry>(result)).toMatchObject({
      host: "www.example.test",
      port: 8080,
      primary: true,
    });
  });

  it("take a whole address, its path included", async () => {
    const result = await run(["domains", "add", "shop/web", "https://api.example.test/v1"]);

    expect(jsonOf<DomainEntry>(result)).toMatchObject({ host: "api.example.test", path: "/v1", https: true });
  });

  it("ask which path when a host has several", async () => {
    await run(["domains", "add", "shop/web", "https://api.example.test/v2"]);

    const result = await run(["domains", "primary", "shop/web", "api.example.test"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("/v1");
    const chosen = await run(["domains", "primary", "shop/web", "api.example.test", "--path", "/v2"]);
    expect(jsonOf<DomainEntry>(chosen)).toMatchObject({ path: "/v2", primary: true });
  });

  it("are only removed once confirmed", async () => {
    const unconfirmed = await run(["domains", "remove", "shop/web", "https://api.example.test/v1"]);
    expect(unconfirmed.code).toBe(2);

    const removed = await run(["domains", "remove", "shop/web", "https://api.example.test/v1", "--yes"]);
    expect(removed.code).toBe(0);
    const left = (await panel.direct<DomainList>(key, "GET", `${WEB}/domains`)).body.domains;
    expect(left.some((domain) => domain.host === "api.example.test" && domain.path === "/v1")).toBe(false);
  });

  it("take a whole address from a linked folder, and match a host whatever its case", async () => {
    const here = join(scratch, "linked-domains");
    await mkdir(here, { recursive: true });
    await run(["link", "shop/web"], { cwd: here });

    const added = await run(["domains", "add", "https://Docs.Example.test/guide/"], { cwd: here });
    expect(added.code).toBe(0);
    expect(jsonOf<DomainEntry>(added)).toMatchObject({ host: "docs.example.test" });

    const removed = await run(["domains", "remove", "DOCS.example.test", "--yes"], { cwd: here });
    expect(removed.code).toBe(0);
  });

  it("say when a host is not there", async () => {
    expect((await run(["domains", "remove", "shop/web", "nowhere.example.test", "--yes"])).code).toBe(5);
  });
});

describe("maintenance", () => {
  it("is turned on only once confirmed, keeping what was set in the panel", async () => {
    await panel.session("PUT", `${WEB}/maintenance`, { enabled: false, customCss: "body { color: red }" });

    expect((await run(["maintenance", "on", "shop/web"])).code).toBe(2);

    const on = await run(["maintenance", "on", "shop/web", "--title", "Back soon", "--yes"]);
    expect(on.code).toBe(0);
    expect(jsonOf<MaintenanceSettings>(on)).toMatchObject({
      enabled: true,
      title: "Back soon",
      customCss: "body { color: red }",
    });
  });

  it("is shown, then turned off without asking", async () => {
    const status = await run(["maintenance", "shop/web"]);
    expect(jsonOf(status)).toEqual((await panel.direct(key, "GET", `${WEB}/maintenance`)).body);

    const off = await run(["maintenance", "off", "shop/web"]);
    expect(jsonOf<MaintenanceSettings>(off).enabled).toBe(false);
  });
});

describe("a database's credentials", () => {
  it("are shown masked, as the API shows them", async () => {
    const result = await run(["db", "shop/pg"]);

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual((await panel.direct(key, "GET", `${PG}/credentials`)).body);
  });

  it("are only printed once confirmed, one secret at a time", async () => {
    expect((await run(["db", "url", "shop/pg"])).code).toBe(2);

    const url = await run(["db", "url", "shop/pg", "--yes"]);
    const viaApi = await panel.direct<{ value: string }>(key, "POST", `${PG}/credentials/reveal`, {
      secret: "internalUrl",
    });
    expect(jsonOf(url)).toEqual({ internalUrl: viaApi.body.value });

    const password = await run(["db", "password", "shop/pg", "--yes"]);
    expect(Object.keys(jsonOf<Record<string, string>>(password))).toEqual(["password"]);

    // Postgres has no separate root account: the panel says so, and the command passes it on.
    const root = await run(["db", "password", "shop/pg", "--root", "--yes"]);
    expect(root.code).toBe(6);
    expect(errorOf(root).code).toBe("no_root_password");
  });
});

describe("scripts", () => {
  it("are saved from a command or a file, with a schedule when given", async () => {
    const file = join(scratch, "nightly.sh");
    await writeFile(file, "echo nightly\n");

    expect((await run(["scripts", "add", "shop/web", "hello", "--command", "echo hello"])).code).toBe(0);
    const nightly = await run([
      "scripts",
      "add",
      "shop/web",
      "nightly",
      "--file",
      file,
      "--cron",
      "0 3 * * *",
      "--tz",
      "Europe/Paris",
    ]);
    expect(nightly.code).toBe(0);

    const list = (await panel.direct<ScriptList>(key, "GET", `${WEB}/scripts`)).body.scripts;
    expect(list.find((script) => script.name === "hello")).toMatchObject({ script: "echo hello" });
    expect(list.find((script) => script.name === "nightly")).toMatchObject({
      script: "echo nightly\n",
      schedule: { cron: "0 3 * * *", timeZone: "Europe/Paris" },
    });
    expect(jsonOf(await run(["scripts", "shop/web"]))).toEqual(
      (await panel.direct(key, "GET", `${WEB}/scripts`)).body,
    );
  });

  it.each([
    [["scripts", "add", "shop/web", "both", "--command", "x", "--file", "y"]],
    [["scripts", "add", "shop/web", "neither"]],
    [["scripts", "add", "shop/web", "zone", "--command", "x", "--tz", "UTC"]],
  ])("refuses %j", async (argv) => {
    expect((await run(argv)).code).toBe(2);
  });

  it("runs one in the service's container and returns its outcome", async () => {
    const result = await run(["run", "shop/web", "hello"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ScriptRunDetail>(result)).toMatchObject({ scriptName: "hello", status: "succeeded" });
  }, 20_000);

  it("starts one and returns at once with --detach", async () => {
    const result = await run(["run", "shop/web", "hello", "--detach"]);

    expect(result.code).toBe(0);
    expect(jsonOf<ActionEntry>(result).id).toBeTruthy();
  });

  it("removes one only once confirmed", async () => {
    expect((await run(["scripts", "remove", "shop/web", "nightly"])).code).toBe(2);
    expect((await run(["scripts", "remove", "shop/web", "nightly", "--yes"])).code).toBe(0);
    expect((await run(["scripts", "remove", "shop/web", "nightly", "--yes"])).code).toBe(5);
  });
});

describe("backups", () => {
  it("are listed as the API lists them", async () => {
    const result = await run(["backups", "shop/pg"]);

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toEqual((await panel.direct(key, "GET", `${PG}/backups`)).body);
  });

  it("say how to set one up when there is none to run", async () => {
    const result = await run(["backups", "run", "shop/pg"]);

    expect(result.code).toBe(2);
    expect(errorOf(result).message).toContain("Backups");
  });
});

describe("ps", () => {
  it("shows the state and the readings of a service", async () => {
    const result = await run(["ps", "shop/web"]);
    const service = (await panel.direct<ServiceDetail>(key, "GET", WEB)).body;

    expect(result.code).toBe(0);
    expect(jsonOf(result)).toMatchObject({ status: service.status, replicas: service.replicas });
    expect(jsonOf<{ metrics: object }>(result).metrics).toHaveProperty("cpuPercent");
  });

  it("reads well for a person", async () => {
    const result = await run(["ps", "shop/web"], { isTTY: true });

    expect(result.stdout).toContain("shop/web");
  });
});
