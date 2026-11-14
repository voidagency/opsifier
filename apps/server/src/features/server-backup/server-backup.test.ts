import type { ServerBackupSaved, ServerBackupSnapshots, ServerBackupState } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeTools, ToolRequest, ToolResult } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { BUILT_IN_PROVIDER_ID } from "../storage-providers/service";
import { nextRunAt } from "./service";

let context: TestContext;
let cookie: string;
let restic: ToolRequest[];
let failNext: string | null;

const SNAPSHOT = "4f1c0b2a9d8e7f60aabbccddeeff00112233445566778899aabbccddeeff0011";

function answer(request: ToolRequest): ToolResult | undefined {
  if (request.command !== "restic") {
    return undefined;
  }
  restic.push(request);
  const verb = request.args[0] ?? "";
  if (failNext === verb) {
    failNext = null;
    request.onLine?.("Fatal: unable to open repository");
    return { exitCode: 1, tail: ["Fatal: unable to open repository"] };
  }
  if (verb === "backup") {
    request.onLine?.(JSON.stringify({ message_type: "status", percent_done: 0.5 }));
    request.onLine?.(
      JSON.stringify({
        message_type: "summary",
        snapshot_id: SNAPSHOT,
        data_added_packed: 2048,
        total_bytes_processed: 1048576,
      }),
    );
  }
  if (verb === "snapshots") {
    request.onLine?.(
      JSON.stringify([
        {
          id: SNAPSHOT,
          time: "2026-11-14T02:30:00Z",
          hostname: "cfc",
          summary: { data_added_packed: 2048, total_bytes_processed: 1048576 },
        },
      ]),
    );
  }
  return { exitCode: 0, tail: [] };
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  restic = [];
  failNext = null;
  (context.deps.tools as FakeTools).handler = async (request) => answer(request);
});

afterEach(async () => {
  await context.close();
});

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });

const SETTINGS = {
  enabled: true,
  providerId: BUILT_IN_PROVIDER_ID,
  time: "02:30",
  keepDaily: 14,
  keepWeekly: 8,
  keepMonthly: 6,
};

async function waitForAction(id: string): Promise<{ status: string; error: string | null }> {
  for (;;) {
    const action = await api<{ status: string; error: string | null }>(`/actions/${id}`);
    if (action.body.status !== "queued" && action.body.status !== "running") {
      return action.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the server backup", () => {
  it("creates its repository and recovery key the first time, and shows the key that once", async () => {
    const first = await api<ServerBackupSaved>("/server/backup", "PUT", SETTINGS);
    expect(first.status).toBe(200);
    expect(first.body.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.keyCreated).toBe(true);
    expect(restic.map((request) => request.args[0])).toEqual(["init"]);
    expect(restic[0]?.env.RESTIC_PASSWORD).toBe(first.body.recoveryKey);

    const again = await api<ServerBackupSaved>("/server/backup", "PUT", { ...SETTINGS, time: "03:00" });
    expect(again.body.recoveryKey).toBeNull();
    expect(again.body.time).toBe("03:00");
    expect(restic).toHaveLength(1);
  });

  it("backs up the panel's state and the volumes, then forgets old snapshots", async () => {
    await api("/server/backup", "PUT", SETTINGS);
    const started = await api<{ id: string }>("/server/backup/run", "POST");
    expect(started.status).toBe(202);
    expect((await waitForAction(started.body.id)).status).toBe("succeeded");

    const backup = restic.find((request) => request.args[0] === "backup");
    expect(backup?.args).toEqual(expect.arrayContaining(["--tag", "opsifier"]));
    expect(backup?.args.some((arg) => arg.endsWith("server-backup/staging"))).toBe(true);
    const forget = restic.find((request) => request.args[0] === "forget");
    expect(forget?.args).toEqual(
      expect.arrayContaining(["--keep-daily", "14", "--keep-weekly", "8", "--prune"]),
    );

    const state = await api<ServerBackupState>("/server/backup");
    expect(state.body.lastRun).toMatchObject({ status: "succeeded", snapshotId: SNAPSHOT, addedBytes: 2048 });
  });

  it("says when a run fails, and keeps the reason", async () => {
    await api("/server/backup", "PUT", SETTINGS);
    failNext = "backup";
    const started = await api<{ id: string }>("/server/backup/run", "POST");
    expect((await waitForAction(started.body.id)).status).toBe("failed");

    const state = await api<ServerBackupState>("/server/backup");
    expect(state.body.lastRun?.status).toBe("failed");
    expect(state.body.lastRun?.error).toMatch(/unable to open repository/);
  });

  it("lists the snapshots", async () => {
    await api("/server/backup", "PUT", SETTINGS);
    const list = await api<ServerBackupSnapshots>("/server/backup/snapshots");
    expect(list.body.snapshots).toEqual([
      expect.objectContaining({ id: SNAPSHOT, addedBytes: 2048, totalBytes: 1048576 }),
    ]);
  });

  it("shows the recovery key again only to the owner proving who they are", async () => {
    const saved = await api<ServerBackupSaved>("/server/backup", "PUT", SETTINGS);
    expect(apiErrorOf(await api("/server/backup/key", "POST", {})).code).toBe("current_password_required");

    const shown = await api<{ recoveryKey: string }>("/server/backup/key", "POST", {
      currentPassword: TEST_PASSWORD,
    });
    expect(shown.body.recoveryKey).toBe(saved.body.recoveryKey);
  });

  it("is closed to anyone but the owner and the host's administrators", async () => {
    const member = await signInMember(context.app, cookie, "ada@example.com", []);
    expect((await api("/server/backup", "GET", undefined, member)).status).toBe(403);
  });

  it("refuses a destination it cannot use yet", async () => {
    const created = await api<{ id: string }>("/storage-providers", "POST", {
      kind: "ftp",
      name: "Old FTP",
      host: "ftp.example.com",
      port: 21,
      username: "u",
      password: "p",
      rootPath: "/",
      tls: false,
    });
    const refused = await api("/server/backup", "PUT", { ...SETTINGS, providerId: created.body.id });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("runs every day at its time, in UTC", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextRunAt("02:30", at("2026-11-14T01:00:00Z"))).toBe(at("2026-11-14T02:30:00Z"));
    expect(nextRunAt("02:30", at("2026-11-14T02:30:00Z"))).toBe(at("2026-11-15T02:30:00Z"));
  });
});
