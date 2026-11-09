// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  withStatus,
} from "../../../testing/appHarness";

vi.mock("../../../ui/CodeEditor", () => ({
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

const SERVICE = "/projects/shop/services/web";

const service = {
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: [],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "nginx:alpine", username: null, hasPassword: false },
  notes: "",
  notesHidden: false,
  stopped: false,
  primaryUrl: null,
  pendingChanges: false,
  answering: null,
};

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  [`GET ${SERVICE}`]: service,
  [`GET ${SERVICE}/metrics`]: {
    cpuPercent: 0,
    memoryUsedBytes: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    readAt: null,
  },
  ...extra,
});

const error = (status: number, code: string, fields?: Record<string, string>) =>
  withStatus(status, { error: { code, message: "refused", ...(fields ? { fields } : {}) } });

const setValue = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe("the resources tab", () => {
  const initial = { memoryReservation: 0, memoryLimit: 0, cpuReservation: 0, cpuLimit: 0 };

  it("saves numbers and reminds you to deploy", async () => {
    const server = installFakeServer(
      base({ [`GET ${SERVICE}/resources`]: initial, [`PUT ${SERVICE}/resources`]: (body: unknown) => body }),
    );
    renderApp("/projects/shop/app/web/resources");

    setValue(await screen.findByRole("spinbutton", { name: "Memory limit (MB)" }), "128");
    setValue(screen.getByRole("spinbutton", { name: "CPU limit (cores)" }), "0.5");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Resources saved");
    expect(screen.getByText("Deploy to apply them.")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
      ...initial,
      memoryLimit: 128,
      cpuLimit: 0.5,
    });
  });

  it.each([
    ["Memory limit (MB)", "-1", "Use 0 for no limit, or at least 6 MB."],
    ["Memory limit (MB)", "3", "Use 0 for no limit, or at least 6 MB."],
    ["CPU limit (cores)", "", "Use 0 for no limit, or at least 0.01 cores."],
  ])("refuses %s of %j before sending anything", async (label, value, message) => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/resources`]: initial }));
    renderApp("/projects/shop/app/web/resources");

    setValue(await screen.findByRole("spinbutton", { name: label }), value);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(server.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("offers to retry when loading fails", async () => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/resources`]: error(500, "internal_error") }));
    renderApp("/projects/shop/app/web/resources");

    await screen.findByText("The server hit a problem and couldn't finish.");
    server.set({ [`GET ${SERVICE}/resources`]: initial });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("spinbutton", { name: "Memory limit (MB)" })).toBeTruthy();
  });
});

describe("the scripts tab", () => {
  it("adds a script from the empty state", async () => {
    let scripts: unknown[] = [];
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: () => ({ scripts }),
        [`POST ${SERVICE}/scripts`]: (body: unknown) => {
          scripts = [body];
          return { scripts };
        },
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Add a script" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Name" }), "Clear cache");
    setValue(dialog.getByRole("textbox", { name: "Script" }), "rm -rf /tmp/cache");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Clear cache")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      name: "Clear cache",
      script: "rm -rf /tmp/cache",
      maxDurationSeconds: 3600,
      schedule: null,
      runAfterDeploy: false,
    });
  });

  it("refuses an empty name", async () => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/scripts`]: { scripts: [] } }));
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Add a script" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await dialog.findByText(/Give it a name/)).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows the server's refusal of a duplicate on the name", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [] },
        [`POST ${SERVICE}/scripts`]: error(409, "script_name_taken", { name: "taken" }),
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Add a script" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Name" }), "Backup");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await dialog.findByText("A script with this name already exists.")).toBeTruthy();
  });

  it("deletes after asking", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ name: "Backup", script: "tar c" }] },
        [`DELETE ${SERVICE}/scripts/0`]: { scripts: [] },
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Delete this script" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete script" }));

    await waitFor(() => expect(server.calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});

describe("the storage tab", () => {
  const empty = { mounts: [] };

  async function addBind(hostPath: string, mountPath: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Add a bind mount" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Path on the server" }), hostPath);
    setValue(dialog.getByRole("textbox", { name: "Path in the container" }), mountPath);
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    return dialog;
  }

  it("lists the three kinds with what identifies each", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/storage`]: {
          mounts: [
            {
              type: "bind",
              hostPath: "/srv/app",
              mountPath: "/mnt/bind",
              acknowledgeRisk: false,
              risk: null,
            },
            { type: "volume", name: "probe-vol", mountPath: "/data/vol" },
            { type: "file", mountPath: "/etc/app.conf", content: "x" },
          ],
        },
      }),
    );
    renderApp("/projects/shop/app/web/storage");

    expect(await screen.findByText("/srv/app")).toBeTruthy();
    expect(screen.getByText("probe-vol")).toBeTruthy();
    expect(screen.getByText("File kept by the panel")).toBeTruthy();
    expect(screen.getByText("BIND")).toBeTruthy();
    expect(screen.getByText("VOLUME")).toBeTruthy();
    expect(screen.getByText("FILE")).toBeTruthy();
    expect(document.querySelector('li svg[data-pictogram="volume"]')).toBeTruthy();
  });

  it("adds a bind mount and reminds you to deploy", async () => {
    const server = installFakeServer(
      base({ [`GET ${SERVICE}/storage`]: empty, [`POST ${SERVICE}/storage/mounts`]: empty }),
    );
    renderApp("/projects/shop/app/web/storage");

    await addBind("/srv/app", "/data");

    await screen.findByText("Mount added");
    expect(screen.getByText("Deploy to apply it.")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      type: "bind",
      hostPath: "/srv/app",
      mountPath: "/data",
      acknowledgeRisk: false,
    });
  });

  it("refuses relative paths before sending anything", async () => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/storage`]: empty }));
    renderApp("/projects/shop/app/web/storage");

    const dialog = await addBind("srv/app", "data");

    expect(await dialog.findByText(/Use an absolute path such as \/srv\/app/)).toBeTruthy();
    expect(dialog.getByText(/Use an absolute path such as \/data/)).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("warns before mounting the Docker socket, and goes ahead only when told to", async () => {
    let attempts = 0;
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/storage`]: empty,
        [`POST ${SERVICE}/storage/mounts`]: (body: { acknowledgeRisk?: boolean }) => {
          attempts += 1;
          return body.acknowledgeRisk
            ? empty
            : error(400, "mount_exposes_docker_socket", { hostPath: "Exposes the Docker socket" });
        },
      }),
    );
    renderApp("/projects/shop/app/web/storage");

    await addBind("/var/run/docker.sock", "/var/run/docker.sock");

    expect(await screen.findByText("This gives the container power over the server")).toBeTruthy();
    expect(screen.getByText(/can start containers of its own/)).toBeTruthy();
    expect(attempts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Mount it anyway" }));

    await screen.findByText("Mount added");
    expect(attempts).toBe(2);
    expect(server.calls.filter((call) => call.method === "POST").at(-1)?.body).toMatchObject({
      acknowledgeRisk: true,
    });
  });

  it("marks a dangerous mount in the list", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/storage`]: {
          mounts: [
            {
              type: "bind",
              hostPath: "/var/run/docker.sock",
              mountPath: "/d.sock",
              acknowledgeRisk: true,
              risk: "docker-socket",
            },
          ],
        },
      }),
    );
    renderApp("/projects/shop/app/web/storage");

    expect(await screen.findByText("Exposes the Docker socket to this container")).toBeTruthy();
  });

  it("keeps the confirmation when a dangerous mount is edited but stays the same path", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/storage`]: {
          mounts: [
            {
              type: "bind",
              hostPath: "/var/run/docker.sock",
              mountPath: "/d.sock",
              acknowledgeRisk: true,
              risk: "docker-socket",
            },
          ],
        },
        [`PUT ${SERVICE}/storage/mounts/0`]: empty,
      }),
    );
    renderApp("/projects/shop/app/web/storage");

    fireEvent.click(await screen.findByRole("button", { name: "Edit this mount" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Path in the container" }), "/other.sock");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await screen.findByText("Mount updated");
    expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({ acknowledgeRisk: true });
  });

  it("shows a path clash on the field", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/storage`]: empty,
        [`POST ${SERVICE}/storage/mounts`]: error(409, "mount_path_taken", { mountPath: "taken" }),
      }),
    );
    renderApp("/projects/shop/app/web/storage");

    const dialog = await addBind("/srv/app", "/data");

    expect(await dialog.findByText("Another mount already uses this path.")).toBeTruthy();
  });

  it("adds a volume and a file", async () => {
    const server = installFakeServer(
      base({ [`GET ${SERVICE}/storage`]: empty, [`POST ${SERVICE}/storage/mounts`]: empty }),
    );
    renderApp("/projects/shop/app/web/storage");

    fireEvent.click(await screen.findByRole("button", { name: "Add a volume" }));
    let dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Name" }), "data");
    setValue(dialog.getByRole("textbox", { name: "Path in the container" }), "/data");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "Add a file" }));
    dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Path in the container" }), "/etc/app.conf");
    setValue(dialog.getByRole("textbox", { name: "Content" }), "key=value");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(server.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
      { type: "volume", name: "data", mountPath: "/data" },
      { type: "file", mountPath: "/etc/app.conf", content: "key=value" },
    ]);
  });

  it("refuses a volume name with spaces", async () => {
    installFakeServer(base({ [`GET ${SERVICE}/storage`]: empty }));
    renderApp("/projects/shop/app/web/storage");

    fireEvent.click(await screen.findByRole("button", { name: "Add a volume" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("textbox", { name: "Name" }), "my vol");
    setValue(dialog.getByRole("textbox", { name: "Path in the container" }), "/data");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await dialog.findByText(/Use lowercase letters/)).toBeTruthy();
  });
});

describe("the advanced tab", () => {
  const deploy = {
    replicas: 1,
    zeroDowntime: true,
    tiniInit: false,
    command: null,
    stopSignal: null,
    stopGraceSeconds: 10,
    capAdd: [],
    capDrop: [],
    sysctls: {},
    groups: [],
  };
  const document = (overrides: object = {}) => ({ deploy, ports: [], stopped: false, ...overrides });

  it("saves deploy settings typed as text, as the lists the API wants", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document(),
        [`PUT ${SERVICE}/advanced/deploy`]: (body: unknown) => body,
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    setValue(await screen.findByRole("spinbutton", { name: "Replicas" }), "2");
    setValue(screen.getByRole("textbox", { name: /^Command/ }), "nginx -g 'daemon off;'");
    setValue(screen.getByRole("spinbutton", { name: /^Time to stop/ }), "45");
    setValue(screen.getByRole("textbox", { name: /^Add capabilities/ }), "net_admin, CAP_SYS_PTRACE");
    setValue(screen.getByRole("textbox", { name: /^Drop capabilities/ }), "MKNOD");
    setValue(
      screen.getByRole("textbox", { name: /^Sysctls/ }),
      "net.ipv4.ip_unprivileged_port_start=0, net.core.somaxconn=1024",
    );
    setValue(screen.getByRole("textbox", { name: /^Extra groups/ }), "999, 1000");
    fireEvent.click(screen.getByRole("switch", { name: "Zero downtime" }));
    fireEvent.click(screen.getByRole("switch", { name: "Run with an init process" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Deploy settings saved");
    expect(server.calls.find((call) => call.method === "PUT")?.body).toEqual({
      replicas: 2,
      zeroDowntime: false,
      tiniInit: true,
      command: "nginx -g 'daemon off;'",
      stopSignal: null,
      stopGraceSeconds: 45,
      capAdd: ["NET_ADMIN", "SYS_PTRACE"],
      capDrop: ["MKNOD"],
      sysctls: { "net.ipv4.ip_unprivileged_port_start": "0", "net.core.somaxconn": "1024" },
      groups: ["999", "1000"],
    });
  });

  it.each([
    [/^Replicas/, "0", "Run from 1 to 100 replicas."],
    [
      /^Add capabilities/,
      "NOT_A_CAP",
      "Use known capability names such as NET_ADMIN, each listed once and never in both fields.",
    ],
    [/^Sysctls/, "vm.swappiness=1", "Use namespaced key=value pairs such as net.core.somaxconn=1024."],
    [/^Extra groups/, "wheel", "Use numeric group IDs."],
    [/^Time to stop/, "-5", "Use a whole number of seconds, from 0 to 3600."],
  ])("refuses a bad value for %s before sending anything", async (name, value, message) => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/advanced`]: document() }));
    renderApp("/projects/shop/app/web/advanced");
    await screen.findByRole("spinbutton", { name: "Replicas" });

    const field = screen.queryByRole("spinbutton", { name }) ?? screen.getByRole("textbox", { name });
    setValue(field, value);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(server.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("accepts zero replicas on a stopped service", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document({ stopped: true }),
        [`PUT ${SERVICE}/advanced/deploy`]: (body: unknown) => body,
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    setValue(await screen.findByRole("spinbutton", { name: "Replicas" }), "0");
    expect(screen.getByText(/A stopped service can stay at 0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Deploy settings saved");
    expect(server.calls.find((call) => call.method === "PUT")?.body).toMatchObject({ replicas: 0 });
  });

  it("explains why zero downtime is off while ports are published", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document({ ports: [{ protocol: "tcp", published: 30080, target: 80 }] }),
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    expect(await screen.findByText(/a new task can't bind a port/)).toBeTruthy();
  });

  it("adds a port from a dialog", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document(),
        [`POST ${SERVICE}/advanced/ports`]: { ports: [{ protocol: "udp", published: 30053, target: 53 }] },
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    fireEvent.click(await screen.findByRole("button", { name: "Add a port" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("combobox", { name: "Protocol" }));
    fireEvent.click(await screen.findByRole("option", { name: "UDP" }));
    setValue(dialog.getByRole("spinbutton", { name: /^Published/ }), "30053");
    setValue(dialog.getByRole("spinbutton", { name: /^Target/ }), "53");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    await screen.findByText("Port added");
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      protocol: "udp",
      published: 30053,
      target: 53,
    });
  });

  it.each(["0", "70000", ""])("refuses %j as a port before sending anything", async (value) => {
    const server = installFakeServer(base({ [`GET ${SERVICE}/advanced`]: document() }));
    renderApp("/projects/shop/app/web/advanced");

    fireEvent.click(await screen.findByRole("button", { name: "Add a port" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("spinbutton", { name: /^Published/ }), value);
    setValue(dialog.getByRole("spinbutton", { name: /^Target/ }), "80");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await dialog.findByText("Use a port from 1 to 65535.")).toBeTruthy();
    expect(server.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows a clash with another service on the field", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document(),
        [`POST ${SERVICE}/advanced/ports`]: error(409, "port_in_use", { published: "taken" }),
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    fireEvent.click(await screen.findByRole("button", { name: "Add a port" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("spinbutton", { name: /^Published/ }), "30080");
    setValue(dialog.getByRole("spinbutton", { name: /^Target/ }), "80");
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    expect(await dialog.findByText("This port is already in use on this server.")).toBeTruthy();
  });

  it("removes every port after asking", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/advanced`]: document({ ports: [{ protocol: "tcp", published: 30080, target: 80 }] }),
        [`DELETE ${SERVICE}/advanced/ports`]: { ports: [] },
      }),
    );
    renderApp("/projects/shop/app/web/advanced");

    fireEvent.click(await screen.findByRole("button", { name: "Remove all ports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove all" }));

    await screen.findByText("Ports removed");
    expect(server.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/ports"))).toBe(true);
  });
});

describe("script runs", () => {
  const finishedRun = {
    id: "run-1",
    scriptName: "Backup",
    status: "failed",
    origin: "schedule",
    actorEmail: null,
    originDetail: null,
    exitCode: 3,
    task: { id: "task-1", slot: 1 },
    maxDurationSeconds: 60,
    dueAt: "2026-06-01T02:00:00.000Z",
    createdAt: "2026-06-01T02:00:00.000Z",
    startedAt: "2026-06-01T02:00:01.000Z",
    finishedAt: "2026-06-01T02:00:05.000Z",
    note: null,
    outputComplete: true,
    outputTruncated: false,
  };
  const script = {
    name: "Backup",
    script: "tar c",
    maxDurationSeconds: 60,
    schedule: null,
    runAfterDeploy: false,
  };
  const empty = { items: [], nextCursor: null };

  it("starts a run and shows what became of it", async () => {
    const running = { ...finishedRun, status: "running", exitCode: null, finishedAt: null };
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ ...script, nextRunAt: null, lastRun: null }] },
        [`GET ${SERVICE}/script-runs`]: empty,
        [`POST ${SERVICE}/script-runs`]: {
          id: "run-1",
          type: "service.script",
          title: "Run Backup",
          status: "queued",
          projectName: "shop",
          serviceName: "web",
          createdAt: finishedRun.createdAt,
          startedAt: null,
          finishedAt: null,
          error: null,
          hasLog: false,
          actorEmail: null,
          origin: "session",
          originDetail: null,
          run: running,
        },
        [`GET ${SERVICE}/script-runs/run-1`]: { ...finishedRun, output: "tar: nothing\n" },
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Run Backup now" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Run of Backup" }));
    expect(await dialog.findByText("tar: nothing")).toBeTruthy();
    expect(dialog.getByText("Failed")).toBeTruthy();
    expect(dialog.getByText("3")).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ script: "Backup" });
  });

  it("says when a script is already running", async () => {
    installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ ...script, nextRunAt: null, lastRun: null }] },
        [`GET ${SERVICE}/script-runs`]: empty,
        [`POST ${SERVICE}/script-runs`]: error(409, "script_already_running"),
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Run Backup now" }));

    expect(
      await screen.findByText(
        "This script is already running. Wait for it to finish or stop it, then try again.",
      ),
    ).toBeTruthy();
  });

  it("lists past runs with how they started and ended, and shows what cannot be known", async () => {
    const lost = {
      ...finishedRun,
      id: "run-2",
      status: "unknown",
      origin: "api",
      actorEmail: "ci@example.com",
      exitCode: null,
      outputComplete: false,
      note: { code: "panel_restarted_unknown", message: "english" },
    };
    installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ ...script, nextRunAt: null, lastRun: lost }] },
        [`GET ${SERVICE}/script-runs`]: { items: [lost, finishedRun], nextCursor: null },
        [`GET ${SERVICE}/script-runs/run-2`]: { ...lost, output: "partial\n" },
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    const row = (await screen.findByText("API")).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Schedule").length).toBeGreaterThan(0);

    fireEvent.click(within(row).getByRole("button", { name: "See this run" }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("partial")).toBeTruthy();
    expect(dialog.getByText(/Docker no longer knows this process/)).toBeTruthy();
    expect(dialog.getByText(/not complete/)).toBeTruthy();
  });

  it("offers to stop a run that is still going, and stops it", async () => {
    const running = { ...finishedRun, status: "running", exitCode: null, finishedAt: null };
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ ...script, nextRunAt: null, lastRun: running }] },
        [`GET ${SERVICE}/script-runs`]: { items: [running], nextCursor: null },
        [`POST ${SERVICE}/script-runs/run-1/cancel`]: running,
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    fireEvent.click(await screen.findByRole("button", { name: "Stop this run" }));

    await waitFor(() => expect(server.calls.some((call) => call.path.endsWith("/cancel"))).toBe(true));
  });

  it("does not offer to start a script that is running", async () => {
    const running = { ...finishedRun, status: "running", exitCode: null, finishedAt: null };
    installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: { scripts: [{ ...script, nextRunAt: null, lastRun: running }] },
        [`GET ${SERVICE}/script-runs`]: { items: [running], nextCursor: null },
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    const button = await screen.findByRole("button", { name: "Run Backup now" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a schedule's time zone and refuses a bad one before anything is sent", async () => {
    const server = installFakeServer(
      base({
        [`GET ${SERVICE}/scripts`]: {
          scripts: [
            {
              ...script,
              schedule: { cron: "0 3 * * *", timeZone: "Asia/Tokyo" },
              nextRunAt: "2030-01-01T18:00:00.000Z",
              lastRun: null,
            },
          ],
        },
        [`GET ${SERVICE}/script-runs`]: empty,
      }),
    );
    renderApp("/projects/shop/app/web/scripts");

    expect(await screen.findByText("Asia/Tokyo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit this script" }));
    const dialog = within(await screen.findByRole("dialog"));
    setValue(dialog.getByRole("combobox", { name: "Time zone" }), "Mars/Olympus");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    expect(await dialog.findByText("Enter a time zone name such as Europe/Paris or UTC.")).toBeTruthy();
    expect(server.calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
