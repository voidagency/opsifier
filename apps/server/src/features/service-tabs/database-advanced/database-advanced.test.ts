import type { BackupsDocument, DatabaseAdvancedSettings, ServiceDetail } from "@opsifier/contract";
import { databaseImageRule } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../../../testing/harness";
import { fakeEngine } from "../../backups/testing";
import { rolloutDatabase } from "../../databases/rollout";
import { requireDatabase } from "../../databases/service";
import { apiErrorOf, type DatabaseTestContext, PROJECT, setupDatabaseTests } from "../../databases/testing";
import { saveServiceSpec } from "../../services/repo";

let suite: DatabaseTestContext;
let context: TestContext;

beforeEach(async () => {
  suite = await setupDatabaseTests();
  context = suite.context;
});

afterEach(async () => {
  await suite.close();
  vi.restoreAllMocks();
});

const path = () => `${suite.service()}/database-advanced`;
const settings = async () => (await suite.api<DatabaseAdvancedSettings>(path())).body;
/** What a deployment pins an image to: the digest it came with. */
const pinned = async (image: string) => (await context.docker.inspectImage(image))?.digests[0];
const container = async () =>
  (await context.docker.inspectService("shop_db"))?.spec.TaskTemplate.ContainerSpec;

describe("DAT-09: advanced settings", () => {
  it("reports the image, command and environment", async () => {
    await suite.deployed({ engine: "postgres", image: "postgres:17.11-alpine" });
    expect(await settings()).toEqual({
      image: "postgres:17.11-alpine",
      command: "",
      envNames: [],
      configFile: "",
    });
  });

  it("shows the names of its variables and leaves them alone when none are sent", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.saveThenDeploy(path(), { image: "postgres:18.6", env: "TZ=Europe/Paris" });

    const page = await settings();
    expect(page.envNames).toEqual(["TZ"]);
    expect(JSON.stringify(page)).not.toContain("Europe/Paris");

    await suite.saveThenDeploy(path(), { image: "postgres:18.6" });
    expect((await container())?.Env).toContain("TZ=Europe/Paris");
    const revealed = await suite.api<{ env: string }>(`${suite.service()}/environment/reveal`, "POST");
    expect(revealed.body.env).toBe("TZ=Europe/Paris");
  });

  it("only stores settings when saved: nothing restarts until a deployment", async () => {
    await suite.deployed({ engine: "redis" });
    const before = await context.docker.inspectService("shop_db");

    const saved = await suite.api<DatabaseAdvancedSettings>(path(), "PUT", {
      image: "redis:7.4.9",
      command: "",
      env: "",
    });

    expect(saved.status).toBe(200);
    expect(saved.body.image).toBe("redis:7.4.9");
    expect(await context.docker.inspectService("shop_db")).toEqual(before);
    expect(context.deps.actions.isIdle()).toBe(true);
  });

  it("applies a new image at the next deployment", async () => {
    await suite.deployed({ engine: "redis" });
    const action = await suite.saveThenDeploy(path(), { image: "redis:7.4.9", command: "", env: "" });

    expect(action.status).toBe("succeeded");
    expect((await container())?.Image).toBe((await context.docker.inspectImage("redis:7.4.9"))?.digests[0]);
    expect((await settings()).image).toBe("redis:7.4.9");
    expect((await suite.api<ServiceDetail>(suite.service())).body.source).toMatchObject({
      image: "redis:7.4.9",
    });
  });

  it("adds a new variable to the container and removes it when cleared", async () => {
    await suite.deployed({ engine: "postgres" });
    await suite.saveThenDeploy(path(), { image: "postgres:18.6", env: "TZ=UTC" });
    expect((await container())?.Env).toContain("TZ=UTC");

    await suite.saveThenDeploy(path(), { image: "postgres:18.6", env: "" });
    expect((await container())?.Env?.some((line) => line.startsWith("TZ="))).toBe(false);
  });

  it("rejects a line without an equals sign, naming it, as the rest of the panel does", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(path(), "PUT", { image: "postgres:18.6", env: "ok=1\nno equals here" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields).toEqual({ env: "Line 2 must look like NAME=value" });
    expect((await settings()).envNames).toEqual([]);
  });

  it("reflects a custom Postgres command as /bin/sh -c, and clears it", async () => {
    await suite.deployed({ engine: "postgres" });
    const command = "docker-entrypoint.sh postgres -c max_connections=200";

    await suite.saveThenDeploy(path(), { image: "postgres:18.6", command });
    expect((await container())?.Command).toEqual(["/bin/sh", "-c", command]);

    await suite.saveThenDeploy(path(), { image: "postgres:18.6", command: "" });
    expect((await container())?.Command).toBeUndefined();
    expect((await settings()).command).toBe("");
  });

  it("really runs a custom Redis command, keeping the password in it", async () => {
    await suite.deployed({ engine: "redis" });
    const command = 'redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 256mb';

    const action = await suite.saveThenDeploy(path(), { image: "redis:7.4.8", command });

    expect(action.status).toBe("succeeded");
    expect((await container())?.Command).toEqual(["/bin/sh", "-c", command]);
    expect((await settings()).command).toBe(command);
  });

  it("refuses a Redis command that would turn the password off", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { image: "redis:7.4.8", command: "redis-server" });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.command).toContain("$REDIS_PASSWORD");
    expect((await container())?.Command).toEqual([
      "/bin/sh",
      "-c",
      'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes',
    ]);
  });

  it("refuses a variable the panel manages", async () => {
    await suite.deployed({ engine: "postgres" });
    const result = await suite.api(path(), "PUT", {
      image: "postgres:18.6",
      env: "POSTGRES_PASSWORD=changed",
    });

    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.env).toContain("POSTGRES_PASSWORD");
  });

  it("accepts a config file on MySQL and MariaDB, and refuses one elsewhere", async () => {
    await suite.deployed({ engine: "mariadb" });
    const accepted = await suite.saveThenDeploy(path(), {
      image: "mariadb:11.8.9",
      configFile: "[mysqld]\nmax_connections=200\n",
    });
    expect(accepted.status).toBe("succeeded");
    expect((await settings()).configFile).toBe("[mysqld]\nmax_connections=200\n");
    expect((await container())?.Mounts).toContainEqual({
      Type: "bind",
      Source: `${context.dataDir}/projects/${PROJECT}/db/files/opsifier.cnf`,
      Target: "/etc/mysql/conf.d/opsifier.cnf",
      ReadOnly: true,
    });

    await suite.deployed({ engine: "postgres", name: "pg" });
    const refused = await suite.api(`${suite.service("pg")}/database-advanced`, "PUT", {
      image: "postgres:18.6",
      configFile: "x",
    });
    expect(refused.status).toBe(400);
    expect(Object.keys(apiErrorOf(refused).fields ?? {})).toEqual(["configFile"]);
  });

  describe("a fixed version (REQ-495)", () => {
    it.each(["postgres:latest", "postgres", "postgres:18"])("refuses moving to %s", async (image) => {
      await suite.deployed({ engine: "postgres" });
      const result = await suite.api(path(), "PUT", { image });

      expect(result.status).toBe(400);
      expect(apiErrorOf(result).fields?.image).toBe(databaseImageRule);
      expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
    });

    it("leaves alone a database that already runs a floating tag, as long as the image stays", async () => {
      await suite.deployed({ engine: "postgres" });
      const { deps } = context;
      const record = requireDatabase(deps, { projectName: PROJECT, serviceName: "db" });
      saveServiceSpec(
        deps.db,
        PROJECT,
        "db",
        {
          ...record.spec,
          source: { type: "image", image: "postgres:17", username: null, sealedPassword: null },
        },
        new Date(deps.now()),
      );

      const action = await suite.saveThenDeploy(path(), { image: "postgres:17", env: "TZ=UTC" });

      expect(action.status).toBe("succeeded");
      expect((await settings()).envNames).toEqual(["TZ"]);
    });
  });

  describe("a major version change (REQ-202)", () => {
    const deployedPostgres = () => suite.deployed({ engine: "postgres", databaseName: "app", user: "owner" });

    it("needs the service's name typed, and nothing changes without it", async () => {
      await deployedPostgres();
      const before = await context.docker.inspectService("shop_db");

      const result = await suite.api(path(), "PUT", { image: "postgres:19.0" });

      expect(result.status).toBe(409);
      expect(apiErrorOf(result).code).toBe("major_version_change");
      expect((await settings()).image).toBe("postgres:18.6");
      expect((await context.docker.inspectService("shop_db"))?.spec).toEqual(before?.spec);
    });

    it("refuses a wrong name typed, as if nothing had been typed", async () => {
      await deployedPostgres();
      const result = await suite.api(path(), "PUT", { image: "postgres:19.0", confirm: "not-the-name" });
      expect(result.status).toBe(409);
      expect(apiErrorOf(result).code).toBe("major_version_change");
    });

    it.each([
      ["the same major", "postgres:18.7"],
      ["a variant of the same version", "postgres:18.6-alpine"],
    ])("does not ask for %s, and takes no copy", async (_label, image) => {
      await deployedPostgres();
      const engine = fakeEngine(context);

      const action = await suite.saveThenDeploy(path(), { image });

      expect(action.status).toBe("succeeded");
      expect((await settings()).image).toBe(image);
      expect(engine.dumps).toEqual([]);
    });

    it.each([
      ["a downgrade", "postgres:17.11"],
      ["another image", "registry.example.com/other/postgres:18.6"],
      ["a digest that says nothing", `postgres@sha256:${"a".repeat(64)}`],
    ])("asks for %s, which can't be read as the same major version", async (_label, image) => {
      await deployedPostgres();
      const result = await suite.api(path(), "PUT", { image });
      expect(result.status).toBe(409);
      expect(apiErrorOf(result).code).toBe("major_version_change");
    });

    it("only stores it when saved: nothing is copied or replaced until a deployment", async () => {
      await deployedPostgres();
      const engine = fakeEngine(context);
      const before = await context.docker.inspectService("shop_db");

      const saved = await suite.api<DatabaseAdvancedSettings>(path(), "PUT", {
        image: "postgres:19.0",
        confirm: "db",
      });

      expect(saved.status).toBe(200);
      expect(saved.body.image).toBe("postgres:19.0");
      expect(engine.dumps).toEqual([]);
      expect(await context.docker.inspectService("shop_db")).toEqual(before);
      expect(context.deps.actions.isIdle()).toBe(true);
    });

    it("backs up the whole server at the deployment, then moves to the new image", async () => {
      await deployedPostgres();
      const engine = fakeEngine(context);

      const action = await suite.saveThenDeploy(path(), { image: "postgres:19.0", confirm: "db" });

      expect(action.status).toBe("succeeded");
      expect(action.log).toMatch(/may need its data to be migrated/);
      expect(engine.dumps.map((call) => call.command[0])).toEqual(["pg_dumpall"]);
      expect((await settings()).image).toBe("postgres:19.0");
      expect((await container())?.Image).toBe(await pinned("postgres:19.0"));
      const backups = await suite.api<BackupsDocument>(`${suite.service()}/backups`);
      expect(backups.body.backups[0]).toMatchObject({
        origin: "safety",
        scope: "instance",
        status: "succeeded",
      });
    });

    it("needs no second confirmation to save other settings once the change is saved", async () => {
      await deployedPostgres();
      await suite.api(path(), "PUT", { image: "postgres:19.0", confirm: "db" });

      const saved = await suite.api(path(), "PUT", { image: "postgres:19.0", env: "TZ=UTC" });

      expect(saved.status).toBe(200);
    });

    it("leaves the running version alone when that backup fails", async () => {
      await deployedPostgres();
      fakeEngine(context, { dumpExit: 1 });

      const action = await suite.saveThenDeploy(path(), { image: "postgres:19.0", confirm: "db" });

      expect(action.status).toBe("failed");
      expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
    });

    it("goes back to the previous image when the new one does not start, and keeps the backup", async () => {
      await deployedPostgres();
      fakeEngine(context);
      await context.docker.pullImage("postgres:19.0");
      const broken = await pinned("postgres:19.0");
      context.docker.taskFailure = (spec) =>
        spec.TaskTemplate.ContainerSpec.Image === broken ? "task: non-zero exit (1)" : null;

      const action = await suite.saveThenDeploy(path(), { image: "postgres:19.0", confirm: "db" });

      expect(action.status).toBe("failed");
      expect(action.error).toContain("previous version is running again");
      expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
      const backups = await suite.api<BackupsDocument>(`${suite.service()}/backups`);
      expect(backups.body.backups[0]).toMatchObject({ origin: "safety", status: "succeeded" });
    });

    it("says that Redis has nothing to back up, and still asks", async () => {
      await suite.deployed({ engine: "redis" });

      const unconfirmed = await suite.api(path(), "PUT", { image: "redis:8.8.4" });
      expect(unconfirmed.status).toBe(409);

      const action = await suite.saveThenDeploy(path(), { image: "redis:8.8.4", confirm: "db" });
      expect(action.status).toBe("succeeded");
      expect(action.log).toMatch(/no backups in the panel/);
      expect((await settings()).image).toBe("redis:8.8.4");
    });

    it("refuses a stopped database, whose data can't be read for a backup", async () => {
      await deployedPostgres();
      await suite.run(`${suite.service()}/stop`);

      const result = await suite.api(path(), "PUT", { image: "postgres:19.0", confirm: "db" });

      expect(result.status).toBe(409);
      expect(apiErrorOf(result).code).toBe("major_change_needs_running");
    });

    describe("saved, and then stopped before it was deployed", () => {
      async function savedThenStopped() {
        await deployedPostgres();
        await suite.api(path(), "PUT", { image: "postgres:19.0", confirm: "db" });
        await suite.run(`${suite.service()}/stop`);
      }

      it("refuses to deploy, since no backup can be taken", async () => {
        await savedThenStopped();

        const action = await suite.run(`${suite.service()}/deploy`);

        expect(action.status).toBe("failed");
        expect(action.error).toContain("Start this database first");
        expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
      });

      it("starts on the version it was stopped on, even after something else updated it", async () => {
        await savedThenStopped();
        const record = requireDatabase(context.deps, { projectName: PROJECT, serviceName: "db" });
        expect(record.spec.stopped).toBe(true);

        const target = { projectName: PROJECT, serviceName: "db" };
        const rollout = await context.deps.actions.enqueue({
          type: "test.rollout",
          title: "Apply the saved settings",
          ...target,
          run: (ctx) => rolloutDatabase(context.deps, target, ctx),
        });
        expect((await suite.waitFor(rollout.id)).status).toBe("succeeded");

        expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
        const started = await suite.run(`${suite.service()}/start`);
        expect(started.status).toBe("succeeded");
        expect((await container())?.Image).toBe(await pinned("postgres:18.6"));
      });

      it("can then be moved, with its copy, once it is running again", async () => {
        await savedThenStopped();
        await suite.run(`${suite.service()}/start`);
        const engine = fakeEngine(context);

        const action = await suite.run(`${suite.service()}/deploy`);

        expect(action.status).toBe("succeeded");
        expect(engine.dumps.map((call) => call.command[0])).toEqual(["pg_dumpall"]);
        expect((await container())?.Image).toBe(await pinned("postgres:19.0"));
      });
    });
  });

  it("rejects a badly formed image", async () => {
    await suite.deployed({ engine: "redis" });
    const result = await suite.api(path(), "PUT", { image: "not valid" });
    expect(result.status).toBe(400);
    expect(apiErrorOf(result).fields?.image).toBe("Enter an image such as name:tag");
  });

  it("stores changes without touching a stopped database", async () => {
    await suite.deployed({ engine: "redis" });
    await suite.run(`${suite.service()}/stop`);
    const before = await context.docker.inspectService("shop_db");

    expect((await suite.api(path(), "PUT", { image: "redis:7.4.9" })).status).toBe(200);

    expect((await suite.api<ServiceDetail>(suite.service())).body.status).toBe("stopped");
    expect(await context.docker.inspectService("shop_db")).toEqual(before);
  });

  it("reports a failed rollout on the deployment", async () => {
    await suite.deployed({ engine: "redis" });
    context.docker.failNext("pullImage");

    const action = await suite.saveThenDeploy(path(), { image: "redis:7.4.9" });

    expect(action.status).toBe("failed");
    expect(action.error).toContain("pullImage failed");
  });
});
