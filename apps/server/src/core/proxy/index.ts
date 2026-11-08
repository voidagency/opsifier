import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isValidHostname, resourceName } from "@opsifier/contract";
import { stringify } from "yaml";

export const BASE_FILE = "_base.yaml";
const DEFAULT_PANEL_UPSTREAM = "http://opsifier:3000";
const DEFAULT_CERT_RESOLVER = "letsencrypt";

/** Where the panel answers with the pages the proxy shows in place of a site. Public, no session. */
export const PROXY_PAGES_PREFIX = "/api/proxy-pages";

export const PANEL_SERVICE = "opsifier-panel";
export const REDIRECT_HTTPS_MIDDLEWARE = "opsifier-redirect-https";
export const BAD_GATEWAY_MIDDLEWARE = "opsifier-error-bad-gateway";
export const STOPPED_MIDDLEWARE = "opsifier-error-stopped";
const NOT_FOUND_MIDDLEWARE = "opsifier-error-not-found";
/** Backends speaking HTTPS on the private network: their certificates can't name the service. */
export const BACKEND_TLS_TRANSPORT = "opsifier-backend-tls";

export type ProxyPageName = "bad-gateway" | "not-found" | "stopped";

export const proxyPagePath = (name: ProxyPageName): string => `${PROXY_PAGES_PREFIX}/${name}`;

/** The page shown for one service while it is in maintenance. */
export const maintenancePagePath = (project: string, service: string): string =>
  `${PROXY_PAGES_PREFIX}/maintenance/${project}/${service}`;

export class InvalidProxyInputError extends Error {
  override readonly name = "InvalidProxyInputError";
}

/** Hostnames end up inside a Traefik rule, so only plain DNS names are let through. */
export function assertHostname(host: string): void {
  if (!isValidHostname(host)) {
    throw new InvalidProxyInputError(`Invalid hostname: ${JSON.stringify(host)}.`);
  }
}

export interface BaseProxyConfig {
  /** The hostname the panel answers on. Omit it until one has been configured. */
  panelHost?: string;
  /** Where Traefik reaches the panel on the shared network. */
  panelUpstream?: string;
  certResolver?: string;
}

/** Pages only the panel can produce, shown in place of a site the proxy can't reach or doesn't know. */
function errorPageMiddlewares(): Record<string, unknown> {
  const page = (name: ProxyPageName) => proxyPagePath(name);
  return {
    [BAD_GATEWAY_MIDDLEWARE]: {
      errors: { status: ["502"], service: PANEL_SERVICE, query: page("bad-gateway") },
    },
    [STOPPED_MIDDLEWARE]: {
      errors: { status: ["503"], service: PANEL_SERVICE, query: page("stopped") },
    },
    [NOT_FOUND_MIDDLEWARE]: { replacePath: { path: page("not-found") } },
  };
}

/** The lowest priority, so anything with a real route wins. HTTP goes through the redirect first. */
function catchAllRouters(): Record<string, unknown> {
  const rule = "HostRegexp(`.+`)";
  return {
    "opsifier-not-found-http": {
      rule,
      priority: 1,
      entryPoints: ["web"],
      middlewares: [REDIRECT_HTTPS_MIDDLEWARE],
      service: PANEL_SERVICE,
    },
    "opsifier-not-found-https": {
      rule,
      priority: 1,
      entryPoints: ["websecure"],
      middlewares: [NOT_FOUND_MIDDLEWARE],
      service: PANEL_SERVICE,
      tls: {},
    },
  };
}

function assertUpstream(upstream: string): void {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new InvalidProxyInputError(`Invalid upstream: ${JSON.stringify(upstream)}.`);
  }
  if (url.protocol !== "http:" || url.username !== "" || url.pathname !== "/" || url.search !== "") {
    throw new InvalidProxyInputError(`Invalid upstream: ${JSON.stringify(upstream)}.`);
  }
}

/** The panel's own routes and the middlewares shared by every service. Pure: no I/O. */
export function renderBaseConfig(input: BaseProxyConfig = {}): string {
  const panelUpstream = input.panelUpstream ?? DEFAULT_PANEL_UPSTREAM;
  assertUpstream(panelUpstream);

  const middlewares = {
    [REDIRECT_HTTPS_MIDDLEWARE]: { redirectScheme: { scheme: "https", permanent: true } },
    "opsifier-compress": { compress: {} },
    ...errorPageMiddlewares(),
  };
  const routers = catchAllRouters();
  const services = {
    [PANEL_SERVICE]: { loadBalancer: { passHostHeader: true, servers: [{ url: panelUpstream }] } },
  };
  const serversTransports = { [BACKEND_TLS_TRANSPORT]: { insecureSkipVerify: true } };

  if (input.panelHost === undefined) {
    return stringify({ http: { middlewares, routers, services, serversTransports } });
  }

  assertHostname(input.panelHost);
  const rule = `Host(\`${input.panelHost}\`)`;
  return stringify({
    http: {
      middlewares,
      routers: {
        ...routers,
        "opsifier-panel-http": {
          rule,
          entryPoints: ["web"],
          middlewares: [REDIRECT_HTTPS_MIDDLEWARE],
          service: PANEL_SERVICE,
        },
        "opsifier-panel": {
          rule,
          entryPoints: ["websecure"],
          service: PANEL_SERVICE,
          tls: { certResolver: input.certResolver ?? DEFAULT_CERT_RESOLVER },
        },
      },
      services,
      serversTransports,
    },
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes to a temporary file, then renames, so a reader only ever sees a complete file. */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  // Traefik's file provider ignores names that do not end in .yaml, .yml or .toml.
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o640);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

export class ProxyFiles {
  /** Writes to one file happen in the order they were requested. */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly dynamicDir: string) {}

  async writeBase(input: BaseProxyConfig = {}): Promise<void> {
    return this.enqueue(BASE_FILE, renderBaseConfig(input));
  }

  /** Stores a service's compiled Traefik configuration. */
  async writeService(project: string, service: string, config: object): Promise<void> {
    return this.enqueue(serviceFileName(project, service), stringify(config));
  }

  /** Removing a file that does not exist is not an error. */
  async removeService(project: string, service: string): Promise<void> {
    const name = serviceFileName(project, service);
    return this.serialize(name, () => rm(join(this.dynamicDir, name), { force: true }));
  }

  private enqueue(name: string, contents: string): Promise<void> {
    return this.serialize(name, async () => {
      await mkdir(this.dynamicDir, { recursive: true, mode: 0o755 });
      await writeFileAtomic(join(this.dynamicDir, name), contents);
    });
  }

  private serialize(name: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(name, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(name) === next) {
          this.tails.delete(name);
        }
      });
    return next;
  }
}

/**
 * Names may contain `_`, so the `__` separator is only unambiguous if neither side contains
 * one: otherwise `a__b` + `c` and `a` + `b__c` would map to the same file.
 */
export function serviceFileName(project: string, service: string): string {
  for (const name of [project, service]) {
    if (!resourceName.safeParse(name).success || name.includes("__")) {
      throw new InvalidProxyInputError(`Invalid name for a routing file: ${JSON.stringify(name)}.`);
    }
  }
  return `${project}__${service}.yaml`;
}
