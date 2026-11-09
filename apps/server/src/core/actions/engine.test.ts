import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActionEntry, type ActionStreamEvent, actionsTopic, deployActionType } from "@opsifier/contract";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, StorageHealth } from "../db";
import { actions } from "../db/schema";
import { AppError } from "../errors";
import {
  type ActionContext,
  ActionEngine,
  type ActionRow,
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
let storage: StorageHealth;
let engine: ActionEngine;

function createEngine() {
  return new ActionEngine({
    db: database.db,
    actionsDir: join(directory, "actions"),
    publisher: { publish: (topic, payload) => published.push({ topic, payload }) },
    logger,
    storage,
  });
}

function statusOf(id: string) {
  return database.db.select().from(actions).where(eq(actions.id, id)).get();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-actions-"));
  database = openDatabase(join(directory, "test.db"));
  storage = new StorageHealth({ client: database.db.$client, dataDir: directory, logger });
  published = [];
  engine = createEngine();
});

afterEach(async () => {
  await engine.stop(50);
  storage.stop();
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

describe("deployments that overlap", () => {
  const deploy = { ...service, type: deployActionType, title: "Deploy" };

  it("queues a deployment behind the running one", async () => {
    const gate = deferred();
    const running = engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await until(() => statusOf(running.id)?.status === "running");

    const next = engine.enqueue({ ...deploy, run: () => {}, join: (waiting) => waiting });

    expect(next.id).not.toBe(running.id);
    expect(next.status).toBe("queued");
    gate.resolve();
    await until(() => statusOf(next.id)?.status === "succeeded");
  });

  it("joins a further request to the deployment already waiting, and deploys once", async () => {
    const gate = deferred();
    let deployed = 0;
    engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await settle();

    const run = () => {
      deployed += 1;
    };
    const first = engine.enqueue({ ...deploy, run, join: (waiting) => waiting });
    const second = engine.enqueue({ ...deploy, run, join: (waiting) => waiting });
    const third = engine.enqueue({ ...deploy, run, join: (waiting) => waiting });

    expect([second.id, third.id]).toEqual([first.id, first.id]);
    expect(database.db.select().from(actions).all()).toHaveLength(2);

    gate.resolve();
    await until(() => statusOf(first.id)?.status === "succeeded");
    await settle();
    expect(deployed).toBe(1);
    expect((await engine.readLog(statusOf(first.id) as never)).log).toContain("Also covers 2 later requests");
  });

  it("lets a joining request change what the waiting deployment does", async () => {
    const gate = deferred();
    const ran: string[] = [];
    engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await settle();
    const plain = () => {
      ran.push("plain");
    };
    const forced = () => {
      ran.push("forced");
    };

    const waiting = engine.enqueue({ ...deploy, run: plain, join: (current) => current });
    engine.enqueue({ ...deploy, run: forced, join: () => forced });
    engine.enqueue({ ...deploy, run: plain, join: (current) => current });

    gate.resolve();
    await until(() => statusOf(waiting.id)?.status === "succeeded");
    expect(ran).toEqual(["forced"]);
  });

  it("starts a new deployment once the waiting one has left the queue", async () => {
    const gate = deferred();
    engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await settle();
    const waiting = engine.enqueue({ ...deploy, run: () => {}, join: (current) => current });
    engine.cancel(waiting.id);

    const next = engine.enqueue({ ...deploy, run: () => {}, join: (current) => current });

    expect(next.id).not.toBe(waiting.id);
    gate.resolve();
    await until(() => statusOf(next.id)?.status === "succeeded");
  });

  it("does not join work on another service, or work of another type", async () => {
    const gate = deferred();
    engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await settle();
    const waiting = engine.enqueue({ ...deploy, run: () => {}, join: (current) => current });

    const elsewhere = engine.enqueue({
      ...deploy,
      serviceName: "api",
      run: () => {},
      join: (current) => current,
    });
    const opaque = engine.enqueue({ ...deploy, run: () => {} });
    const other = engine.enqueue({ ...service, type: "backup", title: "Backup", run: () => {} });

    expect(new Set([waiting.id, elsewhere.id, opaque.id, other.id]).size).toBe(4);
    gate.resolve();
    await until(() => statusOf(other.id)?.status === "succeeded");
  });

  it("does not join a deployment that has already started", async () => {
    const gate = deferred();
    const started = engine.enqueue({ ...deploy, run: () => gate.promise, join: (waiting) => waiting });
    await until(() => statusOf(started.id)?.status === "running");

    const next = engine.enqueue({ ...deploy, run: () => {}, join: (waiting) => waiting });

    expect(next.id).not.toBe(started.id);
    gate.resolve();
    await until(() => statusOf(next.id)?.status === "succeeded");
  });
});

function refusalOf(attempt: () => unknown): AppError {
  try {
    attempt();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a refusal");
}

describe("operations that cannot follow", () => {
  const request = (type: string) => ({ ...service, type, title: type, run: () => {} });
  const deploy = request(deployActionType);

  describe.each([
    ["running", 0],
    ["queued", 1],
  ])("while an Action is %s on the service", (_state, ahead) => {
    let gate: Deferred;

    beforeEach(async () => {
      gate = deferred();
      for (let index = 0; index <= ahead; index += 1) {
        engine.enqueue({ ...service, type: "backup", title: `Backup ${index}`, run: () => gate.promise });
      }
      await settle();
    });

    afterEach(() => {
      gate.resolve();
    });

    it.each([
      ["service.destroy", /Cannot destroy shop\/web while "Backup 0" is in progress/],
      ["service.rename", /Cannot rename or move shop\/web while "Backup 0" is in progress/],
    ])("refuses %s with 409 and an explicit message", (type, message) => {
      const refused = refusalOf(() => engine.enqueue(request(type)));

      expect(refused.status).toBe(409);
      expect(refused.code).toBe("service_busy");
      expect(refused.message).toMatch(message);
    });

    it("leaves no trace of a refused request", () => {
      refusalOf(() => engine.enqueue(request("service.destroy")));

      expect(database.db.select().from(actions).all()).toHaveLength(ahead + 1);
    });

    it("still allows it on another service", async () => {
      const elsewhere = engine.enqueue({ ...request("service.destroy"), serviceName: "api" });
      await until(() => statusOf(elsewhere.id)?.status === "succeeded");
    });
  });

  describe.each([
    ["running", 0],
    ["queued", 1],
  ])("while a deployment is %s", (_state, ahead) => {
    let gate: Deferred;

    beforeEach(async () => {
      gate = deferred();
      engine.enqueue({ ...service, type: "backup", title: "Backup", run: () => gate.promise });
      if (ahead === 0) {
        gate.resolve();
        await settle();
        gate = deferred();
      }
      engine.enqueue({ ...deploy, run: () => gate.promise });
      await settle();
    });

    afterEach(() => {
      gate.resolve();
    });

    it.each([
      ["service.start", "start"],
      ["service.stop", "stop"],
      ["service.restart", "restart"],
    ])("refuses %s with 409 and an explicit message", (type, verb) => {
      const refused = refusalOf(() => engine.enqueue(request(type)));

      expect(refused.status).toBe(409);
      expect(refused.code).toBe("deployment_in_progress");
      expect(refused.message).toBe(
        `Cannot ${verb} shop/web during a deployment. Wait for it to finish or cancel it, then try again.`,
      );
    });

    it("refuses to destroy too", () => {
      expect(refusalOf(() => engine.enqueue(request("service.destroy"))).code).toBe("service_busy");
    });

    it("queues another deployment", () => {
      expect(engine.enqueue(deploy).status).toBe("queued");
    });
  });

  it("queues start, stop and restart behind anything that is not a deployment", async () => {
    const gate = deferred();
    engine.enqueue({ ...service, type: "backup", title: "Backup", run: () => gate.promise });
    await settle();

    const restart = engine.enqueue(request("service.restart"));

    expect(restart.status).toBe("queued");
    gate.resolve();
    await until(() => statusOf(restart.id)?.status === "succeeded");
  });

  it.each([
    ["service.destroy", '"service.destroy" is in progress'],
    ["service.rename", '"service.rename" is in progress'],
  ])("takes nothing new on a service during %s", async (type, message) => {
    const gate = deferred();
    engine.enqueue({ ...request(type), run: () => gate.promise });
    await settle();

    for (const next of [deployActionType, "service.restart", "backup", "service.destroy"]) {
      const refused = refusalOf(() => engine.enqueue(request(next)));
      expect(refused.code).toBe("service_busy");
      expect(refused.message).toContain(message);
    }
    gate.resolve();
  });
});

describe("restarting the panel into another version", () => {
  const update = { type: "panel.update", title: "Update the panel" };

  it("waits for nothing: it is refused while anything else is active", async () => {
    const gate = deferred();
    engine.enqueue({ ...service, title: "Deploy shop/web", run: () => gate.promise });
    await settle();

    const refused = refusalOf(() => engine.enqueue({ ...update, run: () => {} }));

    expect(refused.status).toBe(409);
    expect(refused.code).toBe("panel_busy");
    expect(refused.message).toContain('"Deploy shop/web" is in progress');
    gate.resolve();
  });

  it("keeps everything else out while it runs", async () => {
    const gate = deferred();
    engine.enqueue({ ...update, run: () => gate.promise });
    await settle();

    expect(refusalOf(() => engine.enqueue({ ...service, title: "Deploy", run: () => {} })).code).toBe(
      "panel_updating",
    );
    expect(refusalOf(() => engine.enqueue({ type: "cleanup", title: "Clean", run: () => {} })).code).toBe(
      "panel_updating",
    );
    expect(refusalOf(() => engine.enqueue({ ...update, run: () => {} })).code).toBe("panel_updating");
    gate.resolve();
  });

  it("stays running after handing over, and keeps everything out until the process ends", async () => {
    const row = engine.enqueue({ ...update, run: (ctx) => ctx.handOver() });
    await until(() => (statusOf(row.id)?.hasLog ?? false) && engine.isIdle());
    await settle();

    expect(statusOf(row.id)?.status).toBe("running");
    expect(refusalOf(() => engine.enqueue({ ...service, title: "Deploy", run: () => {} })).code).toBe(
      "panel_restarting",
    );
  });

  it("fails normally if the run throws after handing over", async () => {
    const row = engine.enqueue({
      ...update,
      run: (ctx) => {
        ctx.handOver();
        throw new Error("Docker refused the update");
      },
    });

    await until(() => statusOf(row.id)?.status === "failed");

    expect(statusOf(row.id)?.error).toBe("Docker refused the update");
    expect(engine.enqueue({ ...service, title: "Deploy", run: () => {} }).status).toBe("queued");
  });

  it("leaves a claimed row out of recovery, and marks the rest failed", async () => {
    const claimed = engine.record({ type: "panel.update", title: "Update", status: "succeeded" });
    database.db.update(actions).set({ status: "running" }).where(eq(actions.id, claimed.id)).run();
    const other = engine.record({ type: "x", title: "Other", status: "succeeded" });
    database.db.update(actions).set({ status: "running" }).where(eq(actions.id, other.id)).run();

    const restarted = createEngine();
    restarted.claimInterrupted((row) => row.id === claimed.id);
    restarted.recover();

    expect(statusOf(claimed.id)?.status).toBe("running");
    expect(statusOf(other.id)?.status).toBe("failed");
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

  it("says in the log of every action when the driver is simulated", async () => {
    const real = await runToEnd(() => {});
    expect(readFileSync(join(directory, "actions", `${real.id}.log`), "utf8")).not.toMatch(/Simulated/);

    const simulated = new ActionEngine({
      db: database.db,
      actionsDir: join(directory, "actions"),
      publisher: { publish: () => {} },
      logger,
      storage,
      simulated: true,
    });
    const row = simulated.enqueue({ type: "t", title: "Deploy", run: () => {} });
    await vi.waitFor(() => expect(statusOf(row.id)?.status).toBe("succeeded"));

    expect(readFileSync(join(directory, "actions", `${row.id}.log`), "utf8")).toMatch(
      /Simulated: this panel runs on its simulated Docker driver/,
    );
  });

  it("records the step under way, tells the listeners, and keeps the last one on failure", async () => {
    const release = deferred();
    const row = engine.enqueue({
      ...service,
      title: "with phases",
      run: async (ctx) => {
        ctx.phase("rollout");
        await release.promise;
        throw new Error("no");
      },
    });

    await until(() => statusOf(row.id)?.phase === "rollout");
    const announced = published
      .filter((event) => event.topic === actionsTopic)
      .map((event) => (event.payload as ActionEntry).phase);
    expect(announced).toContain("rollout");

    release.resolve();
    await until(() => statusOf(row.id)?.status === "failed");
    expect(statusOf(row.id)?.phase).toBe("rollout");
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
      storage,
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
    const logFile = join(directory, "actions", `${row.id}.log`);
    await until(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes("visible"));
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

  it("does not call a deployment it finds running a failure: nothing says how it ended", async () => {
    const hang = deferred();
    const running = engine.enqueue({
      ...service,
      type: deployActionType,
      title: "Deploy",
      run: () => hang.promise,
    });
    const waiting = engine.enqueue({ ...service, type: deployActionType, title: "Next", run: () => {} });
    await until(() => statusOf(running.id)?.status === "running");

    createEngine().recover();

    expect(statusOf(running.id)).toMatchObject({ status: "uncertain" });
    expect(statusOf(running.id)?.error).toMatch(/record how this deployment ended/);
    expect(statusOf(running.id)?.finishedAt).toBeInstanceOf(Date);
    expect(statusOf(waiting.id)).toMatchObject({ status: "failed" });
    const log = readFileSync(join(directory, "actions", `${running.id}.log`), "utf8");
    expect(log).toMatch(/Outcome unknown:/);
    hang.resolve();
  });

  it("does nothing when nothing was interrupted", () => {
    expect(createEngine().recover()).toBe(0);
  });
});

describe("when the panel cannot write its state", () => {
  const client = () => database.db.$client;
  const refuseWrites = () => client().pragma("query_only = ON");
  const allowWrites = () => client().pragma("query_only = OFF");
  const deployment = { ...service, type: deployActionType };

  function statusEvent(id: string): ActionEntry | undefined {
    return published
      .filter((event) => event.topic === `action:${id}`)
      .map((event) => event.payload as ActionStreamEvent)
      .filter((event) => event.kind === "status")
      .at(-1)?.action;
  }

  /** Leaves no room in the database: the last page is full and it may not grow. */
  function fillDatabase() {
    const pages = client().pragma("page_count", { simple: true }) as number;
    client().pragma(`max_page_count = ${pages}`);
    expect(() => {
      for (;;) {
        client().exec(
          "INSERT INTO actions (id, type, title, status, created_at) VALUES (hex(randomblob(16)), 'x', 'x', 'failed', 0)",
        );
      }
    }).toThrow(/full/);
  }

  describe("recording how an Action ended", () => {
    it("is not left running: it reads as uncertain, and the real outcome lands once storage is fixed", async () => {
      const release = deferred();
      const finished: string[] = [];
      engine.onFinished((row) => finished.push(row.status));
      const row = engine.enqueue({ ...deployment, title: "Deploy", run: () => release.promise });
      await until(() => statusOf(row.id)?.status === "running");

      refuseWrites();
      release.resolve();
      await until(() => engine.isIdle());
      await settle();

      const stored = statusOf(row.id) as ActionRow;
      expect(stored.status).toBe("running");
      const read = engine.current(stored);
      expect(read.status).toBe("uncertain");
      expect(read.error).toMatch(/could not record how this ended/);
      expect(read.error).toMatch(/finished without an error/);
      expect(read.finishedAt).toBeInstanceOf(Date);
      expect(statusEvent(row.id)?.status).toBe("uncertain");
      expect(finished).toEqual([]);
      expect(storage.isFailing()).toBe(true);

      allowWrites();
      expect(storage.check()).toBe(true);

      expect(statusOf(row.id)).toMatchObject({ status: "succeeded", error: null });
      expect(engine.current(statusOf(row.id) as ActionRow).status).toBe("succeeded");
      expect(statusEvent(row.id)?.status).toBe("succeeded");
      expect(finished).toEqual(["succeeded"]);
      expect(readFileSync(join(directory, "actions", `${row.id}.log`), "utf8")).toMatch(/now recorded/);
    });

    it("keeps the reason of a failure through the wait", async () => {
      const release = deferred();
      const row = engine.enqueue({
        ...deployment,
        title: "Deploy",
        run: async () => {
          await release.promise;
          throw new Error("the image was not found");
        },
      });
      await until(() => statusOf(row.id)?.status === "running");

      refuseWrites();
      release.resolve();
      await until(() => engine.isIdle());
      expect(engine.current(statusOf(row.id) as ActionRow).error).toMatch(/the image was not found/);

      allowWrites();
      storage.check();

      expect(statusOf(row.id)).toMatchObject({ status: "failed", error: "the image was not found" });
    });

    it("lets go of the service, so what it held is not stuck", async () => {
      const release = deferred();
      const row = engine.enqueue({ ...deployment, title: "Deploy", run: () => release.promise });
      await until(() => statusOf(row.id)?.status === "running");

      refuseWrites();
      release.resolve();
      await until(() => engine.isIdle());
      allowWrites();
      storage.check();

      const next = engine.enqueue({ ...deployment, title: "Next", run: () => {} });
      await until(() => statusOf(next.id)?.status === "succeeded");
    });

    it("survives a full disk, and a restart finds it uncertain if it was never written", async () => {
      const release = deferred();
      const row = engine.enqueue({
        ...deployment,
        title: "Deploy",
        run: async () => {
          await release.promise;
          throw new Error("x".repeat(1900));
        },
      });
      await until(() => statusOf(row.id)?.status === "running");

      fillDatabase();
      release.resolve();
      await until(() => engine.isIdle());

      expect(storage.state()).toMatchObject({ writable: false, reason: "full" });
      expect(statusOf(row.id)?.status).toBe("running");
      expect(engine.current(statusOf(row.id) as ActionRow).status).toBe("uncertain");

      await engine.stop(0);
      client().pragma("max_page_count = 1073741823");
      engine = createEngine();
      expect(engine.recover()).toBe(1);

      expect(statusOf(row.id)).toMatchObject({ status: "uncertain" });
      expect(statusOf(row.id)?.error).toMatch(/record how this deployment ended/);
      expect(client().pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    });

    it("loses nothing to a second writer: one waits or fails loudly, and both end up recorded", async () => {
      const other = new Database(join(directory, "test.db"));
      client().pragma("busy_timeout = 1");
      const release = deferred();
      const row = engine.enqueue({ ...deployment, title: "Deploy", run: () => release.promise });
      await until(() => statusOf(row.id)?.status === "running");

      other.exec("BEGIN IMMEDIATE");
      other.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('other-writer', '1', 0)").run();
      release.resolve();
      await until(() => engine.isIdle());
      expect(storage.state()).toMatchObject({ writable: false, reason: "locked" });
      expect(engine.current(statusOf(row.id) as ActionRow).status).toBe("uncertain");

      other.exec("COMMIT");
      other.close();
      storage.check();

      expect(statusOf(row.id)?.status).toBe("succeeded");
      expect(client().prepare("SELECT value FROM settings WHERE key = 'other-writer'").get()).toEqual({
        value: "1",
      });
    });

    it("tries once more on the way out", async () => {
      const release = deferred();
      const row = engine.enqueue({ ...deployment, title: "Deploy", run: () => release.promise });
      await until(() => statusOf(row.id)?.status === "running");

      refuseWrites();
      release.resolve();
      await until(() => engine.isIdle());
      allowWrites();
      await engine.stop(0);

      expect(statusOf(row.id)?.status).toBe("succeeded");
    });
  });

  describe("further work", () => {
    it("is refused at the door while storage is failing", () => {
      storage.report(Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }));

      expect(() => engine.enqueue({ ...service, title: "Deploy", run: () => {} })).toThrow(
        expect.objectContaining({ status: 503, code: "storage_failing" }),
      );
    });

    it("stays queued when it could not be marked as started, and then runs", async () => {
      const row = engine.enqueue({ ...service, title: "Deploy", run: () => {} });
      refuseWrites();
      await settle();

      expect(statusOf(row.id)?.status).toBe("queued");
      expect(storage.isFailing()).toBe(true);
      expect(engine.isIdle()).toBe(false);

      allowWrites();
      storage.check();

      await until(() => statusOf(row.id)?.status === "succeeded");
    });

    it("that was already queued waits for storage instead of failing behind what is running", async () => {
      const release = deferred();
      let ran = false;
      const first = engine.enqueue({ ...service, title: "First", run: () => release.promise });
      const second = engine.enqueue({
        ...service,
        title: "Second",
        run: () => {
          ran = true;
        },
      });
      await until(() => statusOf(first.id)?.status === "running");

      refuseWrites();
      release.resolve();
      await until(() => !(engine as unknown as { running: Map<string, unknown> }).running.has(first.id));
      await settle();

      expect(ran).toBe(false);
      expect(statusOf(second.id)?.status).toBe("queued");

      allowWrites();
      storage.check();

      await until(() => statusOf(second.id)?.status === "succeeded");
      expect(ran).toBe(true);
    });

    it("can still be stopped: cancelling what waits does not depend on writing that down", async () => {
      const release = deferred();
      const first = engine.enqueue({ ...service, title: "First", run: () => release.promise });
      const second = engine.enqueue({ ...service, title: "Second", run: () => {} });
      await until(() => statusOf(first.id)?.status === "running");

      refuseWrites();
      expect(engine.cancel(second.id).status).toBe("uncertain");
      expect(engine.current(statusOf(second.id) as ActionRow).status).toBe("uncertain");

      release.resolve();
      await until(() => engine.isIdle());
      allowWrites();
      storage.check();

      expect(statusOf(second.id)?.status).toBe("cancelled");
    });
  });

  describe("a run that hit it", () => {
    it("is uncertain, since what it changed elsewhere could not be noted down", async () => {
      const row = engine.enqueue({
        ...service,
        title: "Deploy",
        run: () => {
          throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
        },
      });
      await until(() => statusOf(row.id)?.status === "uncertain");

      expect(statusOf(row.id)?.error).toMatch(/could not save its state/);
      expect(statusOf(row.id)?.error).toMatch(/database or disk is full/);
    });

    it("is a plain failure when only the disk of the work itself ran out", async () => {
      const row = engine.enqueue({
        ...service,
        title: "Deploy",
        run: () => {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        },
      });
      await until(() => statusOf(row.id)?.status === "failed");

      expect(statusOf(row.id)?.error).toMatch(/ENOSPC/);
    });
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
