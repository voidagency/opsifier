import { serviceMetrics, servicesMetrics } from "@opsifier/contract";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DockerDriver, DockerDriverError, FakeDriver, type TaskStats } from "../../core/docker";
import { createMetricsProvider, PollingFeed, readServiceMetrics, sumTaskStats } from "./metrics";

const logger = pino({ level: "silent" });
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error("Timed out");
}

const sample = (overrides: Partial<TaskStats> = {}): TaskStats => ({
  taskId: "t1",
  slot: 1,
  containerId: "c1",
  cpuPercent: 1.5,
  memoryUsedBytes: 1024,
  memoryLimitBytes: 4096,
  networkRxBytes: 10,
  networkTxBytes: 20,
  readAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("reading a service", () => {
  it("adds the tasks together", () => {
    expect(sumTaskStats([sample(), sample({ cpuPercent: 2.5 })])).toEqual({
      cpuPercent: 4,
      memoryUsedBytes: 2048,
      networkRxBytes: 20,
      networkTxBytes: 40,
      readAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it.each([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5])(
    "never lets %d through as a reading",
    (bad) => {
      const summed = sumTaskStats([
        sample({ cpuPercent: bad, memoryUsedBytes: bad, networkRxBytes: bad, networkTxBytes: bad }),
      ]);

      expect(serviceMetrics.parse(summed)).toEqual({
        cpuPercent: 0,
        memoryUsedBytes: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        readAt: "2026-01-01T00:00:00.000Z",
      });
    },
  );

  it("reads zero for a service with no tasks", () => {
    expect(sumTaskStats([])).toMatchObject({ cpuPercent: 0, memoryUsedBytes: 0, readAt: null });
  });

  it("reads zero when Docker fails rather than failing", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    docker.failNext("serviceStats", new DockerDriverError("daemon away", 500));

    await expect(
      readServiceMetrics({ docker }, { projectName: "shop", serviceName: "web" }),
    ).resolves.toMatchObject({ memoryUsedBytes: 0, readAt: null });
  });
});

describe("the polling feed", () => {
  function feedOf(read: (signal: AbortSignal) => Promise<number>, intervalMs = 5) {
    const published: number[] = [];
    const feed = new PollingFeed(
      read,
      { publish: (value) => published.push(value as number), pressure: () => 0 },
      intervalMs,
      logger,
      0,
    );
    closers.push(() => feed.close());
    return { feed, published };
  }

  it("reads at once and then at every interval", async () => {
    let reads = 0;
    const { published } = feedOf(async () => {
      reads += 1;
      return reads;
    });

    await until(() => published.length >= 3);
    expect(published.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("stops reading the moment it is closed", async () => {
    let reads = 0;
    const { feed, published } = feedOf(async () => {
      reads += 1;
      return reads;
    });
    await until(() => published.length >= 1);

    feed.close();
    const count = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(reads).toBe(count);
  });

  it("never overlaps a reading with the next one", async () => {
    let running = 0;
    let highest = 0;
    const { published } = feedOf(async () => {
      running += 1;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return 1;
    }, 1);

    await until(() => published.length >= 3);
    expect(highest).toBe(1);
  });

  it("keeps going after a failed reading", async () => {
    let reads = 0;
    const { published } = feedOf(async () => {
      reads += 1;
      if (reads === 1) {
        throw new Error("hiccup");
      }
      return reads;
    });

    await until(() => published.length >= 1);
    expect(published[0]).toBe(2);
  });

  it("hands a new subscriber the latest reading", async () => {
    const { feed, published } = feedOf(async () => 7);
    expect(feed.replay()).toEqual([]);

    await until(() => published.length >= 1);
    expect(feed.replay()).toEqual([7]);
  });
});

describe("the metrics provider", () => {
  const deps = (docker: DockerDriver) => ({ docker, logger, now: () => 1_700_000_000_000 });

  function subscribe(docker: DockerDriver, topic: string) {
    const provider = createMetricsProvider(deps(docker), { intervalMs: 5 });
    const published: unknown[] = [];
    const feed = provider.open(topic, { publish: (value) => published.push(value), pressure: () => 0 });
    closers.push(() => feed.close());
    return { feed, published };
  }

  async function running(name: string, replicas = 1): Promise<FakeDriver> {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: name,
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      Mode: { Replicated: { Replicas: replicas } },
    });
    docker.advance(8);
    return docker;
  }

  it("samples one service only while it is open", async () => {
    const docker = await running("shop_web");
    const spy = vi.spyOn(docker, "serviceStats");
    const { feed, published } = subscribe(docker, "service-metrics:shop/web");

    await until(() => published.length >= 2);
    expect(serviceMetrics.parse(published[0]).memoryUsedBytes).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledWith("shop_web", expect.anything());

    feed.close();
    const calls = spy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(spy.mock.calls.length).toBe(calls);
  });

  it("refuses a malformed topic instead of asking Docker about it", () => {
    const provider = createMetricsProvider(deps(new FakeDriver({ tickMs: 1 })), { intervalMs: 5 });

    expect(() =>
      provider.open("service-metrics:Bad_Project/x", { publish: () => {}, pressure: () => 0 }),
    ).toThrow();
    expect(() => provider.open("service-metrics:a/b/c", { publish: () => {}, pressure: () => 0 })).toThrow();
  });

  it("lists every running task of every workload, split by project and service", async () => {
    const docker = await running("shop_web", 2);
    await docker.createService({
      Name: "opsifier-traefik",
      TaskTemplate: { ContainerSpec: { Image: "traefik:3" } },
    });
    docker.advance(8);
    const { published } = subscribe(docker, "metrics:services");

    await until(() => published.length >= 1);
    const reading = servicesMetrics.parse(published[0]);

    expect(reading.available).toBe(true);
    expect(reading.services.map((service) => [service.projectName, service.serviceName])).toEqual([
      ["shop", "web"],
    ]);
    expect(reading.services[0]?.tasks).toHaveLength(2);
    expect(reading.services[0]?.tasks[0]).toMatchObject({ memoryPercent: 12.5 });
  });

  it("splits a service name that has underscores of its own at the first one", async () => {
    const docker = await running("shop_my_api");
    const { published } = subscribe(docker, "metrics:services");

    await until(() => published.length >= 1);

    expect(servicesMetrics.parse(published[0]).services[0]).toMatchObject({
      projectName: "shop",
      serviceName: "my_api",
    });
  });

  it("says so when Docker doesn't answer", async () => {
    const docker = await running("shop_web");
    docker.failNext("listServices");
    const { published } = subscribe(docker, "metrics:services");

    await until(() => published.length >= 1);

    expect(servicesMetrics.parse(published[0])).toEqual({ available: false, readAt: null, services: [] });
  });
});
