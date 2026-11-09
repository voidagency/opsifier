import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionEntry,
  ComposeDetail,
  DomainEntry,
  PortList,
  ServiceDetail,
  ServiceSource,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { scriptExec } from "../databases/testing";
import { PROXY_SERVICE } from "../projects/network";
import { BUILT_IN_PROVIDER_ID } from "../storage-providers/service";
import { qualifiedName } from "./compile";
import { parseProcNet } from "./host-ports";
import { findService, saveRuntimeUncertain } from "./repo";
import { runtimeUncertainty } from "./runtime-state";

let context: TestContext;
let cookie: string;

const IMAGE = "traefik/whoami:v1.10";
const BROKEN_IMAGE = "broken:1";
const SERVICE = "/projects/shop/services/web";
const PUBLISHED = { protocol: "tcp", published: 30080, target: 80 };

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context.close();
});

async function start(options: Parameters<typeof createTestContext>[0] = {}) {
  context = await createTestContext(options);
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
}

function api<T = unknown>(path: string, method = "GET", body?: unknown) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

async function waitForAction(id: string): Promise<ActionEntry & { log: string }> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { body } = await api<ActionEntry & { log: string }>(`/actions/${id}`);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  throw new Error("The action did not finish");
}

async function deploy(path = SERVICE) {
  const accepted = await api<ActionEntry>(`${path}/deploy`, "POST");
  expect(accepted.status).toBe(202);
  return waitForAction(accepted.body.id);
}

async function createWeb(image = IMAGE) {
  expect((await api(`/projects/shop/services`, "POST", { name: "web" })).status).toBe(201);
  expect((await api(`${SERVICE}/source`, "PUT", { image })).status).toBe(200);
}

async function deployedWeb(image = IMAGE) {
  await createWeb(image);
  const deployed = await deploy();
  expect(deployed.status).toBe("succeeded");
}

const detail = async (path = SERVICE) => (await api<ServiceDetail>(path)).body;
const swarm = (name = "shop_web") => context.docker.inspectService(name);
const running = async (name = "shop_web") =>
  (await context.docker.listTasks({ service: name })).filter(
    (task) => task.state === "running" && task.desiredState === "running",
  );

/** Holds a pull open, so that things can happen while a deployment is in the middle of it. */
function holdPull() {
  const real = context.docker.pullImage.bind(context.docker);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(context.docker, "pullImage").mockImplementation(async (ref, options) => {
    started();
    await gate;
    await real(ref, options);
  });
  return { reached, release };
}

/** What a deployment pins this name to, which is what reaches Swarm. */
const pinnedOf = async (image: string) => (await context.docker.inspectImage(image))?.digests[0];

/** Every task of this image fails to start, for as long as the deployment keeps trying. */
const failTasksOf = (image: string, error = "task: non-zero exit (1)") => {
  const repository = image.split(":", 1)[0] as string;
  context.docker.taskFailure = (spec) =>
    spec.TaskTemplate.ContainerSpec.Image.startsWith(`${repository}@`) ? error : null;
};

describe("a setting saved while a deployment is running", () => {
  it("is still there after the deployment, and has not reached the container", async () => {
    await deployedWeb();
    const pull = holdPull();
    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await pull.reached;

    expect((await api(`${SERVICE}/environment`, "PUT", { env: "SAVED_DURING=1" })).status).toBe(200);
    pull.release();
    expect((await waitForAction(accepted.body.id)).status).toBe("succeeded");

    expect((await api<{ env: string }>(`${SERVICE}/environment/reveal`, "POST")).body.env).toBe(
      "SAVED_DURING=1",
    );
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Env?.join("\n")).not.toContain("SAVED_DURING");
    expect((await detail()).pendingChanges).toBe(true);
  });

  it("keeps a trigger token rotated during the deployment", async () => {
    await deployedWeb();
    const pull = holdPull();
    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await pull.reached;

    const rotated = await api<{ token: string }>(`${SERVICE}/deployments/trigger/rotate`, "POST");
    pull.release();
    await waitForAction(accepted.body.id);

    const deployed = await call(context.app, "/api/v1/deploy", {
      method: "POST",
      headers: { authorization: `Bearer ${rotated.body.token}` },
    });
    expect(deployed.status).toBe(202);
  });

  it("is kept through a stop, whose write comes after Docker has answered", async () => {
    await deployedWeb();
    const update = context.docker.updateService.bind(context.docker);
    vi.spyOn(context.docker, "updateService").mockImplementationOnce(async (name, spec, options) => {
      await api(`${SERVICE}/environment`, "PUT", { env: "SAVED_DURING_STOP=1" });
      return update(name, spec, options);
    });

    const accepted = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(accepted.body.id);

    expect((await api<{ env: string }>(`${SERVICE}/environment/reveal`, "POST")).body.env).toBe(
      "SAVED_DURING_STOP=1",
    );
    expect((await detail()).stopped).toBe(true);
  });

  it("keeps a port added while Docker was still being asked about another", async () => {
    await createWeb();
    const listServices = context.docker.listServices.bind(context.docker);
    vi.spyOn(context.docker, "listServices").mockImplementationOnce(async () => {
      await api(`${SERVICE}/environment`, "PUT", { env: "SAVED_DURING=1" });
      return listServices();
    });

    expect((await api<PortList>(`${SERVICE}/advanced/ports`, "POST", PUBLISHED)).status).toBe(201);

    expect((await api<{ env: string }>(`${SERVICE}/environment/reveal`, "POST")).body.env).toBe(
      "SAVED_DURING=1",
    );
  });
});

describe("what is saved and what is deployed", () => {
  it("has nothing pending until a deployment has put something in place", async () => {
    await createWeb();
    expect((await detail()).pendingChanges).toBe(false);
  });

  it("reports what the running version does not have, and clears with the next deploy", async () => {
    await deployedWeb();
    expect((await detail()).pendingChanges).toBe(false);

    await api(`${SERVICE}/environment`, "PUT", { env: "NEW=1" });
    expect((await detail()).pendingChanges).toBe(true);

    expect((await deploy()).status).toBe("succeeded");
    expect((await detail()).pendingChanges).toBe(false);
  });

  it("notices the project's variables, a Dockerfile, and a replica count", async () => {
    await deployedWeb();
    await api("/projects/shop/env", "PUT", { env: "SHARED=1" });
    expect((await detail()).pendingChanges).toBe(true);
    await deploy();

    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });
    expect((await detail()).pendingChanges).toBe(true);
  });

  it("does not invent a difference for another deployment of the same settings", async () => {
    await deployedWeb();
    await deploy();
    await deploy();
    expect((await detail()).pendingChanges).toBe(false);
  });

  it("counts a build's own variables and secrets as something to deploy", async () => {
    await createWeb();
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });
    await deploy();
    expect((await detail()).pendingChanges).toBe(false);

    await api(`${SERVICE}/environment/build`, "PUT", { env: "API_URL=one\n" });
    expect((await detail()).pendingChanges).toBe(true);
    await deploy();
    expect((await detail()).pendingChanges).toBe(false);

    await api(`${SERVICE}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: "first-secret" });
    expect((await detail()).pendingChanges).toBe(true);
  });

  it("keeps the record sealed, so a secret a container got is not in the database", async () => {
    await createWeb();
    await api(`${SERVICE}/environment`, "PUT", { env: "PLAIN_ON_PURPOSE=findme" });
    await deploy();

    const { applied } = findService(context.deps.db, "shop", "web") as NonNullable<
      ReturnType<typeof findService>
    >;
    expect(applied).not.toBeNull();
    expect(applied).not.toContain("findme");
  });

  it("forgets what was applied once a rename takes the running version away", async () => {
    await deployedWeb();
    await api(`${SERVICE}/environment`, "PUT", { env: "NEW=1" });
    const stopped = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(stopped.body.id);

    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });

    expect((await detail("/projects/shop/services/web2")).pendingChanges).toBe(false);
  });
});

describe("a Swarm service the panel did not create", () => {
  const foreign = (name = "shop_web") =>
    context.docker.createService({ Name: name, TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } } });

  it("keeps its name from being used for a new service, of any kind", async () => {
    await foreign();

    const created = await api("/projects/shop/services", "POST", { name: "web" });

    expect(created.status).toBe(409);
    expect(apiErrorOf(created).code).toBe("service_not_owned");
    expect(apiErrorOf(created).fields?.name).toBeDefined();
  });

  it("refuses a database under that name too", async () => {
    await foreign("shop_db");

    const created = await api("/projects/shop/databases", "POST", { name: "db", engine: "redis" });

    expect(apiErrorOf(created).code).toBe("service_not_owned");
  });

  it("is not replaced by a deploy, which fails with nothing changed", async () => {
    await createWeb();
    await foreign();
    const before = await swarm();

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("did not create");
    expect((await swarm())?.version).toBe(before?.version);
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe("nginx:alpine");
  });

  it("is not stopped or restarted", async () => {
    await createWeb();
    await foreign();

    const stopped = await api(`${SERVICE}/stop`, "POST");
    const restarted = await api(`${SERVICE}/restart`, "POST");

    expect(apiErrorOf(stopped).code).toBe("service_not_owned");
    expect(apiErrorOf(restarted).code).toBe("service_not_owned");
  });

  it("survives the destruction of the service that happened to share its name", async () => {
    await createWeb();
    await foreign();

    const accepted = await api<ActionEntry>(SERVICE, "DELETE", { confirm: "web" });
    const destroyed = await waitForAction(accepted.body.id);

    expect(destroyed.status).toBe("succeeded");
    expect(destroyed.log).toContain("this panel did not create");
    expect(await swarm()).not.toBeNull();
  });

  it("can be walked away from by renaming, and left running", async () => {
    await createWeb();
    await foreign();

    expect((await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" })).status).toBe(200);
    expect(await swarm()).not.toBeNull();
  });

  it("can't be renamed onto", async () => {
    await createWeb();
    await foreign("shop_taken");

    const renamed = await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "taken" });

    expect(apiErrorOf(renamed).code).toBe("service_not_owned");
  });
});

describe("a Docker volume the panel did not create", () => {
  it("is not mounted into a service that happens to want its name", async () => {
    await createWeb();
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await context.docker.createVolume({ name: "shop_web_data", labels: { other: "yes" } });

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("did not create");
    expect(await swarm()).toBeNull();
  });
});

describe("an update that fails", () => {
  async function publishing(image = IMAGE) {
    await createWeb(image);
    await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);
    expect((await deploy()).status).toBe("succeeded");
  }

  async function brokenUpdate() {
    await api(`${SERVICE}/source`, "PUT", { image: BROKEN_IMAGE });
    failTasksOf(BROKEN_IMAGE);
    return deploy();
  }

  it("leaves the previous version running, even with published ports", async () => {
    await publishing();
    expect((await swarm())?.spec.UpdateConfig).toMatchObject({ Order: "stop-first" });

    const deployed = await brokenUpdate();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("non-zero exit");
    expect(deployed.error).toContain("previous version is running again");
    expect(deployed.log).toContain("Putting the previous version back");
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await pinnedOf(IMAGE));
    expect(await running()).toHaveLength(1);
    expect((await running())[0]?.image).toBe(await pinnedOf(IMAGE));
  });

  it("keeps the saved settings, and says they are still waiting", async () => {
    await publishing();

    await brokenUpdate();

    const source = (await api<{ source: ServiceSource }>(`${SERVICE}/source`)).body.source;
    expect(source).toMatchObject({ image: BROKEN_IMAGE });
    expect((await detail()).pendingChanges).toBe(true);
    expect((await detail()).runtimeUncertain).toBeNull();
  });

  it("leaves a stopped service stopped", async () => {
    await publishing();
    const stopped = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(stopped.body.id);

    await brokenUpdate();

    expect((await swarm())?.spec.Mode).toEqual({ Replicated: { Replicas: 0 } });
    expect((await detail()).stopped).toBe(true);
  });

  it("changes nothing when Docker refuses the update outright", async () => {
    await publishing();
    const before = await swarm();
    context.docker.failNext("updateService");
    await api(`${SERVICE}/environment`, "PUT", { env: "X=1" });

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).not.toContain("previous version");
    expect((await swarm())?.version).toBe(before?.version);
    expect(await running()).toHaveLength(1);
  });

  it("is not reported as restored when even that fails", async () => {
    await publishing();
    await api(`${SERVICE}/source`, "PUT", { image: BROKEN_IMAGE });
    context.docker.taskFailure = () => "task: non-zero exit (1)";

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("could not be put back");
    expect((await detail()).runtimeUncertain).toBe("restore_failed");
  });

  it("goes back to the image that ran, when a pull has moved its tag", async () => {
    await createWeb();
    context.docker.images.push({
      id: "sha256:old",
      tags: [IMAGE],
      sizeBytes: 1,
      labels: {},
      createdAt: null,
    });
    expect((await deploy()).status).toBe("succeeded");
    const tagged = vi.spyOn(context.docker, "tagImage");

    // The tag now names something else, and it is broken.
    const pull = context.docker.pullImage.bind(context.docker);
    vi.spyOn(context.docker, "pullImage").mockImplementation(async (ref, options) => {
      await pull(ref, options);
      (context.docker.images[0] as { id: string }).id = "sha256:new";
      context.docker.taskFailure = (spec) =>
        spec.TaskTemplate.ContainerSpec.Image === "sha256:new" ? "task: non-zero exit (1)" : null;
    });

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(tagged).toHaveBeenCalledWith("sha256:old", "opsifier/shop/web:previous");
    // Pinned, so the name that was given to Swarm still means what ran.
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe("sha256:old");
    expect(await running()).toHaveLength(1);
  });

  it("lets go of the outgoing image once a deployment has succeeded", async () => {
    await publishing();

    await deploy();

    expect(context.docker.removedImageReferences).toContain("opsifier/shop/web:previous");
  });
});

describe("cancelling a deployment during its rollout", () => {
  it("puts the previous version back", async () => {
    await createWeb();
    await deploy();
    await api(`${SERVICE}/source`, "PUT", { image: BROKEN_IMAGE });
    failTasksOf(BROKEN_IMAGE);
    const update = context.docker.updateService.bind(context.docker);
    let updated: () => void = () => {};
    const rollingOut = new Promise<void>((resolve) => {
      updated = resolve;
    });
    vi.spyOn(context.docker, "updateService").mockImplementationOnce(async (name, spec, options) => {
      const result = await update(name, spec, options);
      updated();
      return result;
    });

    const accepted = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await rollingOut;
    await api(`/actions/${accepted.body.id}/cancel`, "POST");
    const cancelled = await waitForAction(accepted.body.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.log).toContain("The previous version is running again");
    expect((await swarm())?.spec.TaskTemplate.ContainerSpec.Image).toBe(await pinnedOf(IMAGE));
  });
});

describe("a runtime nobody can vouch for", () => {
  /** What an interruption leaves behind: the flag of a deployment that no longer exists. */
  const interrupted = (name = "web") =>
    saveRuntimeUncertain(context.deps.db, "shop", name, { reason: "interrupted", actionId: "gone" });

  it("writes the flag before it replaces anything, and clears it after", async () => {
    await deployedWeb();
    let during: unknown;
    const update = context.docker.updateService.bind(context.docker);
    vi.spyOn(context.docker, "updateService").mockImplementationOnce(async (name, spec, options) => {
      during = findService(context.deps.db, "shop", "web")?.runtimeUncertain;
      return update(name, spec, options);
    });

    await deploy();

    expect(during).toMatchObject({ reason: "interrupted" });
    expect(findService(context.deps.db, "shop", "web")?.runtimeUncertain).toBeNull();
  });

  it("does not count as uncertain while the deployment that wrote it is still running", async () => {
    await deployedWeb();
    const update = context.docker.updateService.bind(context.docker);
    let seen: ReturnType<typeof runtimeUncertainty> | undefined;
    vi.spyOn(context.docker, "updateService").mockImplementationOnce(async (name, spec, options) => {
      const record = findService(context.deps.db, "shop", "web");
      seen = record === undefined ? undefined : runtimeUncertainty(context.deps, record);
      return update(name, spec, options);
    });

    await deploy();

    expect(seen).toBeNull();
  });

  it("shows, and refuses what would assume otherwise", async () => {
    await deployedWeb();
    await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);
    interrupted();

    expect((await detail()).runtimeUncertain).toBe("interrupted");
    const domains = (await api<{ domains: DomainEntry[] }>(`${SERVICE}/domains`)).body.domains;
    const refusals = await Promise.all([
      api(SERVICE, "DELETE", { confirm: "web" }),
      api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" }),
      api(`${SERVICE}/advanced/ports/0`, "DELETE"),
      api(`${SERVICE}/advanced/ports/0`, "PUT", { ...PUBLISHED, published: 30081 }),
      api(`${SERVICE}/advanced/ports`, "DELETE"),
      api(`${SERVICE}/domains/${domains[0]?.id}`, "DELETE"),
    ]);

    for (const refusal of refusals) {
      expect(apiErrorOf(refusal).code).toBe("runtime_uncertain");
      expect(refusal.status).toBe(409);
    }
  });

  it("still allows what gives nothing up", async () => {
    await deployedWeb();
    interrupted();

    expect((await api(`${SERVICE}/environment`, "PUT", { env: "A=1" })).status).toBe(200);
    expect((await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED)).status).toBe(201);
    const stopped = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    expect((await waitForAction(stopped.body.id)).status).toBe("succeeded");
  });

  it("is settled by the next successful deployment", async () => {
    await deployedWeb();
    interrupted();

    expect((await deploy()).status).toBe("succeeded");

    expect((await detail()).runtimeUncertain).toBeNull();
    expect((await api(SERVICE, "DELETE", { confirm: "web" })).status).toBe(202);
  });

  it("is not settled by a deployment that fails", async () => {
    await deployedWeb();
    interrupted();
    context.docker.failNext("pullImage");

    expect((await deploy()).status).toBe("failed");

    expect((await detail()).runtimeUncertain).toBe("interrupted");
  });

  it("is not settled by a failed update that was put back", async () => {
    await deployedWeb();
    interrupted();
    await api(`${SERVICE}/source`, "PUT", { image: BROKEN_IMAGE });
    failTasksOf(BROKEN_IMAGE);

    expect((await deploy()).status).toBe("failed");

    expect((await detail()).runtimeUncertain).toBe("interrupted");
  });

  it("refuses the data operations of a database too", async () => {
    await context.close();
    await start();
    const created = await api<ServiceDetail>("/projects/shop/databases", "POST", {
      name: "db",
      engine: "postgres",
      databaseName: "app",
    });
    const action = created.body.activeAction;
    expect(action).not.toBeNull();
    await waitForAction((action as NonNullable<typeof action>).id);
    interrupted("db");

    const backups = "/projects/shop/services/db/backups";
    const config = await api<{ id: string }>(`${backups}/configs`, "POST", {
      kind: "database",
      enabled: true,
      schedule: "0 2 * * *",
      retention: null,
      databaseName: "app",
      storageProviderId: BUILT_IN_PROVIDER_ID,
      path: "shop/db",
    });
    expect(config.status).toBe(201);

    const backup = await api(`${backups}/configs/${config.body.id}/run`, "POST", {});
    const password = await api("/projects/shop/services/db/credentials", "PUT", {
      password: "A-new-password1",
    });
    const exposed = await api("/projects/shop/services/db/expose", "PUT", { port: 16432 });

    expect(apiErrorOf(backup).code).toBe("runtime_uncertain");
    expect(apiErrorOf(password).code).toBe("runtime_uncertain");
    expect(apiErrorOf(exposed).code).toBe("runtime_uncertain");
  });
});

describe("ports that are held by something else", () => {
  const plainContainer = (port: number, protocol: "tcp" | "udp" = "tcp") =>
    context.docker.containers.push({
      id: `c${port}`,
      name: "someone-else",
      image: "nginx:alpine",
      imageId: "sha256:n",
      state: "running",
      labels: {},
      sizeBytes: null,
      ports: [{ protocol, port }],
    });

  it("refuses a port a plain container holds, when it is saved", async () => {
    await createWeb();
    plainContainer(30080);

    const saved = await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);

    expect(saved.status).toBe(409);
    expect(apiErrorOf(saved).code).toBe("port_in_use");
  });

  it("tells the two protocols apart", async () => {
    await createWeb();
    plainContainer(30080, "udp");

    expect((await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED)).status).toBe(201);
  });

  it("fails the deployment before replacing anything, when the port was taken after it was saved", async () => {
    await createWeb();
    await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);
    expect((await deploy()).status).toBe("succeeded");
    await api(`${SERVICE}/advanced/ports/0`, "PUT", { ...PUBLISHED, published: 30081 });
    plainContainer(30081);
    const before = await swarm();

    const deployed = await deploy();

    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("Port 30081/tcp is already in use on this server");
    expect(deployed.error).toContain("nothing was replaced");
    expect((await swarm())?.version).toBe(before?.version);
    expect(await running()).toHaveLength(1);
  });

  it("does not mistake the service's own task for someone else's", async () => {
    await createWeb();
    await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);
    expect((await deploy()).status).toBe("succeeded");
    context.docker.containers.push({
      id: "own",
      name: "shop_web.1.task",
      image: IMAGE,
      imageId: "sha256:i",
      state: "running",
      labels: { "com.docker.swarm.service.name": qualifiedName("shop", "web") },
      sizeBytes: null,
      ports: [{ protocol: "tcp", port: 30080 }],
    });
    context.docker.helperResult = () => ({
      exitCode: 0,
      stdout: `--- tcp\n  sl  local_address rem_address   st\n   0: 00000000:7590 00000000:0000 0A\n`,
      stderr: "",
    });

    expect((await deploy()).status).toBe("succeeded");
  });

  describe("with a way to look at the host", () => {
    const hostProcess = (port: number) => {
      const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
      context.docker.helperResult = () => ({
        exitCode: 0,
        stdout: `--- tcp\n  sl  local_address rem_address   st\n   0: 0100007F:${hexPort} 00000000:0000 0A\n`,
        stderr: "",
      });
    };

    beforeEach(async () => {
      await context.close();
      await start({ env: { OPSIFIER_HELPER_IMAGE: "busybox:1.37" } });
    });

    it("refuses a port a process on the host holds", async () => {
      await createWeb();
      hostProcess(30080);

      expect(apiErrorOf(await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED)).code).toBe("port_in_use");
    });

    it("looks from the host's own network, from the panel's image", async () => {
      await createWeb();
      hostProcess(31234);
      await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);

      expect(context.docker.helpers.at(-1)).toMatchObject({ image: "busybox:1.37", hostNetwork: true });
    });

    it("can't be used to find out what another project holds", async () => {
      await createWeb();
      hostProcess(30080);

      const saved = await api(`${SERVICE}/advanced/ports`, "POST", PUBLISHED);

      expect(apiErrorOf(saved).fields).toEqual({ published: "This port is already in use on this server." });
    });
  });

  it("reads listening sockets out of /proc/net", () => {
    const tcp = `  sl  local_address rem_address   st tx_queue
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000
   1: 0100007F:0035 0100007F:D431 01 00000000:00000000
`;
    expect(parseProcNet("tcp", tcp)).toEqual([{ protocol: "tcp", port: 8080 }]);
    expect(parseProcNet("udp", "  sl local\n   0: 00000000:0035 00000000:0000 07\n")).toEqual([
      { protocol: "udp", port: 53 },
    ]);
  });
});

describe("whether a deployed service answers", () => {
  async function withProxy() {
    await context.docker.createService({
      Name: PROXY_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" } },
    });
  }

  it("is asked from the proxy, on the port of the primary domain", async () => {
    await withProxy();
    const calls = scriptExec(context, () => ({ exitCode: 0, output: "opsifier-ok\n" }));

    const deployed = await (async () => {
      await createWeb();
      return deploy();
    })();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toContain("Answering on port 80");
    expect(calls[0]?.options.service).toBe(PROXY_SERVICE);
    expect(calls[0]?.options.env).toEqual(["PROBE_HOST=shop_web", "PROBE_PORT=80"]);
    expect((await detail()).answering).toBe(true);
  });

  it("is reported as not answering rather than as working, without failing a background worker", async () => {
    await withProxy();
    scriptExec(context, () => ({ exitCode: 0, output: "opsifier-silent\n" }));

    await createWeb();
    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect(deployed.log).toContain("nothing answers on port 80");
    expect((await detail()).answering).toBe(false);
  });

  it("says it could not tell when there is no proxy to ask", async () => {
    await createWeb();

    const deployed = await deploy();

    expect(deployed.log).toContain("Could not check whether it answers");
    expect((await detail()).answering).toBeNull();
  });
});

describe("renaming a service", () => {
  const renamed = "/projects/shop/services/web2";

  async function stoppedWeb() {
    await deployedWeb();
    const stopped = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(stopped.body.id);
  }

  it("keeps its identifier, domains, history and token through a rename and a move", async () => {
    await stoppedWeb();
    const before = findService(context.deps.db, "shop", "web")?.id;
    expect(before).toEqual(expect.any(String));
    const trigger = (await api<{ path: string }>(`${SERVICE}/deployments/trigger`)).body.path;
    const domainIds = (await api<{ domains: DomainEntry[] }>(`${SERVICE}/domains`)).body.domains.map(
      (domain) => domain.id,
    );
    await api("/projects", "POST", { name: "other" });

    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });
    await api("/projects/shop/services/web2/rename", "POST", { projectName: "other", name: "web3" });

    const moved = "/projects/other/services/web3";
    expect(findService(context.deps.db, "other", "web3")?.id).toBe(before);
    expect(
      (await api<{ domains: DomainEntry[] }>(`${moved}/domains`)).body.domains.map((domain) => domain.id),
    ).toEqual(domainIds);
    expect((await api<{ path: string }>(`${moved}/deployments/trigger`)).body.path).toBe(trigger);
    expect((await detail(moved)).wake.length).toBe(1);
    expect(existsSync(join(context.dataDir, "projects", "shop", "web"))).toBe(false);
  });

  it("gives Docker's objects the identifier too", async () => {
    await deployedWeb();

    const { id } = findService(context.deps.db, "shop", "web") as { id: string };
    expect((await swarm())?.spec.Labels?.["opsifier.id"]).toBe(id);
  });

  it("removes the old Docker volume, keeps the data, and makes a new one at the next start", async () => {
    await createWeb();
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();
    const stopped = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(stopped.body.id);
    expect(await context.docker.inspectVolume("shop_web_data")).not.toBeNull();

    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });

    expect(await context.docker.inspectVolume("shop_web_data")).toBeNull();
    expect(existsSync(join(context.dataDir, "projects", "shop", "web2", "volumes", "data"))).toBe(true);
    const started = await api<ActionEntry>(`${renamed}/start`, "POST");
    expect((await waitForAction(started.body.id)).status).toBe("succeeded");
    expect(await context.docker.inspectVolume("shop_web2_data")).not.toBeNull();
  });

  it("leaves alone a Docker volume of that name it did not make", async () => {
    await createWeb();
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await context.docker.createVolume({ name: "shop_web_data", labels: { other: "yes" } });

    await api(`${SERVICE}/rename`, "POST", { projectName: "shop", name: "web2" });

    expect(await context.docker.inspectVolume("shop_web_data")).not.toBeNull();
  });
});

describe("a Compose stack", () => {
  const STACK = "/projects/shop/services/stack";
  const FILE = "services:\n  web:\n    image: nginx:alpine\n";

  async function stack() {
    await api("/projects/shop/compose", "POST", { name: "stack" });
    await api(`${STACK}/compose/source`, "PUT", { type: "inline", content: FILE });
  }

  const foreignContainer = (project = "shop_stack") =>
    context.docker.composeContainers.push({
      id: "foreign",
      name: `${project}-web-1`,
      image: "nginx:alpine",
      project,
      child: "web",
      number: 1,
      state: "running",
      status: "Up",
      exitCode: null,
      health: null,
      ports: [],
    });

  it("marks what it starts as the panel's", async () => {
    await stack();
    expect((await deploy(STACK)).status).toBe("succeeded");

    expect(context.docker.composeContainers[0]?.labels).toEqual({
      "opsifier.project": "shop",
      "opsifier.service": "stack",
      "opsifier.type": "compose",
      "opsifier.id": findService(context.deps.db, "shop", "stack")?.id,
    });
  });

  it("can't take a name other containers already answer to", async () => {
    foreignContainer();

    const created = await api("/projects/shop/compose", "POST", { name: "stack" });

    expect(created.status).toBe(409);
    expect(apiErrorOf(created).code).toBe("service_not_owned");
  });

  it("is not deployed over containers it never started, and leaves them when destroyed", async () => {
    await stack();
    foreignContainer();

    const deployed = await deploy(STACK);
    expect(deployed.status).toBe("failed");
    expect(deployed.error).toContain("did not start them");

    const accepted = await api<ActionEntry>(STACK, "DELETE", { confirm: "stack" });
    const destroyed = await waitForAction(accepted.body.id);
    expect(destroyed.status).toBe("succeeded");
    expect(context.docker.composeContainers).toHaveLength(1);
  });

  it("still deploys over its own containers from before they were marked", async () => {
    await stack();
    expect((await deploy(STACK)).status).toBe("succeeded");
    delete context.docker.composeContainers[0]?.labels;

    expect((await deploy(STACK)).status).toBe("succeeded");
  });

  it("does not lose an environment saved while it deploys", async () => {
    await stack();
    const tools = context.deps.tools as unknown as { handler: unknown };
    const handler = tools.handler as (request: { args: string[] }) => Promise<unknown>;
    tools.handler = async (request: { args: string[] }) => {
      if (request.args.includes("up")) {
        await api(`${STACK}/environment`, "PUT", { env: "SAVED_DURING=1" });
      }
      return handler(request);
    };

    expect((await deploy(STACK)).status).toBe("succeeded");

    expect((await api<ComposeDetail & { env: string }>(`${STACK}/environment/reveal`, "POST")).body.env).toBe(
      "SAVED_DURING=1",
    );
    expect((await detail(STACK)).pendingChanges).toBe(true);
  });

  it("is flagged while it deploys, and settled afterwards", async () => {
    await stack();
    expect((await deploy(STACK)).status).toBe("succeeded");

    expect(findService(context.deps.db, "shop", "stack")?.runtimeUncertain).toBeNull();
    expect((await detail(STACK)).pendingChanges).toBe(false);
  });
});

describe("a project re-created under the name of one just deleted", () => {
  it("waits for Docker to really forget the old network before saying it is gone", async () => {
    const inspect = context.docker.inspectNetwork.bind(context.docker);
    let lookups = 0;
    await api("/projects", "POST", { name: "tmp" });
    vi.spyOn(context.docker, "inspectNetwork").mockImplementation(async (name) => {
      lookups += 1;
      // Docker still answers for it for a moment after deleting it.
      return lookups <= 3
        ? { id: "gone", name, driver: "overlay", scope: "swarm", attachable: true, labels: {} }
        : inspect(name);
    });

    const accepted = await api<ActionEntry>("/projects/tmp", "DELETE", { confirm: "tmp" });

    expect((await waitForAction(accepted.body.id)).status).toBe("succeeded");
    expect(lookups).toBeGreaterThan(3);
  });
});
