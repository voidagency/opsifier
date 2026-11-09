import { describe, expect, it } from "vitest";
import { handle, runMaintenance } from "./api";
import { hashSecret } from "./rules";
import { disableServer, sweep } from "./service";
import {
  acmeEvent,
  body,
  challengeValue,
  createHarness,
  errorCode,
  event,
  heartbeatEvent,
  NOW,
  OTHER_PUBLIC_IP,
  PUBLIC_IP,
  recordNames,
  register,
  releaseEvent,
  ZONE,
} from "./testing";

const DAY = 86_400_000;
const registerEvent = event("POST /v1/servers", PUBLIC_IP);

describe("a registration that fails between DynamoDB and Route 53", () => {
  it("leaves nothing behind when Route 53 refuses the batch", async () => {
    const harness = createHarness();
    harness.dns.failNext = "before";

    const result = await handle(registerEvent, harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.size).toBe(0);
  });

  it("takes the records back when Route 53 applied them but the answer was lost", async () => {
    const harness = createHarness();
    harness.dns.failNext = "applied";

    const result = await handle(registerEvent, harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.size).toBe(0);
  });

  it("takes the records back when the row cannot be activated", async () => {
    const harness = createHarness();
    harness.store.failNext("activate");

    const result = await handle(registerEvent, harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.size).toBe(0);
  });

  it("removes an active row too, when the activation went through but its answer was lost", async () => {
    const harness = createHarness();
    harness.store.loseNextAnswer("activate");

    const result = await handle(registerEvent, harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.size).toBe(0);
  });

  it("never shows a pending ID to anyone: it has no usable credentials and no records yet", async () => {
    const harness = createHarness();
    harness.dns.failNext = "before";
    harness.store.failNext("deleteRow");

    const result = await handle(registerEvent, harness.deps);

    expect(body(result)).toEqual({
      error: { code: "unavailable", message: expect.any(String) },
    });
    const [row] = [...harness.store.servers.values()];
    expect(row?.status).toBe("pending");
    expect(harness.dns.records.size).toBe(0);
  });

  it("leaves a row the daily job finishes, when even undoing it fails", async () => {
    const harness = createHarness();
    harness.store.failNext("activate");
    harness.dns.failNext = null;
    const realChange = harness.dns.change.bind(harness.dns);
    let calls = 0;
    harness.dns.change = async (changes) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("Route 53 is unavailable");
      }
      return realChange(changes);
    };

    const result = await handle(registerEvent, harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(2);
    expect([...harness.store.servers.values()][0]?.status).toBe("pending");

    // Within the grace period the job can't tell it from a registration in flight, so it waits.
    await sweep(harness.deps);
    expect(harness.dns.records.size).toBe(2);

    harness.advance(16 * 60_000);
    const report = await sweep(harness.deps);

    expect(report.undone).toBe(1);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.size).toBe(0);
  });

  it("does not undo a pending registration still within its grace period", async () => {
    const harness = createHarness();
    harness.store.servers.set("bcdfghjk", {
      id: "bcdfghjk",
      status: "pending",
      secretHash: hashSecret("x"),
      ip: PUBLIC_IP,
      createdAt: harness.deps.now() - 60_000,
      lastSeen: harness.deps.now() - 60_000,
    });

    await sweep(harness.deps);

    expect(harness.store.servers.get("bcdfghjk")?.status).toBe("pending");
  });
});

describe("a release that fails halfway", () => {
  it("can be repeated once Route 53 is back, and ends with nothing left", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.dns.down = true;

    const failed = await handle(releaseEvent(server), harness.deps);

    expect(failed.statusCode).toBe(503);
    expect(harness.store.servers.get(server.id)?.status).toBe("removing");

    harness.dns.down = false;
    const retried = await handle(releaseEvent(server), harness.deps);

    expect(retried.statusCode).toBe(200);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("released");
  });

  it("is finished by the daily job if the server never asks again", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.dns.down = true;
    await handle(releaseEvent(server), harness.deps);
    harness.dns.down = false;

    const report = await sweep(harness.deps);

    expect(report.finished).toBe(1);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("released");
  });

  it("changes nothing if the intent could not even be recorded", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.store.failNext("update");

    const failed = await handle(releaseEvent(server), harness.deps);

    expect(failed.statusCode).toBe(503);
    expect(harness.store.servers.get(server.id)?.status).toBe("active");
    expect(harness.dns.records.size).toBe(2);
  });

  it("finishes the tombstone when the records went but the last write failed", async () => {
    const harness = createHarness();
    const server = await register(harness);
    const realUpdate = harness.store.update.bind(harness.store);
    let calls = 0;
    harness.store.update = async (lease, patch) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("DynamoDB is unavailable");
      }
      return realUpdate(lease, patch);
    };

    const failed = await handle(releaseEvent(server), harness.deps);

    expect(failed.statusCode).toBe(503);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("removing");

    harness.store.update = realUpdate;
    const report = await sweep(harness.deps);

    expect(report.finished).toBe(1);
    expect(harness.store.servers.get(server.id)?.status).toBe("released");
    expect(harness.store.servers.get(server.id)?.secretHash).toBeUndefined();
  });

  it("removes what is really there when the row and the zone disagree", async () => {
    const harness = createHarness();
    const server = await register(harness);
    // A move that reached Route 53, but whose row update was lost.
    harness.dns.records.set(`${server.domain}|A`, {
      name: server.domain,
      type: "A",
      ttl: 300,
      values: [OTHER_PUBLIC_IP],
    });
    harness.dns.records.set(`*.${server.domain}|A`, {
      name: `*.${server.domain}`,
      type: "A",
      ttl: 300,
      values: [OTHER_PUBLIC_IP],
    });

    const result = await handle(releaseEvent(server), harness.deps);

    expect(result.statusCode).toBe(200);
    expect(harness.dns.records.size).toBe(0);
  });

  it("removes the three names that belong to it and nothing else in the zone", async () => {
    const harness = createHarness();
    const server = await register(harness);
    const neighbour = await register(harness, OTHER_PUBLIC_IP);
    harness.dns.records.set(`names.${ZONE}|A`, {
      name: `names.${ZONE}`,
      type: "A",
      ttl: 60,
      values: ["1.1.1.1"],
    });
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);

    await handle(releaseEvent(server), harness.deps);

    expect(recordNames(harness)).toEqual(
      [`*.${neighbour.domain}|A`, `${neighbour.domain}|A`, `names.${ZONE}|A`].sort(),
    );
  });
});

describe("a heartbeat that fails halfway", () => {
  it("is safe to repeat when the row update was lost after Route 53 took the change", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.store.failNext("update");

    const failed = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(failed.statusCode).toBe(503);
    expect(harness.store.servers.get(server.id)?.ip).toBe(PUBLIC_IP);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([OTHER_PUBLIC_IP]);

    const retried = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(retried.statusCode).toBe(200);
    expect(harness.store.servers.get(server.id)?.ip).toBe(OTHER_PUBLIC_IP);
  });

  it("leaves everything as it was when Route 53 refuses", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.dns.failNext = "before";

    const result = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(result.statusCode).toBe(503);
    expect(harness.store.servers.get(server.id)?.ip).toBe(PUBLIC_IP);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([PUBLIC_IP]);
  });

  it("releases its lease on failure, so the next attempt is not blocked", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.dns.failNext = "before";
    await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(harness.store.servers.get(server.id)?.leaseToken).toBeUndefined();
  });
});

describe("concurrent changes to one server", () => {
  it("does not bring records back after a release that wins the race", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const results = await Promise.all([
      handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps),
      handle(releaseEvent(server), harness.deps),
      handle(heartbeatEvent(server, "151.101.1.2"), harness.deps),
    ]);

    const released = results.some((result) => result.statusCode === 200 && "released" in body(result));
    expect(released).toBe(true);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("released");
  });

  it("answers busy, rather than racing, while another request holds the lease", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await harness.store.lease(
      { id: server.id, token: "someone-else" },
      ["active"],
      harness.deps.now(),
      harness.deps.now() + 30_000,
    );

    const result = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(result.statusCode).toBe(503);
    expect(errorCode(result)).toBe("busy");
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([PUBLIC_IP]);
  });

  it("takes over a lease left by a crash once it has run out", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await harness.store.lease(
      { id: server.id, token: "crashed" },
      ["active"],
      harness.deps.now(),
      harness.deps.now() + 30_000,
    );
    harness.advance(31_000);

    const result = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(result.statusCode).toBe(200);
  });
});

describe("disabling an address", () => {
  it("removes its records, keeps the row, and tells the server so", async () => {
    const harness = createHarness();
    const server = await register(harness);

    await disableServer(harness.deps, server.id);

    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("disabled");
    const answer = await handle(heartbeatEvent(server), harness.deps);
    expect(answer.statusCode).toBe(410);
    expect(errorCode(answer)).toBe("disabled");
  });

  it("can never be reissued, not even by a colliding draw", async () => {
    const harness = createHarness();
    harness.ids.push("bcdfghjk");
    const server = await register(harness);
    await disableServer(harness.deps, server.id);
    harness.ids.push("bcdfghjk", "mnpqrstv");

    const next = await register(harness);

    expect(next.id).toBe("mnpqrstv");
    expect(harness.store.servers.get("bcdfghjk")?.status).toBe("disabled");
  });

  it("cannot be undone by the old server", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await disableServer(harness.deps, server.id);

    await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);

    expect(harness.dns.records.size).toBe(0);
  });

  it("is reached through the maintenance function's event", async () => {
    const harness = createHarness();
    const server = await register(harness);

    await runMaintenance({ action: "disable", id: server.id }, harness.deps);

    expect(harness.store.servers.get(server.id)?.status).toBe("disabled");
  });

  it("refuses an ID that is not one, and one that doesn't exist", async () => {
    const harness = createHarness();

    await expect(disableServer(harness.deps, "../etc")).rejects.toMatchObject({ status: 400 });
    await expect(disableServer(harness.deps, "bcdfghjk")).rejects.toMatchObject({ status: 404 });
  });

  it("is idempotent", async () => {
    const harness = createHarness();
    const server = await register(harness);

    await disableServer(harness.deps, server.id);
    await expect(disableServer(harness.deps, server.id)).resolves.toMatchObject({ status: "disabled" });
  });
});

describe("the daily cleanup", () => {
  it("removes an address after 90 days with no heartbeat", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.advance(91 * DAY);

    const report = await sweep(harness.deps);

    expect(report.expired).toBe(1);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)).toMatchObject({ status: "expired" });
    expect(harness.store.servers.get(server.id)?.secretHash).toBeUndefined();
  });

  it("leaves an address alone while it keeps checking in", async () => {
    const harness = createHarness();
    const server = await register(harness);

    for (let day = 0; day < 95; day += 1) {
      harness.advance(DAY);
      await handle(heartbeatEvent(server), harness.deps);
      await sweep(harness.deps);
    }

    expect(harness.store.servers.get(server.id)?.status).toBe("active");
    expect(harness.dns.records.size).toBe(2);
  });

  it("leaves an address exactly at the limit, and takes it a moment later", async () => {
    const harness = createHarness();
    await register(harness);
    harness.advance(90 * DAY);

    expect((await sweep(harness.deps)).expired).toBe(0);

    harness.advance(1);
    expect((await sweep(harness.deps)).expired).toBe(1);
  });

  it("does not expire a server whose heartbeat landed after the scan", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.advance(91 * DAY);
    const scan = harness.store.scan.bind(harness.store);
    harness.store.scan = async (cursor) => {
      const page = await scan(cursor);
      await handle(heartbeatEvent(server), harness.deps);
      return page;
    };

    const report = await sweep(harness.deps);

    expect(report.expired).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("active");
  });

  it("never reissues an expired ID", async () => {
    const harness = createHarness();
    harness.ids.push("bcdfghjk");
    await register(harness);
    harness.advance(91 * DAY);
    await sweep(harness.deps);
    harness.ids.push("bcdfghjk", "mnpqrstv");

    expect((await register(harness)).id).toBe("mnpqrstv");
  });

  it("carries on past one failure", async () => {
    const harness = createHarness();
    await register(harness);
    await register(harness, OTHER_PUBLIC_IP);
    harness.advance(91 * DAY);
    harness.store.failNext("update");

    const report = await sweep(harness.deps);

    expect(report.failed).toBe(1);
    expect(report.expired).toBe(1);
  });

  it("stops at its limit for a run, and the next run takes the rest", async () => {
    const harness = createHarness({ removalsPerRun: 2 });
    for (let index = 0; index < 5; index += 1) {
      await register(harness);
    }
    harness.advance(91 * DAY);

    const first = await sweep(harness.deps);
    const second = await sweep(harness.deps);
    const third = await sweep(harness.deps);

    expect(first).toMatchObject({ expired: 2, stoppedEarly: true });
    expect(second).toMatchObject({ expired: 2, stoppedEarly: true });
    expect(third).toMatchObject({ expired: 1, stoppedEarly: false });
    expect(harness.dns.records.size).toBe(0);
  });

  it("paces itself between removals, to stay inside Route 53's rate limit", async () => {
    const harness = createHarness({ removalPauseMs: 400 });
    await register(harness);
    await register(harness, OTHER_PUBLIC_IP);
    harness.advance(91 * DAY);
    const pauses: number[] = [];
    harness.deps.sleep = async (ms) => {
      pauses.push(ms);
    };

    await sweep(harness.deps);

    expect(pauses).toEqual([400, 400]);
  });

  it("is what the schedule's event runs", async () => {
    const harness = createHarness();
    await register(harness);
    harness.advance(91 * DAY);

    const report = await runMaintenance({}, harness.deps);

    expect(report).toMatchObject({ expired: 1 });
    expect(harness.logs.join("\n")).toContain('"event":"sweep"');
  });

  it("leaves tombstones alone", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await handle(releaseEvent(server), harness.deps);
    harness.advance(365 * DAY);

    const report = await sweep(harness.deps);

    expect(report.expired).toBe(0);
    expect(harness.store.servers.get(server.id)?.status).toBe("released");
  });

  it("uses the clock it is given", () => {
    expect(new Date(NOW).toISOString()).toBe("2026-11-08T12:00:00.000Z");
  });
});
