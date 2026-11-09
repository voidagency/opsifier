import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionEntry,
  OpsifierAddressState,
  PanelDomainSettings,
  ServiceDomainSettings,
  SetServerPurposeResult,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../core/config";
import type { DbHandle } from "../../core/db";
import { ProxyFiles } from "../../core/proxy";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { defaultPanelDomain } from "../server/panel-host";
import { renderProxyEnv, saveProxyEnvironment } from "../server/proxy";
import { protectionGuard } from "../server-purpose/service";
import { defaultBaseDomain } from "../service-tabs/domains/service";
import { getSetting, putSetting } from "../system/repo";
import {
  ADDRESS_RESOLVER,
  addressCertificatesGuard,
  applyAddressCertificates,
  isCoveredByWildcard,
} from "./certificates";
import { NamesServiceError, registerServer } from "./client";
import { ADDRESS_SECRET_CONTEXT, type RegisteredAddress, readAddress, saveAddress } from "./repo";
import { getAddressState, reconcileAddress, sendDueHeartbeat } from "./service";

const NAMES_URL = "https://names.test";
const ID = "bcdfghjk";
const SECRET = "s".repeat(43);
/** Not opsifier.dev on purpose: the suffix has to come from the answer. */
const DOMAIN = `${ID}.addresses.example`;
const WILDCARD = `*.${DOMAIN}`;
/** A self-signed certificate for WILDCARD, valid for a hundred years, as Traefik stores it: base64 of the PEM. */
const WILDCARD_CERTIFICATE =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJyakNDQVZPZ0F3SUJBZ0lVTFdqOTN2Z1MzNUNHWjVvaHBpQUx2TnkwMHlRd0NnWUlLb1pJemowRUF3SXcKSnpFbE1DTUdBMVVFQXd3Y0tpNWlZMlJtWjJocWF5NWhaR1J5WlhOelpYTXVaWGhoYlhCc1pUQWdGdzB5TmpFeApNRGt3TURBNU1qRmFHQTh5TVRJMk1UQXhOakF3TURreU1Wb3dKekVsTUNNR0ExVUVBd3djS2k1aVkyUm1aMmhxCmF5NWhaR1J5WlhOelpYTXVaWGhoYlhCc1pUQlpNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VIQTBJQUJBWlgKQ2VoYnc5enNNVkFnekxINlU5UnhMSHNQNFBUQXhNSTBDVEc1STBhQmsvMjVBMjA1eWh0QnlodUdaY01VcUZwdgp2V1ZuSFIvSkRKdGw3Tkw3UlArald6QlpNQjBHQTFVZERnUVdCQlFXeW5RRHhWVUh5Z0h1WXBhSnBYNXpuWFF6CjZ6QVBCZ05WSFJNQkFmOEVCVEFEQVFIL01DY0dBMVVkRVFRZ01CNkNIQ291WW1Oa1ptZG9hbXN1WVdSa2NtVnoKYzJWekxtVjRZVzF3YkdVd0NnWUlLb1pJemowRUF3SURTUUF3UmdJaEFMb0NuQXBCMlg0eWE0UGE1blhpV3U4RQpNS0o1b2FWcmc2OGwxTFd1MDVid0FpRUFqdi90SWdDczNNbHJUNjhGTnlDVXFwb0g0dENlam1KRTFRcU9FWkF6ClJQMD0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";
const DAY = 86_400_000;
const PROXY = "opsifier-traefik";

interface NamesCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const registered = (overrides: Record<string, unknown> = {}) =>
  answer(201, { id: ID, secret: SECRET, domain: DOMAIN, ip: "93.184.216.34", ...overrides });

function stubNames(respond: (call: NamesCall) => Response | Promise<Response>): NamesCall[] {
  const calls: NamesCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const entry: NamesCall = {
        method: init?.method ?? "GET",
        path: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body,
      };
      calls.push(entry);
      return respond(entry);
    }),
  );
  return calls;
}

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext({ env: { OPSIFIER_NAMES_URL: NAMES_URL } });
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

const api = <T = unknown>(method: string, path: string, body?: unknown) =>
  call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });

const ROUTE = "/api/v1/server/opsifier-address";
const state = () => api<OpsifierAddressState>("GET", ROUTE);
const register = () => api<OpsifierAddressState>("POST", `${ROUTE}/register`);
const release = (confirm = DOMAIN) => api<OpsifierAddressState>("DELETE", ROUTE, { confirm });

const storedAddress = () => readAddress(context.deps.db) as RegisteredAddress;
const secretFile = () => join(context.dataDir, "traefik", "opsifier-address.secret");
const routingFile = (name: string) =>
  parse(readFileSync(join(context.dataDir, "traefik", "dynamic", name), "utf8"));

async function createService(project = "shop", service = "web") {
  await api("POST", "/api/v1/projects", { name: project });
  await api("POST", `/api/v1/projects/${project}/services`, { name: service });
}

const serviceDomains = async (project = "shop", service = "web") =>
  (
    await api<{ domains: Array<{ host: string }> }>(
      "GET",
      `/api/v1/projects/${project}/services/${service}/domains`,
    )
  ).body.domains;

function installProxy() {
  return context.docker.createService({
    Name: PROXY,
    TaskTemplate: {
      ContainerSpec: {
        Image: "traefik:3",
        Mounts: [{ Type: "bind", Source: join(context.dataDir, "traefik"), Target: "/etc/traefik" }],
      },
    },
    Mode: { Replicated: { Replicas: 1 } },
  });
}

async function latestProxyAction(): Promise<ActionEntry | undefined> {
  const { body } = await api<{ items: ActionEntry[] }>("GET", "/api/v1/actions");
  return body.items.find((item) => item.type === "proxy.restart");
}

async function proxyEnv(): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const action = await latestProxyAction();
    if (action !== undefined && action.status !== "queued" && action.status !== "running") {
      expect(action.status).toBe("succeeded");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return (await context.docker.inspectService(PROXY))?.spec.TaskTemplate.ContainerSpec.Env ?? [];
}

describe("the configured service", () => {
  const namesUrl = (value?: string) =>
    loadConfig(value === undefined ? {} : { OPSIFIER_NAMES_URL: value }).namesUrl;

  it("is names.opsifier.dev unless told otherwise", () => {
    expect(namesUrl()).toBe("https://names.opsifier.dev");
  });

  it("can be moved, without its trailing slash", () => {
    expect(namesUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(namesUrl("https://names.example/base/")).toBe("https://names.example/base");
  });

  it("can be turned off", () => {
    expect(namesUrl("off")).toBeNull();
  });

  it.each(["ftp://names.example", "not a url", "https://user:pw@names.example", "https://names.example?x=1"])(
    "treats %j as off, and never stops the server for it",
    (value) => {
      expect(namesUrl(value)).toBeNull();
    },
  );
});

describe("registering from Settings", () => {
  it("starts with no address", async () => {
    const { body } = await state();

    expect(body).toMatchObject({
      status: "off",
      available: true,
      domain: null,
      panelUrl: "https://panel.203.0.113.10.sslip.io",
    });
  });

  it("says when this server was told never to call the service", async () => {
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_NAMES_URL: "off" } });
    cookie = await setupAdmin(context.app);
    const calls = stubNames(() => registered());

    expect((await state()).body.available).toBe(false);
    const result = await register();

    expect(result.status).toBe(409);
    expect(apiErrorOf(result)?.code).toBe("address_service_off");
    expect(calls).toEqual([]);
  });

  it("stores the ID and the secret sealed, never in the clear", async () => {
    stubNames(() => registered());

    const result = await register();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "active", domain: DOMAIN, wildcard: WILDCARD });
    const stored = storedAddress();
    expect(stored.id).toBe(ID);
    expect(JSON.stringify(getSetting(context.deps.db, "opsifier_address"))).not.toContain(SECRET);
    expect(context.deps.secrets.unseal(stored.sealedSecret, ADDRESS_SECRET_CONTEXT)).toBe(SECRET);
  });

  it("never sends the secret back", async () => {
    stubNames(() => registered());

    const result = await register();

    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    expect(JSON.stringify((await state()).body)).not.toContain(SECRET);
  });

  it("makes the address the default for the panel and for new services", async () => {
    stubNames(() => registered());
    await register();

    const panel = await api<PanelDomainSettings>("GET", "/api/v1/server/panel-domain");
    const services = await api<ServiceDomainSettings>("GET", "/api/v1/server/service-domain");

    expect(panel.body.defaultDomain).toBe(`panel.${DOMAIN}`);
    expect(services.body.defaultDomain).toBe(`*.${DOMAIN}`);
    expect(services.body.customDomain).toBeNull();

    await createService();
    expect(await serviceDomains()).toEqual([expect.objectContaining({ host: `shop-web.${DOMAIN}` })]);
  });

  it("leaves the owner's own domains ahead of it", async () => {
    stubNames(() => registered());
    await register();
    await api("PUT", "/api/v1/server/service-domain", { customDomain: "apps.example.com" });

    await createService();

    expect(await serviceDomains()).toEqual([expect.objectContaining({ host: "shop-web.apps.example.com" })]);
  });

  it("takes the DNS suffix from the answer, whatever it is", async () => {
    stubNames(() => registered({ domain: `${ID}.other.example` }));

    const result = await register();

    expect(result.body.domain).toBe(`${ID}.other.example`);
    expect(routingFile("_base.yaml").http.routers["opsifier-panel-address"].rule).toContain(
      `panel.${ID}.other.example`,
    );
  });

  it("gives Traefik its secret in a file only it and root can read", async () => {
    stubNames(() => registered());

    await register();

    expect(readFileSync(secretFile(), "utf8")).toBe(SECRET);
    expect(statSync(secretFile()).mode & 0o777).toBe(0o600);
  });

  it("restarts the proxy with the DNS resolver, and keeps the secret out of its environment", async () => {
    await installProxy();
    stubNames(() => registered());

    await register();
    const env = await proxyEnv();

    expect(env).toEqual(
      expect.arrayContaining([
        "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME_DNSCHALLENGE_PROVIDER=httpreq",
        "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME_DNSCHALLENGE_PROPAGATION_DELAYBEFORECHECKS=90s",
        "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME_STORAGE=/etc/traefik/acme.json",
        `HTTPREQ_ENDPOINT=${NAMES_URL}/v1/acme`,
        `HTTPREQ_USERNAME=${ID}`,
        "HTTPREQ_PASSWORD_FILE=/etc/traefik/opsifier-address.secret",
      ]),
    );
    expect(env.join("\n")).not.toContain(SECRET);
    // Certificates for domains the owner brings still come from the HTTP challenge.
    expect(env).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_HTTPCHALLENGE_ENTRYPOINT=web");
  });

  it("does nothing to the proxy when it isn't installed", async () => {
    stubNames(() => registered());

    await register();

    expect(await latestProxyAction()).toBeUndefined();
  });

  it("changes nothing when the service fails or can't be reached", async () => {
    stubNames(() => answer(503, { error: { code: "unavailable" } }));

    const failed = await register();

    expect(failed.status).toBe(502);
    expect(apiErrorOf(failed)?.code).toBe("address_service_failed");
    expect(readAddress(context.deps.db)).toBeNull();
    expect(existsSync(secretFile())).toBe(false);
  });

  it("refuses an answer that doesn't hold together", async () => {
    for (const bad of [
      () => registered({ domain: "someone-else.example.com" }),
      () => registered({ domain: `${ID}` }),
      () => registered({ secret: "short" }),
      () => registered({ ip: "not an ip" }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      stubNames(bad);

      expect((await register()).status).toBe(502);
      expect(readAddress(context.deps.db)).toBeNull();
    }
  });

  it("is limited to one at a time", async () => {
    let finish: (value: Response) => void = () => {};
    stubNames(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );

    const first = register();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    const second = await register();
    finish(registered());

    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });

  it("is for an administrator's session only", async () => {
    stubNames(() => registered());

    expect((await call(context.app, ROUTE, {})).status).toBe(401);

    const created = await api<{ token: string }>("POST", "/api/v1/me/api-keys", {
      name: "ci",
      level: "write",
    });
    const withKey = await call(context.app, `${ROUTE}/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.body.token}` },
    });

    expect(withKey.status).toBe(403);
    expect(readAddress(context.deps.db)).toBeNull();
  });
});

describe("the requests themselves", () => {
  it("register with nothing identifying in them", async () => {
    const calls = stubNames(() => registered());

    await register();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/servers" });
    expect(calls[0]?.body).toBeUndefined();
    expect(Object.keys(calls[0]?.headers ?? {}).sort()).toEqual(["accept", "user-agent"]);
    expect(calls[0]?.headers["user-agent"]).toBe("opsifier");
  });

  it("never follow a redirect or wait for ever", async () => {
    const spy = vi.fn(async () => registered());
    vi.stubGlobal("fetch", spy);

    await registerServer(NAMES_URL);

    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turn a timeout into a failure that says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    await expect(registerServer(NAMES_URL)).rejects.toMatchObject({
      kind: "unreachable",
      message: expect.stringContaining("in time"),
    });
  });

  it("report a refusal by kind", async () => {
    stubNames(() => answer(401, {}));
    await expect(registerServer(NAMES_URL)).rejects.toBeInstanceOf(NamesServiceError);
  });
});

describe("releasing", () => {
  beforeEach(async () => {
    stubNames(() => registered());
    await register();
  });

  it("needs the address typed, and says so on the server", async () => {
    const result = await release("something else");

    expect(result.status).toBe(409);
    expect(apiErrorOf(result)?.code).toBe("confirmation_mismatch");
    expect(storedAddress().id).toBe(ID);
  });

  it("tells the service, with this server's own credentials", async () => {
    const calls = stubNames(() => answer(200, { id: ID, released: true }));

    await release();

    expect(calls[0]).toMatchObject({ method: "DELETE", path: `/v1/servers/${ID}` });
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`,
    );
  });

  it("goes back to generated names, and moves what was under the address", async () => {
    await createService();
    stubNames(() => answer(200, {}));

    const result = await release();

    expect(result.body).toMatchObject({ status: "off", domain: null });
    expect(await serviceDomains()).toEqual([
      expect.objectContaining({ host: "shop-web.203.0.113.10.sslip.io" }),
    ]);
    const panel = await api<PanelDomainSettings>("GET", "/api/v1/server/panel-domain");
    expect(panel.body.defaultDomain).toBe("panel.203.0.113.10.sslip.io");
  });

  it("removes Traefik's secret and the resolver", async () => {
    await installProxy();
    stubNames(() => registered());
    stubNames(() => answer(200, {}));

    await release();

    expect(existsSync(secretFile())).toBe(false);
    expect((await proxyEnv()).some((line) => line.startsWith("HTTPREQ_"))).toBe(false);
  });

  it("still lets go when the service can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await release();

    expect(result.status).toBe(200);
    expect(readAddress(context.deps.db)).toMatchObject({ status: "off" });
  });

  it("is remembered as a decision", async () => {
    stubNames(() => answer(200, {}));
    await release();

    expect(readAddress(context.deps.db)?.status).toBe("off");
    expect((await state()).body.status).toBe("off");
  });

  it("refuses when there is nothing to release", async () => {
    stubNames(() => answer(200, {}));
    await release();

    expect((await release()).status).toBe(409);
  });
});

describe("registering again", () => {
  const NEW_ID = "mnpqrstv";
  const NEW_DOMAIN = `${NEW_ID}.addresses.example`;

  it("moves every name to the new address, then lets go of the old one", async () => {
    stubNames(() => registered());
    await register();
    await createService();

    const calls = stubNames((entry) =>
      entry.method === "POST"
        ? registered({ id: NEW_ID, secret: "n".repeat(43), domain: NEW_DOMAIN })
        : answer(200, {}),
    );
    const result = await register();

    expect(result.body.domain).toBe(NEW_DOMAIN);
    expect(await serviceDomains()).toEqual([expect.objectContaining({ host: `shop-web.${NEW_DOMAIN}` })]);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/servers",
      `DELETE /v1/servers/${ID}`,
    ]);
    expect(routingFile("shop__web.yaml").http.routers["https-shop_web-0"].tls.domains).toEqual([
      { main: `*.${NEW_DOMAIN}` },
    ]);
    expect(readFileSync(secretFile(), "utf8")).toBe("n".repeat(43));
  });

  it("keeps the old address when the new one can't be had", async () => {
    stubNames(() => registered());
    await register();
    stubNames(() => answer(429, {}));

    const result = await register();

    expect(result.status).toBe(502);
    expect(storedAddress().domain).toBe(DOMAIN);
    expect(readFileSync(secretFile(), "utf8")).toBe(SECRET);
  });
});

describe("the daily heartbeat", () => {
  beforeEach(async () => {
    stubNames(() => registered());
    await register();
  });

  it("waits a day after registering", async () => {
    const calls = stubNames(() => answer(200, { ip: "93.184.216.34" }));

    expect(await sendDueHeartbeat(context.deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("sends the server's credentials and nothing else, once a day", async () => {
    const calls = stubNames(() => answer(200, { ip: "151.101.1.69" }));
    context.advance(DAY);

    expect(await sendDueHeartbeat(context.deps)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PUT", path: `/v1/servers/${ID}` });
    expect(calls[0]?.body).toBeUndefined();
    expect(Object.keys(calls[0]?.headers ?? {}).sort()).toEqual(["accept", "authorization", "user-agent"]);
    expect(storedAddress()).toMatchObject({ ip: "151.101.1.69", health: "ok" });

    expect(await sendDueHeartbeat(context.deps)).toBe(false);
  });

  it("notices sooner after a restart, when asked to", async () => {
    stubNames(() => answer(200, { ip: "151.101.1.69" }));
    context.advance(2 * 3_600_000);

    expect(await sendDueHeartbeat(context.deps, 3_600_000)).toBe(true);
  });

  it("keeps the address when the service is unreachable, and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    context.advance(DAY);

    await sendDueHeartbeat(context.deps);

    expect(storedAddress()).toMatchObject({ domain: DOMAIN, health: "unreachable" });
    expect((await getAddressState(context.deps)).status).toBe("unreachable");
  });

  it("recovers on the next one that gets through", async () => {
    stubNames(() => answer(503, {}));
    context.advance(DAY);
    await sendDueHeartbeat(context.deps);
    stubNames(() => answer(200, { ip: "93.184.216.34" }));

    await sendDueHeartbeat(context.deps);

    expect(storedAddress().health).toBe("ok");
  });

  it("marks the address lost when the service no longer knows it, and offers it no more", async () => {
    stubNames(() => answer(401, {}));
    context.advance(DAY);

    await sendDueHeartbeat(context.deps);

    expect((await getAddressState(context.deps)).status).toBe("lost");
    expect(defaultBaseDomain(context.deps, context.deps.db)).toBe("203.0.113.10.sslip.io");
    expect(defaultPanelDomain(context.deps)).toBe("panel.203.0.113.10.sslip.io");
  });

  it("marks the address disabled, and stops asking", async () => {
    stubNames(() => answer(410, {}));
    context.advance(DAY);
    await sendDueHeartbeat(context.deps);

    expect((await getAddressState(context.deps)).status).toBe("disabled");

    const calls = stubNames(() => answer(200, { ip: "93.184.216.34" }));
    context.advance(DAY);
    expect(await sendDueHeartbeat(context.deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is never sent once the address is released", async () => {
    stubNames(() => answer(200, {}));
    await release();
    const calls = stubNames(() => answer(200, { ip: "93.184.216.34" }));
    context.advance(2 * DAY);

    expect(await sendDueHeartbeat(context.deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not bring back an address released while it was on the wire", async () => {
    let finish: (value: Response) => void = () => {};
    stubNames(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    context.advance(DAY);
    const beat = sendDueHeartbeat(context.deps);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    saveAddress(context.deps.db, { status: "off", at: new Date().toISOString() }, new Date());

    finish(answer(200, { ip: "93.184.216.34" }));
    await beat;

    expect(readAddress(context.deps.db)?.status).toBe("off");
  });
});

describe("at boot", () => {
  it("puts back Traefik's secret if it went missing", async () => {
    stubNames(() => registered());
    await register();
    const { rmSync } = await import("node:fs");
    rmSync(secretFile());

    await reconcileAddress(context.deps);

    expect(readFileSync(secretFile(), "utf8")).toBe(SECRET);
  });

  it("restarts the proxy if a change never reached it", async () => {
    stubNames(() => registered());
    await register();
    await installProxy();

    await reconcileAddress(context.deps);

    expect(await proxyEnv()).toContain(`HTTPREQ_USERNAME=${ID}`);
  });

  it("leaves a proxy that is already right alone", async () => {
    stubNames(() => registered());
    await installProxy();
    await register();
    await proxyEnv();
    const version = (await context.docker.inspectService(PROXY))?.version;

    await reconcileAddress(context.deps);

    expect((await context.docker.inspectService(PROXY))?.version).toBe(version);
  });
});

describe("the certificate of a route", () => {
  const router = (rule: string, tls: object = { certResolver: "letsencrypt" }) => ({
    http: { routers: { r: { rule, entryPoints: ["websecure"], service: "s", tls } } },
  });
  const tlsOf = (config: unknown) =>
    (config as { http: { routers: { r: { tls: unknown } } } }).http.routers.r.tls;

  it("is the wildcard for a name directly under the address", () => {
    expect(tlsOf(applyAddressCertificates(router(`Host(\`a.${DOMAIN}\`)`), DOMAIN))).toEqual({
      certResolver: ADDRESS_RESOLVER,
      domains: [{ main: WILDCARD }],
    });
  });

  it("is the wildcard for a route with a path too", () => {
    const rule = `Host(\`a.${DOMAIN}\`) && PathPrefix(\`/x\`)`;
    expect(tlsOf(applyAddressCertificates(router(rule), DOMAIN))).toMatchObject({
      certResolver: ADDRESS_RESOLVER,
    });
  });

  it.each([
    ["the address itself", `Host(\`${DOMAIN}\`)`],
    ["two labels down, which a wildcard can't cover", `Host(\`a.b.${DOMAIN}\`)`],
    ["somebody's own domain", "Host(`app.example.com`)"],
    ["a name that merely ends the same", `Host(\`a.x${DOMAIN}\`)`],
    ["a wildcard route", `HostRegexp(\`^[a-z0-9-]+\\.${DOMAIN.replaceAll(".", "\\.")}$\`)`],
    ["a rule mixing one of each", `Host(\`a.${DOMAIN}\`) || Host(\`app.example.com\`)`],
  ])("stays on the HTTP challenge for %s", (_name, rule) => {
    expect(tlsOf(applyAddressCertificates(router(rule), DOMAIN))).toEqual({ certResolver: "letsencrypt" });
  });

  it("stays on a resolver someone chose", () => {
    expect(
      tlsOf(applyAddressCertificates(router(`Host(\`a.${DOMAIN}\`)`, { certResolver: "mine" }), DOMAIN)),
    ).toEqual({
      certResolver: "mine",
    });
  });

  it("changes nothing with no address, or no TLS", () => {
    const config = router(`Host(\`a.${DOMAIN}\`)`);
    expect(applyAddressCertificates(config, null)).toBe(config);
    const plain = { http: { routers: { r: { rule: `Host(\`a.${DOMAIN}\`)` } } } };
    expect(applyAddressCertificates(plain, DOMAIN)).toEqual(plain);
  });

  it("recognizes coverage exactly", () => {
    expect(isCoveredByWildcard(`a.${DOMAIN}`, DOMAIN)).toBe(true);
    expect(isCoveredByWildcard(DOMAIN, DOMAIN)).toBe(false);
    expect(isCoveredByWildcard(`.${DOMAIN}`, DOMAIN)).toBe(false);
    expect(isCoveredByWildcard(`a.b.${DOMAIN}`, DOMAIN)).toBe(false);
  });

  it("appears under the address in the routing files of a real service", async () => {
    stubNames(() => registered());
    await register();
    await createService();

    const routers = routingFile("shop__web.yaml").http.routers;

    expect(routers["https-shop_web-0"].tls).toEqual({
      certResolver: ADDRESS_RESOLVER,
      domains: [{ main: WILDCARD }],
    });
  });

  it("keeps the HTTP challenge for a domain the owner brings", async () => {
    stubNames(() => registered());
    await register();
    await createService();

    await api("POST", "/api/v1/projects/shop/services/web/domains", {
      host: "www.example.com",
      path: "/",
      port: 80,
      https: true,
      destinationProtocol: "http",
      destinationPath: "/",
      certificateResolver: "",
      wildcard: false,
      middlewares: [],
    });

    expect(routingFile("shop__web.yaml").http.routers["https-shop_web-1"].tls).toEqual({
      certResolver: "letsencrypt",
      domains: [{ main: "www.example.com" }],
    });
  });

  it("keeps the panel on its own router under the address, apart from its custom domain", async () => {
    stubNames(() => registered());
    await register();
    await api("PUT", "/api/v1/server/panel-domain", { customDomain: "panel.example.com", serveOnIp: true });

    const routers = routingFile("_base.yaml").http.routers;

    expect(routers["opsifier-panel"].rule).toBe("Host(`panel.example.com`)");
    expect(routers["opsifier-panel"].tls).toEqual({ certResolver: "letsencrypt" });
    expect(routers["opsifier-panel-address"].rule).toBe(`Host(\`panel.${DOMAIN}\`)`);
    expect(routers["opsifier-panel-address"].tls).toEqual({
      certResolver: ADDRESS_RESOLVER,
      domains: [{ main: WILDCARD }],
    });
  });

  it("is reported as issued for every name the wildcard covers", async () => {
    stubNames(() => registered());
    await register();
    await createService();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(context.dataDir, "traefik"), { recursive: true });
    writeFileSync(
      join(context.dataDir, "traefik", "acme.json"),
      JSON.stringify({
        opsifier: { Certificates: [{ domain: { main: WILDCARD }, certificate: WILDCARD_CERTIFICATE }] },
      }),
    );

    const overview = await api<{ domains: Array<{ host: string; tls: string }> }>("GET", "/api/v1/domains");

    expect(overview.body.domains).toEqual([
      expect.objectContaining({ host: `shop-web.${DOMAIN}`, tls: "issued" }),
    ]);
    expect((await state()).body.certificate).toBe("issued");
  });
});

describe("on a server that isn't in production", () => {
  async function protectedWithAddress() {
    stubNames(() => registered());
    await register();
    const result = await api<SetServerPurposeResult>("PUT", "/api/v1/server-purpose", { purpose: "staging" });
    expect(result.body.state.purpose).toBe("staging");
    await createService();
  }

  const httpsRouter = () => routingFile("shop__web.yaml").http.routers["https-shop_web-0"];

  it("keeps a wildcard-certificate route behind the gate, with its robots.txt and header", async () => {
    await protectedWithAddress();

    const router = httpsRouter();

    expect(router.tls).toEqual({ certResolver: ADDRESS_RESOLVER, domains: [{ main: WILDCARD }] });
    expect(router.middlewares[0]).toBe("opsifier-protect-noindex");
    expect(router.middlewares).toContain("opsifier-protect-gate");
    const routers = routingFile("shop__web.yaml").http.routers;
    const robots = routers["opsifier-protect-robots-https-shop_web-0"];
    expect(robots.tls).toEqual({ certResolver: ADDRESS_RESOLVER, domains: [{ main: WILDCARD }] });
    expect(robots.rule).toContain(`Host(\`shop-web.${DOMAIN}\`)`);
  });

  it("reads it back from the file as protected", async () => {
    await protectedWithAddress();

    const { body } = await api<{
      domains: Array<{ host: string; status: string }>;
      problems: unknown[];
    }>("GET", "/api/v1/server-purpose");

    expect(body.domains).toEqual([
      expect.objectContaining({ host: `shop-web.${DOMAIN}`, status: "protected" }),
    ]);
    expect(body.problems).toEqual([]);
  });

  it("keeps the panel's own wildcard route tagged but ungated", async () => {
    await protectedWithAddress();

    const routers = routingFile("_base.yaml").http.routers;

    expect(routers["opsifier-panel-address"].middlewares).toEqual(["opsifier-protect-noindex"]);
    expect(routers["opsifier-panel-address-http"].middlewares[0]).toBe("opsifier-protect-noindex");
  });

  it("keeps the certificate through a change of purpose and back, losing no protection", async () => {
    await protectedWithAddress();
    const { body } = await api<{ confirmation: string }>("GET", "/api/v1/server-purpose");

    await api("PUT", "/api/v1/server-purpose", { purpose: "production", confirm: body.confirmation });
    expect(httpsRouter().tls.certResolver).toBe(ADDRESS_RESOLVER);
    expect(httpsRouter().middlewares ?? []).not.toContain("opsifier-protect-gate");

    await api("PUT", "/api/v1/server-purpose", { purpose: "development" });
    expect(httpsRouter().tls.certResolver).toBe(ADDRESS_RESOLVER);
    expect(httpsRouter().middlewares).toContain("opsifier-protect-gate");
  });

  describe("the guard still fails closed", () => {
    const guarded = (db: DbHandle) =>
      addressCertificatesGuard(
        db,
        true,
        protectionGuard(db, () => Date.now()),
      );
    const route = {
      http: {
        routers: {
          r: {
            rule: `Host(\`a.${DOMAIN}\`)`,
            entryPoints: ["websecure"],
            service: "s",
            tls: { certResolver: "letsencrypt" },
          },
        },
      },
    };

    it("adds the gate after retargeting the certificate, in that order", async () => {
      stubNames(() => registered());
      await register();
      await api("PUT", "/api/v1/server-purpose", { purpose: "staging" });

      const result = guarded(context.deps.db).apply("shop__web.yaml", route) as typeof route & {
        http: { routers: { r: { middlewares: string[]; tls: object } } };
      };

      expect(result.http.routers.r.tls).toMatchObject({ certResolver: ADDRESS_RESOLVER });
      expect(result.http.routers.r.middlewares).toContain("opsifier-protect-gate");
    });

    it("protects a route even with no address, or a damaged one", async () => {
      await api("PUT", "/api/v1/server-purpose", { purpose: "staging" });
      putSetting(context.deps.db, "opsifier_address", { status: "registered", nonsense: true }, new Date());

      const result = guarded(context.deps.db).apply("shop__web.yaml", route) as {
        http: { routers: { r: { middlewares: string[]; tls: object } } };
      };

      expect(result.http.routers.r.middlewares).toContain("opsifier-protect-gate");
      expect(result.http.routers.r.tls).toEqual({ certResolver: "letsencrypt" });
    });

    it("protects when the purpose can't be read: no purpose is the strictest state", async () => {
      putSetting(context.deps.db, "server_protection", { nonsense: true }, new Date());

      const result = guarded(context.deps.db).apply("shop__web.yaml", route) as {
        http: { routers: { r: { middlewares: string[] } } };
      };

      expect(result.http.routers.r.middlewares).toContain("opsifier-protect-gate");
    });

    it("refuses the write rather than let an unreadable address skip the guard", async () => {
      const broken = {
        select: () => {
          throw new Error("The database went away");
        },
      } as unknown as DbHandle;
      const directory = join(context.dataDir, "guard-test");
      const files = new ProxyFiles(directory, guarded(broken));

      await expect(files.writeService("shop", "web", route)).rejects.toThrow("went away");

      expect(existsSync(join(directory, "shop__web.yaml"))).toBe(false);
    });

    it("refuses a route it can't protect", async () => {
      await api("PUT", "/api/v1/server-purpose", { purpose: "staging" });
      const directory = join(context.dataDir, "guard-test");
      const files = new ProxyFiles(directory, guarded(context.deps.db));

      await expect(
        files.writeService("shop", "web", { tcp: { routers: { t: { rule: "HostSNI(`*`)" } } } }),
      ).rejects.toThrow(/can't be protected/);

      expect(existsSync(join(directory, "shop__web.yaml"))).toBe(false);
    });

    it("leaves a stored address off the proxy when the service is turned off", async () => {
      await api("PUT", "/api/v1/server-purpose", { purpose: "staging" });
      stubNames(() => registered());
      await register();

      const offGuard = addressCertificatesGuard(
        context.deps.db,
        false,
        protectionGuard(context.deps.db, () => Date.now()),
      );
      const result = offGuard.apply("shop__web.yaml", route) as {
        http: { routers: { r: { tls: object; middlewares: string[] } } };
      };

      expect(result.http.routers.r.tls).toEqual({ certResolver: "letsencrypt" });
      expect(result.http.routers.r.middlewares).toContain("opsifier-protect-gate");
    });

    it("hands the guard's forget through", () => {
      const inner = { apply: (_file: string, config: unknown) => config as object, forget: vi.fn() };
      addressCertificatesGuard(context.deps.db, true, inner).forget?.("x.yaml");

      expect(inner.forget).toHaveBeenCalledWith("x.yaml");
    });
  });
});

describe("the proxy's environment", () => {
  const challenge = { namesUrl: NAMES_URL, id: ID, secretFile: "/t/opsifier-address.secret" };
  const base = { directory: "/t", email: "a@b.example", trustAll: false, entries: [] };

  it("adds nothing without an address", () => {
    const env = renderProxyEnv({ ...base, userEnv: "" });

    expect(env.some((line) => line.startsWith("HTTPREQ_"))).toBe(false);
    expect(env.some((line) => line.includes("OPSIFIER_ACME"))).toBe(false);
  });

  it("can't be overridden by what the owner set", () => {
    const env = renderProxyEnv({
      ...base,
      userEnv: "HTTPREQ_ENDPOINT=https://evil.example\n",
      addressChallenge: challenge,
    });

    expect(env).toContain(`HTTPREQ_ENDPOINT=${NAMES_URL}/v1/acme`);
    expect(env).not.toContain("HTTPREQ_ENDPOINT=https://evil.example");
  });

  it("refuses those names from the owner while an address is registered", async () => {
    stubNames(() => registered());
    await register();

    expect(() =>
      saveProxyEnvironment(context.deps, "HTTPREQ_ENDPOINT=https://evil.example\n", undefined),
    ).toThrow();
  });

  it("leaves those names to the owner with no address", () => {
    expect(() =>
      saveProxyEnvironment(context.deps, "HTTPREQ_ENDPOINT=https://mine.example\n", undefined),
    ).not.toThrow();
  });

  it("always keeps the panel's resolver name for itself", () => {
    expect(() =>
      saveProxyEnvironment(
        context.deps,
        "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME_EMAIL=x@y.example\n",
        undefined,
      ),
    ).toThrow();
  });
});
