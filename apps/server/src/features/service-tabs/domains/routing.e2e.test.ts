import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Sends real traffic through a real Traefik, because a routing file can look right and still be
 * refused, or match more than it says. Run it against a panel in a Docker-in-Docker sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3403 OPSIFIER_E2E_PROXY_HTTP_PORT=28203 \
 *   OPSIFIER_E2E_PROXY_PORT=28503 OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/service-tabs/domains/routing.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3403"}/api/v1`;
const HTTP_PORT = Number(process.env.OPSIFIER_E2E_PROXY_HTTP_PORT ?? 80);
const HTTPS_PORT = Number(process.env.OPSIFIER_E2E_PROXY_PORT ?? 443);

const IMAGE = "nginx:alpine-slim";
const SUFFIX = Date.now().toString(36);
const OWNER = `e2e-owner-${SUFFIX}`;
const RIVAL = `e2e-rival-${SUFFIX}`;
const DOMAIN = `${SUFFIX}.routing.example.test`;
const SETTLE_MS = 45_000;
const POLL_MS = 300;
const SLOW = 600_000;

interface Reply {
  status: number;
  body: string;
  location: string | undefined;
}

interface DomainReply {
  id: string;
}

let cookie = "";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      origin: new URL(BASE).origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) {
    cookie = setCookie.split(";", 1)[0] ?? "";
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ApiFailure(response.status, text, `${method} ${path}: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the proxy answers for this host and path, with certificate checks aside. */
function send(scheme: "http" | "https", host: string, path: string): Promise<Reply> {
  const options = { host: "127.0.0.1", path, headers: { host } };
  return new Promise((resolve, reject) => {
    const receive = (res: import("node:http").IncomingMessage) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
    };
    const req =
      scheme === "http"
        ? httpRequest({ ...options, port: HTTP_PORT }, receive)
        : httpsRequest(
            { ...options, port: HTTPS_PORT, servername: host, rejectUnauthorized: false },
            receive,
          );
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("timed out")));
    req.end();
  });
}

const get = (host: string, path = "/") => send("http", host, path);

/** Traefik picks up a routing file a moment after it is written, so a check has to wait for it. */
async function settles(
  host: string,
  path: string,
  wanted: (reply: Reply) => boolean,
  scheme: "http" | "https" = "http",
): Promise<Reply> {
  const deadline = Date.now() + SETTLE_MS;
  let last: Reply | Error = new Error("Never asked");
  while (Date.now() < deadline) {
    last = await send(scheme, host, path).catch((error: Error) => error);
    if (!(last instanceof Error) && wanted(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${scheme}://${host}${path} never settled. Last answer: ${JSON.stringify(last)}`);
}

const answeredBy = (name: string) => (reply: Reply) =>
  reply.status === 200 && reply.body.includes(`name=${name} `);
/** Whatever else it is, the request did not reach any of these backends. */
const unserved = (reply: Reply) => !reply.body.includes("name=");

const serviceUrl = (project: string, service: string) => `/projects/${project}/services/${service}`;

async function waitForAction(id: string): Promise<void> {
  for (;;) {
    const action = await api<{ status: string; error: string | null }>(`/actions/${id}`);
    if (action.status === "succeeded") {
      return;
    }
    if (action.status !== "queued" && action.status !== "running") {
      throw new Error(`The action ended as ${action.status}: ${action.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function nginxConfig(name: string, ports: readonly number[], tls: boolean): string {
  const listens = ports.map((port) => `  listen ${port}${tls ? " ssl" : ""};`);
  const certificates = tls
    ? ["  ssl_certificate /etc/nginx/tls/cert.pem;", "  ssl_certificate_key /etc/nginx/tls/key.pem;"]
    : [];
  return [
    "server {",
    ...listens,
    ...certificates,
    "  location / {",
    "    default_type text/plain;",
    `    return 200 "name=${name} port=$server_port uri=$request_uri proto=$http_x_forwarded_proto\\n";`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** A running backend whose answer says who it is, with no route of its own yet. */
async function deployBackend(
  project: string,
  name: string,
  ports: readonly number[],
  certificates?: { cert: string; key: string },
): Promise<void> {
  const url = serviceUrl(project, name);
  await api(`/projects/${project}/services`, "POST", { name });
  const { domains } = await api<{ domains: DomainReply[] }>(`${url}/domains`);
  for (const domain of domains) {
    await api(`${url}/domains/${domain.id}`, "DELETE");
  }
  await api(`${url}/source`, "PUT", { image: IMAGE });
  await api(`${url}/storage/mounts`, "POST", {
    type: "file",
    mountPath: "/etc/nginx/conf.d/default.conf",
    content: nginxConfig(name, ports, certificates !== undefined),
  });
  if (certificates !== undefined) {
    await api(`${url}/storage/mounts`, "POST", {
      type: "file",
      mountPath: "/etc/nginx/tls/cert.pem",
      content: certificates.cert,
    });
    await api(`${url}/storage/mounts`, "POST", {
      type: "file",
      mountPath: "/etc/nginx/tls/key.pem",
      content: certificates.key,
    });
  }
  const action = await api<{ id: string }>(`${url}/deploy`, "POST");
  await waitForAction(action.id);
}

const addDomain = (project: string, name: string, body: Record<string, unknown>) =>
  api<DomainReply>(`${serviceUrl(project, name)}/domains`, "POST", { https: false, ...body });

const removeDomain = (project: string, name: string, id: string) =>
  api(`${serviceUrl(project, name)}/domains/${id}`, "DELETE");

interface TestCertificates {
  ca: string;
  cert: string;
  key: string;
}

/** A private CA and a certificate from it for `backend.internal`, which no public authority vouches for. */
function makeCertificates(): TestCertificates {
  const directory = mkdtempSync(join(tmpdir(), "opsifier-e2e-tls-"));
  const inDirectory = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  try {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=Routing test CA",
      "-keyout",
      inDirectory("ca.key"),
      "-out",
      inDirectory("ca.pem"),
    );
    openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=backend.internal",
      "-keyout",
      inDirectory("key.pem"),
      "-out",
      inDirectory("csr.pem"),
    );
    writeFileSync(inDirectory("ext"), "subjectAltName=DNS:backend.internal\n");
    openssl(
      "x509",
      "-req",
      "-days",
      "2",
      "-in",
      inDirectory("csr.pem"),
      "-CA",
      inDirectory("ca.pem"),
      "-CAkey",
      inDirectory("ca.key"),
      "-CAcreateserial",
      "-extfile",
      inDirectory("ext"),
      "-out",
      inDirectory("cert.pem"),
    );
    return {
      ca: readFileSync(inDirectory("ca.pem"), "utf8"),
      cert: readFileSync(inDirectory("cert.pem"), "utf8"),
      key: readFileSync(inDirectory("key.pem"), "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)("routing on real Traefik", () => {
  let certificates: TestCertificates;

  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    // On anything but production every route is behind a password, which is not what this tests.
    const purpose = await api<{ protection: boolean; confirmation: string }>("/server-purpose");
    if (purpose.protection) {
      await api("/server-purpose", "PUT", { purpose: "production", confirm: purpose.confirmation });
    }
    certificates = makeCertificates();
    await api("/projects", "POST", { name: OWNER });
    await api("/projects", "POST", { name: RIVAL });
    await deployBackend(OWNER, "one", [8001, 8002]);
    await deployBackend(OWNER, "two", [8003]);
    await deployBackend(OWNER, "secure", [8443], certificates);
    await deployBackend(RIVAL, "rival", [8004]);
  }, SLOW);

  afterAll(async () => {
    for (const project of [OWNER, RIVAL]) {
      await api(`/projects/${project}`, "DELETE", { confirm: project }).catch(() => undefined);
    }
  }, SLOW);

  it(
    "sends two paths to two ports, and keeps each one inside its own segment",
    async () => {
      const host = `paths.${DOMAIN}`;
      const first = await addDomain(OWNER, "one", { host, path: "/one", port: 8001 });
      const second = await addDomain(OWNER, "one", { host, path: "/two", port: 8002 });

      expect((await settles(host, "/one", answeredBy("one"))).body).toContain("port=8001 uri=/one ");
      expect((await settles(host, "/one/deeper", answeredBy("one"))).body).toContain("port=8001");
      expect((await settles(host, "/one/", answeredBy("one"))).body).toContain("port=8001 uri=/one/ ");
      expect((await settles(host, "/two/x", answeredBy("one"))).body).toContain("port=8002");

      expect(unserved(await get(host, "/oneplus"))).toBe(true);
      expect(unserved(await get(host, "/oneplus/x"))).toBe(true);
      expect(unserved(await get(host, "/one-more"))).toBe(true);
      expect(unserved(await get(host, "/twofold/"))).toBe(true);

      await removeDomain(OWNER, "one", first.id);
      await removeDomain(OWNER, "one", second.id);
    },
    SLOW,
  );

  it(
    "keeps the query string, and gives the backend the whole path unless told to strip it",
    async () => {
      const host = `query.${DOMAIN}`;
      const kept = await addDomain(OWNER, "one", { host, path: "/keep", port: 8001 });
      const stripped = await addDomain(OWNER, "one", { host, path: "/strip", port: 8001, stripPath: true });
      const query = "?a=1&b=two%20words&empty=&c=%2Fslash";

      expect((await settles(host, `/keep/x${query}`, answeredBy("one"))).body).toContain(
        `uri=/keep/x${query} `,
      );
      expect((await settles(host, `/strip/x${query}`, answeredBy("one"))).body).toContain(`uri=/x${query} `);
      expect((await settles(host, "/strip", answeredBy("one"))).body).toContain("uri=/ ");
      expect(unserved(await get(host, "/stripped"))).toBe(true);

      await removeDomain(OWNER, "one", kept.id);
      await removeDomain(OWNER, "one", stripped.id);
    },
    SLOW,
  );

  it(
    "prefers an exact host over a wildcard, on any path",
    async () => {
      const exactHost = `exact.wild.${DOMAIN}`;
      const wildcard = await addDomain(OWNER, "one", { host: `wild.${DOMAIN}`, wildcard: true, port: 8001 });
      const exact = await addDomain(OWNER, "two", { host: exactHost, port: 8003 });

      await settles(exactHost, "/", answeredBy("two"));
      await settles(`other.wild.${DOMAIN}`, "/", answeredBy("one"));
      expect((await settles(exactHost, "/deep/path", answeredBy("two"))).body).toContain("port=8003");

      await removeDomain(OWNER, "one", wildcard.id);
      await removeDomain(OWNER, "two", exact.id);
    },
    SLOW,
  );

  it(
    "stops answering once a route is removed",
    async () => {
      const host = `gone.${DOMAIN}`;
      const route = await addDomain(OWNER, "one", { host, port: 8001 });
      await settles(host, "/", answeredBy("one"));

      await removeDomain(OWNER, "one", route.id);

      await settles(host, "/", unserved);
      expect(unserved(await get(host, "/anything"))).toBe(true);
    },
    SLOW,
  );

  it(
    "leaves a service with no domain unreachable, and does not freeze later changes",
    async () => {
      const host = `last.${DOMAIN}`;
      const last = await addDomain(OWNER, "two", { host, port: 8003 });
      await settles(host, "/", answeredBy("two"));

      // Its last domain: a routing file with nothing in it would make Traefik refuse every other file.
      await removeDomain(OWNER, "two", last.id);
      await settles(host, "/", unserved);

      const later = `later.${DOMAIN}`;
      const route = await addDomain(OWNER, "one", { host: later, port: 8001 });
      await settles(later, "/", answeredBy("one"));
      await removeDomain(OWNER, "one", route.id);
    },
    SLOW,
  );

  it(
    "refuses a claim on a route another project holds, and the holder keeps its traffic",
    async () => {
      const host = `held.${DOMAIN}`;
      const held = await addDomain(OWNER, "one", { host, port: 8001 });
      await settles(host, "/admin", answeredBy("one"));

      const failure = await addDomain(RIVAL, "rival", { host, path: "/admin", port: 8004 }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ApiFailure);
      expect((failure as ApiFailure).status).toBe(409);
      expect((failure as ApiFailure).body).not.toContain(OWNER);
      expect((await get(host, "/admin")).body).toContain("name=one ");

      await removeDomain(OWNER, "one", held.id);
    },
    SLOW,
  );

  it(
    "reports a missing port and a bad upstream certificate, and reaches one it can verify",
    async () => {
      const closed = await addDomain(OWNER, "one", { host: `closed.${DOMAIN}`, port: 9 });
      await settles(`closed.${DOMAIN}`, "/", (reply) => reply.status === 502);

      // Nothing vouches for this certificate, so the request must fail rather than go through.
      const upstream = { destinationProtocol: "https", port: 8443 };
      const unknown = await addDomain(OWNER, "secure", { host: `unknown.${DOMAIN}`, ...upstream });
      const untrusted = await settles(`unknown.${DOMAIN}`, "/", (reply) => reply.status >= 500);
      expect(unserved(untrusted)).toBe(true);

      // The right name and the right authority: verified, not waved through.
      const trust = { upstreamServerName: "backend.internal", upstreamCa: certificates.ca };
      const verified = await addDomain(OWNER, "secure", {
        host: `verified.${DOMAIN}`,
        ...upstream,
        ...trust,
      });
      await settles(`verified.${DOMAIN}`, "/", answeredBy("secure"));

      // The right authority for the wrong name is still a bad certificate.
      const wrongName = await addDomain(OWNER, "secure", {
        host: `wrong.${DOMAIN}`,
        ...upstream,
        upstreamServerName: "other.internal",
        upstreamCa: certificates.ca,
      });
      expect(unserved(await settles(`wrong.${DOMAIN}`, "/", (reply) => reply.status >= 500))).toBe(true);

      await removeDomain(OWNER, "one", closed.id);
      await removeDomain(OWNER, "secure", unknown.id);
      await removeDomain(OWNER, "secure", verified.id);
      await removeDomain(OWNER, "secure", wrongName.id);
    },
    SLOW,
  );

  it(
    "redirects HTTP to HTTPS once, tells the backend, and refuses rules that would go round",
    async () => {
      const host = `upgrade.${DOMAIN}`;
      const route = await addDomain(OWNER, "one", { host, https: true, port: 8001 });

      // The catch-all redirects any HTTP request too, so only HTTPS can say the route has loaded.
      const arrived = await settles(host, "/x?a=1", answeredBy("one"), "https");
      // A backend that forces HTTPS relies on this, or it would redirect straight back.
      expect(arrived.body).toContain("proto=https");
      expect(arrived.body).toContain("uri=/x?a=1 ");

      const first = await get(host, "/x?a=1");
      expect(first.status).toBeGreaterThanOrEqual(300);
      expect(first.status).toBeLessThan(400);
      expect(first.location).toBe(`https://${host}/x?a=1`);

      const url = serviceUrl(OWNER, "one");
      await api(`${url}/redirects`, "POST", { regex: "^(https://[^/]+)/first$", replacement: "$1/second" });
      const failure = await api(`${url}/redirects`, "POST", {
        regex: "^(https://[^/]+)/second$",
        replacement: "$1/first",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApiFailure);
      expect((failure as ApiFailure).status).toBe(400);
      expect((failure as ApiFailure).body).toContain("redirect_loop");

      await removeDomain(OWNER, "one", route.id);
    },
    SLOW,
  );
});
