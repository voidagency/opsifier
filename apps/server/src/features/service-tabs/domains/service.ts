import { isIP } from "node:net";
import type { DomainEntry } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { assertHostname, InvalidProxyInputError } from "../../../core/proxy";
import type { CompileDomain } from "../../services/compile";
import { internalUrl, qualifiedName } from "../../services/compile";
import type { ServiceTarget } from "../../services/service";
import { getSetting, SERVICE_DOMAIN_KEY } from "../../system/repo";
import { getSystemInfo } from "../../system/service";
import { type DomainRow, insertDomain, isHostAvailable, listServiceDomains } from "./repo";

const MAX_LABEL = 63;
const DEFAULT_PORT = 80;
const SSLIP_SUFFIX = "sslip.io";

export const toCompileDomains = (rows: readonly DomainRow[]): CompileDomain[] =>
  rows.map((row) => ({
    host: row.host,
    path: row.path,
    port: row.port,
    https: row.https,
    primary: row.isPrimary,
    destinationProtocol: row.destinationProtocol,
    destinationPath: row.destinationPath,
    certificateResolver: row.certificateResolver,
    wildcard: row.wildcard,
    middlewares: row.middlewares,
  }));

export function listDomainRows(db: DbHandle, target: ServiceTarget): DomainRow[] {
  return listServiceDomains(db, target.projectName, target.serviceName);
}

export const externalUrl = (row: DomainRow) =>
  `${row.https ? "https" : "http"}://${row.wildcard ? "*." : ""}${row.host}${row.path}`;

export function toEntry(row: DomainRow): DomainEntry {
  return {
    id: row.id,
    host: row.host,
    path: row.path,
    port: row.port,
    https: row.https,
    primary: row.isPrimary,
    destinationProtocol: row.destinationProtocol,
    destinationPath: row.destinationPath,
    certificateResolver: row.certificateResolver,
    wildcard: row.wildcard,
    middlewares: row.middlewares,
    url: externalUrl(row),
    internalUrl: internalUrl(
      qualifiedName(row.projectName, row.serviceName),
      row.port,
      row.destinationProtocol,
      row.destinationPath,
    ),
  };
}

export function listDomainEntries(deps: Pick<AppDeps, "db">, target: ServiceTarget): DomainEntry[] {
  return listDomainRows(deps.db, target).map(toEntry);
}

/** What the toolbar's Open link points at. */
export function primaryUrl(db: DbHandle, target: ServiceTarget): string | null {
  const primary = listDomainRows(db, target).find((row) => row.isPrimary);
  return primary === undefined ? null : externalUrl(primary);
}

/** sslip.io spells an IPv6 address with dashes, and a label cannot begin with one. */
function sslipLabel(ip: string): string {
  if (isIP(ip) !== 6) {
    return ip;
  }
  const dashed = ip.toLowerCase().replaceAll(":", "-");
  return dashed.startsWith("-") ? `0${dashed}` : dashed;
}

function isValidHostname(host: string): boolean {
  try {
    assertHostname(host);
    return true;
  } catch (error) {
    if (error instanceof InvalidProxyInputError) {
      return false;
    }
    throw error;
  }
}

/** The configured base domain, or the sslip.io name of the server's address. Null if neither is known. */
function defaultBaseDomain(deps: AppDeps, db: DbHandle): string | null {
  const configured = getSetting(db, SERVICE_DOMAIN_KEY);
  if (typeof configured === "string" && configured !== "") {
    if (isValidHostname(`x.${configured}`)) {
      return configured;
    }
    deps.logger.warn({ value: configured }, "Ignoring an invalid service domain setting");
  }
  const { serverIp } = getSystemInfo(deps);
  return serverIp === null ? null : `${sslipLabel(serverIp)}.${SSLIP_SUFFIX}`;
}

/**
 * The hostname a new service gets. `a-b` + `c` and `a` + `b-c` map to one label, as do `x_y` and
 * `x-y`, so a label already taken gets a numeric suffix.
 */
function pickDefaultHost(db: DbHandle, target: ServiceTarget, base: string): string | null {
  const label = `${target.projectName}-${target.serviceName}`.replaceAll("_", "-");
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const host = `${label.slice(0, MAX_LABEL - suffix.length)}${suffix}.${base}`;
    if (isValidHostname(host) && isHostAvailable(db, host, "/")) {
      return host;
    }
  }
  return null;
}

/** Gives a new service its first domain. It stays with the service through renames. */
export function assignDefaultDomain(deps: AppDeps, db: DbHandle, target: ServiceTarget, now: Date): void {
  const base = defaultBaseDomain(deps, db);
  const host = base === null ? null : pickDefaultHost(db, target, base);
  if (host === null) {
    deps.logger.warn({ target }, "No default domain could be assigned: the server's address is unknown");
    return;
  }
  insertDomain(db, {
    id: nanoid(),
    projectName: target.projectName,
    serviceName: target.serviceName,
    host,
    path: "/",
    port: DEFAULT_PORT,
    https: true,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
  });
}
