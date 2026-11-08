import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionEntry, ActionStreamEvent } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db";
import { actions } from "../db/schema";
import { AppError } from "../errors";
import {
  type ActionContext,
  ActionEngine,
  type ActionRun,
  MAX_GLOBAL_CONCURRENCY,
  RETAINED_ACTIONS,
} from "./index";

const logger = pino({ level: "silent" });

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(rounds = 10) {
  for (let round = 0; round < rounds; round += 1) {
    await tick();
  }
}

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

let directory: string;
let database: ReturnType<typeof openDatabase>;
let published: Array<{ topic: string; payload: unknown }>;
let engine: ActionEngine;

function createEngine() {
  return new ActionEngine({
    db: database.db,
    actionsDir: join(directory, "actions"),
    publisher: { publish: (topic, payload) => published.push({ topic, payload }) },
    logger,
  });
}

function statusOf(id: string) {
  return database.db.select().from(actions).where(eq(actions.id, id)).get();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-actions-"));
  database = openDatabase(join(directory, "test.db"));
  published = [];
  engine = createEngine();
});

afterEach(async () => {
  await engine.stop(50);
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

const service = { type: "deploy", projectName: "shop", serviceName: "web" };

describe("enqueue", () => {
  it("returns the queued row before any work starts", async () => {
    let started = false;
    const row = engine.enqueue({
      ...service,
      title: "Deploy web",
      run: () => {
        started = true;
      },
    });

    expect(row.status).toBe("queued");
    expect(row.id).toBeTruthy();
    expect(started).toBe(false);
    expect(statusOf(row.id)?.status).toBe("queued");

    await until(() => statusOf(row.id)?.status === "succeeded");
    expect(started).toBe(true);
  });

  it("records the timestamps and the outcome", async () => {
    const row = engine.enqueue({ ...service, title: "Deploy", run: async () => {} });
    await until(() => statusOf(row.id)?.status === "succeeded");

    const finished = statusOf(row.id);
    expect(finished?.startedAt).toBeInstanceOf(Date);
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    expect(finished?.error).toBeNull();
  });

  it("marks a throwing run as failed and keeps the reason", async () => {
    const failing = engine.enqueue({
      ...service,
      title: "Deploy",
      run: async () => {
        throw new Error("image not found");
      },
    });
    await until(() => statusOf(failing.id)?.status === "failed");
    expect(statusOf(failing.id)?.error).toBe("image not found");

    const synchronous = engine.enqueue({
      ...service,
      title: "Deploy",
      run: () => {
        throw new Error("sync failure");
      },
    });
    await until(() => statusOf(synchronous.id)?.status === "failed");
    expect(statusOf(synchronous.id)?.error).toBe("sync failure");
  });

  it("requires a project for a service, and valid names", () => {
    expect(() => engine.enqueue({ type: "x", title: "t", serviceName: "web", run: () => {} })).toThrow(
      TypeError,
    );
    expect(() =>
      engine.enqueue({ type: "x", title: "t", projectName: "../etc", serviceName: "web", run: () => {} }),
    ).toThrow();
  });
});

describe("per-service scheduling", () => {
  it("runs one action per service at a time, in FIFO order", async () => {
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const running = new Set<number>();
    let peak = 0;

    const rows = gates.map((gate, index) =>
      engine.enqueue({
        ...service,
        title: `step ${index}`,
        run: async () => {
          order.push(`start ${index}`);
          running.add(index);
          peak = Math.max(peak, running.size);
          await gate.promise;
          running.delete(index);
          order.push(`end ${index}`);
        },
      }),
    );

    await until(() => order.includes("start 0"));
    await settle();
    expect(order).toEqual(["start 0"]);
    expect(statusOf(rows[1]?.id as string)?.status).toBe("queued");

    gates[0]?.resolve();
    await until(() => order.includes("start 1"));
    await settle();
    expect(statusOf(rows[2]?.id as string)?.status).toBe("queued");

    gates[1]?.resolve();
    await until(() => order.includes("start 2"));
    gates[2]?.resolve();
    await until(() => statusOf(rows[2]?.id as string)?.status === "succeeded");

    expect(order).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
    expect(peak).toBe(1);
  });

  it("does not let different services block each other", async () => {
    const gate = deferred();
    let otherRan = false;
    engine.enqueue({ ...service, title: "slow", run: () => gate.promise });
    const other = engine.enqueue({
      ...service,
      serviceName: "api",
      title: "other",
      run: () => {
        otherRan = true;
      },
    });

    await until(() => statusOf(other.id)?.status === "succeeded");
    expect(otherRan).toBe(true);
    gate.resolve();
  });

  it("keeps same-named services in different projects apart", async () => {
    const gate = deferred();
    engine.enqueue({ ...service, title: "slow", run: () => gate.promise });
    const other = engine.enqueue({ ...service, projectName: "blog", title: "other", run: () => {} });

    await until(() => statusOf(other.id)?.status === "succeeded");
    gate.resolve();
  });

  it("releases the service after a failure", async () => {
    const failing = engine.enqueue({
      ...service,
      title: "bad",
      run: () => {
        throw new Error("boom");
      },
    });
    const next = engine.enqueue({ ...service, title: "next", run: () => {} });

    await until(() => statusOf(next.id)?.status === "succeeded");
    expect(statusOf(failing.id)?.status).toBe("failed");
  });
});

describe("service-less actions", () => {
  it("run concurrently up to the limit, and the rest wait in order", async () => {
    const total = MAX_GLOBAL_CONCURRENCY + 2;
    const gates = Array.from({ length: total }, () => deferred());
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    gates.forEach((gate, index) => {
      engine.enqueue({
        type: "cleanup",
        title: `job ${index}`,
        run: async () => {
          started.push(index);
          running += 1;
          peak = Math.max(peak, running);
          await gate.promise;
          running -= 1;
        },
      });
    });

    await until(() => started.length === MAX_GLOBAL_CONCURRENCY);
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[0]?.resolve();
    await until(() => started.length === MAX_GLOBAL_CONCURRENCY + 1);
    gates.forEach((gate) => {
      gate.resolve();
    });
    await until(() => started.length === total);
    expect(peak).toBe(MAX_GLOBAL_CONCURRENCY);
  });

  it("are not held back by service actions", async () => {
    const gate = deferred();
    engine.enqueue({ ...service, title: "slow", run: () => gate.promise });
    const free = engine.enqueue({ type: "cleanup", title: "fast", run: () => {} });

    await until(() => statusOf(free.id)?.status === "succeeded");
    gate.resolve();
  });
});

describe("cancellation", () => {
  it("cancels a queued action at once and never runs it", async () => {
    const gate = deferred();
    let ran = false;
    engine.enqueue({ ...service, title: "first", run: () => gate.promise });
    const queued = engine.enqueue({
      ...service,
      title: "second",
      run: () => {
        ran = true;
      },
    });

    expect(engine.cancel(queued.id).status).toBe("cancelled");
    expect(statusOf(queued.id)?.status).toBe("cancelled");

    gate.resolve();
    await settle();
    expect(ran).toBe(false);
  });

  it("aborts the signal of a running action and waits for it to stop", async () => {
    const entered = deferred();
    const release = deferred();
    let received: ActionContext | undefined;
    const row = engine.enqueue({
      ...service,
      title: "long",
      run: async (ctx) => {
        received = ctx;
        entered.resolve();
        await release.promise;
        ctx.signal.throwIfAborted();
      },
    });
    await entered.promise;

    const returned = engine.cancel(row.id);
    expect(returned.status).toBe("running");
    expect(received?.signal.aborted).toBe(true);
    await settle();
    expect(statusOf(row.id)?.status).toBe("running");

    release.resolve();
    await until(() => statusOf(row.id)?.status === "cancelled");
    expect(statusOf(row.id)?.error).toBeNull();
  });

  it("counts a run that returns quietly after an abort as cancelled", async () => {
    const entered = deferred();
    const row = engine.enqueue({
      ...service,
      title: "polite",
      run: async (ctx) => {
        entered.resolve();
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
    });
    await entered.promise;
    engine.cancel(row.id);
    await until(() => statusOf(row.id)?.status === "cancelled");
  });

  it("lets the next action in the queue start afterwards", async () => {
    const entered = deferred();
    const running = engine.enqueue({
      ...service,
      title: "cancelled",
      run: async (ctx) => {
        entered.resolve();
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
    });
    const next = engine.enqueue({ ...service, title: "next", run: () => {} });
    await entered.promise;

    engine.cancel(running.id);
    await until(() => statusOf(next.id)?.status === "succeeded");
  });

  it("is idempotent while stopping", async () => {
    const entered = deferred();
    const release = deferred();
    const row = engine.enqueue({
      ...service,
      title: "long",
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    engine.cancel(row.id);
    expect(() => engine.cancel(row.id)).not.toThrow();
    release.resolve();
    await until(() => statusOf(row.id)?.status === "cancelled");
  });

  it("refuses to cancel what has finished, and reports what does not exist", async () => {
    const row = engine.enqueue({ ...service, title: "done", run: () => {} });
    await until(() => statusOf(row.id)?.status === "succeeded");

    expect(() => engine.cancel(row.id)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => engine.cancel("nope")).toThrow(AppError);
    expect(() => engine.cancel("nope")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("logging", () => {
  async function runToEnd(run: ActionRun) {
    const row = engine.enqueue({ ...service, title: "with log", run });
    await until(() => {
      const status = statusOf(row.id)?.status;
      return status !== "queued" && status !== "running";
    });
    return row;
  }

  it("appends output to a private file named after the action", async () => {
    const row = await runToEnd((ctx) => {
      ctx.log("first line");
      ctx.log("second line");
    });

    const file = join(directory, "actions", `${row.id}.log`);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("first line\nsecond line\n");
    expect(text).toMatch(/Started: with log/);
    expect(text).toMatch(/Succeeded/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statusOf(row.id)?.hasLog).toBe(true);
  });

  it("splits multi-line output into lines", async () => {
    const row = await runToEnd((ctx) => ctx.log("a\nb\r\nc\n"));
    const view = await engine.readLog(statusOf(row.id) as NonNullable<ReturnType<typeof statusOf>>);
    expect(view.log).toContain("a\nb\nc\n");
  });

  it("streams lines and status changes to the action's topic", async () => {
    const row = await runToEnd((ctx) => ctx.log("hello"));
    const events = published
      .filter((event) => event.topic === `action:${row.id}`)
      .map((e) => e.payload as ActionStreamEvent);

    const lines = events.filter((event) => event.kind === "log").map((event) => event.line);
    expect(lines).toContain("hello");
    const seqs = events.filter((event) => event.kind === "log").map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));

    const statuses = events.filter((event) => event.kind === "status").map((event) => event.action.status);
    expect(statuses).toEqual(["queued", "running", "succeeded"]);
  });

  it("announces changes on the global topic for the Activity page", async () => {
    const row = await runToEnd(() => {});
    const statuses = published
      .filter((event) => event.topic === "actions" && (event.payload as ActionEntry).id === row.id)
      .map((event) => (event.payload as ActionEntry).status);
    expect(statuses).toEqual(["queued", "running", "succeeded"]);
  });

  it("does not let a late log call reopen a finished action", async () => {
    let captured: ActionContext | undefined;
    const row = await runToEnd((ctx) => {
      captured = ctx;
    });
    const before = readFileSync(join(directory, "actions", `${row.id}.log`), "utf8");
    captured?.log("too late");
    await settle();
    expect(readFileSync(join(directory, "actions", `${row.id}.log`), "utf8")).toBe(before);
  });

  it("stops writing at the size limit, and says so", async () => {
    await engine.stop(0);
    engine = new ActionEngine({
      db: database.db,
      actionsDir: join(directory, "actions"),
      publisher: { publish: () => {} },
      logger,
      maxLogBytes: 200,
    });
    const row = engine.enqueue({
      ...service,
      title: "noisy",
      run: (ctx) => {
        for (let index = 0; index < 500; index += 1) {
          ctx.log(`line ${index}`);
        }
      },
    });
    await until(() => statusOf(row.id)?.status === "succeeded");

    const finished = statusOf(row.id);
    expect(finished?.logTruncated).toBe(true);
    const view = await engine.readLog(finished as NonNullable<typeof finished>);
    expect(view.logTruncated).toBe(true);
    expect(view.log).toContain("size limit");
    expect(view.log).not.toContain("line 499");
  });

  it("returns only what is on disk while running, and which lines that covers", async () => {
    const release = deferred();
    const row = engine.enqueue({
      ...service,
      title: "live",
      run: async (ctx) => {
        ctx.log("visible while running");
        await release.promise;
      },
    });
    await until(() => (engine as unknown as { running: Map<string, unknown> }).running.has(row.id));
    await until(() => readFileSync(join(directory, "actions", `${row.id}.log`), "utf8").includes("visible"));
    await settle();

    const view = await engine.readLog(statusOf(row.id) as NonNullable<ReturnType<typeof statusOf>>);
    expect(view.log).toContain("visible while running");
    expect(view.logSeq).toBe(view.log.trimEnd().split("\n").length);
    release.resolve();
  });

  it("returns an empty log for an action with no file", async () => {
    const row = engine.record({ type: "auth.login", title: "Signed in" });
    expect(await engine.readLog(row)).toEqual({ log: "", logTruncated: false, logSeq: 0 });
  });
});

describe("record", () => {
  it("adds a finished entry with no log and no queueing", () => {
    const row = engine.record({ type: "auth.login", title: "Signed in", actorEmail: "a@example.com" });
    expect(row).toMatchObject({ status: "succeeded", hasLog: false, actorEmail: "a@example.com" });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(existsSync(join(directory, "actions", `${row.id}.log`))).toBe(false);
  });
});

describe("recovery at boot", () => {
  it("fails whatever was in flight, with the reason, and leaves finished work alone", async () => {
    const hang = deferred();
    const running = engine.enqueue({ ...service, title: "interrupted", run: () => hang.promise });
    const queued = engine.enqueue({ ...service, title: "never started", run: () => {} });
    const finished = engine.enqueue({ ...service, serviceName: "api", title: "done", run: () => {} });
    await until(
      () => statusOf(running.id)?.status === "running" && statusOf(finished.id)?.status === "succeeded",
    );

    // A new process: the old engine and its closures are gone.
    const rebooted = createEngine();
    expect(rebooted.recover()).toBe(2);

    expect(statusOf(running.id)).toMatchObject({
      status: "failed",
      error: "The panel restarted while this action was running.",
    });
    expect(statusOf(running.id)?.finishedAt).toBeInstanceOf(Date);
    expect(statusOf(queued.id)).toMatchObject({
      status: "failed",
      error: "The panel restarted before this action could start.",
    });
    expect(statusOf(finished.id)?.status).toBe("succeeded");

    const log = readFileSync(join(directory, "actions", `${running.id}.log`), "utf8");
    expect(log).toMatch(/Failed: The panel restarted/);
    hang.resolve();
  });

  it("does nothing when nothing was interrupted", () => {
    expect(createEngine().recover()).toBe(0);
  });
});

describe("retention", () => {
  const HOUR = 60 * 60 * 1000;

  /** Adds finished rows directly, oldest first, each with a log file on disk. */
  function addFinished(count: number, status: "succeeded" | "failed" | "cancelled" = "succeeded"): string[] {
    const ids = Array.from({ length: count }, (_, index) => `old-${status}-${index}-${Math.random()}`);
    database.db.transaction((tx) => {
      for (const id of ids) {
        tx.insert(actions)
          .values({ id, type: "deploy", title: "t", status, hasLog: true, createdAt: new Date(0) })
          .run();
      }
    });
    for (const id of ids) {
      writeFileSync(logFile(id), "output\n");
    }
    return ids;
  }

  function addUnfinished(status: "queued" | "running"): string {
    const id = `old-${status}-${Math.random()}`;
    database.db
      .insert(actions)
      .values({ id, type: "deploy", title: "t", status, createdAt: new Date(0) })
      .run();
    return id;
  }

  const logFile = (id: string) => join(directory, "actions", `${id}.log`);
  const rowCount = () => database.db.select({ id: actions.id }).from(actions).all().length;

  it("keeps the most recent 1,000 and removes older rows with their log files", async () => {
    expect(RETAINED_ACTIONS).toBe(1000);
    const oldest = addFinished(3);
    const kept = addFinished(RETAINED_ACTIONS);

    expect(await engine.prune()).toBe(3);

    expect(rowCount()).toBe(RETAINED_ACTIONS);
    for (const id of oldest) {
      expect(statusOf(id)).toBeUndefined();
      expect(existsSync(logFile(id))).toBe(false);
    }
    expect(statusOf(kept[0] as string)).toBeDefined();
    expect(existsSync(logFile(kept[0] as string))).toBe(true);
  });

  it("removes every finished status alike", async () => {
    const old = [...addFinished(1, "failed"), ...addFinished(1, "cancelled")];
    addFinished(RETAINED_ACTIONS);

    await engine.prune();

    expect(old.map(statusOf)).toEqual([undefined, undefined]);
  });

  it("leaves everything alone at the limit", async () => {
    addFinished(RETAINED_ACTIONS);
    expect(await engine.prune()).toBe(0);
    expect(rowCount()).toBe(RETAINED_ACTIONS);
  });

  it("never touches a queued or running action, however old", async () => {
    const queued = addUnfinished("queued");
    const running = addUnfinished("running");
    const finished = addFinished(1);
    addFinished(RETAINED_ACTIONS);

    expect(await engine.prune()).toBe(1);

    expect(statusOf(queued)?.status).toBe("queued");
    expect(statusOf(running)?.status).toBe("running");
    expect(statusOf(finished[0] as string)).toBeUndefined();
  });

  it("copes with a row whose log file is already gone", async () => {
    const [missing] = addFinished(1);
    rmSync(logFile(missing as string));
    addFinished(RETAINED_ACTIONS);
    await expect(engine.prune()).resolves.toBe(1);
  });

  it("prunes when started, then every hour, until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const atBoot = addFinished(1);
      addFinished(RETAINED_ACTIONS);
      await engine.startRetention();
      expect(statusOf(atBoot[0] as string)).toBeUndefined();

      addFinished(2);
      vi.advanceTimersByTime(HOUR);
      await until(() => rowCount() === RETAINED_ACTIONS);

      await engine.stop(0);
      addFinished(2);
      vi.advanceTimersByTime(HOUR * 2);
      await settle();
      expect(rowCount()).toBe(RETAINED_ACTIONS + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shutdown", () => {
  it("fails queued work, aborts running work and waits for it", async () => {
    const entered = deferred();
    const running = engine.enqueue({
      ...service,
      title: "running",
      run: async (ctx) => {
        entered.resolve();
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      },
    });
    const queued = engine.enqueue({ ...service, title: "queued", run: () => {} });
    await entered.promise;

    await engine.stop(1000);

    expect(statusOf(running.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("shut down"),
    });
    expect(statusOf(queued.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("shut down"),
    });
  });

  it("refuses new work once stopping", async () => {
    await engine.stop(10);
    expect(() => engine.enqueue({ ...service, title: "late", run: () => {} })).toThrow(
      expect.objectContaining({ status: 503 }),
    );
  });

  it("gives up waiting after the timeout", async () => {
    const entered = deferred();
    const row = engine.enqueue({
      ...service,
      title: "stuck",
      run: async () => {
        entered.resolve();
        await new Promise(() => {});
      },
    });
    await entered.promise;

    await engine.stop(5);
    expect(statusOf(row.id)?.status).toBe("running");
  });
});
