import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActionEntry,
  BOX_BASE_IMAGE,
  BOX_MATRIX_REVISION,
  type BoxDetail,
  type BoxProcessesStatus,
  boxMatrix,
  boxModuleIds,
  boxModuleIssues,
  boxModulesConfig,
  boxPresets,
  type ServiceDetail,
  saveBoxProcessesRequest,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { services } from "../../core/db/schema";
import type { FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { findService } from "../services/repo";
import { boxModuleFixtures } from "./box.fixtures";
import { renderBoxDockerfile } from "./dockerfile";
import { boxWorkspaceDir } from "./service";
import { type StoredBox, storedBox } from "./spec";

const noTools = (): StoredBox => storedBox.parse({});

describe("the module matrix", () => {
  it("pins every version to something that can't move", () => {
    for (const module of boxMatrix) {
      expect(module.versions.length).toBeGreaterThan(0);
      for (const { pin } of module.versions) {
        expect(pin).not.toMatch(/latest/);
        expect(pin).toMatch(/\d/);
      }
      expect(module.versions.map(({ version }) => version)).toContain(module.defaultVersion);
    }
    expect(BOX_BASE_IMAGE).toMatch(/^alpine:\d+\.\d+\.\d+$/);
  });

  it("refuses a version the matrix does not have", () => {
    expect(boxModuleIssues(boxModulesConfig.parse({ node: { version: "12" } }))).toEqual([
      expect.objectContaining({ field: "node.version" }),
    ]);
  });

  it("refuses an extension the matrix does not have", () => {
    expect(
      boxModuleIssues(boxModulesConfig.parse({ node: { version: "24", extensions: ["left-pad"] } })),
    ).toEqual([expect.objectContaining({ field: "node.extensions" })]);
  });

  it("refuses an extension that does not work on the chosen version", () => {
    const issues = boxModuleIssues(
      boxModulesConfig.parse({ php: { version: "8.5", extensions: ["opcache"] } }),
    );
    expect(issues).toEqual([expect.objectContaining({ field: "php.extensions" })]);
    expect(issues[0]?.message).toContain("8.3, 8.4");
  });

  it("accepts the same extension on a version it works on", () => {
    expect(
      boxModuleIssues(boxModulesConfig.parse({ php: { version: "8.4", extensions: ["opcache"] } })),
    ).toEqual([]);
  });

  it("has a fixture for every module it declares", () => {
    expect(Object.keys(boxModuleFixtures).sort()).toEqual([...boxModuleIds].sort());
    for (const id of boxModuleIds) {
      expect(boxModuleFixtures[id].module).toBe(id);
    }
  });

  it("has presets that all build", () => {
    for (const preset of boxPresets) {
      expect(boxModuleIssues(preset.modules)).toEqual([]);
      expect(saveBoxProcessesRequest.safeParse({ processes: preset.processes }).success).toBe(true);
    }
  });
});

describe("the generated image", () => {
  const box = (changes: Partial<StoredBox>): StoredBox => storedBox.parse(changes);

  it.each(boxModuleIds.map((id) => [id]))("installs and checks %s, and nothing else", (id) => {
    const fixture = boxModuleFixtures[id];
    const dockerfile = renderBoxDockerfile(box({ modules: boxModulesConfig.parse(fixture.modules) }));
    const definition = boxMatrix.find((module) => module.id === id);
    const version =
      id === "nginx" ? definition?.defaultVersion : (fixture.modules[id] as { version: string }).version;
    const pin = definition?.versions.find((candidate) => candidate.version === version)?.pin ?? "";

    // A pin's first word names an image or a package, which is what appears in the file.
    expect(dockerfile).toContain(pin.split(" ")[0]);
    for (const other of boxMatrix.filter((module) => module.id !== id)) {
      for (const candidate of other.versions) {
        const [name = ""] = candidate.pin.split(" ");
        expect(dockerfile).not.toContain(name === "nginx" ? "apk add --no-cache nginx" : name);
      }
    }
  });

  it("generates no image that depends on anything outside the matrix", () => {
    const dockerfile = renderBoxDockerfile(noTools());
    expect(dockerfile).toContain(`FROM ${BOX_BASE_IMAGE}`);
    expect(dockerfile).not.toMatch(/latest/);
  });

  it("leaves everything before the last layers alone when a process changes", () => {
    const before = box({ modules: boxModulesConfig.parse({ node: { version: "24" } }) });
    const after = {
      ...before,
      processes: [{ name: "web", command: "node server.js", directory: ".", enabled: true }],
    };
    const shared = (file: string) => file.slice(0, file.indexOf("COPY --chmod=0755"));

    expect(shared(renderBoxDockerfile(after))).toBe(shared(renderBoxDockerfile(before)));
    expect(renderBoxDockerfile(after)).not.toBe(renderBoxDockerfile(before));
  });

  it("keeps a command with shell syntax and a marker lookalike out of the file's own syntax", () => {
    const command = `echo "$PATH" > out\nOPSIFIER_EOF_0123456789abcdef\necho done`;
    const dockerfile = renderBoxDockerfile(
      box({ processes: [{ name: "web", command, directory: ".", enabled: true }] }),
    );
    expect(dockerfile).toContain(command);
    // The marker closing the block is derived from the content, so the content can't contain it.
    const marker = /COPY --chmod=0755 <<'(OPSIFIER_EOF_[0-9a-f]+)' \/opt\/opsifier\/processes\/web/.exec(
      dockerfile,
    )?.[1];
    expect(marker).toBeDefined();
    expect(command).not.toContain(marker as string);
  });

  it("adds package managers only once the runtime that runs them has its libraries", () => {
    const dockerfile = renderBoxDockerfile(
      box({ modules: boxModulesConfig.parse({ node: { version: "24", extensions: ["pnpm"] } }) }),
    );
    expect(dockerfile.indexOf("scanelf")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("npm install --global")).toBeGreaterThan(dockerfile.indexOf("scanelf"));
  });

  it("runs as the box's own user, not as root", () => {
    const dockerfile = renderBoxDockerfile(noTools());
    expect(dockerfile).toContain("USER 1000:1000");
    expect(dockerfile.indexOf("USER 1000:1000")).toBeLessThan(dockerfile.indexOf("ENTRYPOINT"));
  });

  it("waits for the start hook before calling the box healthy", () => {
    expect(renderBoxDockerfile(noTools())).toContain('CMD ["/opt/opsifier/boxctl", "ready"]');
  });
});

describe("a box", () => {
  let context: TestContext;
  let cookie: string;
  const BOX = "/projects/shop/services/dev";

  const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
    call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

  async function waitForAction(id: string): Promise<ActionEntry & { log: string }> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { body } = await api<ActionEntry & { log: string }>(`/actions/${id}`);
      if (body.status !== "queued" && body.status !== "running") {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The action did not finish");
  }

  async function deploy(body: { force?: boolean } = {}) {
    const accepted = await api<ActionEntry>(`${BOX}/deploy`, "POST", body);
    if (accepted.status !== 202) {
      throw new Error(`Deploy answered ${accepted.status}: ${JSON.stringify(accepted.body)}`);
    }
    return waitForAction(accepted.body.id);
  }

  const detail = async () => (await api<BoxDetail>(`${BOX}/box`)).body;
  const tools = () => context.deps.tools as FakeTools;
  const workspace = () => boxWorkspaceDir(context.deps, { projectName: "shop", serviceName: "dev" });
  const swarmSpec = async () => (await context.docker.inspectService("shop_dev"))?.spec;

  beforeEach(async () => {
    context = await createTestContext();
    cookie = await setupAdmin(context.app);
    await api("/projects", "POST", { name: "shop" });
  });

  afterEach(async () => {
    await context.close();
  });

  const create = (preset: string | null = null) =>
    api<ServiceDetail>("/projects/shop/box", "POST", { name: "dev", preset });

  describe("creating one", () => {
    it("makes a service that builds from generated settings and keeps a workspace", async () => {
      const created = await create();
      expect(created.status).toBe(201);
      expect(created.body.type).toBe("box");
      const spec = findService(context.deps.db, "shop", "dev")?.spec;
      expect(spec?.source?.type).toBe("dockerfile");
      expect(spec?.mounts).toEqual([{ type: "volume", name: "workspace", mountPath: "/workspace" }]);
      expect(spec?.deploy).toMatchObject({ replicas: 1, zeroDowntime: false, tiniInit: true });
      expect(existsSync(workspace())).toBe(true);
    });

    it("starts from a preset, writing its starter files", async () => {
      expect((await create("node-service")).status).toBe(201);
      const box = await detail();
      expect(box.modules.node?.version).toBe("24");
      expect(box.processes.map(({ name }) => name)).toEqual(["web"]);
      expect(readFileSync(join(workspace(), "server.js"), "utf8")).toContain("process.env.PORT");
    });

    it("refuses a preset that does not exist", async () => {
      const refused = await api("/projects/shop/box", "POST", { name: "dev", preset: "nothing" });
      expect(refused.status).toBe(400);
    });

    it("takes the name another service holds to be taken", async () => {
      await create();
      expect((await create()).status).toBe(409);
    });
  });

  describe("presets", () => {
    beforeEach(async () => {
      await create();
    });

    it("never touches a file that is already in the workspace", async () => {
      mkdirSync(join(workspace(), "public"), { recursive: true });
      writeFileSync(join(workspace(), "public/index.html"), "mine");
      writeFileSync(join(workspace(), "server.js"), "also mine");

      expect((await api(`${BOX}/box/preset`, "POST", { preset: "static-site" })).status).toBe(200);
      expect((await api(`${BOX}/box/preset`, "POST", { preset: "node-service" })).status).toBe(200);

      expect(readFileSync(join(workspace(), "public/index.html"), "utf8")).toBe("mine");
      expect(readFileSync(join(workspace(), "server.js"), "utf8")).toBe("also mine");
    });

    it("leaves a link alone rather than writing through it", async () => {
      const outside = join(context.dataDir, "outside.txt");
      writeFileSync(outside, "untouched");
      symlinkSync(outside, join(workspace(), "server.js"));

      expect((await api(`${BOX}/box/preset`, "POST", { preset: "node-service" })).status).toBe(200);

      expect(readFileSync(outside, "utf8")).toBe("untouched");
    });

    it("replaces the modules, processes and hooks, and says it did on the Activity page", async () => {
      await api(`${BOX}/box/modules`, "PUT", { python: { version: "3.14" } });
      await api(`${BOX}/box/processes`, "PUT", {
        processes: [{ name: "keep-out", command: "true" }],
      });
      await api(`${BOX}/box/preset`, "POST", { preset: "node-service" });

      const box = await detail();
      expect(box.modules.python).toBeNull();
      expect(box.modules.node).not.toBeNull();
      expect(box.processes.map(({ name }) => name)).toEqual(["web"]);
      const { body } = await api<{ items: ActionEntry[] }>("/actions?serviceName=dev");
      expect(body.items.some((item) => item.type === "box.preset")).toBe(true);
    });
  });

  describe("saving settings", () => {
    beforeEach(async () => {
      await create();
    });

    it("refuses a module outside the matrix, naming the field", async () => {
      const refused = await api(`${BOX}/box/modules`, "PUT", { php: { version: "5.6" } });
      expect(refused.status).toBe(400);
      expect(apiErrorOf(refused).fields).toHaveProperty("php.version");
    });

    it("refuses an extension that is incompatible with the version", async () => {
      const refused = await api(`${BOX}/box/modules`, "PUT", {
        php: { version: "8.5", extensions: ["opcache"] },
      });
      expect(refused.status).toBe(400);
      expect(apiErrorOf(refused).fields).toHaveProperty("php.extensions");
    });

    it("refuses a process with a reserved or repeated name", async () => {
      const reserved = await api(`${BOX}/box/processes`, "PUT", {
        processes: [{ name: "nginx", command: "true" }],
      });
      const repeated = await api(`${BOX}/box/processes`, "PUT", {
        processes: [
          { name: "web", command: "true" },
          { name: "web", command: "true" },
        ],
      });
      expect(reserved.status).toBe(400);
      expect(repeated.status).toBe(400);
    });

    it("refuses a process that would run outside the workspace", async () => {
      const escaping = await api(`${BOX}/box/processes`, "PUT", {
        processes: [{ name: "web", command: "true", directory: "../etc" }],
      });
      expect(escaping.status).toBe(400);
    });

    it("regenerates the image description and never deploys by itself", async () => {
      const before = (await detail()).dockerfile;
      await api(`${BOX}/box/hooks`, "PUT", { build: "apk add jq\n", start: "" });
      const after = await detail();

      expect(after.dockerfile).not.toBe(before);
      expect(after.dockerfile).toContain("apk add jq");
      expect(await context.docker.inspectService("shop_dev")).toBeNull();
    });

    it("keeps its generated source and its workspace from being taken away", async () => {
      expect(apiErrorOf(await api(`${BOX}/source`, "PUT", { type: "image", image: "nginx:1" })).code).toBe(
        "box_source_managed",
      );
      const storage = await api<{ mounts: unknown[] }>(`${BOX}/storage`);
      expect(storage.body.mounts).toHaveLength(1);
      expect((await api(`${BOX}/storage/mounts/0`, "DELETE")).status).toBe(409);
      expect(
        (await api(`${BOX}/storage/mounts/0`, "PUT", { type: "volume", name: "other", mountPath: "/x" }))
          .status,
      ).toBe(409);
    });

    it("refuses settings that would break how a box runs", async () => {
      const { body } = await api<{ deploy: Record<string, unknown> }>(`${BOX}/advanced`);
      const refused = await api(`${BOX}/advanced/deploy`, "PUT", { ...body.deploy, replicas: 3 });
      expect(apiErrorOf(refused).code).toBe("box_deploy_managed");
    });
  });

  describe("deploying", () => {
    beforeEach(async () => {
      await create("node-service");
    });

    it("records the first build, and what it contains", async () => {
      const finished = await deploy();
      expect(finished.status).toBe("succeeded");
      expect(finished.log).toContain("Building this box because: first");

      const box = await detail();
      expect(box.history[0]).toMatchObject({ reason: "first", status: "succeeded" });
      expect(box.built?.modules.node).toMatchObject({ version: "24" });
      expect(box.built?.matrixRevision).toBe(BOX_MATRIX_REVISION);
      expect(box.pendingChanges).toEqual([]);
    });

    it("rebuilds with a changed module while keeping files and configuration", async () => {
      await deploy();
      writeFileSync(join(workspace(), "notes.txt"), "keep me");
      await api(`${BOX}/environment`, "PUT", { env: "API_URL=https://example.test" });

      await api(`${BOX}/box/modules`, "PUT", { node: { version: "22" }, nginx: { documentRoot: "." } });
      expect((await detail()).pendingChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "upgrade", subject: "node", from: "24", to: "22" }),
          expect.objectContaining({ kind: "modules", subject: "nginx" }),
        ]),
      );
      const before = await swarmSpec();

      const finished = await deploy();
      expect(finished.status).toBe("succeeded");
      expect(finished.log).toContain("upgrade node: 24 -> 22");

      expect(readFileSync(join(workspace(), "notes.txt"), "utf8")).toBe("keep me");
      expect(existsSync(join(workspace(), "server.js"))).toBe(true);
      const after = await swarmSpec();
      expect(after?.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining(["API_URL=https://example.test"]),
      );
      expect(after?.TaskTemplate.ForceUpdate).toBeGreaterThan(before?.TaskTemplate.ForceUpdate ?? -1);
      const box = await detail();
      expect(box.processes.map(({ name }) => name)).toEqual(["web"]);
      expect(box.modules.node?.version).toBe("22");
      expect(box.history[0]).toMatchObject({ reason: "upgrade", status: "succeeded" });
    });

    it("reports a runtime whose pin moved as a security rebuild, and traces it", async () => {
      await deploy();
      const record = findService(context.deps.db, "shop", "dev");
      const stale = structuredClone(record?.spec.box);
      if (stale?.built?.modules.node === undefined) {
        throw new Error("Nothing was built.");
      }
      stale.built.modules.node.pin = "node:24.0.0-alpine3.20";
      stale.built.base = "alpine:3.20.0";
      context.deps.db
        .update(services)
        .set({ spec: { ...record?.spec, box: stale } })
        .where(eq(services.name, "dev"))
        .run();

      const pending = await detail();
      expect(pending.pendingChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "security",
            subject: "node",
            from: "node:24.0.0-alpine3.20",
          }),
          expect.objectContaining({ kind: "security", subject: "base" }),
        ]),
      );

      const finished = await deploy();
      expect(finished.log).toContain("Building this box because: security");
      expect((await detail()).history[0]).toMatchObject({
        reason: "security",
        status: "succeeded",
        actorEmail: "admin@example.com",
      });
    });

    it("pulls fresh base images when a rebuild is forced, and says it was forced", async () => {
      await deploy();
      await deploy({ force: true });

      const builds = tools()
        .callsTo("docker")
        .filter((call) => call.args.includes("buildx"));
      const forced = builds.at(-1);
      expect(forced?.args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
      expect((await detail()).history[0]).toMatchObject({ reason: "forced", status: "succeeded" });
    });

    it("stops before any build when a saved extension has become incompatible", async () => {
      await deploy();
      const record = findService(context.deps.db, "shop", "dev");
      const before = await swarmSpec();
      const buildsBefore = tools().callsTo("docker").length;
      if (record?.spec.box === undefined || record.spec.box === null) {
        throw new Error("No box.");
      }
      context.deps.db
        .update(services)
        .set({
          spec: {
            ...record.spec,
            box: {
              ...record.spec.box,
              modules: boxModulesConfig.parse({ php: { version: "8.5", extensions: ["opcache"] } }),
            },
          },
        })
        .where(eq(services.name, "dev"))
        .run();

      const finished = await deploy();

      expect(finished.status).toBe("failed");
      expect(finished.error).toContain("opcache can't be added to version 8.5");
      expect(tools().callsTo("docker").length).toBe(buildsBefore);
      expect((await swarmSpec())?.TaskTemplate.ForceUpdate).toBe(before?.TaskTemplate.ForceUpdate);
    });

    it("leaves what is running alone when the build hook fails, and records why", async () => {
      await deploy();
      const before = await swarmSpec();
      await api(`${BOX}/box/hooks`, "PUT", { build: "exit 9\n", start: "" });
      tools().handler = async (request) => {
        if (request.command === "docker" && request.args.includes("buildx")) {
          request.onLine?.(
            'ERROR: process "/bin/sh -c /opt/opsifier/hooks/build" did not complete successfully: exit code: 9',
          );
          return { exitCode: 1, tail: [] };
        }
        return undefined;
      };

      const finished = await deploy();

      expect(finished.status).toBe("failed");
      expect(finished.error).toContain("The build hook failed");
      expect((await swarmSpec())?.TaskTemplate.ForceUpdate).toBe(before?.TaskTemplate.ForceUpdate);
      expect((await detail()).history[0]).toMatchObject({ status: "failed" });
      expect((await detail()).built?.configuration).toBeDefined();
    });

    it("names the start hook when a task fails because of it", async () => {
      await deploy();
      context.docker.failNext(
        "updateService",
        new Error("The new tasks did not stay up: task: non-zero exit (78)."),
      );

      const finished = await deploy();

      expect(finished.status).toBe("failed");
      expect(finished.error).toContain("The start hook failed");
      expect((await detail()).history[0]).toMatchObject({ status: "failed" });
    });

    it("ends a cancelled build as cancelled and leaves what is running alone", async () => {
      await deploy();
      const before = await swarmSpec();
      tools().buildMs = 5000;

      const accepted = await api<ActionEntry>(`${BOX}/deploy`, "POST", {});
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (
          tools()
            .callsTo("docker")
            .filter((call) => call.args.includes("buildx")).length >= 2
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await api(`/actions/${accepted.body.id}/cancel`, "POST", {});
      const finished = await waitForAction(accepted.body.id);

      expect(finished.status).toBe("cancelled");
      expect((await swarmSpec())?.TaskTemplate.ForceUpdate).toBe(before?.TaskTemplate.ForceUpdate);
      expect((await detail()).history[0]).toMatchObject({ status: "cancelled" });
    });

    it("stops a deployment wanting two tasks at once ever applying, by creating one stop-first", async () => {
      await deploy();
      const spec = await swarmSpec();
      expect(spec?.Mode?.Replicated?.Replicas).toBe(1);
      expect(spec?.UpdateConfig?.Order).toBe("stop-first");
      expect(spec?.TaskTemplate.ContainerSpec.Init).toBe(true);
      expect(spec?.Labels?.["opsifier.type"]).toBe("box");
    });
  });

  describe("its processes", () => {
    beforeEach(async () => {
      await create("php-site");
      await api(`${BOX}/box/processes`, "PUT", {
        processes: [
          { name: "worker", command: "php worker.php" },
          { name: "off", command: "true", enabled: false },
        ],
      });
    });

    it("reports nothing as running until the box has been deployed", async () => {
      const { body } = await api<BoxProcessesStatus>(`${BOX}/box/processes/status`);
      expect(body.reachable).toBe(false);
      expect(body.processes.find(({ name }) => name === "worker")?.state).toBe("unknown");
    });

    it("reports each process and what a module runs itself", async () => {
      await deploy();
      const { body } = await api<BoxProcessesStatus>(`${BOX}/box/processes/status`);
      expect(body.reachable).toBe(true);
      expect(body.processes.map(({ name, state, system }) => [name, state, system])).toEqual([
        ["nginx", "running", true],
        ["php-fpm", "running", true],
        ["worker", "running", false],
        ["off", "disabled", false],
      ]);
    });

    it("restarts one process, and refuses one that isn't running here", async () => {
      await deploy();
      const accepted = await api<ActionEntry>(`${BOX}/box/processes/worker/restart`, "POST");
      expect(accepted.status).toBe(202);
      expect((await waitForAction(accepted.body.id)).status).toBe("succeeded");

      expect((await api(`${BOX}/box/processes/off/restart`, "POST")).status).toBe(404);
      expect((await api(`${BOX}/box/processes/nothing/restart`, "POST")).status).toBe(404);
    });

    it("refuses to restart a process during a deployment", async () => {
      await deploy();
      tools().buildMs = 200;
      const deploying = await api<ActionEntry>(`${BOX}/deploy`, "POST", {});
      const refused = await api(`${BOX}/box/processes/worker/restart`, "POST");
      expect(refused.status).toBe(409);
      expect(apiErrorOf(refused).code).toBe("deployment_in_progress");
      await waitForAction(deploying.body.id);
    });
  });

  describe("access", () => {
    beforeEach(async () => {
      await create();
    });

    it("leaves its settings to operators and hides it from viewers", async () => {
      const viewer = await signIn("viewer@example.com", "viewer");
      const asViewer = (path: string, method = "GET", body?: unknown) =>
        call(context.app, `/api/v1${path}`, { method, body, cookie: viewer, origin: TEST_ORIGIN });

      expect((await asViewer(`${BOX}/box`)).status).toBe(403);
      expect((await asViewer(`${BOX}/box/modules`, "PUT", {})).status).toBe(403);
      expect((await asViewer("/projects/shop/box", "POST", { name: "second" })).status).toBe(403);
    });

    async function signIn(email: string, role: "viewer" | "operator"): Promise<string> {
      const { signInMember } = await import("../../testing/harness");
      return signInMember(context.app, cookie, email, [{ project: "shop", role }]);
    }
  });
});
