import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isValidHostname, resourceName } from "@opsifier/contract";
import { parse, stringify } from "yaml";

/** Generated files stay flat: an alias in a routing file helps nobody reading it. */
const toYaml = (config: object): string => stringify(config, { aliasDuplicateObjects: false });

export const BASE_FILE = "_base.yaml";
const DEFAULT_PANEL_UPSTREAM = "http://opsifier:3000";
const DEFAULT_CERT_RESOLVER = "letsencrypt";
const DEFAULT_FILE_MODE = 0o640;

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
  /** More hostnames the panel answers on. */
  panelHosts?: readonly string[];
  /** Panel hostnames served by a wildcard certificate, which need a router of their own. */
  wildcardCertificateHosts?: readonly string[];
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

  const hosts = [
    ...new Set([...(input.panelHost === undefined ? [] : [input.panelHost]), ...(input.panelHosts ?? [])]),
  ];
  const wildcardHosts = [...new Set(input.wildcardCertificateHosts ?? [])];
  if (hosts.length === 0 && wildcardHosts.length === 0) {
    return stringify({ http: { middlewares, routers, services, serversTransports } });
  }

  [...hosts, ...wildcardHosts].forEach(assertHostname);
  const panelRouters = (name: string, group: readonly string[]) => {
    if (group.length === 0) {
      return {};
    }
    const rule = group.map((host) => `Host(\`${host}\`)`).join(" || ");
    return {
      [`${name}-http`]: {
        rule,
        entryPoints: ["web"],
        middlewares: [REDIRECT_HTTPS_MIDDLEWARE],
        service: PANEL_SERVICE,
      },
      [name]: {
        rule,
        entryPoints: ["websecure"],
        service: PANEL_SERVICE,
        tls: { certResolver: input.certResolver ?? DEFAULT_CERT_RESOLVER },
      },
    };
  };
  return stringify({
    http: {
      middlewares,
      routers: {
        ...routers,
        ...panelRouters("opsifier-panel", hosts),
        ...panelRouters("opsifier-panel-address", wildcardHosts),
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

/** Writes a complete, flushed file under a name Traefik ignores. Nobody sees it until it is renamed. */
async function writeTemporary(path: string, contents: string, mode = DEFAULT_FILE_MODE): Promise<string> {
  // Traefik's file provider ignores names that do not end in .yaml, .yml or .toml.
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Writes to a temporary file, then renames, so a reader only ever sees a complete file, and a disk
 * that fills up partway leaves the old one exactly as it was.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  mode = DEFAULT_FILE_MODE,
): Promise<void> {
  const temporary = await writeTemporary(path, contents, mode);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}

/** Decides what each routing file may contain. Every file reaches the disk through it. */
export interface ProxyGuard {
  /** What may be written for one routing file. Throwing refuses the write. */
  apply(file: string, config: unknown): object;
  /** A routing file has been removed, along with whatever the guard kept for it. */
  forget?(file: string): void;
}

/** One change to every routing file together, and the state those files reflect. */
export interface RewritePlan {
  /** What one file should become. Pure. Throwing abandons the whole change before anything moved. */
  render(file: string, config: unknown): object;
  /** Stores the state the new files reflect. */
  commit(): void;
  /** Puts that state back, when the files could not follow it. */
  revert(): void;
  /**
   * Protection is being added: the state is stored before the files change, so a crash midway comes
   * back protected, and `_base.yaml` goes first, so nothing points at a middleware not there yet.
   * Otherwise the state is stored last and `_base.yaml` changes last, for the same two reasons.
   */
  protecting: boolean;
}

export interface RoutingFile {
  file: string;
  /** Null when the file could not be read or is not valid YAML. */
  config: unknown;
}

interface StagedFile {
  file: string;
  before: string;
  temporary: string;
}

function hasNoRoutes(config: object): boolean {
  const { http } = config as { http?: { routers?: object } };
  return http !== undefined && Object.keys(http.routers ?? {}).length === 0;
}

export class ProxyFiles {
  /** One operation at a time across every file, so a rewrite of all of them can't be overtaken. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dynamicDir: string,
    private readonly guard: ProxyGuard,
  ) {}

  async writeBase(input: BaseProxyConfig = {}): Promise<void> {
    return this.enqueue(BASE_FILE, renderBaseConfig(input));
  }

  /**
   * Stores a service's compiled Traefik configuration. Traefik refuses a whole directory over one
   * empty `routers:`, and then keeps its old routes, so a service with no routes has no file at all.
   */
  async writeService(project: string, service: string, config: object): Promise<void> {
    if (hasNoRoutes(config)) {
      return this.removeService(project, service);
    }
    return this.enqueue(serviceFileName(project, service), stringify(config));
  }

  /** Writes one of the panel's own routing files, whose name starts with an underscore. */
  async writeOwnFile(name: string, config: object | string): Promise<void> {
    return this.enqueue(ownFileName(name), typeof config === "string" ? config : stringify(config));
  }

  /** Removing a file that does not exist is not an error. */
  async removeOwnFile(name: string): Promise<void> {
    const file = ownFileName(name);
    return this.serialize(() => rm(join(this.dynamicDir, file), { force: true }));
  }

  /** Removing a file that does not exist is not an error. */
  async removeService(project: string, service: string): Promise<void> {
    const name = serviceFileName(project, service);
    return this.serialize(async () => {
      await rm(join(this.dynamicDir, name), { force: true });
      this.guard.forget?.(name);
    });
  }

  /** Every routing file as it stands on disk, for reporting what the proxy was really given. */
  async readAll(): Promise<RoutingFile[]> {
    const files = await this.routingFiles();
    return Promise.all(
      files.map(async (file) => {
        try {
          return {
            file,
            config: (parse(await readFile(join(this.dynamicDir, file), "utf8")) ?? {}) as unknown,
          };
        } catch {
          return { file, config: null };
        }
      }),
    );
  }

  /**
   * Changes every routing file together. All that can fail slowly happens first, into files Traefik
   * ignores, so by the time a real file changes, only one rename per file is left to do. A failure at
   * any point leaves the previous files, and the previous state, in place.
   */
  async rewriteAll(makePlan: () => RewritePlan | Promise<RewritePlan>): Promise<void> {
    return this.serialize(async () => {
      const plan = await makePlan();
      await this.swap(await this.stage(plan), plan);
    });
  }

  /**
   * Brings each file in line with `render` on its own, for startup, when there is no earlier state
   * to go back to. Returns the files it could not bring in line.
   */
  async reconcile(render: (file: string, config: unknown) => object): Promise<string[]> {
    return this.serialize(async () => {
      const failed: string[] = [];
      for (const file of await this.routingFiles()) {
        const path = join(this.dynamicDir, file);
        try {
          const before = await readFile(path, "utf8");
          const after = toYaml(render(file, parse(before)));
          if (after !== before) {
            await writeFileAtomic(path, after);
          }
        } catch {
          failed.push(file);
        }
      }
      return failed;
    });
  }

  /** Removes a routing file, for one that can't be made safe. A route that does not exist is closed. */
  async discard(file: string): Promise<void> {
    return this.serialize(() => rm(join(this.dynamicDir, file), { force: true }));
  }

  private async routingFiles(): Promise<string[]> {
    const names = await readdir(this.dynamicDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [] as string[];
      }
      throw error;
    });
    return names.filter((name) => !name.startsWith(".") && /\.ya?ml$/.test(name)).sort();
  }

  private async stage(plan: RewritePlan): Promise<StagedFile[]> {
    const staged: StagedFile[] = [];
    try {
      for (const file of await this.routingFiles()) {
        const path = join(this.dynamicDir, file);
        const before = await readFile(path, "utf8");
        const after = toYaml(plan.render(file, parse(before)));
        if (after !== before) {
          staged.push({ file, before, temporary: await writeTemporary(path, after) });
        }
      }
    } catch (error) {
      await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
      throw error;
    }
    return staged;
  }

  private async swap(staged: readonly StagedFile[], plan: RewritePlan): Promise<void> {
    const base = staged.filter(({ file }) => file === BASE_FILE);
    const others = staged.filter(({ file }) => file !== BASE_FILE);
    const ordered = plan.protecting ? [...base, ...others] : [...others, ...base];

    const swapped: StagedFile[] = [];
    try {
      if (plan.protecting) {
        plan.commit();
      }
      for (const entry of ordered) {
        await rename(entry.temporary, join(this.dynamicDir, entry.file));
        swapped.push(entry);
      }
      await syncDirectory(this.dynamicDir);
      if (!plan.protecting) {
        plan.commit();
      }
    } catch (error) {
      await Promise.all(ordered.map(({ temporary }) => rm(temporary, { force: true })));
      await this.restore(swapped, plan);
      plan.revert();
      throw error;
    }
  }

  /**
   * Puts swapped files back. While protection stands, a file that can't be put back is removed
   * instead: a missing route is closed, and an unprotected one would be open.
   */
  private async restore(swapped: readonly StagedFile[], plan: RewritePlan): Promise<void> {
    for (const entry of [...swapped].reverse()) {
      const path = join(this.dynamicDir, entry.file);
      try {
        await writeFileAtomic(path, entry.before);
      } catch (error) {
        if (plan.protecting) {
          throw error;
        }
        await rm(path, { force: true });
      }
    }
  }

  /** The one way into the directory, which is what makes the guard unavoidable. */
  private enqueue(name: string, contents: string): Promise<void> {
    return this.serialize(async () => {
      const guarded = toYaml(this.guard.apply(name, parse(contents)));
      await mkdir(this.dynamicDir, { recursive: true, mode: 0o755 });
      await writeFileAtomic(join(this.dynamicDir, name), guarded);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const OWN_FILE = /^_[a-z0-9-]+\.yaml$/;

/** `_base.yaml` belongs to `writeBase`, and everything else needs the leading underscore. */
function ownFileName(name: string): string {
  if (!OWN_FILE.test(name) || name === BASE_FILE) {
    throw new InvalidProxyInputError(`Invalid name for a routing file: ${JSON.stringify(name)}.`);
  }
  return name;
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
