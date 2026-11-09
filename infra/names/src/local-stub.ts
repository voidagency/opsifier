import { createServer, type IncomingMessage } from "node:http";
import { type HttpEvent, handle } from "./api";
import { FakeDns, FakeStore } from "./fakes";
import { randomId, randomSecret, randomToken } from "./rules";
import type { Deps } from "./service";

/**
 * The real request handling in front of in-memory DNS and storage, for trying the product without AWS:
 *
 *   tsx infra/names/src/local-stub.ts          (STUB_PORT, STUB_SOURCE_IP, STUB_ZONE)
 *   OPSIFIER_NAMES_URL=http://127.0.0.1:8787
 *
 * A connection from this machine has a private source address, so the one that is reported can be set.
 */
const port = Number(process.env.STUB_PORT ?? 8787);
const sourceIp = process.env.STUB_SOURCE_IP ?? "93.184.216.34";
const zone = process.env.STUB_ZONE ?? "opsifier.dev";

const deps: Deps = {
  store: new FakeStore(),
  dns: new FakeDns(),
  zone,
  limits: {
    registrationsPerIpPerDay: 50,
    registrationsPerDay: 1000,
    changesPerServerPerHour: 60,
    inactiveAfterDays: 90,
    removalsPerRun: 100,
    removalPauseMs: 0,
    maxChallengeValues: 8,
  },
  now: Date.now,
  newId: randomId,
  newSecret: randomSecret,
  newToken: randomToken,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (event, fields = {}) => console.log(JSON.stringify({ event, ...fields })),
};

const ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^POST \/v1\/servers$/, "POST /v1/servers"],
  [/^PUT \/v1\/servers\/([^/]+)$/, "PUT /v1/servers/{id}"],
  [/^DELETE \/v1\/servers\/([^/]+)$/, "DELETE /v1/servers/{id}"],
  [/^POST \/v1\/acme\/present$/, "POST /v1/acme/present"],
  [/^POST \/v1\/acme\/cleanup$/, "POST /v1/acme/cleanup"],
];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://stub");
  const key = `${request.method} ${url.pathname}`;
  const match = ROUTES.find(([pattern]) => pattern.test(key));
  const id = match?.[0].exec(key)?.[1];
  const event: HttpEvent = {
    routeKey: match?.[1] ?? "unknown",
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
    ),
    pathParameters: id === undefined ? {} : { id },
    body: await readBody(request),
    requestContext: { http: { sourceIp } },
  };
  const result = await handle(event, deps);
  response.writeHead(result.statusCode, result.headers).end(result.body);
}).listen(port, "0.0.0.0", () => console.log(`Stub of the names API on port ${port}, for ${zone}`));
