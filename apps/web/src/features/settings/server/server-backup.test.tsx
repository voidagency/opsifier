// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../../testing/appHarness";

afterEach(resetApp);

const STATE = {
  enabled: false,
  providerId: null,
  time: "02:30",
  keepDaily: 14,
  keepWeekly: 8,
  keepMonthly: 6,
  keyCreated: false,
  lastRun: null,
  nextRunAt: null,
  destinations: [
    { id: "s3", name: "Backups bucket", kind: "aws-s3", usable: true },
    { id: "ftp", name: "Old FTP", kind: "ftp", usable: false },
  ],
  repository: null,
  restore: null,
};

const REPOSITORY = "s3:https://s3.eu-west-3.amazonaws.com/acme-backups/opsifier-server";

const KEY = "kq3Yx0b8n2c-recovery-key-shown-once-0123456789";

describe("the server backup page", () => {
  it("turns it on and shows the recovery key once", async () => {
    const server = installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /server/backup": STATE,
      "PUT /server/backup": { ...STATE, enabled: true, providerId: "s3", keyCreated: true, recoveryKey: KEY },
    });
    renderApp("/settings/server/backup");

    expect(await screen.findByText("Server backup", { selector: "h2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /Back up this server every day/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(KEY)).toBeTruthy();
    const saved = server.calls.find((call) => call.method === "PUT" && call.path === "/server/backup");
    expect(saved?.body).toMatchObject({ enabled: true, providerId: "s3", time: "02:30", keepDaily: 14 });
  });

  it("shows how the last run went, and starts one on demand", async () => {
    const server = installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /server/backup": {
        ...STATE,
        enabled: true,
        providerId: "s3",
        keyCreated: true,
        nextRunAt: "2026-11-15T02:30:00.000Z",
        lastRun: {
          actionId: "a1",
          status: "succeeded",
          startedAt: "2026-11-14T02:30:00.000Z",
          finishedAt: "2026-11-14T02:41:00.000Z",
          snapshotId: "4f1c0b2a",
          addedBytes: 2048,
          processedBytes: 1048576,
          error: null,
        },
      },
      "POST /server/backup/run": {
        id: "a2",
        type: "backup.server",
        title: "Back up the server",
        status: "queued",
        phase: null,
        projectName: null,
        serviceName: null,
        createdAt: "2026-11-14T10:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        error: null,
        hasLog: false,
        actorEmail: "admin@example.com",
        origin: "session",
        originDetail: null,
      },
    });
    renderApp("/settings/server/backup");

    expect(await screen.findByText(/^Finished .* read, .* added\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("The backup has started. Follow it under Activity.");
    expect(server.calls.some((call) => call.method === "POST" && call.path === "/server/backup/run")).toBe(
      true,
    );
  });

  it("writes out how to rebuild the server elsewhere from this repository", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /server/backup": {
        ...STATE,
        enabled: true,
        providerId: "s3",
        keyCreated: true,
        repository: REPOSITORY,
      },
    });
    renderApp("/settings/server/backup");

    expect(await screen.findByText("Rebuild this server elsewhere")).toBeTruthy();
    expect(screen.getByText(REPOSITORY, { selector: "code" })).toBeTruthy();
    const commands = screen.getByText(/--restore/, { selector: "pre" }).textContent ?? "";
    expect(commands).toContain(`export RESTIC_REPOSITORY='${REPOSITORY}'`);
    expect(commands).toContain("read -rs RESTIC_PASSWORD");
    expect(commands).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("says what a restore could not bring back", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /server/backup": {
        ...STATE,
        restore: {
          status: "failed",
          actionId: "a9",
          snapshotId: "4f1c0b2a",
          snapshotTime: "2026-11-14T02:30:00.000Z",
          hostname: "old-server",
          startedAt: "2026-11-15T09:00:00.000Z",
          finishedAt: "2026-11-15T09:20:00.000Z",
          problems: ["shop/db: the import failed (exit code 1), so it was not deployed."],
        },
      },
    });
    renderApp("/settings/server/backup");

    expect(await screen.findByText(/from the backup of old-server taken .*, except for:$/)).toBeTruthy();
    expect(screen.getByText(/^shop\/db: the import failed/)).toBeTruthy();
  });
});
