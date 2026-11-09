import { randomBytes } from "node:crypto";
import type { Certificate, DomainsOverview, DomainTlsState, OverviewDomain } from "@opsifier/contract";
import { isValidRoutePath } from "@opsifier/contract";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { customDomains, domains } from "../../core/db/schema";
import { conflict, notFound } from "../../core/errors";
import { assertHostname, InvalidProxyInputError } from "../../core/proxy";
import { type Access, canSeeProject, meetsLevel } from "../access/rules";
import { listCertificates } from "../certificates/service";
import { assertHostAvailableForPanel } from "../server/panel-host";
import { findRouteConflict, sameRoute } from "../service-tabs/domains/repo";
import { toEntry } from "../service-tabs/domains/service";
import { routeRule, stripPathMiddleware, wildcardPriority } from "../services/compile/domains";
import { getSystemInfo } from "../system/service";

type CustomRow = typeof customDomains.$inferSelect;
type SaveFields = z.output<typeof import("@opsifier/contract").saveCustomDomainRequest>;

const CERT_RESOLVER = "letsencrypt";

/** A wildcard route needs a wildcard certificate. Any other host has its own name, or its parent's wildcard. */
function certificateCovers(certificate: Certificate, host: string, wildcard: boolean): boolean {
  const names = [certificate.domain, ...certificate.sans];
  return wildcard
    ? names.includes(`*.${host}`)
    : names.includes(host) || names.includes(`*.${host.slice(host.indexOf(".") + 1)}`);
}

/** From the best certificate covering this host, because one good certificate is all a request needs. */
function tlsStateFor(
  https: boolean,
  host: string,
  wildcard: boolean,
  certificates: readonly Certificate[],
): DomainTlsState {
  if (!https) {
    return "none";
  }
  const states = certificates
    .filter((certificate) => certificateCovers(certificate, host, wildcard))
    .map((certificate) => certificate.state);
  if (states.length === 0) {
    return wildcard ? "unverified" : "pending";
  }
  if (states.includes("valid")) {
    return "issued";
  }
  if (states.includes("expiring")) {
    return "expiring";
  }
  return states.includes("expired") ? "expired" : "unreadable";
}

function toCustomOverview(row: CustomRow, certificates: readonly Certificate[]): OverviewDomain {
  return {
    destination: "custom",
    id: row.id,
    host: row.host,
    path: row.path,
    stripPath: row.stripPath,
    https: row.https,
    url: `${row.https ? "https" : "http"}://${row.wildcard ? "*." : ""}${row.host}${row.path}`,
    servers: row.servers,
    certificateResolver: row.certificateResolver,
    wildcard: row.wildcard,
    middlewares: row.middlewares,
    tls: tlsStateFor(row.https, row.host, row.wildcard, certificates),
  };
}

/** Every domain the caller may see. Custom destinations belong to no project, so only admins do. */
export async function listOverview(deps: AppDeps, access: Access): Promise<DomainsOverview> {
  const certificates = await listCertificates(deps);
  const rows = deps.db.select().from(domains).orderBy(asc(domains.host), asc(domains.path)).all();
  const serviceEntries: OverviewDomain[] = rows
    .filter((row) => canSeeProject(access, row.projectName))
    .map((row) => ({
      ...toEntry(row),
      destination: "service" as const,
      projectName: row.projectName,
      serviceName: row.serviceName,
      tls: tlsStateFor(row.https, row.host, row.wildcard, certificates),
    }));
  const custom =
    access.projects === null ? listCustomRows(deps.db).map((row) => toCustomOverview(row, certificates)) : [];
  return {
    domains: [...serviceEntries, ...custom],
    serverIp: getSystemInfo(deps).serverIp,
    managedProjects: managedProjects(access),
  };
}

/** What the caller may change here: a viewer or a read-only key sees domains without touching them. */
function managedProjects(access: Access): string[] | null {
  if (access.projects === null && access.canWrite) {
    return null;
  }
  if (!access.canWrite || access.projects === null) {
    return [];
  }
  return [...access.projects].filter(([, role]) => meetsLevel(role, "operator")).map(([project]) => project);
}

function listCustomRows(db: DbHandle): CustomRow[] {
  return db.select().from(customDomains).orderBy(asc(customDomains.host)).all();
}

const routeFileName = (id: string) => `_custom-domain-${id}.yaml`;
const routeName = (id: string) => `custom-${id}`;

function assertServersRoutable(servers: SaveFields["servers"]): void {
  for (const server of servers) {
    const url = new URL(server.url);
    if (url.username !== "" || url.password !== "") {
      throw conflict("custom_domain_credentials", "A server's URL can't hold credentials.", {
        servers: "Remove the credentials from the URL",
      });
    }
  }
}

/** The file for one custom destination. Pure, so it can be tested without a proxy. */
export function renderCustomRoute(
  row: Pick<
    CustomRow,
    | "id"
    | "host"
    | "path"
    | "stripPath"
    | "https"
    | "servers"
    | "certificateResolver"
    | "wildcard"
    | "middlewares"
  >,
): object {
  assertHostname(row.host);
  if (!isValidRoutePath(row.path)) {
    throw new InvalidProxyInputError(`Invalid path: ${JSON.stringify(row.path)}.`);
  }
  const name = routeName(row.id);
  const rule = routeRule(row.host, row.path, row.wildcard);
  const priority = row.wildcard ? { priority: wildcardPriority(row.path) } : {};
  const strip = stripPathMiddleware(name, row.path, row.stripPath);
  const chain = [...row.middlewares, ...(strip === null ? [] : [strip.name])];
  const middlewares = chain.length > 0 ? { middlewares: chain } : {};
  const certificateHost = row.wildcard ? `*.${row.host}` : row.host;
  const httpsRouter = {
    rule,
    entryPoints: ["websecure"],
    service: name,
    ...priority,
    ...middlewares,
    tls: { certResolver: row.certificateResolver ?? CERT_RESOLVER, domains: [{ main: certificateHost }] },
  };
  return {
    http: {
      routers: {
        [`http-${name}`]: {
          rule,
          entryPoints: ["web"],
          service: name,
          ...priority,
          ...(row.https ? { middlewares: ["opsifier-redirect-https"] } : middlewares),
        },
        ...(row.https ? { [`https-${name}`]: httpsRouter } : {}),
      },
      services: {
        [name]: {
          weighted: undefined,
          loadBalancer: {
            passHostHeader: true,
            servers: row.servers.map((server) => ({ url: server.url, weight: server.weight })),
          },
        },
      },
      ...(strip === null ? {} : { middlewares: { [strip.name]: strip.definition } }),
    },
  };
}

function assertRouteFree(deps: AppDeps, fields: SaveFields, ownId?: string): void {
  if (findRouteConflict(deps.db, fields, null, ownId) !== undefined) {
    throw conflict("domain_taken", "This hostname and path are already taken.", { host: "Already taken" });
  }
  assertHostAvailableForPanel(deps, fields.host, fields.wildcard);
}

function toRow(
  id: string,
  fields: SaveFields,
  now: Date,
  createdAt: Date,
): typeof customDomains.$inferInsert {
  return {
    id,
    host: fields.host,
    path: fields.path,
    stripPath: fields.stripPath,
    https: fields.https,
    servers: fields.servers,
    certificateResolver: fields.certificateResolver === "" ? null : fields.certificateResolver,
    wildcard: fields.wildcard,
    middlewares: fields.middlewares,
    createdAt,
    updatedAt: now,
  };
}

export async function createCustomDomain(
  deps: AppDeps,
  fields: SaveFields,
  actorEmail: string | undefined,
): Promise<OverviewDomain> {
  assertServersRoutable(fields.servers);
  assertRouteFree(deps, fields);
  const id = randomBytes(8).toString("hex");
  const now = new Date(deps.now());
  const row = toRow(id, fields, now, now);
  deps.db.insert(customDomains).values(row).run();
  await deps.proxy.writeOwnFile(routeFileName(id), renderCustomRoute(row as CustomRow));
  deps.actions.record({ type: "domain.custom", title: `Add the custom domain ${fields.host}`, actorEmail });
  return toCustomOverview(findCustom(deps, id), []);
}

function findCustom(deps: AppDeps, id: string): CustomRow {
  const row = deps.db.select().from(customDomains).where(eq(customDomains.id, id)).get();
  if (row === undefined) {
    throw notFound("This domain does not exist.");
  }
  return row;
}

export async function updateCustomDomain(
  deps: AppDeps,
  id: string,
  fields: SaveFields,
  actorEmail: string | undefined,
): Promise<OverviewDomain> {
  const current = findCustom(deps, id);
  assertServersRoutable(fields.servers);
  // What a route already holds is not a new claim, so one that predates these rules can be edited.
  if (!sameRoute(current, fields)) {
    assertRouteFree(deps, fields, id);
  }
  const row = toRow(id, fields, new Date(deps.now()), current.createdAt);
  deps.db.update(customDomains).set(row).where(eq(customDomains.id, id)).run();
  await deps.proxy.writeOwnFile(routeFileName(id), renderCustomRoute(row as CustomRow));
  deps.actions.record({
    type: "domain.custom",
    title: `Update the custom domain ${fields.host}`,
    actorEmail,
  });
  return toCustomOverview(findCustom(deps, id), []);
}

export async function deleteCustomDomain(
  deps: AppDeps,
  id: string,
  actorEmail: string | undefined,
): Promise<void> {
  const current = findCustom(deps, id);
  deps.db.delete(customDomains).where(eq(customDomains.id, id)).run();
  await deps.proxy.removeOwnFile(routeFileName(id));
  deps.actions.record({
    type: "domain.custom",
    title: `Remove the custom domain ${current.host}`,
    actorEmail,
  });
}

/** A custom destination's routes are written again at boot, in case the proxy's folder was reset. */
export async function rewriteCustomRoutes(deps: AppDeps): Promise<void> {
  for (const row of listCustomRows(deps.db)) {
    await deps.proxy.writeOwnFile(routeFileName(row.id), renderCustomRoute(row));
  }
}
