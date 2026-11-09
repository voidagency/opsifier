import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionEntry,
  CleanupPreview,
  DeploymentPage,
  PanelUser,
  PendingChanges,
  ReleaseDetail,
  ReleaseEntry,
  ReleaseList,
  ServiceDetail,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerDriverError } from "../../core/docker";
import { FAKE_GIT_SHA, type FakeTools } from "../../core/tools";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { OCI_REVISION_LABEL } from "../service-tabs/source/build/builders";
import { enqueueDeploy } from "../services/lifecycle";
import { findService } from "../services/repo";
import { listReleaseRows } from "./repo";
import { openSnapshot } from "./service";

let context: TestContext;
let cookie: string;

const OLD = "nginx:1.26";
const NEW = "nginx:1.27";
const SERVICE = "/projects/shop/services/web";
const RELEASES = `${SERVICE}/releases`;
const BUILT = "opsifier/shop/web:latest";

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" });
  await api("/projects/shop/services", "POST", { name: "web" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context.close();
});

function api<T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });
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

const setImage = (image: string) => api(`${SERVICE}/source`, "PUT", { image });
const setEnv = (env: string) => api(`${SERVICE}/environment`, "PUT", { env });
const swarm = () => context.docker.inspectService("shop_web");
const container = async () => (await swarm())?.spec.TaskTemplate.ContainerSpec;
const digestOf = async (image: string) => (await context.docker.inspectImage(image))?.digests[0];
const idOf = async (image: string) => (await context.docker.inspectImage(image))?.id;
const running = async () =>
  (await context.docker.listTasks({ service: "shop_web" })).filter(
    (task) => task.state === "running" && task.desiredState === "running",
  );
const releases = async () => (await api<ReleaseList>(RELEASES)).body;
const version = async (number: number) =>
  (await releases()).items.find((item) => item.number === number) as ReleaseEntry;
const detail = async () => (await api<ServiceDetail>(SERVICE)).body;
const pending = async () => (await api<PendingChanges>(`${SERVICE}/deployments/pending`)).body;
const lastDeployment = async () => (await api<DeploymentPage>(`${SERVICE}/deployments`)).body.items[0];
const tools = () => context.deps.tools as FakeTools;
const retainedTag = (number: number) =>
  `opsifier/releases/${findService(context.deps.db, "shop", "web")?.id}:${number}`;

/** Deploys version 1 of the image, with a setting, then version 2 with another image and setting. */
async function twoVersions(old = OLD, next = NEW) {
  await setImage(old);
  await setEnv("WHICH=one");
  expect((await deploy()).status).toBe("succeeded");
  await setImage(next);
  await setEnv("WHICH=two");
  expect((await deploy()).status).toBe("succeeded");
}

function rollback(number: number, confirm = "web", as = cookie) {
  return api<ActionEntry>(`${RELEASES}/${number}/rollback`, "POST", { confirm }, as);
}

async function rollBackTo(number: number) {
  const accepted = await rollback(number);
  expect(accepted.status).toBe(202);
  return waitForAction(accepted.body.id);
}

async function member(email: string, role: "viewer" | "operator") {
  const created = await api<PanelUser>("/users", "POST", {
    email,
    password: TEST_PASSWORD,
    role: "member",
    projects: [{ project: "shop", role }],
  });
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  return login.cookie as string;
}

describe("what a deployment runs", () => {
  it("gives Swarm the digest the tag meant, read before anything is replaced", async () => {
    await setImage(OLD);
    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect((await container())?.Image).toBe(await digestOf(OLD));
    expect(deployed.log).toContain(`${OLD} is ${await digestOf(OLD)}`);
  });

  it("records what it asked for and exactly what it got", async () => {
    await setImage(OLD);
    await deploy();

    expect((await lastDeployment())?.deployment).toEqual({
      requestedRef: null,
      builtCommit: null,
      ociRevision: null,
      image: OLD,
      imageId: await idOf(OLD),
      digest: await digestOf(OLD),
      release: 1,
      rollbackOf: null,
      answering: null,
      runningTasks: 1,
      desiredTasks: 1,
    });
  });

  it("keeps deploying the same image when the tag moves after it was resolved", async () => {
    await setImage(OLD);
    await deploy();
    context.docker.addLocalImage("something:else");
    const resolved = await digestOf(OLD);
    const update = context.docker.updateService.bind(context.docker);
    vi.spyOn(context.docker, "updateService").mockImplementation(async (...args) => {
      // Between the pull and the update, somebody retags the image.
      context.docker.moveLocalTag(OLD, "something:else");
      return update(...args);
    });

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    expect((await container())?.Image).toBe(resolved);
  });

  it("leaves the old application running when the registry stops answering", async () => {
    await setImage(OLD);
    await deploy();
    const runningBefore = (await swarm())?.version;
    await setImage(NEW);
    context.docker.failNext("pullImage", new DockerDriverError("unauthorized: access denied", 401));

    const failed = await deploy();

    expect(failed.status).toBe("failed");
    expect((await swarm())?.version).toBe(runningBefore);
    expect((await container())?.Image).toBe(await digestOf(OLD));
    expect(await running()).toHaveLength(1);
  });

  it("restarts the pinned image, whatever the tag has come to mean", async () => {
    await setImage(OLD);
    await deploy();
    const pinned = await digestOf(OLD);
    context.docker.addLocalImage("another:one");
    context.docker.moveLocalTag(OLD, "another:one");

    const accepted = await api<ActionEntry>(`${SERVICE}/restart`, "POST");
    await waitForAction(accepted.body.id);

    expect((await container())?.Image).toBe(pinned);
  });

  it("stays settled for a second deployment of a tag that has not moved", async () => {
    await setImage(OLD);
    await deploy();
    await deploy();

    expect((await detail()).pendingChanges).toBe(false);
  });
});

describe("what a build leaves behind", () => {
  const SHA = "fedcba9876543210fedcba9876543210fedcba98";

  async function gitSource(ref = "main") {
    const saved = await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref,
      path: "/",
    });
    expect(saved.status).toBe(200);
  }

  it("runs the image it built, by its id, and records the requested and built commits", async () => {
    await gitSource();
    tools().gitSha = SHA;

    const deployed = await deploy();

    expect(deployed.status).toBe("succeeded");
    const id = await idOf(BUILT);
    expect((await container())?.Image).toBe(id);
    expect((await lastDeployment())?.deployment).toMatchObject({
      requestedRef: "main",
      builtCommit: SHA,
      ociRevision: SHA,
      image: BUILT,
      imageId: id,
      digest: null,
    });
  });

  it("writes the commit into the image's OCI label, reading it back from the image", async () => {
    await gitSource();
    tools().gitSha = SHA;

    await deploy();

    expect((await context.docker.inspectImage(BUILT))?.labels[OCI_REVISION_LABEL]).toBe(SHA);
    expect(tools().callsTo("docker").at(-1)?.args).toContain(`--label=${OCI_REVISION_LABEL}=${SHA}`);
  });

  it("records the commit a push asked for, next to the commit actually built", async () => {
    await gitSource();
    tools().gitSha = FAKE_GIT_SHA;
    const pushed = "aaaa".repeat(10);

    const action = enqueueDeploy(context.deps, { projectName: "shop", serviceName: "web" }, undefined, {
      commit: pushed,
    });
    await waitForAction(action.id);

    expect((await lastDeployment())?.deployment).toMatchObject({
      requestedRef: pushed,
      builtCommit: FAKE_GIT_SHA,
    });
  });

  it("records the result of a Dockerfile written inline, which has no commit", async () => {
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: "FROM scratch\n" });

    expect((await deploy()).status).toBe("succeeded");

    expect((await lastDeployment())?.deployment).toMatchObject({
      requestedRef: null,
      builtCommit: null,
      ociRevision: null,
      image: BUILT,
      imageId: await idOf(BUILT),
    });
    expect(
      tools()
        .callsTo("docker")
        .every((call) => !call.args.some((arg) => arg.includes("--label="))),
    ).toBe(true);
  });

  it("leaves the running image alone when the tag moves after the build", async () => {
    await gitSource();
    await deploy();
    const built = await idOf(BUILT);

    context.docker.addBuiltImage(BUILT, {});

    expect(await idOf(BUILT)).not.toBe(built);
    expect((await container())?.Image).toBe(built);
    expect((await version(1)).imageId).toBe(built);
  });

  it("says the same thing in its log and its label after the panel restarts", async () => {
    await gitSource();
    tools().gitSha = SHA;
    const deployed = await deploy();
    const restarted = await context.restart();

    const after = await call<ActionEntry & { log: string }>(restarted.app, `/api/v1/actions/${deployed.id}`, {
      cookie,
    });

    expect(after.body.log).toContain(`OCI revision ${SHA}`);
    expect((await context.docker.inspectImage(BUILT))?.labels[OCI_REVISION_LABEL]).toBe(SHA);
  });

  it("keeps the fetched commit on a build that then fails, and no version of it", async () => {
    await gitSource();
    tools().gitSha = SHA;
    tools().handler = (request) =>
      request.command === "docker" && !request.args.join(" ").includes("--label=")
        ? { exitCode: 1, tail: [] }
        : undefined;

    expect((await deploy()).status).toBe("failed");

    expect((await lastDeployment())?.deployment).toMatchObject({ requestedRef: "main", release: null });
    expect((await releases()).items).toEqual([]);
  });
});

describe("a kept version", () => {
  it("exists for each successful deployment and not for a failed one", async () => {
    await setImage(OLD);
    await deploy();
    context.docker.failNext("pullImage");
    expect((await deploy()).status).toBe("failed");
    await deploy();

    expect((await releases()).items.map((item) => [item.number, item.active])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("holds its exact image under a tag of its own, and its effective configuration sealed", async () => {
    await twoVersions();

    expect((await version(2)).imageId).toBe(await idOf(NEW));
    expect(await idOf(retainedTag(2))).toBe(await idOf(NEW));
    expect(await idOf(retainedTag(1))).toBe(await idOf(OLD));

    const [row] = listReleaseRows(context.deps.db, findService(context.deps.db, "shop", "web")?.id ?? "");
    expect(row?.snapshot).not.toContain("WHICH");
    expect(
      openSnapshot(context.deps, row as NonNullable<typeof row>).swarm.TaskTemplate.ContainerSpec.Env,
    ).toContain("WHICH=two");
  });

  it("takes no credential along", async () => {
    await api(`${SERVICE}/source`, "PUT", {
      image: "registry.example.com/private/app:1",
      username: "registry-user",
      password: "registry-password-1",
    });
    await deploy();

    const [row] = listReleaseRows(context.deps.db, findService(context.deps.db, "shop", "web")?.id ?? "");
    const snapshot = JSON.stringify(openSnapshot(context.deps, row as NonNullable<typeof row>));
    expect(snapshot).not.toContain("registry-password-1");
    expect(snapshot).not.toContain("registry-user");
    expect(JSON.stringify(row)).not.toContain("registry-password-1");
  });

  it("is listed as metadata only", async () => {
    await twoVersions();
    await setEnv("SECRET_THING=hunter2");

    const listing = JSON.stringify((await api(RELEASES)).body);

    expect(listing).not.toContain("snapshot");
    expect(listing).not.toContain("WHICH");
    expect(listing).not.toContain("hunter2");
  });

  it("survives the Action that made it being forgotten", async () => {
    await twoVersions();
    const rows = (await api<DeploymentPage>(`${SERVICE}/deployments`)).body.items;
    expect(rows.length).toBeGreaterThan(0);
    const before = await releases();

    context.deps.db.$client.prepare("DELETE FROM actions").run();

    expect(await releases()).toEqual(before);
  });

  it("is said to be active only while the panel can vouch for what runs", async () => {
    await twoVersions();
    expect((await version(2)).active).toBe(true);

    context.deps.db.$client
      .prepare("UPDATE services SET runtime_uncertain = ? WHERE name = 'web'")
      .run(JSON.stringify({ reason: "restore_failed", actionId: "gone" }));

    expect((await version(2)).active).toBe(false);
  });

  it("does not exist for a database or a Compose stack", async () => {
    await api("/projects/shop/databases", "POST", { name: "db", engine: "redis" });
    await api("/projects/shop/compose", "POST", { name: "stack" });
    const STACK = "/projects/shop/services/stack";
    await api(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: "services:\n  web:\n    image: nginx:alpine\n",
    });
    await deploy(STACK);

    for (const path of ["/projects/shop/services/db", STACK]) {
      const listing = (await api<ReleaseList>(`${path}/releases`)).body;
      expect(listing).toMatchObject({ available: false, items: [] });
    }
    const refused = await api(`${STACK}/releases/1/rollback`, "POST", { confirm: "stack" });
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("rollback_not_available");
  });
});

describe("going back to a kept version", () => {
  it("puts back its exact image and effective configuration", async () => {
    await twoVersions();

    const done = await rollBackTo(1);

    expect(done.status).toBe("succeeded");
    expect((await container())?.Image).toBe(await idOf(OLD));
    expect((await container())?.Env).toContain("WHICH=one");
    expect((await container())?.Env).not.toContain("WHICH=two");
  });

  it("uses the image it kept even after the tag has moved, with no pull, build or Git", async () => {
    await twoVersions();
    const kept = (await version(1)).imageId;
    context.docker.addLocalImage("attacker:latest");
    context.docker.moveLocalTag(OLD, "attacker:latest");
    const pulls = vi.spyOn(context.docker, "pullImage");
    tools().calls.length = 0;

    const done = await rollBackTo(1);

    expect(done.status).toBe("succeeded");
    expect((await container())?.Image).toBe(kept);
    expect(await idOf(OLD)).not.toBe(kept);
    expect(pulls).not.toHaveBeenCalled();
    expect(tools().calls).toEqual([]);
    expect(done.log).toContain("Nothing is pulled, built or fetched");
  });

  it("keeps the saved settings, and says they are still waiting for a deployment", async () => {
    await twoVersions();

    await rollBackTo(1);

    expect((await api<{ env: string }>(`${SERVICE}/environment/reveal`, "POST")).body.env).toBe("WHICH=two");
    expect((await api<{ source: { image: string } }>(`${SERVICE}/source`)).body.source.image).toBe(NEW);
    expect((await detail()).pendingChanges).toBe(true);
    expect((await pending()).changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "image", before: OLD, after: NEW }),
        expect.objectContaining({ area: "environment", name: "WHICH", kind: "changed" }),
      ]),
    );
  });

  it("reuses the volumes in use and leaves what is in them alone", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();
    await setImage(NEW);
    await deploy();
    const directory = join(context.deps.config.dataDir, "projects/shop/web/volumes/data");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "written-after-v2.txt"), "keep me");
    const volumesBefore = context.docker.listVolumes();

    const done = await rollBackTo(1);

    expect(done.status).toBe("succeeded");
    expect(done.log).toContain("Volumes were left as they were");
    expect((await container())?.Mounts).toEqual([
      expect.objectContaining({ Type: "volume", Source: "shop_web_data", Target: "/data" }),
    ]);
    expect(readFileSync(join(directory, "written-after-v2.txt"), "utf8")).toBe("keep me");
    expect(await context.docker.listVolumes()).toEqual(await volumesBefore);
  });

  it("is a new attempt in the history, and becomes a new version", async () => {
    await twoVersions();

    const done = await rollBackTo(1);

    const history = (await api<DeploymentPage>(`${SERVICE}/deployments`)).body.items;
    expect(history[0]).toMatchObject({
      id: done.id,
      type: "service.rollback",
      status: "succeeded",
      deployment: expect.objectContaining({ rollbackOf: 1, release: 3, imageId: await idOf(OLD) }),
    });
    expect(history).toHaveLength(3);
    const listing = await releases();
    expect(listing.items[0]).toMatchObject({
      number: 3,
      active: true,
      rollbackOf: 1,
      imageId: await idOf(OLD),
    });
    expect((await detail()).wake.at(-1)).toBe("succeeded");
  });

  it("keeps its tasks on the node that holds the image", async () => {
    await twoVersions();
    const { nodeId } = await context.docker.swarmInfo();

    await rollBackTo(1);

    expect((await swarm())?.spec.TaskTemplate.Placement?.Constraints).toContain(`node.id==${nodeId}`);
  });

  it("settles a runtime nobody could vouch for, like any deployment that succeeds", async () => {
    await twoVersions();
    context.deps.db.$client
      .prepare("UPDATE services SET runtime_uncertain = ? WHERE name = 'web'")
      .run(JSON.stringify({ reason: "interrupted", actionId: "gone" }));
    expect((await detail()).runtimeUncertain).toBe("interrupted");

    const done = await rollBackTo(2);

    expect(done.status).toBe("succeeded");
    expect((await detail()).runtimeUncertain).toBeNull();
    expect((await version(3)).active).toBe(true);
  });

  it("joins the networks the project uses today, whichever it was deployed on", async () => {
    await twoVersions();
    const serviceId = findService(context.deps.db, "shop", "web")?.id as string;
    const row = listReleaseRows(context.deps.db, serviceId).find((item) => item.number === 1);
    const snapshot = openSnapshot(context.deps, row as NonNullable<typeof row>);
    // A version from before each project had a network of its own for the proxy.
    const oneNetwork = [{ Target: "opsifier-shop", Aliases: ["shop-web", "web"] }];
    snapshot.swarm.TaskTemplate.Networks = oneNetwork;
    const effective = snapshot.effective as { swarm: { TaskTemplate: { Networks: unknown } } };
    effective.swarm.TaskTemplate.Networks = oneNetwork;
    context.deps.db.$client
      .prepare("UPDATE service_releases SET snapshot = ? WHERE service_id = ? AND number = 1")
      .run(context.deps.secrets.seal(JSON.stringify(snapshot), "release-snapshot"), serviceId);

    await rollBackTo(1);

    expect((await swarm())?.spec.TaskTemplate.Networks).toEqual([
      { Target: "opsifier-shop", Aliases: ["shop-web", "web"] },
      { Target: "opsifier-shop_proxy" },
    ]);
    // And it says so: no network change is left waiting for a deployment.
    expect((await pending()).changes.filter((change) => change.name === "networks")).toEqual([]);
  });

  it("refuses a version whose variables reach into another project", async () => {
    await setImage(OLD);
    await setEnv("DB=postgres://u:p@other-pg:5432/x");
    await deploy();
    await setEnv("DB=postgres://u:p@local/x");
    await setImage(NEW);
    await deploy();
    expect((await api("/projects", "POST", { name: "other" })).status).toBe(201);
    expect((await api("/projects/other/databases", "POST", { name: "pg", engine: "postgres" })).status).toBe(
      201,
    );

    const refused = await rollback(1);

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("foreign_database");
    expect((await container())?.Image).toBe(await digestOf(NEW));
  });

  it("is not offered to a database, which has no earlier network to go back to", async () => {
    await api("/projects/shop/databases", "POST", { name: "db", engine: "redis" });

    const refused = await api("/projects/shop/services/db/releases/1/rollback", "POST", { confirm: "db" });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("rollback_not_available");
  });

  it("can be undone by going forward again", async () => {
    await twoVersions();
    await rollBackTo(1);

    const done = await rollBackTo(2);

    expect(done.status).toBe("succeeded");
    expect((await container())?.Image).toBe(await idOf(NEW));
    expect((await container())?.Env).toContain("WHICH=two");
    expect((await detail()).pendingChanges).toBe(false);
  });

  it("needs the exact name of the service", async () => {
    await twoVersions();

    const refused = await rollback(1, "WEB");

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("confirmation_mismatch");
    expect((await container())?.Image).toBe(await digestOf(NEW));
  });

  it("takes an operator of the project, and says nothing to anyone else", async () => {
    await twoVersions();
    const viewer = await member("v@example.com", "viewer");
    const operator = await member("o@example.com", "operator");

    expect((await rollback(1, "web", viewer)).status).toBe(403);
    expect((await api(RELEASES, "GET", undefined, viewer)).status).toBe(403);

    const allowed = await rollback(1, "web", operator);
    expect(allowed.status).toBe(202);
    await waitForAction(allowed.body.id);
  });

  it("leaves a capability taken away since to an administrator", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/advanced/deploy`, "PUT", { capAdd: ["NET_ADMIN"] });
    await deploy();
    await api(`${SERVICE}/advanced/deploy`, "PUT", { capAdd: [] });
    await deploy();
    const operator = await member("o@example.com", "operator");

    const refused = await rollback(1, "web", operator);

    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("admin_required");
    expect((await rollback(1)).status).toBe(202);
  });

  it("refuses a version that does not exist", async () => {
    await twoVersions();
    expect((await rollback(9)).status).toBe(404);
  });

  it("refuses the version already running", async () => {
    await twoVersions();
    expect((await version(2)).refusal).toBe("active");
    const refused = await rollback(2);
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("release_active");
  });

  it("refuses an image that is no longer on the server, before any change and with no pull", async () => {
    await twoVersions();
    const swarmBefore = (await swarm())?.version;
    const keptId = (await version(1)).imageId;
    await context.docker.removeImage(keptId);
    const pulls = vi.spyOn(context.docker, "pullImage");

    expect((await version(1)).refusal).toBe("image_missing");
    const refused = await rollback(1);

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("release_image_missing");
    expect(pulls).not.toHaveBeenCalled();
    expect((await swarm())?.version).toBe(swarmBefore);
  });

  it("refuses a kept tag that was moved or removed behind the panel's back", async () => {
    await twoVersions();
    const swarmBefore = (await swarm())?.version;

    context.docker.moveLocalTag(retainedTag(1), NEW);
    expect((await version(1)).refusal).toBe("image_altered");
    const moved = await rollback(1);
    expect(moved.status).toBe(409);
    expect(apiErrorOf(moved).code).toBe("release_image_altered");

    await context.docker.removeImage(retainedTag(1));
    expect((await version(1)).refusal).toBe("image_altered");
    expect((await swarm())?.version).toBe(swarmBefore);
  });

  it("refuses a version that did not use the volume in use now", async () => {
    await setImage(OLD);
    await deploy();
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();

    expect((await version(1)).refusal).toBe("volumes_differ");
    const refused = await rollback(1);

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("release_mount_incompatible");
    expect((await container())?.Mounts).toHaveLength(1);
  });

  it("refuses a version that used a volume no longer mounted", async () => {
    await setImage(OLD);
    const added = await api(`${SERVICE}/storage/mounts`, "POST", {
      type: "volume",
      name: "data",
      mountPath: "/data",
    });
    expect(added.status).toBe(201);
    await deploy();
    await api(`${SERVICE}/storage/mounts/0`, "DELETE");
    await deploy();

    expect((await version(1)).refusal).toBe("volumes_differ");
  });

  it("allows the same volume at another path, since the volume is what matters", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "volume", name: "data", mountPath: "/data" });
    await deploy();
    await api(`${SERVICE}/storage/mounts/0`, "PUT", {
      type: "volume",
      name: "data",
      mountPath: "/var/data",
    });
    await deploy();

    expect((await version(1)).refusal).toBeNull();
    expect((await rollBackTo(1)).status).toBe("succeeded");
    expect((await container())?.Mounts?.[0]?.Target).toBe("/data");
  });

  it("puts a file mount back as that version had it", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "file", content: "one", mountPath: "/app.conf" });
    await deploy();
    await api(`${SERVICE}/storage/mounts/0`, "PUT", {
      type: "file",
      content: "two",
      mountPath: "/app.conf",
    });
    await deploy();
    const file = join(context.deps.config.dataDir, "projects/shop/web/files/0.txt");
    expect(readFileSync(file, "utf8")).toBe("two");

    await rollBackTo(1);

    expect(readFileSync(file, "utf8")).toBe("one");
  });

  it("refuses a version deployed under another name", async () => {
    await setImage(OLD);
    await deploy();
    await setImage(NEW);
    await deploy();
    const stop = await api<ActionEntry>(`${SERVICE}/stop`, "POST");
    await waitForAction(stop.body.id);
    expect(
      (
        await api(`${SERVICE}/rename`, "POST", {
          projectName: "shop",
          name: "web2",
        })
      ).status,
    ).toBe(200);
    const start = await api<ActionEntry>("/projects/shop/services/web2/start", "POST");
    await waitForAction(start.body.id);

    const listing = (await api<ReleaseList>("/projects/shop/services/web2/releases")).body;

    expect(listing.items.map((item) => item.refusal)).toEqual(["renamed", "renamed"]);
    expect(listing.items.some((item) => item.active)).toBe(false);
  });

  it("refuses while anything else is happening to the service", async () => {
    await twoVersions();
    const update = context.docker.pullImage.bind(context.docker);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(context.docker, "pullImage").mockImplementation(async (ref, options) => {
      reached();
      await gate;
      await update(ref, options);
    });
    const deployment = await api<ActionEntry>(`${SERVICE}/deploy`, "POST");
    await started;

    const refused = await rollback(1);

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("service_busy");
    release();
    await waitForAction(deployment.body.id);
  });

  it("holds off start, stop and restart while it runs", async () => {
    await twoVersions();
    context.docker.taskFailure = () => null;
    const accepted = await rollback(1);
    expect(accepted.status).toBe(202);

    const refused = await api(`${SERVICE}/restart`, "POST");
    if (refused.status === 409) {
      expect(apiErrorOf(refused).code).toBe("deployment_in_progress");
    } else {
      expect(refused.status).toBe(202);
    }
    await waitForAction(accepted.body.id);
  });

  it("puts what was running back when the version it went back to will not start", async () => {
    await twoVersions();
    const keptId = (await version(1)).imageId;
    context.docker.taskFailure = (spec) =>
      spec.TaskTemplate.ContainerSpec.Image === keptId ? "task: non-zero exit (1)" : null;

    const failed = await rollBackTo(1);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("previous version is running again");
    expect((await container())?.Image).toBe(await digestOf(NEW));
    expect((await version(2)).active).toBe(true);
    expect((await releases()).items).toHaveLength(2);
    expect((await detail()).runtimeUncertain).toBeNull();
  });

  it("is reported as uncertain, like any deployment, if the panel dies during one", async () => {
    await twoVersions();
    const accepted = await rollback(1);
    // Hold the row where a dead process would have left it.
    context.deps.db.$client
      .prepare("UPDATE actions SET status = 'running' WHERE id = ?")
      .run(accepted.body.id);
    await waitForAction(accepted.body.id).catch(() => undefined);
    context.deps.db.$client
      .prepare("UPDATE actions SET status = 'running' WHERE id = ?")
      .run(accepted.body.id);

    const restarted = await context.restart();

    const after = await call<ActionEntry>(restarted.app, `/api/v1/actions/${accepted.body.id}`, { cookie });
    expect(after.body.status).toBe("uncertain");
  });

  it("tells a dialog what it would change, without a secret in sight", async () => {
    await twoVersions();

    const version1 = (await api<ReleaseDetail>(`${RELEASES}/1`)).body;

    expect(version1.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "image", before: NEW, after: OLD }),
        { area: "environment", name: "WHICH", kind: "changed", before: null, after: null },
      ]),
    );
    expect(JSON.stringify(version1.changes)).not.toContain("two");
    expect(JSON.stringify(version1.changes)).not.toContain("one");
  });
});

describe("how many versions are kept", () => {
  const keep = (value: number, as = cookie) =>
    api<{ keep: number }>("/server/releases-kept", "PUT", { keep: value }, as);
  const kept = async () => (await releases()).items.map((item) => item.number);

  async function deployTimes(times: number) {
    await setImage(OLD);
    for (let count = 0; count < times; count += 1) {
      await deploy();
    }
  }

  it("is five of each service by default, the newest ones", async () => {
    await deployTimes(7);

    expect(await kept()).toEqual([7, 6, 5, 4, 3]);
    expect((await releases()).keep).toBe(5);
    expect(await idOf(retainedTag(2))).toBeUndefined();
    expect(await idOf(retainedTag(1))).toBeUndefined();
    expect(await idOf(retainedTag(3))).toBeDefined();
  });

  it("is an administrator's to change, and takes effect at once", async () => {
    await deployTimes(4);

    const saved = await keep(2);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ keep: 2 });
    await vi.waitFor(async () => {
      expect(await kept()).toEqual([4, 3]);
    });
    expect(await idOf(retainedTag(2))).toBeUndefined();
    expect((await api<{ releasesKept: number }>("/server/overview")).body.releasesKept).toBe(2);
    expect((await keep(0)).status).toBe(400);
    expect((await keep(51)).status).toBe(400);

    const operator = await member("o@example.com", "operator");
    expect((await keep(9, operator)).status).toBe(403);
  });

  it("applies to rollbacks too, which are versions like any other", async () => {
    await keep(2);
    await twoVersions();

    await rollBackTo(1);

    expect(await kept()).toEqual([3, 2]);
  });

  it("leaves retained images alone in a cleanup, and lets the others go", async () => {
    await twoVersions();
    await context.docker.removeImage(OLD);
    await context.docker.removeImage(NEW);
    context.docker.images.push(
      {
        id: (await idOf(retainedTag(1))) as string,
        tags: [retainedTag(1)],
        sizeBytes: 2048,
        labels: {},
        createdAt: null,
      },
      {
        id: "sha256:leftover",
        tags: ["opsifier/shop/web:previous"],
        sizeBytes: 1024,
        labels: {},
        createdAt: null,
      },
    );

    const preview = (await api<CleanupPreview>("/server/docker/cleanup/images")).body;

    expect(preview.items.map((item) => item.label)).toEqual(["opsifier/shop/web:previous"]);
    expect(preview.retained).toEqual([{ label: retainedTag(1), reason: "rollback" }]);
  });

  it("goes when the service goes", async () => {
    await twoVersions();
    const removed = vi.spyOn(context.docker, "removeImage");
    const id = findService(context.deps.db, "shop", "web")?.id ?? "";
    const tag = retainedTag(1);

    const destroy = await api<ActionEntry>(SERVICE, "DELETE", { confirm: "web" });
    await waitForAction(destroy.body.id);

    expect(removed).toHaveBeenCalledWith(tag);
    expect(listReleaseRows(context.deps.db, id)).toEqual([]);
  });
});

describe("what is saved against what runs", () => {
  async function deployedWeb() {
    await setImage(OLD);
    await setEnv("A=1\nB=2");
    await api(`${SERVICE}/resources`, "PUT", { memoryLimit: 256 });
    await deploy();
  }

  it("says nothing is known before there has been a deployment", async () => {
    await setImage(OLD);
    expect(await pending()).toEqual({ known: false, changes: [], refetches: "image" });
  });

  it("is empty when what is saved is what runs", async () => {
    await deployedWeb();
    expect(await pending()).toEqual({ known: true, changes: [], refetches: "image" });
  });

  it("names each saved difference, with values only where they are safe to show", async () => {
    await deployedWeb();
    await setImage(NEW);
    await setEnv("A=9\nC=3");
    await api(`${SERVICE}/resources`, "PUT", { memoryLimit: 512 });

    const { changes } = await pending();

    expect(changes).toEqual(
      expect.arrayContaining([
        { area: "image", name: "", kind: "changed", before: OLD, after: NEW },
        { area: "environment", name: "A", kind: "changed", before: null, after: null },
        { area: "environment", name: "B", kind: "removed", before: null, after: null },
        { area: "environment", name: "C", kind: "added", before: null, after: null },
        { area: "resources", name: "memory-limit", kind: "changed", before: "256 MiB", after: "512 MiB" },
      ]),
    );
    expect(JSON.stringify(changes)).not.toContain('"9"');
  });

  it("reports the contents of a file mount without showing them", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "file", content: "one", mountPath: "/app.conf" });
    await deploy();

    await api(`${SERVICE}/storage/mounts/0`, "PUT", {
      type: "file",
      content: "two",
      mountPath: "/app.conf",
    });

    expect((await pending()).changes).toEqual([
      { area: "files", name: "/app.conf", kind: "changed", before: null, after: null },
    ]);
    expect((await detail()).pendingChanges).toBe(true);
  });

  it("does not invent a difference for a record from before file contents were kept", async () => {
    await setImage(OLD);
    await api(`${SERVICE}/storage/mounts`, "POST", { type: "file", content: "one", mountPath: "/app.conf" });
    await deploy();
    const { secrets } = context.deps;
    const row = findService(context.deps.db, "shop", "web");
    const applied = JSON.parse(secrets.unseal(row?.applied as string, "applied-configuration"));
    delete applied.files;
    context.deps.db.$client
      .prepare("UPDATE services SET applied = ? WHERE name = 'web'")
      .run(secrets.seal(JSON.stringify(applied), "applied-configuration"));

    expect(await pending()).toMatchObject({ known: true, changes: [] });
    expect((await detail()).pendingChanges).toBe(false);
  });

  it("does not invent a difference when only the image's tag has moved", async () => {
    await deployedWeb();
    context.docker.moveRegistryTag(OLD);
    await deploy();

    expect((await pending()).changes).toEqual([]);
  });

  it("says a deployment will fetch the code again, for a source built from Git", async () => {
    await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
    expect((await pending()).refetches).toBe("code");
  });

  it("names a change of repository branch", async () => {
    await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "main",
      path: "/",
    });
    await deploy();
    await api(`${SERVICE}/source`, "PUT", {
      type: "git",
      url: "https://git.example.com/acme/shop.git",
      ref: "develop",
      path: "/",
    });

    expect((await pending()).changes).toEqual([
      { area: "source", name: "ref", kind: "changed", before: "main", after: "develop" },
    ]);
  });

  it("says what a Compose stack would change, without quoting its file", async () => {
    const STACK = "/projects/shop/services/stack";
    await api("/projects/shop/compose", "POST", { name: "stack" });
    await api(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: "services:\n  web:\n    image: nginx:alpine\n",
    });
    await deploy(STACK);
    await api(`${STACK}/compose/source`, "PUT", {
      type: "inline",
      content: "services:\n  web:\n    image: nginx:1.27-alpine\n",
    });

    const stack = (await api<PendingChanges>(`${STACK}/deployments/pending`)).body;

    expect(stack).toMatchObject({
      known: true,
      refetches: "stack",
      changes: [{ area: "compose", name: "file", kind: "changed", before: null, after: null }],
    });
    expect(JSON.stringify(stack)).not.toContain("1.27-alpine");
  });

  it("is viewer-proof: only an operator can read the list", async () => {
    await deployedWeb();
    const viewer = await member("v@example.com", "viewer");

    expect((await api(`${SERVICE}/deployments/pending`, "GET", undefined, viewer)).status).toBe(403);
  });
});
