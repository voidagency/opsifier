import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DriverKind, loadConfig } from "../config";
import { DockerodeDriver } from "./dockerode";
import {
  createDockerDriver,
  DockerDriverError,
  FakeDriver,
  InvalidDockerInputError,
  type SwarmServiceSpec,
} from "./index";
import { DockerLogParser } from "./log-parser";

const spec = (name: string, replicas = 1, image = "nginx:1.27"): SwarmServiceSpec => ({
  Name: name,
  TaskTemplate: { ContainerSpec: { Image: image } },
  Mode: { Replicated: { Replicas: replicas } },
});

describe("FakeDriver", () => {
  let driver: FakeDriver;

  beforeEach(() => {
    driver = new FakeDriver({ tickMs: 60_000 });
  });

  afterEach(async () => {
    await driver.dispose();
  });

  it("starts as an initialized swarm manager", async () => {
    expect(await driver.swarmInfo()).toMatchObject({ state: "active", isManager: true });
    expect((await driver.listNetworks()).map((network) => network.name)).toContain("opsifier");
  });

  it("transitions from inactive to active on swarm init, only once", async () => {
    const fresh = new FakeDriver({ swarmActive: false });
    expect((await fresh.swarmInfo()).state).toBe("inactive");
    await expect(fresh.createService(spec("a_b"))).rejects.toThrow(DockerDriverError);

    await fresh.swarmInit({ advertiseAddr: "10.0.0.1" });
    expect((await fresh.swarmInfo()).state).toBe("active");
    await expect(fresh.swarmInit({ advertiseAddr: "10.0.0.1" })).rejects.toThrow(/already/);
    await fresh.dispose();
  });

  it("moves a task through Swarm's states to running", async () => {
    await driver.createService(spec("shop_web"));
    const states = [(await driver.listTasks({ service: "shop_web" }))[0]?.state];
    for (let step = 0; step < 6; step += 1) {
      driver.advance();
      states.push((await driver.listTasks({ service: "shop_web" }))[0]?.state);
    }
    expect(states).toEqual(["new", "pending", "assigned", "accepted", "preparing", "starting", "running"]);
    expect((await driver.listTasks({ service: "shop_web" }))[0]?.containerId).toBeTruthy();
  });

  it("starts one task per replica", async () => {
    await driver.createService(spec("shop_web", 3));
    expect(await driver.listTasks({ service: "shop_web" })).toHaveLength(3);
  });

  it("replaces tasks on update and bumps the version", async () => {
    const created = await driver.createService(spec("shop_web"));
    driver.advance(6);
    const [original] = await driver.listTasks({ service: "shop_web" });

    const updated = await driver.updateService("shop_web", spec("shop_web", 1, "nginx:1.28"));
    expect(updated.version).toBe(created.version + 1);

    driver.advance();
    const tasks = await driver.listTasks({ service: "shop_web" });
    expect(tasks.find((task) => task.id === original?.id)?.state).toBe("shutdown");

    driver.advance(8);
    const final = await driver.listTasks({ service: "shop_web" });
    expect(final.map((task) => [task.state, task.image])).toEqual([["running", "nginx:1.28"]]);
  });

  it("removes services idempotently and reports what is missing", async () => {
    await driver.createService(spec("shop_web"));
    await driver.removeService("shop_web");
    await driver.removeService("shop_web");
    expect(await driver.inspectService("shop_web")).toBeNull();
    await expect(driver.updateService("shop_web", spec("shop_web"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("refuses a duplicate service", async () => {
    await driver.createService(spec("shop_web"));
    await expect(driver.createService(spec("shop_web"))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates volumes idempotently", async () => {
    await driver.createVolume({ name: "data" });
    await driver.createVolume({ name: "data" });
    expect(await driver.listVolumes()).toHaveLength(1);
    await driver.removeVolume("data");
    expect(await driver.inspectVolume("data")).toBeNull();
  });

  it("creates overlay networks", async () => {
    const network = await driver.createNetwork({ name: "opsifier-shop", attachable: true });
    expect(network).toMatchObject({ driver: "overlay", attachable: true });
    await expect(driver.createNetwork({ name: "opsifier-shop" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("produces logs and follows until aborted", async () => {
    await driver.createService(spec("shop_web"));
    driver.advance(6);

    const history: string[] = [];
    for await (const line of driver.serviceLogs("shop_web")) {
      history.push(line.line);
    }
    expect(history.join("\n")).toContain("is running");

    const controller = new AbortController();
    const followed: string[] = [];
    const following = (async () => {
      for await (const line of driver.serviceLogs("shop_web", {
        follow: true,
        tail: 0,
        signal: controller.signal,
      })) {
        followed.push(line.line);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await driver.updateService("shop_web", spec("shop_web"));
    driver.advance(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await following;
    expect(followed.join("\n")).toContain("stopped");
  });

  it("ends a log stream when the service is removed", async () => {
    await driver.createService(spec("shop_web"));
    const following = (async () => {
      for await (const _ of driver.serviceLogs("shop_web", { follow: true })) {
        // drained
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await driver.removeService("shop_web");
    await expect(following).resolves.toBeUndefined();
  });

  it("attaches to a running task and exits cleanly", async () => {
    await driver.createService(spec("shop_web"));
    driver.advance(6);
    const session = await driver.execAttach({ service: "shop_web", command: ["sh"] });

    const output: string[] = [];
    session.stream.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    session.stream.write("whoami\n");
    session.stream.write("exit\n");

    expect(await session.exited()).toBe(0);
    expect(output.join("")).toContain("fake: whoami");
  });

  it("refuses to attach to a service with nothing running", async () => {
    await driver.createService(spec("shop_web"));
    await expect(driver.execAttach({ service: "shop_web", command: ["sh"] })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("reports stats only for running tasks", async () => {
    await driver.createService(spec("shop_web", 2));
    expect(await driver.serviceStats("shop_web")).toHaveLength(0);
    driver.advance(6);
    expect(await driver.serviceStats("shop_web")).toHaveLength(2);
  });

  it("reports pull progress and stops when aborted", async () => {
    const statuses: string[] = [];
    await driver.pullImage("nginx:1.27", { onProgress: (event) => statuses.push(event.status) });
    expect(statuses.at(-1)).toContain("Downloaded");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(driver.pullImage("nginx:1.27", { signal: controller.signal })).rejects.toThrow("stop");
  });

  it("can be made to fail on demand", async () => {
    driver.failNext("listServices", new Error("daemon went away"));
    await expect(driver.listServices()).rejects.toThrow("daemon went away");
    await expect(driver.listServices()).resolves.toEqual([]);
  });
});

describe("name validation", () => {
  const drivers = (): Array<
    [
      string,
      Pick<FakeDriver, "createService" | "inspectService" | "pullImage" | "createVolume" | "createNetwork">,
    ]
  > => [
    ["fake", new FakeDriver()],
    ["dockerode", new DockerodeDriver({ socketPath: "/nonexistent/docker.sock" })],
  ];

  it.each(drivers())("%s rejects hostile names before they reach Docker", async (_name, driver) => {
    await expect(driver.inspectService("../../etc")).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.inspectService("a b")).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.inspectService(`x${"a".repeat(70)}`)).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.createVolume({ name: "/etc" })).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.createNetwork({ name: "a;b" })).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.pullImage("nginx; rm -rf /")).rejects.toThrow(InvalidDockerInputError);
    await expect(driver.createService(spec("ok_name", 1, "IN VALID"))).rejects.toThrow(
      InvalidDockerInputError,
    );
  });

  it("accepts ordinary image references", async () => {
    const driver = new FakeDriver();
    const digest = "a".repeat(64);
    for (const ref of [
      "nginx",
      "nginx:1.27-alpine",
      "ghcr.io/owner/app:v1.2.3",
      "localhost:5000/team/app",
      `registry.example.com/app@sha256:${digest}`,
    ]) {
      await expect(driver.pullImage(ref)).resolves.toBeUndefined();
    }
  });
});

describe("DockerLogParser", () => {
  function frame(stream: number, text: string): Buffer {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  it("demultiplexes stdout and stderr", () => {
    const parser = new DockerLogParser();
    const lines = parser.push(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]));
    expect(lines).toEqual([
      { stream: "stdout", line: "out" },
      { stream: "stderr", line: "err" },
    ]);
  });

  it("reassembles frames and lines split across chunks", () => {
    const parser = new DockerLogParser();
    const data = frame(1, "hello ");
    const more = frame(1, "world\nnext");

    expect(parser.push(data.subarray(0, 4))).toEqual([]);
    expect(parser.push(data.subarray(4))).toEqual([]);
    expect(parser.push(more)).toEqual([{ stream: "stdout", line: "hello world" }]);
    expect(parser.flush()).toEqual([{ stream: "stdout", line: "next" }]);
  });

  it("keeps a multi-byte character intact when a chunk splits it", () => {
    const parser = new DockerLogParser();
    const bytes = Buffer.from("héllo\n");
    expect([...parser.push(bytes.subarray(0, 2)), ...parser.push(bytes.subarray(2))]).toEqual([
      { stream: "stdout", line: "héllo" },
    ]);
  });

  it("treats a TTY stream as plain text", () => {
    const parser = new DockerLogParser();
    expect(parser.push(Buffer.from("plain terminal text\nmore\n"))).toEqual([
      { stream: "stdout", line: "plain terminal text" },
      { stream: "stdout", line: "more" },
    ]);
  });

  it("separates timestamps when requested", () => {
    const parser = new DockerLogParser({ timestamps: true });
    expect(parser.push(frame(1, "2026-01-02T03:04:05.123456789Z hello\n"))).toEqual([
      { stream: "stdout", line: "hello", timestamp: "2026-01-02T03:04:05.123456789Z" },
    ]);
  });
});

describe("driver selection", () => {
  const load = (env: Record<string, string>) => loadConfig({ OPSIFIER_DATA_DIR: "/tmp/unused", ...env });
  const kind = (env: Record<string, string>): DriverKind => load(env).driver;

  it("uses Docker in production, whatever else is set", () => {
    expect(kind({ NODE_ENV: "production" })).toBe("dockerode");
    expect(kind({ NODE_ENV: "production", OPSIFIER_DRIVER: "dockerode" })).toBe("dockerode");
  });

  it("refuses the fake driver in production instead of pretending", () => {
    expect(() => kind({ NODE_ENV: "production", OPSIFIER_DRIVER: "fake" })).toThrow(
      /Production needs Docker/,
    );
  });

  it("uses the fake driver by default in development, Docker on request", () => {
    expect(kind({ NODE_ENV: "development" })).toBe("fake");
    expect(kind({ NODE_ENV: "development", OPSIFIER_DRIVER: "dockerode" })).toBe("dockerode");
  });

  it("rejects an unknown driver name rather than guessing", () => {
    expect(() => kind({ OPSIFIER_DRIVER: "dokcer" })).toThrow();
  });

  it("builds the right implementation", async () => {
    expect(createDockerDriver(load({ OPSIFIER_DRIVER: "fake" })).kind).toBe("fake");
    expect(createDockerDriver(load({ NODE_ENV: "production" })).kind).toBe("dockerode");
  });

  it("makes a boot fail when Docker cannot be reached", async () => {
    const driver = new DockerodeDriver({ socketPath: "/nonexistent/docker.sock" });
    await expect(driver.ping()).rejects.toBeInstanceOf(DockerDriverError);
  });
});
