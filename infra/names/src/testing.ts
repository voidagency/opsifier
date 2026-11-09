import type { HttpEvent, HttpResult } from "./api";
import { handle } from "./api";
import { FakeDns, FakeStore } from "./fakes";
import { randomId, randomSecret, randomToken } from "./rules";
import type { Deps, Limits } from "./service";

/** Not a test itself: what the test files in this folder share. */

export const ZONE = "opsifier.dev";
export const PUBLIC_IP = "93.184.216.34";
export const OTHER_PUBLIC_IP = "151.101.1.69";
export const NOW = Date.UTC(2026, 10, 8, 12);

export interface Harness {
  deps: Deps;
  store: FakeStore;
  dns: FakeDns;
  /** Lines of what was logged, in order, to check that nothing sensitive reaches them. */
  logs: string[];
  advance(ms: number): void;
  /** Handed out by the next registrations, ahead of random ones. */
  ids: string[];
}

export function createHarness(limits: Partial<Limits> = {}): Harness {
  const store = new FakeStore();
  const dns = new FakeDns();
  const logs: string[] = [];
  const ids: string[] = [];
  let clock = NOW;
  const deps: Deps = {
    store,
    dns,
    zone: ZONE,
    limits: {
      registrationsPerIpPerDay: 1000,
      registrationsPerDay: 10_000,
      changesPerServerPerHour: 1000,
      inactiveAfterDays: 90,
      removalsPerRun: 1000,
      removalPauseMs: 0,
      maxChallengeValues: 8,
      ...limits,
    },
    now: () => clock,
    newId: () => ids.shift() ?? randomId(),
    newSecret: randomSecret,
    newToken: randomToken,
    sleep: async () => {},
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  };
  return {
    deps,
    store,
    dns,
    logs,
    ids,
    advance: (ms) => {
      clock += ms;
    },
  };
}

export const basic = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

export function event(
  routeKey: string,
  sourceIp: string,
  extra: Partial<Omit<HttpEvent, "routeKey" | "requestContext">> = {},
): HttpEvent {
  return { routeKey, requestContext: { http: { sourceIp } }, ...extra };
}

export const body = <T = Record<string, unknown>>(result: HttpResult): T => JSON.parse(result.body) as T;

export const errorCode = (result: HttpResult): string => body<{ error: { code: string } }>(result).error.code;

export interface Registration {
  id: string;
  secret: string;
  domain: string;
  ip: string;
}

export async function register(harness: Harness, sourceIp = PUBLIC_IP): Promise<Registration> {
  const result = await handle(event("POST /v1/servers", sourceIp), harness.deps);
  if (result.statusCode !== 201) {
    throw new Error(`Registration failed: ${result.body}`);
  }
  return body<Registration>(result);
}

export const heartbeatEvent = (server: Registration, sourceIp = PUBLIC_IP): HttpEvent =>
  event("PUT /v1/servers/{id}", sourceIp, {
    pathParameters: { id: server.id },
    headers: { authorization: basic(server.id, server.secret) },
  });

export const releaseEvent = (server: Registration): HttpEvent =>
  event("DELETE /v1/servers/{id}", PUBLIC_IP, {
    pathParameters: { id: server.id },
    headers: { authorization: basic(server.id, server.secret) },
  });

export const challengeBody = (id: string, value: string): string =>
  JSON.stringify({ fqdn: `_acme-challenge.${id}.${ZONE}.`, value });

export const challengeValue = (seed: string): string => seed.repeat(43).slice(0, 43);

export const acmeEvent = (
  kind: "present" | "cleanup",
  server: Registration,
  value: string,
  overrides: Partial<HttpEvent> = {},
): HttpEvent =>
  event(`POST /v1/acme/${kind}`, PUBLIC_IP, {
    headers: { authorization: basic(server.id, server.secret) },
    body: challengeBody(server.id, value),
    ...overrides,
  });

export const recordNames = (harness: Harness): string[] => [...harness.dns.records.keys()].sort();
