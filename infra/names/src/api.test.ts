import { describe, expect, it } from "vitest";
import { handle } from "./api";
import { ID_LENGTH, isValidId } from "./rules";
import { approveServer } from "./service";
import {
  acmeEvent,
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
  register,
  releaseEvent,
  requestEvent,
  ZONE,
} from "./testing";

describe("registering", () => {
  it("returns an ID, a secret and a domain, and creates both records at the caller's address", async () => {
    const harness = createHarness();

    const server = await register(harness);

    expect(server.domain).toBe(`${server.id}.${ZONE}`);
    expect(server.secret.length).toBeGreaterThanOrEqual(40);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([PUBLIC_IP]);
    expect(harness.dns.get(`*.${server.domain}`, "A")?.values).toEqual([PUBLIC_IP]);
    expect(harness.store.servers.get(server.id)?.status).toBe("active");
  });

  it("creates both records in one batch, so one can never exist without the other", async () => {
    const harness = createHarness();

    const server = await register(harness);

    expect(harness.dns.batches).toHaveLength(1);
    expect(harness.dns.batches[0]?.map((change) => change.record.name).sort()).toEqual([
      `*.${server.domain}`,
      server.domain,
    ]);
    expect(harness.dns.batches[0]?.every((change) => change.action === "UPSERT")).toBe(true);
  });

  describe("cannot be pointed at another address", () => {
    const FORGED = "8.8.8.8";

    it("ignores every header that claims one", async () => {
      const harness = createHarness();

      const result = await handle(
        requestEvent(PUBLIC_IP, {
          headers: {
            "x-forwarded-for": FORGED,
            "x-real-ip": FORGED,
            forwarded: `for=${FORGED}`,
            "cf-connecting-ip": FORGED,
            "true-client-ip": FORGED,
          },
        }),
        harness.deps,
      );

      expect(body<{ ip: string }>(result).ip).toBe(PUBLIC_IP);
      const { domain, id } = body<{ domain: string; id: string }>(result);
      await approveServer(harness.deps, id);
      expect(harness.dns.get(domain, "A")?.values).toEqual([PUBLIC_IP]);
    });

    it("ignores an address in the body or the query", async () => {
      const harness = createHarness();

      const result = await handle(
        requestEvent(PUBLIC_IP, {
          body: JSON.stringify({
            email: EMAIL,
            purpose: PURPOSE,
            ip: FORGED,
            sourceIp: FORGED,
            address: FORGED,
          }),
          pathParameters: { ip: FORGED },
        }),
        harness.deps,
      );

      const { domain, id } = body<{ domain: string; id: string }>(result);
      await approveServer(harness.deps, id);
      expect(harness.dns.get(domain, "A")?.values).toEqual([PUBLIC_IP]);
    });

    it("ignores the same claims on a heartbeat", async () => {
      const harness = createHarness();
      const server = await register(harness);

      await handle(
        {
          ...heartbeatEvent(server, OTHER_PUBLIC_IP),
          headers: { ...heartbeatEvent(server).headers, "x-forwarded-for": FORGED },
          body: JSON.stringify({ ip: FORGED }),
        },
        harness.deps,
      );

      expect(harness.dns.get(server.domain, "A")?.values).toEqual([OTHER_PUBLIC_IP]);
    });
  });

  describe("only gives a public IPv4 address a name", () => {
    it.each([
      ["IPv6", "2001:db8::1", "ipv4_only"],
      ["an IPv4-mapped IPv6 address", "::ffff:8.8.8.8", "ipv4_only"],
      ["this network", "0.1.2.3", "address_not_public"],
      ["10/8", "10.1.2.3", "address_not_public"],
      ["shared CGNAT space", "100.64.0.1", "address_not_public"],
      ["loopback", "127.0.0.1", "address_not_public"],
      ["link-local", "169.254.169.254", "address_not_public"],
      ["172.16/12", "172.31.255.1", "address_not_public"],
      ["192.168/16", "192.168.1.10", "address_not_public"],
      ["TEST-NET-1", "192.0.2.1", "address_not_public"],
      ["TEST-NET-2", "198.51.100.1", "address_not_public"],
      ["TEST-NET-3", "203.0.113.1", "address_not_public"],
      ["benchmarking", "198.18.0.1", "address_not_public"],
      ["multicast", "224.0.0.1", "address_not_public"],
      ["reserved", "240.0.0.1", "address_not_public"],
      ["broadcast", "255.255.255.255", "address_not_public"],
    ])("refuses %s", async (_name, sourceIp, code) => {
      const harness = createHarness();

      const result = await handle(event("POST /v1/servers", sourceIp), harness.deps);

      expect(result.statusCode).toBe(400);
      expect(errorCode(result)).toBe(code);
      expect(harness.dns.records.size).toBe(0);
      expect(harness.store.servers.size).toBe(0);
      expect(harness.store.counters.size).toBe(0);
    });

    it("refuses a private address on a heartbeat too, and keeps the records as they were", async () => {
      const harness = createHarness();
      const server = await register(harness);

      const result = await handle(heartbeatEvent(server, "10.0.0.8"), harness.deps);

      expect(result.statusCode).toBe(400);
      expect(harness.dns.get(server.domain, "A")?.values).toEqual([PUBLIC_IP]);
    });
  });

  describe("IDs", () => {
    it("are short, lowercase and free of characters that can be misread", async () => {
      const harness = createHarness();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const { id } = await register(harness);

        expect(id).toHaveLength(ID_LENGTH);
        expect(id).toMatch(/^[a-z][a-z0-9]+$/);
        expect(id).not.toMatch(/[01oil]/);
      }
    });

    it("are unique through the conditional write: a collision is retried with another", async () => {
      const harness = createHarness();
      harness.ids.push("bcdfghjk", "bcdfghjk", "mnpqrstv");

      const first = await register(harness);
      const second = await register(harness);

      expect(first.id).toBe("bcdfghjk");
      expect(second.id).toBe("mnpqrstv");
    });

    it("are unique under concurrent registrations", async () => {
      const harness = createHarness();
      harness.ids.push("bcdfghjk", "bcdfghjk", "bcdfghjk");

      const servers = await Promise.all(Array.from({ length: 12 }, () => register(harness)));

      expect(new Set(servers.map((server) => server.id)).size).toBe(12);
      expect(servers.filter((server) => server.id === "bcdfghjk")).toHaveLength(1);
      expect(recordNames(harness)).toHaveLength(24);
    });

    it.each(["www", "api", "get", "mail", "ns1", "ns2", "names"])(
      "are never the reserved name %s",
      async (name) => {
        const harness = createHarness();
        harness.ids.push(name, "bcdfghjk");

        const server = await register(harness);

        expect(server.id).toBe("bcdfghjk");
        expect(isValidId(name)).toBe(false);
      },
    );

    it("give up cleanly when no free ID can be found", async () => {
      const harness = createHarness();
      harness.deps.newId = () => "www";

      const result = await handle(requestEvent(PUBLIC_IP), harness.deps);

      expect(result.statusCode).toBe(503);
      expect(harness.dns.records.size).toBe(0);
    });
  });

  describe("the abuse limits", () => {
    it("stops one source address at its daily limit", async () => {
      const harness = createHarness({ registrationsPerIpPerDay: 2 });
      await register(harness);
      await register(harness);

      const result = await handle(requestEvent(PUBLIC_IP), harness.deps);

      expect(result.statusCode).toBe(429);
      expect(errorCode(result)).toBe("rate_limited");
      expect(await register(harness, OTHER_PUBLIC_IP)).toBeDefined();
    });

    it("holds the limit exactly under concurrency", async () => {
      const harness = createHarness({ registrationsPerIpPerDay: 3 });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => handle(requestEvent(PUBLIC_IP), harness.deps)),
      );

      expect(results.filter((result) => result.statusCode === 202)).toHaveLength(3);
      expect(results.filter((result) => result.statusCode === 429)).toHaveLength(7);
    });

    it("trips the global cap as a circuit breaker, across addresses", async () => {
      const harness = createHarness({ registrationsPerDay: 1 });
      await register(harness);

      const result = await handle(requestEvent(OTHER_PUBLIC_IP), harness.deps);

      expect(result.statusCode).toBe(503);
      expect(errorCode(result)).toBe("capacity");
      expect(harness.logs.join("\n")).toContain("daily_cap_reached");
    });

    it("does not let someone over their own limit use up the global cap", async () => {
      const harness = createHarness({ registrationsPerIpPerDay: 1, registrationsPerDay: 2 });
      await register(harness);
      await handle(requestEvent(PUBLIC_IP), harness.deps);

      expect(await register(harness, OTHER_PUBLIC_IP)).toBeDefined();
    });

    it("starts counting again the next day", async () => {
      const harness = createHarness({ registrationsPerIpPerDay: 1 });
      await register(harness);
      harness.advance(86_400_000);

      expect(await register(harness)).toBeDefined();
    });
  });
});

describe("secrets", () => {
  it("are stored only as a hash", async () => {
    const harness = createHarness();

    const server = await register(harness);

    const stored = JSON.stringify([...harness.store.servers.values()]);
    expect(stored).not.toContain(server.secret);
    expect(harness.store.servers.get(server.id)?.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never reach a log, on any path, including a wrong one", async () => {
    const harness = createHarness();
    const server = await register(harness);
    const wrong = "w".repeat(43);

    await handle(heartbeatEvent(server), harness.deps);
    await handle(heartbeatEvent({ ...server, secret: wrong }), harness.deps);
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);
    harness.dns.down = true;
    await handle(releaseEvent(server), harness.deps);

    const logged = harness.logs.join("\n");
    expect(logged).not.toContain(server.secret);
    expect(logged).not.toContain(wrong);
    expect(logged).not.toContain("Basic ");
  });

  it("does not answer differently for a missing server and a wrong secret", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const wrongSecret = await handle(heartbeatEvent({ ...server, secret: "nope" }), harness.deps);
    const missing = await handle(heartbeatEvent({ ...server, id: "zzzzzzzz" }), harness.deps);

    expect(wrongSecret.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrongSecret.body).toBe(missing.body);
    expect(wrongSecret.headers["www-authenticate"]).toContain("Basic");
  });
});

describe("a server can only touch its own records", () => {
  it("refuses another server's secret on a heartbeat", async () => {
    const harness = createHarness();
    const mine = await register(harness);
    const theirs = await register(harness, OTHER_PUBLIC_IP);

    const result = await handle(
      event("PUT /v1/servers/{id}", PUBLIC_IP, {
        pathParameters: { id: theirs.id },
        headers: { authorization: basic(mine.id, mine.secret) },
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(401);
    expect(harness.dns.get(theirs.domain, "A")?.values).toEqual([OTHER_PUBLIC_IP]);
  });

  it("refuses to release someone else's address", async () => {
    const harness = createHarness();
    const mine = await register(harness);
    const theirs = await register(harness, OTHER_PUBLIC_IP);

    const result = await handle(
      event("DELETE /v1/servers/{id}", PUBLIC_IP, {
        pathParameters: { id: theirs.id },
        headers: { authorization: basic(mine.id, mine.secret) },
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(401);
    expect(harness.dns.get(theirs.domain, "A")).toBeDefined();
    expect(harness.store.servers.get(theirs.id)?.status).toBe("active");
  });

  it("refuses a request with no credentials at all", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      event("PUT /v1/servers/{id}", OTHER_PUBLIC_IP, { pathParameters: { id: server.id } }),
      harness.deps,
    );

    expect(result.statusCode).toBe(401);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([PUBLIC_IP]);
  });
});

describe("the heartbeat", () => {
  it("refreshes lastSeen without touching Route 53 when the address has not moved", async () => {
    const harness = createHarness();
    const server = await register(harness);
    harness.advance(3_600_000);
    const batches = harness.dns.batches.length;

    const result = await handle(heartbeatEvent(server), harness.deps);

    expect(result.statusCode).toBe(200);
    expect(harness.dns.batches).toHaveLength(batches);
    expect(harness.store.servers.get(server.id)?.lastSeen).toBe(harness.deps.now());
  });

  it("moves both records together when the address has changed", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(heartbeatEvent(server, OTHER_PUBLIC_IP), harness.deps);

    expect(body<{ ip: string }>(result).ip).toBe(OTHER_PUBLIC_IP);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual([OTHER_PUBLIC_IP]);
    expect(harness.dns.get(`*.${server.domain}`, "A")?.values).toEqual([OTHER_PUBLIC_IP]);
    expect(harness.dns.batches.at(-1)).toHaveLength(2);
    expect(harness.store.servers.get(server.id)?.ip).toBe(OTHER_PUBLIC_IP);
  });

  it("limits how often one server can make Route 53 work", async () => {
    const harness = createHarness({ changesPerServerPerHour: 2 });
    const server = await register(harness);
    await handle(heartbeatEvent(server, "151.101.1.1"), harness.deps);
    await handle(heartbeatEvent(server, "151.101.1.2"), harness.deps);

    const result = await handle(heartbeatEvent(server, "151.101.1.3"), harness.deps);

    expect(result.statusCode).toBe(429);
    expect(harness.dns.get(server.domain, "A")?.values).toEqual(["151.101.1.2"]);
  });

  it("does not spend that budget on a heartbeat that changes nothing", async () => {
    const harness = createHarness({ changesPerServerPerHour: 1 });
    const server = await register(harness);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await handle(heartbeatEvent(server), harness.deps)).statusCode).toBe(200);
    }
  });
});

describe("releasing", () => {
  it("removes every record and leaves a tombstone", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);

    const result = await handle(releaseEvent(server), harness.deps);

    expect(result.statusCode).toBe(200);
    expect(harness.dns.records.size).toBe(0);
    expect(harness.store.servers.get(server.id)).toMatchObject({ status: "released" });
    expect(harness.store.servers.get(server.id)?.secretHash).toBeUndefined();
  });

  it("is refused once it is already gone, with no records to orphan", async () => {
    const harness = createHarness();
    const server = await register(harness);
    await handle(releaseEvent(server), harness.deps);

    const again = await handle(releaseEvent(server), harness.deps);

    expect(again.statusCode).toBe(401);
    expect(harness.dns.records.size).toBe(0);
  });

  it("never issues a released ID again", async () => {
    const harness = createHarness();
    harness.ids.push("bcdfghjk");
    const server = await register(harness);
    await handle(releaseEvent(server), harness.deps);
    harness.ids.push("bcdfghjk", "mnpqrstv");

    const next = await register(harness);

    expect(next.id).toBe("mnpqrstv");
  });
});

describe("the ACME endpoints", () => {
  it("only allow the challenge name of the server that is asking", async () => {
    const harness = createHarness();
    const mine = await register(harness);
    const theirs = await register(harness, OTHER_PUBLIC_IP);

    const result = await handle(
      acmeEvent("present", mine, challengeValue("a"), {
        body: JSON.stringify({
          fqdn: `_acme-challenge.${theirs.id}.${ZONE}.`,
          value: challengeValue("a"),
        }),
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(403);
    expect(harness.dns.get(`_acme-challenge.${theirs.id}.${ZONE}`, "TXT")).toBeUndefined();
    expect(harness.dns.get(`_acme-challenge.${mine.id}.${ZONE}`, "TXT")).toBeUndefined();
  });

  it("cannot clean up another server's challenge", async () => {
    const harness = createHarness();
    const mine = await register(harness);
    const theirs = await register(harness, OTHER_PUBLIC_IP);
    await handle(acmeEvent("present", theirs, challengeValue("t")), harness.deps);

    const result = await handle(
      acmeEvent("cleanup", mine, challengeValue("t"), {
        body: JSON.stringify({
          fqdn: `_acme-challenge.${theirs.id}.${ZONE}.`,
          value: challengeValue("t"),
        }),
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(403);
    expect(harness.dns.get(`_acme-challenge.${theirs.id}.${ZONE}`, "TXT")?.values).toEqual([
      challengeValue("t"),
    ]);
  });

  it.each([
    ["no trailing dot", (id: string) => `_acme-challenge.${id}.${ZONE}`],
    ["the wrong zone", (id: string) => `_acme-challenge.${id}.example.com.`],
    ["a name below it", (id: string) => `_acme-challenge.sub.${id}.${ZONE}.`],
    ["the address itself", (id: string) => `${id}.${ZONE}.`],
    ["the zone's apex", () => `_acme-challenge.${ZONE}.`],
    ["another case", (id: string) => `_ACME-challenge.${id}.${ZONE}.`],
  ])("refuses %s", async (_name, fqdn) => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      acmeEvent("present", server, challengeValue("a"), {
        body: JSON.stringify({ fqdn: fqdn(server.id), value: challengeValue("a") }),
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(403);
    expect([...harness.dns.records.values()].some((record) => record.type === "TXT")).toBe(false);
  });

  it.each([
    ["too short", "abc"],
    ["quotes, to escape the record", `${"a".repeat(40)}"x"`],
    ["a space", `${"a".repeat(42)} `],
    ["a non-string", 42],
  ])("refuses a value that is %s", async (_name, value) => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      acmeEvent("present", server, challengeValue("a"), {
        body: JSON.stringify({ fqdn: `_acme-challenge.${server.id}.${ZONE}.`, value }),
      }),
      harness.deps,
    );

    expect(result.statusCode).toBe(400);
  });

  it("needs the server's own credentials", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      acmeEvent("present", { ...server, secret: "nope" }, challengeValue("a")),
      harness.deps,
    );

    expect(result.statusCode).toBe(401);
    expect([...harness.dns.records.values()].some((record) => record.type === "TXT")).toBe(false);
  });

  it("answers from the format httpreq sends: a Basic header and a JSON body", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      {
        ...acmeEvent("present", server, challengeValue("a")),
        body: Buffer.from(
          JSON.stringify({ fqdn: `_acme-challenge.${server.id}.${ZONE}.`, value: challengeValue("a") }),
        ).toString("base64"),
        isBase64Encoded: true,
      },
      harness.deps,
    );

    expect(result.statusCode).toBe(200);
    expect(harness.dns.get(`_acme-challenge.${server.id}.${ZONE}`, "TXT")?.values).toEqual([
      challengeValue("a"),
    ]);
  });

  it("keeps a wildcard and its base name's challenges side by side, in one record set", async () => {
    const harness = createHarness();
    const server = await register(harness);
    const name = `_acme-challenge.${server.id}.${ZONE}`;

    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);
    await handle(acmeEvent("present", server, challengeValue("b")), harness.deps);

    expect([...(harness.dns.get(name, "TXT")?.values ?? [])].sort()).toEqual([
      challengeValue("a"),
      challengeValue("b"),
    ]);

    await handle(acmeEvent("cleanup", server, challengeValue("a")), harness.deps);
    expect(harness.dns.get(name, "TXT")?.values).toEqual([challengeValue("b")]);

    await handle(acmeEvent("cleanup", server, challengeValue("b")), harness.deps);
    expect(harness.dns.get(name, "TXT")).toBeUndefined();
  });

  it("does not lose a challenge when two arrive at once", async () => {
    const harness = createHarness();
    const server = await register(harness);
    const name = `_acme-challenge.${server.id}.${ZONE}`;
    // Long enough for whoever holds the lease to finish before the others try again.
    harness.deps.sleep = () => new Promise((resolve) => setTimeout(resolve, 5));

    const results = await Promise.all(
      ["a", "b", "c"].map((seed) => handle(acmeEvent("present", server, challengeValue(seed)), harness.deps)),
    );

    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200]);
    expect(harness.dns.get(name, "TXT")?.values).toHaveLength(3);
  });

  it("presenting twice and cleaning up twice are both harmless", async () => {
    const harness = createHarness();
    const server = await register(harness);

    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);
    expect(harness.dns.get(`_acme-challenge.${server.id}.${ZONE}`, "TXT")?.values).toHaveLength(1);

    await handle(acmeEvent("cleanup", server, challengeValue("a")), harness.deps);
    const again = await handle(acmeEvent("cleanup", server, challengeValue("a")), harness.deps);

    expect(again.statusCode).toBe(200);
  });

  it("drops stale values rather than let them block a renewal for ever", async () => {
    const harness = createHarness({ maxChallengeValues: 3 });
    const server = await register(harness);

    for (const seed of ["a", "b", "c", "d"]) {
      await handle(acmeEvent("present", server, challengeValue(seed)), harness.deps);
    }

    expect(harness.dns.get(`_acme-challenge.${server.id}.${ZONE}`, "TXT")?.values).toEqual([
      challengeValue("d"),
    ]);
  });

  it("limits how often one server can spend Route 53 on challenges", async () => {
    const harness = createHarness({ changesPerServerPerHour: 1 });
    const server = await register(harness);
    await handle(acmeEvent("present", server, challengeValue("a")), harness.deps);

    const result = await handle(acmeEvent("present", server, challengeValue("b")), harness.deps);

    expect(result.statusCode).toBe(429);
  });
});

describe("when a request has nothing to do with this API", () => {
  it("answers 404 for an unknown route", async () => {
    const result = await handle(event("GET /v1/anything", PUBLIC_IP), createHarness().deps);
    expect(result.statusCode).toBe(404);
  });

  it("does not expose the operator's actions over HTTP", async () => {
    const harness = createHarness();
    const server = await register(harness);

    const result = await handle(
      event("POST /v1/servers/{id}/disable", PUBLIC_IP, { pathParameters: { id: server.id } }),
      harness.deps,
    );

    expect(result.statusCode).toBe(404);
    expect(harness.store.servers.get(server.id)?.status).toBe("active");
  });

  it("turns an unexpected failure into a 503 that says nothing about why", async () => {
    const harness = createHarness();
    harness.store.failNext("create");

    const result = await handle(requestEvent(PUBLIC_IP), harness.deps);

    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("create");
  });
});
