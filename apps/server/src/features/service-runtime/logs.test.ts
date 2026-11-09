import type { ServiceLogEvent, ServiceLogLine } from "@opsifier/contract";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerDriver, LogLine, LogOptions, ServiceInfo, TaskInfo } from "../../core/docker";
import { FakeDriver } from "../../core/docker";
import { Redactor } from "../../core/tools";
import { detectLevel, LogFeed, type LogFeedTiming, redactLogEntries, searchServiceLogs } from "./logs";

const logger = pino({ level: "silent" });
const FAST: Partial<LogFeedTiming> = { flushMs: 1, settleMs: 0, watchMs: 5, retryMs: 2, paceMs: 0 };
const feeds: LogFeed[] = [];

afterEach(() => {
  for (const feed of feeds.splice(0)) {
    feed.close();
  }
});

function channel(pressure: () => number = () => 0) {
  const events: ServiceLogEvent[] = [];
  return { events, publish: (event: unknown) => events.push(event as ServiceLogEvent), pressure };
}

const linesOf = (events: readonly ServiceLogEvent[]): ServiceLogLine[] =>
  events.flatMap((event) => (event.kind === "lines" ? event.lines : []));

const states = (events: readonly ServiceLogEvent[]) =>
  events.flatMap((event) => (event.kind === "state" ? [event.state] : []));

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error("Timed out");
}

function spec(name: string, replicas = 1) {
  return {
    Name: name,
    TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
    Mode: { Replicated: { Replicas: replicas } },
  };
}

function open(
  docker: DockerDriver,
  output: ReturnType<typeof channel>,
  overrides: Partial<ConstructorParameters<typeof LogFeed>[0]> = {},
): LogFeed {
  const feed = new LogFeed({ docker, logger, name: "shop_web", channel: output, timing: FAST, ...overrides });
  feeds.push(feed);
  return feed;
}

async function runningDriver(): Promise<FakeDriver> {
  const docker = new FakeDriver({ tickMs: 1 });
  await docker.createService(spec("shop_web"));
  docker.advance(8);
  return docker;
}

/** A driver whose log stream is whatever the test yields, so reads can be counted. */
function scriptedDriver(source: (options: LogOptions) => AsyncGenerator<LogLine>): DockerDriver {
  const service = { id: "s1", name: "shop_web", spec: spec("shop_web") } as ServiceInfo;
  const task = { desiredState: "running" } as TaskInfo;
  return {
    inspectService: async () => service,
    listTasks: async () => [task],
    serviceLogs: (_name: string, options: LogOptions = {}) => source(options),
  } as unknown as DockerDriver;
}

describe("the log feed", () => {
  it("waits for a service that doesn't exist yet, then streams it without being reopened", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const output = channel();
    const feed = open(docker, output);

    expect(feed.replay()[0]).toMatchObject({ kind: "snapshot", state: "connecting", lines: [] });
    await until(() => states(output.events).includes("waiting"));

    await docker.createService(spec("shop_web"));
    docker.advance(8);
    await until(() => states(output.events).includes("streaming"));
    docker.writeLog("shop_web", "hello from the task");

    await until(() => linesOf(output.events).some((line) => line.line === "hello from the task"));
  });

  it("reports waiting again when the service is scaled to zero", async () => {
    const docker = await runningDriver();
    const output = channel();
    open(docker, output);
    await until(() => states(output.events).includes("streaming"));

    const service = await docker.inspectService("shop_web");
    await docker.updateService("shop_web", {
      ...(service as ServiceInfo).spec,
      Mode: { Replicated: { Replicas: 0 } },
    });

    await until(() => states(output.events).at(-1) === "waiting");
  });

  it("delivers stdout and stderr with their timestamps, in time order", async () => {
    const docker = scriptedDriver(async function* () {
      yield { stream: "stdout", line: "second", timestamp: "2026-01-01T00:00:02.5Z" };
      yield { stream: "stderr", line: "first", timestamp: "2026-01-01T00:00:02.123456789Z" };
      await new Promise(() => {});
    });
    const output = channel();
    open(docker, output, { timing: { ...FAST, settleMs: 20 } });

    await until(() => linesOf(output.events).length === 2);

    expect(linesOf(output.events).map((line) => [line.stream, line.line])).toEqual([
      ["stderr", "first"],
      ["stdout", "second"],
    ]);
  });

  it("removes colours and control characters and cuts absurdly long lines", async () => {
    const docker = await runningDriver();
    const output = channel();
    open(docker, output);
    await until(() => states(output.events).includes("streaming"));

    docker.writeLog("shop_web", "\u001b[31mred\u001b[0m \u0007bell");
    docker.writeLog("shop_web", "x".repeat(100_000));

    await until(() => linesOf(output.events).some((line) => line.line.startsWith("xxx")));
    const lines = linesOf(output.events);
    expect(lines.some((line) => line.line === "red bell")).toBe(true);
    const long = lines.find((line) => line.line.startsWith("xxx"));
    expect(long?.line.length).toBeLessThanOrEqual(16 * 1024 + 1);
  });

  it("gives a late subscriber only what the ring still holds", async () => {
    const docker = await runningDriver();
    const output = channel();
    const feed = open(docker, output, { limits: { ringLines: 50, batchLines: 10 } });
    await until(() => states(output.events).includes("streaming"));

    for (let index = 0; index < 500; index += 1) {
      docker.writeLog("shop_web", `line ${index}`);
    }
    await until(() => linesOf(output.events).some((line) => line.line === "line 499"));

    const [snapshot] = feed.replay();
    expect(snapshot?.kind).toBe("snapshot");
    const replayed = snapshot?.kind === "snapshot" ? snapshot.lines : [];
    expect(replayed).toHaveLength(50);
    expect(replayed.at(-1)?.line).toBe("line 499");
  });

  it("bounds the ring by size as well as by count", async () => {
    const docker = await runningDriver();
    const output = channel();
    const feed = open(docker, output, { limits: { ringBytes: 10 * 1024, batchLines: 5 } });
    await until(() => states(output.events).includes("streaming"));

    for (let index = 0; index < 50; index += 1) {
      docker.writeLog("shop_web", `${index} ${"y".repeat(1024)}`);
    }
    await until(() => linesOf(output.events).length >= 50);

    const [snapshot] = feed.replay();
    const replayed = snapshot?.kind === "snapshot" ? snapshot.lines : [];
    expect(replayed.reduce((total, line) => total + line.line.length, 0)).toBeLessThanOrEqual(10 * 1024);
  });

  it("never publishes more than a batch at once", async () => {
    const docker = await runningDriver();
    const output = channel();
    open(docker, output, { limits: { batchLines: 10 } });
    await until(() => states(output.events).includes("streaming"));

    for (let index = 0; index < 300; index += 1) {
      docker.writeLog("shop_web", `line ${index}`);
    }
    await until(() => linesOf(output.events).length >= 300);

    for (const event of output.events) {
      if (event.kind === "lines") {
        expect(event.lines.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it("stops reading from Docker while a subscriber can't keep up, and resumes when it can", async () => {
    let produced = 0;
    let pressure = Number.MAX_SAFE_INTEGER;
    const docker = scriptedDriver(async function* () {
      for (;;) {
        produced += 1;
        yield { stream: "stdout", line: `line ${produced}`, timestamp: "2026-01-01T00:00:00Z" };
      }
    });
    const output = channel(() => pressure);
    open(docker, output, {
      limits: { batchLines: 20 },
      timing: { ...FAST, pressureWaitMs: 60_000 },
    });

    await until(() => produced >= 20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(produced).toBeLessThanOrEqual(21);

    pressure = 0;
    await until(() => produced > 100);
  });

  it("lets a stuck subscriber hold everyone else up only for a while", async () => {
    let produced = 0;
    const docker = scriptedDriver(async function* () {
      for (;;) {
        produced += 1;
        yield { stream: "stdout", line: "x", timestamp: "2026-01-01T00:00:00Z" };
      }
    });
    open(
      docker,
      channel(() => Number.MAX_SAFE_INTEGER),
      {
        limits: { batchLines: 5 },
        timing: { ...FAST, pressureWaitMs: 5 },
      },
    );

    await until(() => produced > 30);
  });

  it("stops following when it is closed", async () => {
    let released = false;
    let aborted = false;
    const docker = scriptedDriver(async function* (options) {
      options.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      try {
        yield { stream: "stdout", line: "one" };
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
      } finally {
        released = true;
      }
    });
    const output = channel();
    const feed = open(docker, output);
    await until(() => linesOf(output.events).length === 1);

    feed.close();

    await until(() => released);
    expect(aborted).toBe(true);
    const count = output.events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(output.events).toHaveLength(count);
  });

  it("notices a service that was replaced, since Docker leaves the old follow open", async () => {
    let follows = 0;
    let service = { id: "first", name: "shop_web", spec: spec("shop_web") } as ServiceInfo;
    const docker = {
      inspectService: async () => service,
      listTasks: async () => [{ desiredState: "running" } as TaskInfo],
      serviceLogs: async function* (_name: string, options: LogOptions) {
        follows += 1;
        yield { stream: "stdout", line: `follow ${follows}` };
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
      },
    } as unknown as DockerDriver;
    const output = channel();
    open(docker, output);
    await until(() => follows === 1);

    service = { id: "second", name: "shop_web", spec: spec("shop_web") } as ServiceInfo;

    await until(() => follows === 2);
    await until(() => linesOf(output.events).some((line) => line.line === "follow 2"));
  });

  it("picks up after the last line when a follow ends, without repeating it", async () => {
    const seen: LogOptions[] = [];
    const docker = scriptedDriver(async function* (options) {
      seen.push(options);
      if (seen.length === 1) {
        yield { stream: "stdout", line: "one", timestamp: "2026-01-01T00:00:10.5Z" };
        return;
      }
      yield { stream: "stdout", line: "one", timestamp: "2026-01-01T00:00:10.5Z" };
      yield { stream: "stdout", line: "two", timestamp: "2026-01-01T00:00:11Z" };
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
    });
    const output = channel();
    open(docker, output);

    await until(() => linesOf(output.events).some((line) => line.line === "two"));

    expect(linesOf(output.events).map((line) => line.line)).toEqual(["one", "two"]);
    expect(seen[1]?.since).toBe(Math.floor(Date.parse("2026-01-01T00:00:10.5Z") / 1000));
  });

  it("numbers lines in the order they are sent, so that a client never loses one", async () => {
    const docker = scriptedDriver(async function* () {
      yield { stream: "stdout", line: "newest", timestamp: "2026-01-01T00:00:09Z" };
      yield { stream: "stdout", line: "oldest", timestamp: "2026-01-01T00:00:01Z" };
      yield { stream: "stdout", line: "middle", timestamp: "2026-01-01T00:00:05Z" };
      await new Promise(() => {});
    });
    const output = channel();
    open(docker, output, { timing: { ...FAST, settleMs: 20 } });

    await until(() => linesOf(output.events).length === 3);

    const lines = linesOf(output.events);
    expect(lines.map((line) => line.line)).toEqual(["oldest", "middle", "newest"]);
    expect(lines.map((line) => line.seq)).toEqual([0, 1, 2]);
  });

  describe("falling behind", () => {
    const CATCHING_UP: Partial<LogFeedTiming> = { ...FAST, paceMs: 1, behindMs: 40 };

    function backlog(seen: LogOptions[], options: { history?: boolean } = {}) {
      return scriptedDriver(async function* (requested) {
        seen.push(requested);
        if (seen.length > 1) {
          yield { stream: "stdout", line: "the present", timestamp: new Date().toISOString() };
          await new Promise<void>((resolve) =>
            requested.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return;
        }
        // Docker's queue: everything was printed the moment the service started.
        const printedAt = new Date(
          options.history === true ? Date.now() - 3_600_000 : Date.now(),
        ).toISOString();
        for (let index = 0; ; index += 1) {
          yield { stream: "stdout", line: `queued ${index}`, timestamp: printedAt };
        }
      });
    }

    it("drops what Docker has queued and starts again from the present, leaving a mark", async () => {
      const seen: LogOptions[] = [];
      const output = channel();
      open(backlog(seen), output, { limits: { batchLines: 20 }, timing: CATCHING_UP });

      await until(() => linesOf(output.events).some((line) => line.line === "the present"));

      const lines = linesOf(output.events);
      const gap = lines.findIndex((line) => line.gap === true);
      expect(gap).toBeGreaterThan(0);
      expect(lines[gap]).toMatchObject({ line: "", stream: "stdout" });
      expect(lines.slice(gap + 1).map((line) => line.line)).toEqual(["the present"]);
      expect(seen).toHaveLength(2);
      expect(seen[1]?.since).toBeGreaterThan(Date.now() / 1000 - 10);
      expect(seen[1]?.tail).toBe(200);
    });

    it("keeps the marks in order for whoever joins later", async () => {
      const seen: LogOptions[] = [];
      const output = channel();
      const feed = open(backlog(seen), output, { limits: { batchLines: 20 }, timing: CATCHING_UP });

      await until(() => linesOf(output.events).some((line) => line.line === "the present"));

      const [snapshot] = feed.replay();
      const replayed = snapshot?.kind === "snapshot" ? snapshot.lines : [];
      const seqs = replayed.map((line) => line.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(replayed.some((line) => line.gap === true)).toBe(true);
    });

    it("does not count old history as falling behind", async () => {
      const seen: LogOptions[] = [];
      const output = channel();
      open(backlog(seen, { history: true }), output, { limits: { batchLines: 20 }, timing: CATCHING_UP });

      await until(() => linesOf(output.events).length > 400);

      expect(linesOf(output.events).some((line) => line.gap === true)).toBe(false);
      expect(seen).toHaveLength(1);
    });

    it("keeps reading a fast stream that it is keeping up with", async () => {
      const seen: LogOptions[] = [];
      const docker = scriptedDriver(async function* (requested) {
        seen.push(requested);
        for (let index = 0; index < 400; index += 1) {
          yield { stream: "stdout", line: `live ${index}`, timestamp: new Date().toISOString() };
          if (index % 20 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        await new Promise(() => {});
      });
      const output = channel();
      open(docker, output, { limits: { batchLines: 20 }, timing: CATCHING_UP });

      await until(() => linesOf(output.events).length === 400);

      expect(linesOf(output.events).some((line) => line.gap === true)).toBe(false);
      expect(seen).toHaveLength(1);
    });
  });

  it("says how far back it reads and how much it keeps", async () => {
    const docker = await runningDriver();
    const feed = open(docker, channel(), { limits: { ringLines: 50 } });

    expect(feed.replay()[0]).toMatchObject({ kind: "snapshot", tailLines: 200, ringLines: 50 });
  });

  it("keeps identifiable lines of two services apart, live and in search", async () => {
    const docker = await runningDriver();
    await docker.createService(spec("shop_api"));
    docker.advance(8);
    const web = channel();
    const api = channel();
    open(docker, web, { name: "shop_web" });
    open(docker, api, { name: "shop_api" });
    await until(() => states(web.events).includes("streaming") && states(api.events).includes("streaming"));

    docker.writeLog("shop_web", "marker from web");
    docker.writeLog("shop_api", "marker from api");

    await until(() => linesOf(web.events).some((line) => line.line === "marker from web"));
    await until(() => linesOf(api.events).some((line) => line.line === "marker from api"));
    const printedBy = (output: ReturnType<typeof channel>) =>
      linesOf(output.events)
        .map((line) => line.line)
        .filter((line) => line.startsWith("marker"));
    expect(printedBy(web)).toEqual(["marker from web"]);
    expect(printedBy(api)).toEqual(["marker from api"]);

    const search = (serviceName: string) =>
      searchServiceLogs(
        { docker, now: () => Date.now() },
        { projectName: "shop", serviceName },
        { q: "marker", stream: "all", level: "any", limit: 500 },
      );
    expect((await search("web")).lines.map((line) => line.line)).toEqual(["marker from web"]);
    expect((await search("api")).lines.map((line) => line.line)).toEqual(["marker from api"]);
  });

  it("reports an error when Docker fails, and recovers by itself", async () => {
    const docker = await runningDriver();
    docker.failNext("inspectService");
    const output = channel();
    open(docker, output);

    await until(() => states(output.events).includes("error"));
    await until(() => states(output.events).includes("streaming"));
  });
});

describe("secrets in a service's logs", () => {
  const SECRET = "correct-horse-battery-staple";
  const redactor = () => new Redactor().addSecret(SECRET);
  const text = (output: ReturnType<typeof channel>) =>
    linesOf(output.events)
      .map((line) => line.line)
      .join("\n");

  it("are removed from what subscribers get, and from what a late one catches up on", async () => {
    const docker = await runningDriver();
    const output = channel();
    const feed = open(docker, output, { redactor });
    await until(() => states(output.events).includes("streaming"));

    docker.writeLog("shop_web", `connecting with ${SECRET} now`);
    await until(() => text(output).includes("connecting with"));

    expect(text(output)).toContain("connecting with [redacted] now");
    expect(text(output)).not.toContain(SECRET);
    expect(JSON.stringify(feed.replay())).not.toContain(SECRET);
  });

  it("are removed from a line too long to keep whole, before it is cut", async () => {
    const docker = await runningDriver();
    const output = channel();
    open(docker, output, { redactor });
    await until(() => states(output.events).includes("streaming"));

    docker.writeLog("shop_web", `${"x".repeat(16 * 1024 - 8)}${SECRET}${"y".repeat(100)}`);
    await until(() => text(output).includes("xxxx"));

    expect(text(output)).not.toContain("correct-");
  });

  it("are put back together when Docker delivers a line in pieces", async () => {
    const docker = scriptedDriver(async function* () {
      yield { stream: "stdout", line: "first piece correct-horse-", timestamp: "2026-01-01T00:00:01.1Z" };
      yield { stream: "stdout", line: "battery-staple second piece", timestamp: "2026-01-01T00:00:01.2Z" };
      await new Promise(() => {});
    });
    const output = channel();
    open(docker, output, { redactor });

    await until(() => linesOf(output.events).length === 2);

    expect(text(output)).not.toContain("correct-");
    expect(text(output)).not.toContain("battery-staple");
    expect(text(output)).toBe("first piece [redacted]\n[redacted] second piece");
  });

  it("stay removed from a high volume of output, without slowing it down to a stop", async () => {
    const docker = await runningDriver();
    const output = channel();
    open(docker, output, { redactor });
    await until(() => states(output.events).includes("streaming"));

    for (let line = 0; line < 4000; line += 1) {
      docker.writeLog("shop_web", `line ${line} of the flood with ${SECRET} in it`);
    }

    await until(() => linesOf(output.events).length >= 100);
    expect(text(output)).not.toContain(SECRET);
  });

  it("stay removed after the follow drops and starts again", async () => {
    let follows = 0;
    const docker = scriptedDriver(async function* () {
      follows += 1;
      yield {
        stream: "stdout",
        line: `follow ${follows} ${SECRET}`,
        timestamp: `2026-01-01T00:00:0${follows}Z`,
      };
      if (follows > 1) {
        await new Promise(() => {});
      }
    });
    const output = channel();
    open(docker, output, { redactor });

    await until(() => linesOf(output.events).length === 2);

    expect(text(output)).toBe("follow 1 [redacted]\nfollow 2 [redacted]");
  });

  it("are asked about again as the service changes, with what its container was started with", async () => {
    const docker = await runningDriver();
    const output = channel();
    const seen: Array<readonly string[]> = [];
    let current = new Redactor();
    open(docker, output, {
      redactor: (applied) => {
        seen.push(applied);
        return current;
      },
    });
    await until(() => states(output.events).includes("streaming"));

    current = new Redactor().addSecret("rotated-in-meanwhile");
    const asked = seen.length;
    await until(() => seen.length > asked);
    docker.writeLog("shop_web", "now rotated-in-meanwhile");
    await until(() => text(output).includes("now "));

    expect(text(output)).toContain("now [redacted]");
    expect(seen.at(-1)).toEqual([]);
  });

  it("are removed from a search, whichever way they were printed", async () => {
    const docker = scriptedDriver(async function* () {
      yield { stream: "stdout", line: `whole ${SECRET}` };
      yield { stream: "stdout", line: "split correct-horse-" };
      yield { stream: "stdout", line: "battery-staple tail" };
    });

    const result = await searchServiceLogs(
      {
        docker,
        now: () => 1_700_000_000_000,
      },
      { projectName: "shop", serviceName: "web" },
      { q: "", stream: "all", level: "any", limit: 500 },
    );
    // With no panel behind it there is nothing to know about, and the function is still usable.
    expect(result.lines).toHaveLength(3);

    const entries = redactLogEntries(redactor(), [
      { stream: "stdout", line: `whole ${SECRET}` },
      { stream: "stdout", line: "split correct-horse-" },
      { stream: "stderr", line: "another stream" },
      { stream: "stdout", line: "battery-staple tail" },
    ]);
    expect(entries.map((entry) => entry.line)).toEqual([
      "whole [redacted]",
      "split [redacted]",
      "another stream",
      "[redacted] tail",
    ]);
  });
});

describe("searching logs", () => {
  async function driverWith(...lines: LogLine[]): Promise<DockerDriver> {
    return scriptedDriver(async function* () {
      yield* lines;
    });
  }

  const query = (overrides = {}) => ({
    q: "",
    stream: "all" as const,
    level: "any" as const,
    limit: 500,
    ...overrides,
  });
  const search = async (docker: DockerDriver, overrides = {}) =>
    searchServiceLogs(
      { docker, now: () => 1_700_000_000_000 },
      { projectName: "shop", serviceName: "web" },
      query(overrides),
    );

  it("finds text regardless of case", async () => {
    const docker = await driverWith(
      { stream: "stdout", line: "Payment accepted" },
      { stream: "stdout", line: "cart emptied" },
    );

    expect((await search(docker, { q: "PAYMENT" })).lines.map((line) => line.line)).toEqual([
      "Payment accepted",
    ]);
  });

  it("filters by stream", async () => {
    const docker = await driverWith({ stream: "stdout", line: "out" }, { stream: "stderr", line: "err" });

    expect((await search(docker, { stream: "stderr" })).lines.map((line) => line.line)).toEqual(["err"]);
  });

  it("filters by level", async () => {
    const docker = await driverWith(
      { stream: "stdout", line: "2026 ERROR: connection refused" },
      { stream: "stdout", line: 'level=info msg="started"' },
      { stream: "stdout", line: "plain line" },
    );

    expect((await search(docker, { level: "error" })).lines.map((line) => line.line)).toEqual([
      "2026 ERROR: connection refused",
    ]);
  });

  it("keeps the newest matches up to the limit and says it had more", async () => {
    const docker = await driverWith(
      { stream: "stdout", line: "a", timestamp: "2026-01-01T00:00:01Z" },
      { stream: "stdout", line: "b", timestamp: "2026-01-01T00:00:02Z" },
      { stream: "stdout", line: "c", timestamp: "2026-01-01T00:00:03Z" },
    );

    const result = await search(docker, { limit: 2 });

    expect(result.lines.map((line) => line.line)).toEqual(["b", "c"]);
    expect(result).toMatchObject({ scanned: 3, truncated: true });
  });

  it("stops reading at a fixed number of lines", async () => {
    const docker = scriptedDriver(async function* () {
      for (;;) {
        yield { stream: "stdout", line: "again" };
      }
    });

    const result = await search(docker);

    expect(result.scanned).toBe(50_000);
    expect(result.truncated).toBe(true);
  });

  it("asks Docker for the right period", async () => {
    let seen: LogOptions | undefined;
    const docker = scriptedDriver(async function* (options) {
      seen = options;
      yield* [];
    });

    await search(docker, { since: 3600 });

    expect(seen?.since).toBe(1_700_000_000 - 3600);
    expect(seen?.follow).toBeUndefined();
  });

  it("answers nothing for a service that was never deployed", async () => {
    const docker = new FakeDriver({ tickMs: 1 });

    expect((await search(docker)).lines).toEqual([]);
  });

  it.each([
    ["2026-01-01 ERROR something", "error"],
    ['{"level":"warn","msg":"x"}', "warn"],
    ["INFO warning follows", "info"],
    ["DEBUG detail", "debug"],
    ["nothing here", "any"],
  ])("reads the level of %j as %s", (line, level) => {
    expect(detectLevel(line)).toBe(level);
  });
});
