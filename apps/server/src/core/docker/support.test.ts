import { describe, expect, it, vi } from "vitest";
import { FakeTools, ToolNotFoundError, type ToolRunner, ToolTimeoutError } from "../tools";
import {
  assertCliFeature,
  assertEngineSupported,
  cliProblems,
  compareVersions,
  DockerDriverError,
  DockerUnsupportedError,
  engineProblems,
  FakeDriver,
  MINIMUM_DOCKER_API,
  MINIMUM_DOCKER_VERSION,
  refuseOnUnsupportedEngine,
} from "./index";

const compatible = () => new FakeDriver({ tickMs: 1 }).engine;

describe("comparing versions", () => {
  it("is numeric, so 9 sorts before 26 and an API is ordered by its minor number", () => {
    expect(compareVersions("9.0.0", "26.0.0")).toBeLessThan(0);
    expect(compareVersions("1.9", "1.45")).toBeLessThan(0);
    expect(compareVersions("1.52", MINIMUM_DOCKER_API)).toBeGreaterThan(0);
    expect(compareVersions("v26.0.1-ce", MINIMUM_DOCKER_VERSION)).toBeGreaterThan(0);
  });
});

describe("what a daemon says about itself", () => {
  it("finds nothing wrong with a compatible engine", () => {
    expect(engineProblems(compatible())).toEqual([]);
  });

  it.each([
    ["an old engine", { version: "20.10.0", apiVersion: "1.41" }, ["version", "api"]],
    ["a current number with an old API", { version: "29.1.0", apiVersion: "1.40" }, ["api"]],
    ["an API it won't name", { apiVersion: "" }, ["api"]],
    ["no overlay driver", { networkDrivers: ["bridge"] }, ["overlay"]],
    ["no local volumes", { volumeDrivers: ["convoy"] }, ["volumes"]],
    ["no Swarm mode", { swarmAvailable: false }, ["swarm"]],
    ["Swarm inactive", { swarm: "inactive" as const, swarmManager: false }, ["swarm"]],
    ["a worker node", { swarmManager: false }, ["swarm"]],
  ])("refuses %s", (_name, engine, missing) => {
    expect(engineProblems({ ...compatible(), ...engine }).map(({ feature }) => feature)).toEqual(missing);
  });

  it("doesn't mind Swarm being off while it is being set up, only it being absent", () => {
    const inactive = { ...compatible(), swarm: "inactive" as const, swarmManager: false };
    expect(engineProblems(inactive, { settingUp: true })).toEqual([]);
    expect(engineProblems({ ...inactive, swarmAvailable: false }, { settingUp: true })).toHaveLength(1);
  });
});

describe("the Docker CLI's plugins", () => {
  const cli = (tools: FakeTools) => ({ tools, env: {} });

  it("finds nothing wrong when both answer", async () => {
    expect(await cliProblems(cli(new FakeTools()))).toEqual([]);
  });

  it("names each one that doesn't", async () => {
    const tools = new FakeTools();
    tools.missingPlugins.add("buildx");

    const problems = await cliProblems(cli(tools));

    expect(problems.map(({ feature }) => feature)).toEqual(["buildx"]);
  });

  it("counts a CLI that isn't there at all, or one that hangs", async () => {
    for (const error of [new ToolNotFoundError("docker"), new ToolTimeoutError("docker", 15_000)]) {
      const tools: ToolRunner = {
        kind: "fake",
        run: async () => {
          throw error;
        },
      };

      expect(await cliProblems({ tools, env: {} })).toHaveLength(2);
    }
  });

  it("refuses a plugin's commands on an engine that can't run them, before asking the plugin", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.engine = { ...docker.engine, apiVersion: "1.30" };
    const tools = new FakeTools();

    await expect(assertCliFeature(docker, cli(tools), "compose")).rejects.toBeInstanceOf(
      DockerUnsupportedError,
    );
    expect(tools.calls).toHaveLength(0);
  });

  it("refuses a command of a plugin that does not answer", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const tools = new FakeTools();
    tools.missingPlugins.add("compose");

    await expect(assertCliFeature(docker, cli(tools), "compose")).rejects.toThrow(/Compose plugin/);
    await expect(assertCliFeature(docker, cli(tools), "buildx")).resolves.toBeUndefined();
  });
});

describe("a driver that refuses what the engine can't do", () => {
  const SPEC = {
    Name: "shop_web",
    TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
    Mode: { Replicated: { Replicas: 1 } },
  };

  it("lets everything through on a compatible engine", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const guarded = refuseOnUnsupportedEngine(docker);

    await guarded.createService(SPEC);

    expect(await docker.inspectService("shop_web")).not.toBeNull();
  });

  it("stops a change before Docker sees it, on an old engine and on a current number with an old API", async () => {
    for (const engine of [
      { version: "20.10.0", apiVersion: "1.41" },
      { version: "29.1.0", apiVersion: "1.40" },
    ]) {
      const docker = new FakeDriver({ tickMs: 1 });
      docker.engine = { ...docker.engine, ...engine };
      const create = vi.spyOn(docker, "createService");
      const guarded = refuseOnUnsupportedEngine(docker);

      await expect(guarded.createService(SPEC)).rejects.toBeInstanceOf(DockerUnsupportedError);

      expect(create).not.toHaveBeenCalled();
      expect(await docker.listServices()).toEqual([]);
    }
  });

  it("stops every kind of change, not only the ones that deploy", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.engine = { ...docker.engine, networkDrivers: [] };
    const guarded = refuseOnUnsupportedEngine(docker);

    await expect(guarded.createNetwork({ name: "opsifier-x" })).rejects.toThrow(/overlay/);
    await expect(guarded.pullImage("nginx:alpine")).rejects.toBeInstanceOf(DockerUnsupportedError);
    await expect(guarded.createVolume({ name: "v" })).rejects.toBeInstanceOf(DockerUnsupportedError);
    await expect(guarded.removeService("shop_web")).rejects.toBeInstanceOf(DockerUnsupportedError);
    await expect(guarded.runHelper({ image: "x", command: ["df"] })).rejects.toBeInstanceOf(
      DockerUnsupportedError,
    );
  });

  it("keeps answering reads, so the panel can still say what is wrong", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.engine = { ...docker.engine, apiVersion: "1.20" };
    const guarded = refuseOnUnsupportedEngine(docker);

    await expect(guarded.listServices()).resolves.toEqual([]);
    await expect(guarded.engineInfo()).resolves.toMatchObject({ apiVersion: "1.20" });
    await expect(guarded.ping()).resolves.toBeUndefined();
  });

  it("still lets a running process be ended", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.engine = { ...docker.engine, apiVersion: "1.20" };
    const guarded = refuseOnUnsupportedEngine(docker);

    await expect(guarded.terminateExec({ service: "x", marker: "m" })).resolves.toBeUndefined();
  });

  it("stays out of the way when the daemon can't be asked, so that its own error is what is reported", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.failNext("engineInfo");
    docker.failNext("createService", new DockerDriverError("connection refused", 503));
    const guarded = refuseOnUnsupportedEngine(docker);

    await expect(guarded.createService(SPEC)).rejects.toThrow("connection refused");
  });

  it("is the error a route turns into an answer", () => {
    expect(new DockerUnsupportedError("x")).toBeInstanceOf(DockerDriverError);
  });

  it("names the reason, and that nothing was changed", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.engine = { ...docker.engine, swarm: "inactive", swarmManager: false };

    await expect(assertEngineSupported(docker)).rejects.toThrow(/Swarm is "inactive".*Nothing was changed/);
  });
});
