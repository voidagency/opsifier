// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type {
  BackupConfigEntry,
  BackupEntry,
  BackupsDocument,
  DatabaseDetail,
  RestoreEntry,
  ServiceDetail,
  StorageProviderEntry,
  StorageProviderList,
} from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, withStatus } from "../../testing/appHarness";

afterEach(resetApp);

const SERVICE = "/projects/shop/services/db";
const BACKUPS = `${SERVICE}/backups`;

const detail = (overrides: Partial<ServiceDetail> = {}): ServiceDetail => ({
  projectName: "shop",
  name: "db",
  type: "postgres",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "postgres:18", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: null,
  pendingChanges: false,
  answering: null,
  ...overrides,
});

const database: DatabaseDetail = {
  engine: "postgres",
  image: "postgres:18",
  volume: "shop_db_data",
  exposedPort: 0,
  internalHost: "shop_db",
  internalPort: 5432,
  versions: { proposed: "postgres:18", configured: "postgres:18", running: null },
};

const config = (overrides: Partial<BackupConfigEntry> = {}): BackupConfigEntry => ({
  id: "c1",
  kind: "database",
  scope: "database",
  enabled: true,
  schedule: "0 2 * * *",
  retention: 3,
  databaseName: "app",
  volumeName: null,
  storageProviderId: "local-disk",
  storageProviderName: "Local Disk",
  destinationReady: true,
  path: "shop/db",
  nextRunAt: "2026-06-01T02:00:00.000Z",
  lastRun: { status: "succeeded", finishedAt: "2026-05-30T02:00:10.000Z", backupId: "b1" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const backup = (overrides: Partial<BackupEntry> = {}): BackupEntry => ({
  id: "b1",
  kind: "database",
  origin: "schedule",
  name: null,
  configId: "c1",
  status: "succeeded",
  databaseName: "app",
  volumeName: null,
  engine: "postgres",
  engineVersion: "18.1",
  format: "postgres-sql-gz-v1",
  scope: "database",
  storageProviderId: "local-disk",
  storageProviderName: "Local Disk",
  path: "shop/db/2026-05-30T02:00:00.000Z.sql.gz",
  sizeBytes: 2048,
  sha256: "ab".repeat(32),
  actionId: "a1",
  error: null,
  cleanupError: null,
  deletedAt: null,
  restorable: true,
  createdAt: "2026-05-30T02:00:00.000Z",
  finishedAt: "2026-05-30T02:00:10.000Z",
  ...overrides,
});

const doc = (overrides: Partial<BackupsDocument> = {}): BackupsDocument => ({
  timezone: "UTC",
  configs: [config()],
  backups: [backup()],
  restores: [],
  defaultDatabase: "app",
  volumes: [],
  ...overrides,
});

function server(document: BackupsDocument, extra: Record<string, unknown> = {}) {
  return installFakeServer({
    [`GET ${SERVICE}`]: detail(),
    [`GET ${SERVICE}/database`]: database,
    [`GET ${BACKUPS}`]: document,
    [`GET ${BACKUPS}/destinations`]: {
      options: [{ id: "local-disk", name: "Local Disk", kind: "local", offHost: false }],
    },
    [`GET ${BACKUPS}/databases`]: { databases: ["app", "other"] },
    "GET /projects": { projects: [] },
    ...extra,
  });
}

describe("the Backups tab of a database", () => {
  it("shows the empty state with its illustration before anything exists", async () => {
    server(doc({ configs: [], backups: [] }));
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByRole("heading", { name: "No backups yet" });
    expect(document.querySelector('[data-illustration="no-backups"]')).not.toBeNull();
  });

  it("lists a configuration with its destination, schedule and lamp, then the history", async () => {
    server(doc());
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByRole("heading", { name: "History" });
    expect(screen.getAllByText(/Local Disk/).length).toBeGreaterThan(0);
    expect(screen.getByText("Daily at 2:00")).toBeTruthy();
    expect(screen.getByText("Keeps the last 3")).toBeTruthy();
    const row = screen.getByText("Scheduled").closest("tr") as HTMLElement;
    expect(within(row).getByText("Succeeded")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Restore this backup" })).toBeTruthy();
  });

  it("says what each backup holds: source, format, size, checksum, destination, date (REQ-215)", async () => {
    server(doc());
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByRole("heading", { name: "History" });
    const row = screen.getByText("Scheduled").closest("tr") as HTMLElement;
    expect(within(row).getByText(`app · postgres-sql-gz-v1 · sha256 ${"ab".repeat(4)}`)).toBeTruthy();
    expect(within(row).getByText("Local Disk")).toBeTruthy();
  });

  it("names a backup of the whole server by what it holds, not by a database", async () => {
    server(
      doc({
        backups: [
          backup({
            scope: "instance",
            format: "postgres-instance-sql-gz-v1",
            databaseName: null,
            path: "shop/db/2026-05-30T02:00:00.000Z.instance.sql.gz",
          }),
        ],
      }),
    );
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByRole("heading", { name: "History" });
    const row = screen.getByText("Scheduled").closest("tr") as HTMLElement;
    expect(within(row).getByText(/Whole server · postgres-instance-sql-gz-v1/)).toBeTruthy();
  });

  it("offers each stored backup for download, and nothing that is gone (REQ-075, REQ-686)", async () => {
    server(
      doc({
        backups: [
          backup({ id: "kept", name: "same title" }),
          backup({
            id: "gone",
            name: "same title",
            deletedAt: "2026-06-01T00:00:00.000Z",
            restorable: false,
          }),
        ],
      }),
    );
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByRole("heading", { name: "History" });

    const links = screen.getAllByRole("link", { name: "Download this file" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/api/v1/projects/shop/services/db/backups/kept/download",
    ]);
  });

  it("says why a backup can't run when its destination can't be reached", async () => {
    server(doc({ configs: [config({ destinationReady: false })], backups: [] }));
    renderApp("/projects/shop/postgres/db/backups");

    const run = await screen.findByRole("button", { name: "Run now" });
    expect(run.getAttribute("aria-disabled")).toBe("true");
    fireEvent.focus(run);
    expect(
      (await screen.findAllByText("Its destination can't be reached right now.")).length,
    ).toBeGreaterThan(0);
  });

  it("offers no restore for a backup that was removed by retention", async () => {
    server(doc({ backups: [backup({ deletedAt: "2026-06-01T00:00:00.000Z", restorable: false })] }));
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByText("Removed");
    expect(screen.queryByRole("button", { name: "Restore this backup" })).toBeNull();
  });

  it("makes the destructive restore ask for the exact name", async () => {
    const api = server(doc(), {
      [`POST ${BACKUPS}/b1/restore`]: { ...action("r1"), status: "queued" },
    });
    renderApp("/projects/shop/postgres/db/backups");
    fireEvent.click(await screen.findByRole("button", { name: "Restore this backup" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "wrong" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "app" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === "POST" && call.path === `${BACKUPS}/b1/restore`)).toBe(
        true,
      );
    });
    const sent = api.calls.find((call) => call.path === `${BACKUPS}/b1/restore`);
    expect(sent?.body).toEqual({ confirm: "app" });
  });

  it("keeps the preset and the cron field in step", async () => {
    server(doc({ configs: [], backups: [] }));
    renderApp("/projects/shop/postgres/db/backups");
    fireEvent.click(await screen.findByRole("button", { name: "Add backup" }));
    const dialog = await screen.findByRole("dialog");
    const cron = within(dialog).getByRole("textbox", { name: "Cron" }) as HTMLInputElement;
    expect(cron.value).toBe("0 2 * * *");
    // The database defaults to the service's own, and the destination to the first offered.
    expect((within(dialog).getByLabelText("Database") as HTMLInputElement).value).toBe("app");
  });

  it("offers the three scopes, and only one database needs a name (REQ-667)", async () => {
    const api = server(doc({ configs: [], backups: [] }), {
      [`POST ${BACKUPS}/configs`]: config({ id: "new", scope: "instance", databaseName: null }),
    });
    renderApp("/projects/shop/postgres/db/backups");
    fireEvent.click(await screen.findByRole("button", { name: "Add backup" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText("Database");

    fireEvent.click(within(dialog).getByRole("combobox", { name: "What it holds" }));
    fireEvent.click(await screen.findByRole("option", { name: "Whole server" }));

    await waitFor(() => expect(within(dialog).queryByLabelText("Database")).toBeNull());
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const posted = api.calls.find((call) => call.method === "POST" && call.path === `${BACKUPS}/configs`)
        ?.body as Record<string, unknown> | undefined;
      expect(posted).toMatchObject({ scope: "instance" });
      expect(posted?.databaseName).toBeUndefined();
    });
  });

  it("has a restore of a whole server confirmed by the service's name", async () => {
    const api = server(
      doc({
        backups: [
          backup({
            scope: "instance",
            format: "postgres-instance-sql-gz-v1",
            databaseName: null,
            path: "shop/db/2026-05-30T02:00:00.000Z.instance.sql.gz",
          }),
        ],
      }),
      { [`POST ${BACKUPS}/b1/restore`]: withStatus(202, action("r")) },
    );
    renderApp("/projects/shop/postgres/db/backups");
    fireEvent.click(await screen.findByRole("button", { name: "Restore this backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this whole server?" });

    const confirm = within(dialog).getByRole("textbox");
    fireEvent.change(confirm, { target: { value: "db" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(api.calls.find((call) => call.path === `${BACKUPS}/b1/restore`)?.body).toEqual({
        confirm: "db",
      }),
    );
  });

  it("refuses an invalid schedule before anything is sent", async () => {
    const api = server(doc({ configs: [], backups: [] }));
    renderApp("/projects/shop/postgres/db/backups");
    fireEvent.click(await screen.findByRole("button", { name: "Add backup" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Cron" }), {
      target: { value: "nonsense" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("Enter a valid cron expression, or pick a preset");
    expect(api.calls.some((call) => call.method === "POST" && call.path === `${BACKUPS}/configs`)).toBe(
      false,
    );
  });

  it("puts a restore that needs attention at the top, with both ways out", async () => {
    const restore: RestoreEntry = {
      id: "r1",
      kind: "database",
      scope: "database",
      backupId: "b1",
      sourcePath: "shop/db/2026-05-30T02:00:00.000Z.sql.gz",
      storageProviderName: "Local Disk",
      databaseName: "app",
      volumeName: null,
      status: "failed",
      phase: "importing",
      safetyBackupId: null,
      earlierCopy: null,
      actorEmail: "admin@example.com",
      actionId: "a2",
      error: "The panel restarted during this restore.",
      unresolved: true,
      createdAt: "2026-05-30T03:00:00.000Z",
      finishedAt: "2026-05-30T03:01:00.000Z",
    };
    server(doc({ restores: [restore] }));
    renderApp("/projects/shop/postgres/db/backups");
    expect(await screen.findByRole("heading", { name: "A restore needs attention" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark as checked" })).toBeTruthy();
  });

  it("shows the error state with a retry when the document can't load", async () => {
    server(doc(), {
      [`GET ${BACKUPS}`]: withStatus(500, { error: { code: "internal_error", message: "Boom" } }),
    });
    renderApp("/projects/shop/postgres/db/backups");
    await screen.findByText("Something went wrong on the server.").catch(async () => {
      await screen.findByRole("button", { name: /retry|try again/i });
    });
  });
});

function action(id: string) {
  return {
    id,
    type: "backup.restore-database",
    title: "Restore",
    status: "queued" as const,
    projectName: "shop",
    serviceName: "db",
    actorEmail: "admin@example.com",
    hasLog: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

describe("Settings, Storage providers", () => {
  const entry = (overrides: Partial<StorageProviderEntry> = {}): StorageProviderEntry => ({
    id: "local-disk",
    name: "Local Disk",
    kind: "local",
    builtIn: true,
    status: "ready",
    location: "/var/lib/opsifier/backups",
    offHost: false,
    usedBy: 1,
    requiredPermissions: ["list", "read", "write", "rename", "delete"],
    lastCheckAt: null,
    lastCheckError: null,
    config: { kind: "local", path: "/var/lib/opsifier/backups" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  const list = (providers: StorageProviderEntry[]): StorageProviderList => ({
    providers,
    oauthRedirectUrl: "https://panel.example.com/api/v1/storage-providers/oauth/callback",
  });

  it("says what a destination's credentials must be allowed to do (REQ-235)", async () => {
    installFakeServer({ "GET /storage-providers": list([entry()]) });
    renderApp("/settings/server/storage-providers");
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AWS S3" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Permissions needed")).toBeTruthy();
    expect(
      within(dialog).getByText(/s3:ListBucket, s3:PutObject, s3:GetObject, s3:DeleteObject/),
    ).toBeTruthy();
  });

  it("lists the built-in Local Disk with its lamp and a warning that it stays on this server", async () => {
    installFakeServer({ "GET /storage-providers": list([entry()]) });
    renderApp("/settings/server/storage-providers");
    await screen.findByText("Local Disk");
    expect(screen.getByText("On this server")).toBeTruthy();
  });

  it("offers all eleven destinations in the Add menu, and submits a valid local one", async () => {
    const api = installFakeServer({
      "GET /storage-providers": list([entry()]),
      "POST /storage-providers": entry({ id: "x", name: "external", builtIn: false }),
    });
    renderApp("/settings/server/storage-providers");
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(11);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Local" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "external" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Folder" }), {
      target: { value: "/srv/backups" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === "POST" && call.path === "/storage-providers")).toBe(
        true,
      );
    });
    const sent = api.calls.find((call) => call.path === "/storage-providers" && call.method === "POST");
    expect(sent?.body).toMatchObject({ kind: "local", name: "external", path: "/srv/backups" });
  });

  it("shows empty required errors on every field of a blank form", async () => {
    installFakeServer({ "GET /storage-providers": list([entry()]) });
    renderApp("/settings/server/storage-providers");
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Add" }), { button: 0 });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Local" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await within(dialog).findByText("Give it a name");
    expect(within(dialog).getByText("Use an absolute path with no . or .. in it")).toBeTruthy();
  });
});
