import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserList } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../../../apps/server/src/testing/harness";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { type CliRuntime, runCli } from "./cli";

let panel: LivePanel;
let scratch: string;
let key: string;

beforeAll(async () => {
  panel = await startLivePanel();
  key = (await panel.createKey({ name: "accounts", level: "write" })).token;
  scratch = await mkdtemp(join(tmpdir(), "opsifier-accounts-"));
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

const file = () => join(scratch, "credentials.json");

async function run(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    signal: new AbortController().signal,
    cwd: scratch,
    credentialsFile: file(),
    ...overrides,
  });
  return { code, stdout, stderr };
}

/** Runs `login --web` and approves it from the panel's browser session as soon as the code shows. */
async function loginWithBrowser(): Promise<CliResult> {
  let approved: Promise<unknown> | undefined;
  let stderr = "";
  const result = await run(["login", "--web", panel.url], {
    stderr: (text) => {
      stderr += text;
      const code = /[A-Z]{4}-[A-Z]{4}/.exec(stderr)?.[0];
      if (code !== undefined && approved === undefined) {
        approved = panel.session("POST", `/api/v1/auth/cli/requests/${code}/approve`, {
          currentPassword: TEST_PASSWORD,
        });
      }
    },
  });
  await approved;
  return { ...result, stderr };
}

describe("accounts from the command line", () => {
  it("signs in as a person once the request is approved in a browser", async () => {
    const result = await loginWithBrowser();

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("/cli-login?code=");
    const kept = JSON.parse(await readFile(file(), "utf8")) as {
      panels: Record<string, { session?: { token: string; email: string } }>;
    };
    expect(kept.panels[new URL(panel.url).origin]?.session?.email).toBe("admin@example.com");
  });

  it("lists the accounts and changes one, with that session", async () => {
    await panel.createMember("ada@example.com", []);

    const list = await run(["users", "--json"]);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.stdout) as UserList["users"]).map((user) => user.email)).toContain(
      "ada@example.com",
    );

    const set = await run(["users", "set", "ada@example.com", "--all-projects", "operator", "--json"]);
    expect(set.code).toBe(0);
    const users = await panel.session<UserList>("GET", "/api/v1/users");
    expect(users.body.users.find((user) => user.email === "ada@example.com")?.allProjects).toBe("operator");

    const off = await run(["users", "deactivate", "ada@example.com", "--json"]);
    expect(off.code).toBe(0);
    expect((JSON.parse(off.stdout) as { active: boolean }).active).toBe(false);
  });

  it("refuses accounts to an API key alone", async () => {
    const result = await run(["users", "--json"], {
      env: { OPSIFIER_URL: panel.url, OPSIFIER_API_KEY: key },
      credentialsFile: join(scratch, "key-only.json"),
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("login --web");
  });

  it("ends the session on the panel when it logs out", async () => {
    const result = await run(["logout", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { sessionEnded: boolean }).sessionEnded).toBe(true);

    expect((await run(["users", "--json"])).code).not.toBe(0);
  });
});
