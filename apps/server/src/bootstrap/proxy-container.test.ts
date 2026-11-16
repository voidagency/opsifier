import { describe, expect, it } from "vitest";
import { DockerDriverError, FakeDriver, type NetworkInfo } from "../core/docker";
import {
  connectProxyNow,
  createProxy,
  disconnectProxyNow,
  LEGACY_PROXY_SERVICE,
  moveProxyOffSwarm,
  PROXY_CONTAINER,
  replaceProxy,
  serializeProxyChange,
} from "./proxy-container";
import { proxyContainerSpec, proxyServiceSpec } from "./specs";

const FAST = { pollMs: 1, settleMs: 0, freeMs: 200 };
const noLog = () => undefined;

async function serverWithProxy() {
  const docker = new FakeDriver({ tickMs: 1 });
  const shared = (await docker.inspectNetwork("opsifier")) as NetworkInfo;
  await createProxy(
    docker,
    proxyContainerSpec({ dataDir: "/var/lib/opsifier", image: "traefik:3", networkId: shared.name }),
    noLog,
    FAST,
  );
  return { docker, shared };
}

const networksOf = async (docker: FakeDriver, name = PROXY_CONTAINER) =>
  ((await docker.inspectPlainContainer(name))?.networks ?? []).map((network) => network.name).sort();

describe("the proxy's container", () => {
  it("joins and leaves a project's network while it runs, and says so once", async () => {
    const { docker } = await serverWithProxy();
    const before = await docker.inspectPlainContainer(PROXY_CONTAINER);
    const project = await docker.createNetwork({
      name: "opsifier-shop_proxy",
      driver: "overlay",
      attachable: true,
    });
    const lines: string[] = [];

    expect(await connectProxyNow(docker, [project], (line) => lines.push(line))).toBe(true);
    expect(await connectProxyNow(docker, [project], (line) => lines.push(line))).toBe(true);
    expect(await networksOf(docker)).toEqual(["opsifier", "opsifier-shop_proxy"]);

    // Swarm keeps the network while the proxy is on it.
    await expect(docker.removeNetwork("opsifier-shop_proxy")).rejects.toBeInstanceOf(DockerDriverError);
    expect(await disconnectProxyNow(docker, [project], (line) => lines.push(line))).toBe(true);
    await docker.removeNetwork("opsifier-shop_proxy");

    expect(lines).toEqual([
      "Connecting the proxy to opsifier-shop_proxy",
      "Disconnecting the proxy from opsifier-shop_proxy",
    ]);
    const after = await docker.inspectPlainContainer(PROXY_CONTAINER);
    expect(after?.id).toBe(before?.id);
    expect(after?.startedAt).toBe(before?.startedAt);
  });

  it("leaves the networks to the Swarm service when there is no container", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const project = await docker.createNetwork({
      name: "opsifier-shop_proxy",
      driver: "overlay",
      attachable: true,
    });

    expect(await connectProxyNow(docker, [project], noLog)).toBe(false);
    expect(await disconnectProxyNow(docker, [project], noLog)).toBe(false);
  });

  it("is replaced by one with new settings, on every network the old one was on", async () => {
    const { docker } = await serverWithProxy();
    const project = await docker.createNetwork({
      name: "opsifier-shop_proxy",
      driver: "overlay",
      attachable: true,
    });
    await connectProxyNow(docker, [project], noLog);
    const before = await docker.inspectPlainContainer(PROXY_CONTAINER);

    await replaceProxy(docker, (spec) => ({ ...spec, env: [...spec.env, "NEW=1"] }), noLog, FAST);

    const after = await docker.inspectPlainContainer(PROXY_CONTAINER);
    expect(after?.id).not.toBe(before?.id);
    expect(after?.state).toBe("running");
    expect(after?.env).toContain("NEW=1");
    expect(await networksOf(docker)).toEqual(["opsifier", "opsifier-shop_proxy"]);
    expect(await docker.inspectPlainContainer("opsifier-traefik-previous")).toBeNull();
  });

  it("comes back as it was when the new one does not start", async () => {
    const { docker } = await serverWithProxy();
    const before = await docker.inspectPlainContainer(PROXY_CONTAINER);
    const start = docker.startContainer.bind(docker);
    let starts = 0;
    docker.startContainer = async (name) => {
      starts += 1;
      if (starts === 1) {
        throw new DockerDriverError("the new image is broken", 500);
      }
      return start(name);
    };

    await expect(
      replaceProxy(docker, (spec) => ({ ...spec, image: "traefik:broken" }), noLog, FAST),
    ).rejects.toThrow(/broken/);

    const after = await docker.inspectPlainContainer(PROXY_CONTAINER);
    expect(after?.id).toBe(before?.id);
    expect(after?.state).toBe("running");
    expect(after?.image).toBe("traefik:3");
    expect(await docker.inspectPlainContainer("opsifier-traefik-previous")).toBeNull();
  });

  it("comes back as it was when the new one stops right after starting", async () => {
    const { docker } = await serverWithProxy();
    const before = await docker.inspectPlainContainer(PROXY_CONTAINER);
    const start = docker.startContainer.bind(docker);
    docker.startContainer = async (name) => {
      await start(name);
      if (name === PROXY_CONTAINER && (await docker.inspectPlainContainer(name))?.id !== before?.id) {
        docker.crashPlainContainer(name);
      }
    };

    await expect(replaceProxy(docker, (spec) => spec, noLog, FAST)).rejects.toThrow(
      /stopped right after it started/,
    );

    expect((await docker.inspectPlainContainer(PROXY_CONTAINER))?.id).toBe(before?.id);
    expect((await docker.inspectPlainContainer(PROXY_CONTAINER))?.state).toBe("running");
  });

  it("does one change at a time", async () => {
    const { docker } = await serverWithProxy();
    const order: string[] = [];

    await Promise.all([
      serializeProxyChange(docker, async () => {
        order.push("first starts");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first ends");
      }),
      serializeProxyChange(docker, async () => {
        order.push("second");
      }),
    ]);

    expect(order).toEqual(["first starts", "first ends", "second"]);
  });
});

describe("moving the proxy out of Swarm", () => {
  async function serverWithLegacyProxy() {
    const docker = new FakeDriver({ tickMs: 1 });
    const shared = (await docker.inspectNetwork("opsifier")) as NetworkInfo;
    const project = await docker.createNetwork({
      name: "opsifier-shop_proxy",
      driver: "overlay",
      attachable: true,
    });
    const spec = proxyServiceSpec({ dataDir: "/var/lib/opsifier", image: "traefik:3", networkId: shared.id });
    await docker.createService({
      ...spec,
      TaskTemplate: { ...spec.TaskTemplate, Networks: [{ Target: shared.id }, { Target: project.id }] },
    });
    docker.advance(8);
    return docker;
  }

  it("keeps its image, settings, folder, ports and networks", async () => {
    const docker = await serverWithLegacyProxy();
    const legacy = await docker.inspectService(LEGACY_PROXY_SERVICE);

    expect(await moveProxyOffSwarm(docker, noLog, FAST)).toBe(true);

    expect(await docker.inspectService(LEGACY_PROXY_SERVICE)).toBeNull();
    const proxy = await docker.inspectPlainContainer(PROXY_CONTAINER);
    expect(proxy).toMatchObject({ state: "running", image: "traefik:3", ports: [80, 443] });
    expect(proxy?.env).toEqual(legacy?.spec.TaskTemplate.ContainerSpec.Env);
    expect(proxy?.binds).toEqual([
      { source: "/var/lib/opsifier/traefik", target: "/var/lib/opsifier/traefik" },
    ]);
    expect(await networksOf(docker)).toEqual(["opsifier", "opsifier-shop_proxy"]);
    expect(await moveProxyOffSwarm(docker, noLog, FAST)).toBe(false);
  });

  it("puts the Swarm service back as it was when the container does not start", async () => {
    const docker = await serverWithLegacyProxy();
    const legacy = await docker.inspectService(LEGACY_PROXY_SERVICE);
    docker.startContainer = async () => {
      throw new DockerDriverError("port 80 is taken by something else", 500);
    };

    await expect(moveProxyOffSwarm(docker, noLog, FAST)).rejects.toThrow(/port 80/);

    expect(await docker.inspectPlainContainer(PROXY_CONTAINER)).toBeNull();
    expect((await docker.inspectService(LEGACY_PROXY_SERVICE))?.spec).toEqual(legacy?.spec);
  });

  it("only removes the service when a container already holds the ports", async () => {
    const docker = await serverWithLegacyProxy();
    await docker.removeService(LEGACY_PROXY_SERVICE);
    await createProxy(
      docker,
      proxyContainerSpec({ dataDir: "/var/lib/opsifier", image: "traefik:3", networkId: "opsifier" }),
      noLog,
      FAST,
    );
    const container = await docker.inspectPlainContainer(PROXY_CONTAINER);
    await docker.createService(
      proxyServiceSpec({ dataDir: "/var/lib/opsifier", image: "traefik:3", networkId: "opsifier" }),
    );

    expect(await moveProxyOffSwarm(docker, noLog, FAST)).toBe(true);

    expect(await docker.inspectService(LEGACY_PROXY_SERVICE)).toBeNull();
    expect((await docker.inspectPlainContainer(PROXY_CONTAINER))?.id).toBe(container?.id);
  });
});
