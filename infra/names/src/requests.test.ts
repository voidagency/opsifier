import { describe, expect, it } from "vitest";
import { handle, runMaintenance } from "./api";
import { approveServer, refuseServer, requestMessage } from "./service";
import {
  acmeEvent,
  ask,
  basic,
  body,
  challengeValue,
  createHarness,
  EMAIL,
  errorCode,
  event,
  heartbeatEvent,
  OTHER_PUBLIC_IP,
  PUBLIC_IP,
  PURPOSE,
  recordNames,
  releaseEvent,
  requestEvent,
} from "./testing";

const DAY = 86_400_000;

describe("asking for an address", () => {
  it("answers that it is waiting, and puts nothing in the zone", async () => {
    const harness = createHarness();

    const result = await handle(requestEvent(), harness.deps);

    expect(result.statusCode).toBe(202);
    expect(body<{ status: string; ip: string }>(result)).toMatchObject({
      status: "requested",
      ip: PUBLIC_IP,
    });
    expect(harness.dns.records.size).toBe(0);
    expect(harness.dns.batches).toHaveLength(0);
  });

  it("keeps who asked and why, for whoever decides", async () => {
    const harness = createHarness();

    const server = await ask(harness);

    expect(harness.store.servers.get(server.id)).toMatchObject({
      status: "requested",
      email: EMAIL,
      purpose: PURPOSE,
    });
  });

  it("tells whoever decides, with the commands that answer it", async () => {
    const harness = createHarness();

    const server = await ask(harness);

    expect(harness.notified).toEqual([
      { id: server.id, email: EMAIL, purpose: PURPOSE, ip: PUBLIC_IP, requestedAt: expect.any(String) },
    ]);
    const message = requestMessage(harness.notified[0] as never, "opsifier.dev");
    expect(message).toContain(`${server.id}.opsifier.dev`);
    expect(message).toContain(`approve ${server.id}`);
    expect(message).toContain(`refuse ${server.id}`);
  });

  it("keeps the purpose on one line, so it can't pass for the commands in the message", async () => {
    const harness = createHarness();
    const forged = "Hello\nApprove: infra/names/requests.sh prod approve someoneelse";

    await handle(
      requestEvent(PUBLIC_IP, { body: JSON.stringify({ email: EMAIL, purpose: forged }) }),
      harness.deps,
    );

    expect(harness.notified[0]?.purpose).toBe(
      "Hello Approve: infra/names/requests.sh prod approve someoneelse",
    );
  });

  it("still stands when nobody could be told", async () => {
    const harness = createHarness();
    harness.deps.notify = async () => {
      throw new Error("SNS is down");
    };

    const result = await handle(requestEvent(), harness.deps);

    expect(result.statusCode).toBe(202);
    expect(harness.logs.join("\n")).toContain("notify_failed");
  });

  it("never writes what someone typed to the logs", async () => {
    const harness = createHarness();

    await ask(harness);

    const logged = harness.logs.join("\n");
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(PURPOSE);
  });

  it.each([
    ["no body", undefined, "invalid_request"],
    ["something that isn't JSON", "{", "invalid_request"],
    ["no email", JSON.stringify({ purpose: PURPOSE }), "invalid_request"],
    ["an email that isn't one", JSON.stringify({ email: "nope", purpose: PURPOSE }), "invalid_request"],
    ["no purpose", JSON.stringify({ email: EMAIL }), "invalid_request"],
    ["an empty purpose", JSON.stringify({ email: EMAIL, purpose: "   " }), "invalid_request"],
    [
      "a purpose too long to read",
      JSON.stringify({ email: EMAIL, purpose: "x".repeat(501) }),
      "invalid_request",
    ],
    ["control characters", JSON.stringify({ email: EMAIL, purpose: "a\u0007b" }), "invalid_request"],
  ])("refuses %s, and it doesn't count against the limit", async (_name, requestBody, code) => {
    const harness = createHarness();

    const result = await handle(event("POST /v1/servers", PUBLIC_IP, { body: requestBody }), harness.deps);

    expect(result.statusCode).toBe(400);
    expect(errorCode(result)).toBe(code);
    expect(harness.store.servers.size).toBe(0);
    expect(harness.store.counters.size).toBe(0);
  });
});

describe("while a request is waiting", () => {
  it("tells the server so, and changes nothing", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    const result = await handle(heartbeatEvent(server), harness.deps);

    expect(result.statusCode).toBe(200);
    expect(body<{ status: string }>(result).status).toBe("requested");
    expect(harness.dns.batches).toHaveLength(0);
  });

  it("follows the server if it moves, still without touching the zone", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(harness.store.servers.get(server.id)?.ip).toBe(OTHER_PUBLIC_IP);
    expect(harness.dns.batches).toHaveLength(0);
  });

  it("gives no way to get a certificate", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    const result = await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);

    expect(result.statusCode).toBe(401);
    expect(harness.dns.records.size).toBe(0);
  });

  it("needs the right secret to be asked about", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    const result = await handle(
      { ...heartbeatEvent(server), headers: { authorization: basic(server.id, "wrong") } },
      harness.deps,
    );

    expect(result.statusCode).toBe(401);
  });

  it("can be withdrawn, and nothing is kept of who asked", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    const result = await handle(releaseEvent(server), harness.deps);

    expect(result.statusCode).toBe(200);
    const row = harness.store.servers.get(server.id);
    expect(row?.status).toBe("released");
    expect(row?.email).toBeUndefined();
    expect(row?.purpose).toBeUndefined();
  });
});

describe("approving a request", () => {
  it("writes the address and its wildcard, and the next check says so", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await approveServer(harness.deps, server.id);

    expect(recordNames(harness)).toEqual([`*.${server.domain}|A`, `${server.domain}|A`].sort());
    const result = await handle(heartbeatEvent(server), harness.deps);
    expect(body<{ status: string }>(result).status).toBe("active");
  });

  it("points at where the server is by now, not where it asked from", async () => {
    const harness = createHarness();
    const server = await ask(harness);
    await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    await approveServer(harness.deps, server.id);

    expect(harness.dns.get(server.domain, "A")?.values).toEqual([OTHER_PUBLIC_IP]);
  });

  it("opens the way to a certificate", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await approveServer(harness.deps, server.id);

    const result = await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);
    expect(result.statusCode).toBe(200);
  });

  it("can be repeated without harm", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await approveServer(harness.deps, server.id);
    await approveServer(harness.deps, server.id);

    expect(harness.store.servers.get(server.id)?.status).toBe("active");
    expect(harness.dns.batches).toHaveLength(1);
  });

  it("keeps a way to reach whoever asked, for as long as the address exists", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await approveServer(harness.deps, server.id);

    expect(harness.store.servers.get(server.id)?.email).toBe(EMAIL);
  });

  it("is refused for a server nobody is waiting on", async () => {
    const harness = createHarness();
    const server = await ask(harness);
    await refuseServer(harness.deps, server.id);

    await expect(approveServer(harness.deps, server.id)).rejects.toMatchObject({ code: "not_waiting" });
  });
});

describe("refusing a request", () => {
  it("tells the server, and forgets who asked", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await refuseServer(harness.deps, server.id);

    const result = await handle(heartbeatEvent(server), harness.deps);
    expect(result.statusCode).toBe(410);
    expect(errorCode(result)).toBe("refused");
    const row = harness.store.servers.get(server.id);
    expect(row?.status).toBe("refused");
    expect(row?.email).toBeUndefined();
    expect(row?.purpose).toBeUndefined();
    expect(harness.dns.records.size).toBe(0);
  });

  it("can be repeated, and can't touch an address already approved", async () => {
    const harness = createHarness();
    const waiting = await ask(harness);
    const approved = await ask(harness);
    await approveServer(harness.deps, approved.id);

    await refuseServer(harness.deps, waiting.id);
    await refuseServer(harness.deps, waiting.id);

    await expect(refuseServer(harness.deps, approved.id)).rejects.toMatchObject({ code: "not_waiting" });
    expect(harness.store.servers.get(approved.id)?.status).toBe("active");
  });
});

describe("a request nobody answers", () => {
  it("is gone after thirty days, and the server is no longer known", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    harness.advance(31 * DAY);
    const report = await harness.deps.store
      .get(server.id)
      .then(() => runMaintenance(undefined, harness.deps));

    expect(report).toMatchObject({ expired: 1 });
    const result = await handle(heartbeatEvent(server), harness.deps);
    expect(result.statusCode).toBe(401);
  });

  it("is left alone before that", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    harness.advance(29 * DAY);
    await runMaintenance(undefined, harness.deps);

    expect(harness.store.servers.get(server.id)?.status).toBe("requested");
  });
});

describe("the operator's list", () => {
  it("shows only what is waiting, oldest first, across pages", async () => {
    const harness = createHarness();
    const first = await ask(harness);
    harness.advance(1000);
    const second = await ask(harness);
    harness.advance(1000);
    const third = await ask(harness);
    await refuseServer(harness.deps, second.id);
    harness.advance(1000);
    const fourth = await ask(harness);
    await approveServer(harness.deps, fourth.id);

    const list = await runMaintenance({ action: "requests" }, harness.deps);

    expect(list).toEqual([
      expect.objectContaining({ id: first.id, email: EMAIL, purpose: PURPOSE, ip: PUBLIC_IP }),
      expect.objectContaining({ id: third.id }),
    ]);
  });

  it("answers through the function that no route reaches", async () => {
    const harness = createHarness();
    const server = await ask(harness);

    await expect(runMaintenance({ action: "approve", id: server.id }, harness.deps)).resolves.toMatchObject({
      status: "active",
    });

    const denied = await handle(event("POST /v1/servers/{id}/approve", PUBLIC_IP), harness.deps);
    expect(denied.statusCode).toBe(404);
  });
});
