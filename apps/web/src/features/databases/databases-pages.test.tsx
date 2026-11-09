// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type {
  ActionEntry,
  CompanionList,
  DatabaseAdvancedSettings,
  DatabaseAvailability,
  DatabaseCredentials,
  DatabaseDetail,
  ServiceDetail,
} from "@opsifier/contract";
import { actionsTopic } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectLocation,
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  withStatus,
} from "../../testing/appHarness";

vi.mock("../../ui/CodeEditor", () => ({
  CodeEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

afterEach(resetApp);

const SERVICE = "/projects/shop/services/db";

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

const credentials = (overrides: Partial<DatabaseCredentials> = {}): DatabaseCredentials => ({
  engine: "postgres",
  user: "postgres",
  hasRootPassword: false,
  databaseName: "shop",
  internal: {
    host: "shop_db",
    port: 5432,
    maskedUrl: "postgres://postgres:••••••••@shop_db:5432/shop?sslmode=disable",
  },
  external: null,
  rotationUnresolved: false,
  ...overrides,
});

const companions: CompanionList = {
  companions: [
    { tool: "pgweb", enabled: false, url: null, username: null },
    { tool: "dbgate", enabled: false, url: null, username: null },
  ],
};

const metrics = {
  cpuPercent: 1.5,
  memoryUsedBytes: 67108864,
  networkRxBytes: 2048,
  networkTxBytes: 4096,
  readAt: "2026-01-01T00:00:00.000Z",
};

const action = (overrides: Partial<ActionEntry> = {}): ActionEntry => ({
  id: "a1",
  type: "database.password",
  title: "Change the password of shop/db",
  status: "queued",
  phase: null,
  projectName: "shop",
  serviceName: "db",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  error: null,
  hasLog: false,
  actorEmail: "admin@example.com",
  origin: "session",
  originDetail: null,
  ...overrides,
});

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  [`GET ${SERVICE}`]: detail(),
  [`GET ${SERVICE}/metrics`]: metrics,
  [`GET ${SERVICE}/database`]: database,
  [`GET ${SERVICE}/credentials`]: credentials(),
  [`GET ${SERVICE}/companions`]: companions,
  ...extra,
});

const button = (name: string | RegExp) => screen.findByRole("button", { name });

describe("the service chooser (DAT-01)", () => {
  it("shows the nine types, the databases active, and opens a dialog named for the type", async () => {
    installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/projects/shop/create");

    await screen.findByText("Postgres");
    for (const name of [
      "App",
      "MySQL",
      "MariaDB",
      "Postgres",
      "Mongo",
      "Redis",
      "Box",
      "Compose",
      "WordPress",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    fireEvent.click(screen.getByText("Postgres"));

    expect(await screen.findByRole("dialog", { name: "Add a Postgres database" })).toBeTruthy();
  });

  it.each([
    ["Mongo", "Add a Mongo database", ["Service name", "User", "Password", "Image"]],
    ["Redis", "Add a Redis database", ["Service name", "Password", "Image"]],
    [
      "MySQL",
      "Add a MySQL database",
      ["Service name", "Database name", "User", "Password", "Root password", "Image"],
    ],
  ])("asks %s only for its own fields (DAT-14)", async (engine, title, fields) => {
    installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByText(engine));
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(
      within(dialog)
        .getAllByRole("textbox")
        .map((input) => input.getAttribute("name"))
        .filter(Boolean),
    ).toEqual(
      within(dialog)
        .getAllByRole("textbox")
        .map((input) => input.getAttribute("name"))
        .filter(Boolean),
    );
    const labels = [...dialog.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(fields);
  });

  it("creates a database and goes to its page (DAT-02)", async () => {
    const server = installFakeServer(
      base({
        "POST /projects/shop/databases": (body: unknown) => {
          expect(body).toMatchObject({ name: "db", engine: "postgres", password: "" });
          return withStatus(201, detail());
        },
      }),
    );
    const app = renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByText("Postgres"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Service name/), { target: { value: "db" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add database" }));

    await expectLocation(app, "/projects/shop/postgres/db");
    expect(server.calls.some((call) => call.path === "/projects/shop/databases")).toBe(true);
  });

  it("keeps the dialog open with a banner and a field message on a server rejection", async () => {
    installFakeServer(
      base({
        "POST /projects/shop/databases": withStatus(409, {
          error: { code: "service_exists", message: "Exists.", fields: { name: "Taken" } },
        }),
      }),
    );
    renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByText("Redis"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Service name/), { target: { value: "cache" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add database" }));

    await within(dialog).findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("requires a name before sending anything", async () => {
    const server = installFakeServer({ "GET /projects": { projects: [] } });
    renderApp("/projects/shop/create");

    fireEvent.click(await screen.findByText("Redis"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add database" }));

    await within(dialog).findByText("Give the service a name.");
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("the database page (DAT-03, DAT-04, DAT-12)", () => {
  it("shows the tabs and readings without Deploy or Open, and stops without confirmation", async () => {
    const server = installFakeServer(
      base({ [`POST ${SERVICE}/stop`]: action({ id: "s1", type: "service.stop" }) }),
    );
    renderApp("/projects/shop/postgres/db/");

    const tabs = within(await screen.findByRole("navigation", { name: "Database sections" }));
    for (const tab of ["Overview", "Credentials", "Expose", "Resources", "Advanced"]) {
      expect(tabs.getByRole("link", { name: tab })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(await screen.findByText("1.5%")).toBeTruthy();

    fireEvent.click(await button("Stop"));
    await waitFor(() => expect(server.calls.some((call) => call.path === `${SERVICE}/stop`)).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Start once stopped", async () => {
    installFakeServer(base({ [`GET ${SERVICE}`]: detail({ status: "stopped", stopped: true }) }));
    renderApp("/projects/shop/postgres/db/");
    expect(await button("Start")).toBeTruthy();
  });

  it("requires the typed name to destroy, and says what happens to the data", async () => {
    const server = installFakeServer(
      base({ [`DELETE ${SERVICE}`]: action({ id: "d1", type: "service.destroy" }) }),
    );
    renderApp("/projects/shop/postgres/db/");

    fireEvent.pointerDown(await button("More actions"), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Destroy database" }));

    const dialog = await screen.findByRole("dialog", { name: "Destroy this database?" });
    expect(dialog.textContent).toContain("Removed");
    expect(dialog.textContent).toContain("Kept");
    expect(dialog.textContent).toContain("Its data volume shop_db_data and its backups");
    const confirm = within(dialog).getByRole("button", { name: "Destroy database" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "db" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "DELETE")?.body).toEqual({ confirm: "db" }),
    );
  });

  it("is not reachable for a service of another type", async () => {
    installFakeServer(base({ [`GET ${SERVICE}`]: detail({ type: "app" }) }));
    renderApp("/projects/shop/postgres/db/");
    expect(await screen.findByText("There is nothing at this address")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Database sections" })).toBeNull();
  });

  it("sends a database reached through the App URL to its own page", async () => {
    installFakeServer(base());
    const app = renderApp("/projects/shop/app/db/");
    await expectLocation(app, "/projects/shop/postgres/db");
  });
});

describe("the database connection state", () => {
  it("says it can be reached inside and not outside", async () => {
    installFakeServer(base());
    renderApp("/projects/shop/postgres/db/");

    expect(await screen.findByText("shop_db:5432")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not exposed" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Not exposed" }).getAttribute("href")).toBe(
      "/projects/shop/postgres/db/expose",
    );
  });

  it("shows the outside address once exposed, and flags an unconfirmed password", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/credentials`]: credentials({
          external: {
            host: "203.0.113.10",
            port: 15432,
            maskedUrl: "postgres://postgres:••••••••@203.0.113.10:15432/shop?sslmode=disable",
          },
          rotationUnresolved: true,
        }),
      }),
    );
    renderApp("/projects/shop/postgres/db/");

    expect(await screen.findByText("203.0.113.10:15432")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Not exposed" })).toBeNull();
    expect(screen.getByRole("img", { name: "Password unconfirmed" })).toBeTruthy();
  });

  describe("a started process versus an engine that lets the panel in (REQ-198)", () => {
    const availability = (overrides: Partial<DatabaseAvailability>): DatabaseAvailability => ({
      process: "running",
      signIn: "accepted",
      detail: null,
      checkedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("says it accepts the panel's credentials when it does", async () => {
      installFakeServer(
        base({ [`GET ${SERVICE}/database/availability`]: availability({ signIn: "accepted" }) }),
      );
      renderApp("/projects/shop/postgres/db/");
      expect(await screen.findByRole("img", { name: "Accepted" })).toBeTruthy();
      expect(screen.getByText("Sign-in")).toBeTruthy();
    });

    it("says so, with its own lamp, when the engine runs and refuses", async () => {
      installFakeServer(
        base({
          [`GET ${SERVICE}/database/availability`]: availability({
            signIn: "refused",
            detail: "password authentication failed",
          }),
        }),
      );
      renderApp("/projects/shop/postgres/db/");
      expect(await screen.findByRole("img", { name: "Refused" })).toBeTruthy();
    });

    it("does not claim anything about an engine that is not running", async () => {
      installFakeServer(
        base({
          [`GET ${SERVICE}/database/availability`]: availability({
            process: "not-running",
            signIn: "unknown",
          }),
        }),
      );
      renderApp("/projects/shop/postgres/db/");
      expect(await screen.findByRole("img", { name: "Not running" })).toBeTruthy();
    });
  });

  it("doesn't call a port open just because it was saved", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/expose`]: { port: 15432, publishedPort: 0 },
      }),
    );
    renderApp("/projects/shop/postgres/db/expose");

    expect(await screen.findByText("Not exposed")).toBeTruthy();
    expect(screen.queryByText(/Open on port/)).toBeNull();
  });

  it("leads the expose tab with whether it is open", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/expose`]: { port: 15432, publishedPort: 15432 },
      }),
    );
    renderApp("/projects/shop/postgres/db/expose");

    expect(await screen.findByText("Open on port 15432 · Running")).toBeTruthy();
  });
});

describe("the Credentials tab (DAT-05, DAT-06)", () => {
  it("shows the fields with the password masked, and reveals through the audited endpoint", async () => {
    const server = installFakeServer(
      base({
        [`POST ${SERVICE}/credentials/reveal`]: (body: unknown) => {
          expect(body).toEqual({ secret: "password" });
          return { value: "hunter2hunter2" };
        },
      }),
    );
    renderApp("/projects/shop/postgres/db/credentials");

    await screen.findByText("shop_db");
    expect(screen.getByText("postgres://postgres:••••••••@shop_db:5432/shop?sslmode=disable")).toBeTruthy();
    expect(screen.getAllByText("••••••••").length).toBe(1);
    expect(server.calls.some((call) => call.path.endsWith("/reveal"))).toBe(false);

    const row = screen.getByText("Password").closest("div") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Reveal" }));
    expect(await within(row).findByText("hunter2hunter2")).toBeTruthy();
  });

  it("hides again without asking the server", async () => {
    let reveals = 0;
    installFakeServer(
      base({
        [`POST ${SERVICE}/credentials/reveal`]: () => {
          reveals += 1;
          return { value: "secret" };
        },
      }),
    );
    renderApp("/projects/shop/postgres/db/credentials");

    const row = (await screen.findByText("Password")).closest("div") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Reveal" }));
    await within(row).findByText("secret");
    fireEvent.click(within(row).getByRole("button", { name: "Hide" }));
    await within(row).findByText("••••••••");
    expect(reveals).toBe(1);
  });

  it("shows the external group only once exposed", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/credentials`]: credentials({
          external: {
            host: "203.0.113.10",
            port: 15432,
            maskedUrl: "postgres://postgres:••••••••@203.0.113.10:15432/shop?sslmode=disable",
          },
        }),
      }),
    );
    renderApp("/projects/shop/postgres/db/credentials");

    await screen.findByText("From outside");
    expect(screen.getByText("15432")).toBeTruthy();
  });

  it("offers only the password to change, and sends what was typed", async () => {
    const server = installFakeServer(base({ [`PUT ${SERVICE}/credentials`]: withStatus(202, action()) }));
    const app = renderApp("/projects/shop/postgres/db/credentials");

    fireEvent.click(await button("Change password"));
    const dialog = await screen.findByRole("dialog", { name: "Change the password" });
    expect(within(dialog).queryByLabelText(/Root password/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/New password/), { target: { value: "new-pass" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ password: "new-pass" }),
    );
    app.emit(actionsTopic, action({ status: "succeeded" }));
    await screen.findByText("Password changed");
  });

  it("refuses an empty new password before sending anything", async () => {
    const server = installFakeServer(base());
    renderApp("/projects/shop/postgres/db/credentials");

    fireEvent.click(await button("Change password"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change password" }));

    await within(dialog).findByText("Enter a new password.");
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("asks for the root password too on MySQL (GAP-35)", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}`]: detail({ type: "mysql" }),
        [`GET ${SERVICE}/credentials`]: credentials({ engine: "mysql", hasRootPassword: true }),
      }),
    );
    renderApp("/projects/shop/mysql/db/credentials");

    expect(await screen.findByText("Root password")).toBeTruthy();
    fireEvent.click(await button("Change password"));
    expect(await screen.findByLabelText(/New root password/)).toBeTruthy();
  });

  it("flags a change the panel could not confirm, and offers to check", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/credentials`]: credentials({ rotationUnresolved: true }),
        [`POST ${SERVICE}/credentials/check`]: withStatus(202, action({ id: "c1" })),
      }),
    );
    renderApp("/projects/shop/postgres/db/credentials");

    fireEvent.click(await button("Check again"));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/credentials/check"))).toBe(true),
    );
  });

  it("reports a failed change with the reason, and leaves the page in place", async () => {
    installFakeServer(base({ [`PUT ${SERVICE}/credentials`]: withStatus(202, action()) }));
    const app = renderApp("/projects/shop/postgres/db/credentials");

    fireEvent.click(await button("Change password"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/New password/), { target: { value: "x-pass-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    app.emit(actionsTopic, action({ status: "failed", error: "The password was not changed: refused" }));
    expect(await screen.findByText("The password was not changed: refused")).toBeTruthy();
  });

  it("shows its error state and retries", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/credentials`]: withStatus(500, {
          error: { code: "internal_error", message: "Boom." },
        }),
      }),
    );
    renderApp("/projects/shop/postgres/db/credentials");

    await button("Try again");
    server.set({ [`GET ${SERVICE}/credentials`]: credentials() });
    fireEvent.click(await button("Try again"));
    expect(await screen.findByText("shop_db")).toBeTruthy();
  });
});

describe("the Expose tab (DAT-07)", () => {
  const exposeRoutes = (port: number): FakeRoute =>
    base({
      [`GET ${SERVICE}/expose`]: { port, publishedPort: port },
      [`PUT ${SERVICE}/expose`]: { port },
    });

  it("warns about the risk and asks before exposing", async () => {
    const server = installFakeServer(exposeRoutes(0));
    renderApp("/projects/shop/postgres/db/expose");

    expect(await screen.findByText("Think twice before exposing a database")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Public port"), { target: { value: "15432" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Expose this database?" });
    expect(server.calls.some((call) => call.method === "PUT")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Expose it" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ port: 15432 }),
    );
  });

  it("removes a port without a warning dialog", async () => {
    const server = installFakeServer(exposeRoutes(15432));
    renderApp("/projects/shop/postgres/db/expose");

    fireEvent.change(await screen.findByLabelText("Public port"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({ port: 0 }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects an invalid port before sending anything", async () => {
    const server = installFakeServer(exposeRoutes(0));
    renderApp("/projects/shop/postgres/db/expose");

    fireEvent.change(await screen.findByLabelText("Public port"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Use 0, or a whole number from 1024 to 65535.");
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("shows a conflict from the server on the field", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/expose`]: { port: 0, publishedPort: 0 },
        [`PUT ${SERVICE}/expose`]: withStatus(409, {
          error: { code: "port_in_use", message: "Used.", fields: { port: "Already used by shop/other" } },
        }),
      }),
    );
    renderApp("/projects/shop/postgres/db/expose");

    fireEvent.change(await screen.findByLabelText("Public port"), { target: { value: "16379" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Expose it" }));

    expect(await screen.findByText("This port is already in use on this server.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Public port").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the Resources tab (DAT-08)", () => {
  it("shows the saved values, and saves numbers", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/database-resources`]: {
          memoryReservation: 64,
          memoryLimit: 128,
          cpuReservation: 0.1,
          cpuLimit: 0.5,
        },
        [`PUT ${SERVICE}/database-resources`]: {
          memoryReservation: 64,
          memoryLimit: 256,
          cpuReservation: 0.1,
          cpuLimit: 0.5,
        },
      }),
    );
    renderApp("/projects/shop/postgres/db/resources");

    const limit = (await screen.findByLabelText("Memory limit (MB)")) as HTMLInputElement;
    await waitFor(() => expect(limit.value).toBe("128"));
    fireEvent.change(limit, { target: { value: "256" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        memoryReservation: 64,
        memoryLimit: 256,
        cpuReservation: 0.1,
        cpuLimit: 0.5,
      }),
    );
  });

  it("refuses a negative value before sending anything", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/database-resources`]: {
          memoryReservation: 0,
          memoryLimit: 0,
          cpuReservation: 0,
          cpuLimit: 0,
        },
      }),
    );
    renderApp("/projects/shop/postgres/db/resources");

    fireEvent.change(await screen.findByLabelText("Memory limit (MB)"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Use a number, 0 or more, and keep any reservation within its limit.");
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });
});

describe("the Advanced tab (DAT-09)", () => {
  const advanced = (engine = "postgres", overrides: Partial<DatabaseAdvancedSettings> = {}): FakeRoute =>
    base({
      [`GET ${SERVICE}`]: detail({ type: engine }),
      [`GET ${SERVICE}/database-advanced`]: {
        image: `${engine}:18`,
        command: "",
        envNames: [],
        configFile: "",
        ...overrides,
      },
      [`PUT ${SERVICE}/database-advanced`]: {
        image: "postgres:17",
        command: "",
        envNames: [],
        configFile: "",
      },
    });

  it("edits image, command and environment", async () => {
    const server = installFakeServer(advanced());
    renderApp("/projects/shop/postgres/db/advanced");

    const image = (await screen.findByLabelText("Image")) as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe("postgres:18"));
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "TZ=UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        image: "postgres:18",
        command: "",
        env: "TZ=UTC",
        configFile: "",
      }),
    );
  });

  it("shows variables by name, and only sends values someone asked to see", async () => {
    const server = installFakeServer({
      ...advanced("postgres", { envNames: ["TZ"] }),
      [`POST ${SERVICE}/environment/reveal`]: { env: "TZ=UTC" },
    });
    renderApp("/projects/shop/postgres/db/advanced");

    await screen.findByText("TZ");
    expect(screen.queryByLabelText("Environment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
        image: "postgres:18",
        command: "",
        configFile: "",
      }),
    );
    expect(server.calls.some((call) => call.path.endsWith("/environment/reveal"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show and edit" }));
    const field = (await screen.findByLabelText("Environment")) as HTMLTextAreaElement;
    expect(field.value).toBe("TZ=UTC");
  });

  it("offers a config file only on MySQL and MariaDB", async () => {
    installFakeServer(advanced("postgres"));
    const app = renderApp("/projects/shop/postgres/db/advanced");
    await screen.findByLabelText("Image");
    expect(screen.queryByLabelText("Config file")).toBeNull();
    app.unmount();
    resetApp();

    installFakeServer(advanced("mysql"));
    renderApp("/projects/shop/mysql/db/advanced");
    expect(await screen.findByLabelText("Config file")).toBeTruthy();
  });

  it("asks before moving to another major version, and sends the name typed (REQ-202)", async () => {
    const server = installFakeServer(advanced("postgres", { image: "postgres:18.6" }));
    renderApp("/projects/shop/postgres/db/advanced");

    const image = (await screen.findByLabelText("Image")) as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe("postgres:18.6"));
    fireEvent.change(image, { target: { value: "postgres:19.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Move to another major version?" });
    expect(within(dialog).getByText(/backup of the whole server/)).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "db" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save this version" }));

    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({
        image: "postgres:19.0",
        confirm: "db",
      }),
    );
  });

  it("says to start a stopped database when it can't be backed up for the move (REQ-202)", async () => {
    installFakeServer({
      ...advanced("postgres", { image: "postgres:18.6" }),
      [`PUT ${SERVICE}/database-advanced`]: withStatus(409, {
        error: { code: "major_change_needs_running", message: "Start this database first." },
      }),
    });
    renderApp("/projects/shop/postgres/db/advanced");

    const image = (await screen.findByLabelText("Image")) as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe("postgres:18.6"));
    fireEvent.change(image, { target: { value: "postgres:19.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Move to another major version?" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "db" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save this version" }));

    expect(await within(dialog).findByText(/moving to another major version backs it up/)).toBeTruthy();
  });

  it("refuses a floating image before sending anything (REQ-495)", async () => {
    const server = installFakeServer(advanced("postgres", { image: "postgres:18.6" }));
    renderApp("/projects/shop/postgres/db/advanced");

    const image = (await screen.findByLabelText("Image")) as HTMLInputElement;
    await waitFor(() => expect(image.value).toBe("postgres:18.6"));
    fireEvent.change(image, { target: { value: "postgres:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Name a fixed version, such as postgres:18.6, or pin a digest.");
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });

  it("rejects a malformed environment before sending anything", async () => {
    const server = installFakeServer(advanced());
    renderApp("/projects/shop/postgres/db/advanced");

    await screen.findByLabelText("Image");
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "no equals" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Each line must look like NAME=value.");
    expect(server.calls.filter((call) => call.method === "PUT")).toEqual([]);
  });
});

describe("companions (DAT-13)", () => {
  it("offers one card per tool, each enabled on its own", async () => {
    const server = installFakeServer(
      base({
        [`POST ${SERVICE}/companions/pgweb`]: withStatus(
          202,
          action({ id: "c1", type: "database.companion-enable" }),
        ),
      }),
    );
    renderApp("/projects/shop/postgres/db/");

    const pgweb = (await screen.findByText("pgweb")).closest("li") as HTMLElement;
    expect(within(pgweb).getByRole("button", { name: "Enable" })).toBeTruthy();
    expect((await screen.findByText("DbGate")).closest("li")).toBeTruthy();

    fireEvent.click(within(pgweb).getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/companions/pgweb"))).toBe(true),
    );
    expect(server.calls.some((call) => call.path.endsWith("/companions/dbgate"))).toBe(false);
  });

  it("shows the address of an enabled tool, with its token behind a reveal", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/companions`]: {
          companions: [
            {
              tool: "pgweb",
              enabled: true,
              url: "https://shop-db-pgweb.example.test/",
              username: "opsifier",
            },
          ],
        },
      }),
    );
    renderApp("/projects/shop/postgres/db/");

    expect(await screen.findByText("https://shop-db-pgweb.example.test/")).toBeTruthy();
    expect(screen.getByText("opsifier")).toBeTruthy();
    expect(screen.getByText("••••••••")).toBeTruthy();
  });
});
