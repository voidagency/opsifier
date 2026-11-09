import { X509Certificate } from "node:crypto";
import { type DomainEntry, MAX_DOMAINS_PER_SERVICE, type SaveDomainFields } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { DockerDriverError } from "../../../core/docker";
import { badRequest, conflict, notFound } from "../../../core/errors";
import { assertHostAvailableForPanel } from "../../server/panel-host";
import { compileService } from "../../services/compile";
import { builtImageName } from "../../services/compile/names";
import { findService, listServiceRecords, type ServiceRecord } from "../../services/repo";
import { assertRuntimeCertain } from "../../services/runtime-state";
import { requireProject, requireService, type ServiceTarget, writeProxyConfig } from "../../services/service";
import { findRedirectLoop } from "../redirects/loops";
import {
  type DomainRow,
  deleteDomain as deleteDomainRow,
  findDomain,
  findRouteConflict,
  insertDomain,
  listServiceDomains,
  type RouteClaim,
  sameRoute,
  setPrimaryDomain,
  updateDomain as updateDomainRow,
} from "./repo";
import { toCompileDomains, toEntry } from "./service";

const TAKEN_BY_THIS_SERVICE = "This service already answers on this hostname and path";
const TAKEN_BY_ANOTHER_SERVICE = "Another service already uses this hostname on this path";
const OVERLAPS_ANOTHER_ROUTE = "This hostname and path overlap a route that is already in use";

/** The UI compares these exact codes against its own translated messages. Nothing here names the owner. */
function assertRouteFree(db: DbHandle, target: ServiceTarget, route: RouteClaim, ownId?: string): void {
  const held = findRouteConflict(db, route, target.projectName, ownId);
  if (held === undefined) {
    return;
  }
  const ownService = held.project === target.projectName && held.service === target.serviceName;
  const identical = ownService ? TAKEN_BY_THIS_SERVICE : TAKEN_BY_ANOTHER_SERVICE;
  const message = sameRoute(held, route) ? identical : OVERLAPS_ANOTHER_ROUTE;
  throw conflict("domain_taken", message, { host: message });
}

const PEM_BLOCKS = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The contract checks the shape. Only this says that the proxy will really be able to use it. */
function assertReadableCertificates(pem: string | null): void {
  try {
    for (const block of pem?.match(PEM_BLOCKS) ?? []) {
      new X509Certificate(block);
    }
  } catch {
    throw badRequest("validation_failed", "Some fields need attention.", {
      upstreamCa: "This certificate can't be read",
    });
  }
}

/** An address can complete a loop the rules could not make alone, by bringing their target here. */
function assertNoRedirectLoop(
  db: DbHandle,
  target: ServiceTarget,
  domain: Pick<DomainRow, "host" | "wildcard">,
): void {
  const record = findService(db, target.projectName, target.serviceName);
  if (record === undefined) {
    return;
  }
  const host = domain.wildcard ? `x.${domain.host}` : domain.host;
  const domains = listServiceDomains(db, target.projectName, target.serviceName);
  if (findRedirectLoop({ host }, record.spec.redirects, domains) !== null) {
    throw conflict(
      "domain_redirect_loop",
      "This address would send visitors round in a loop with this service's redirects.",
      { host: "This service's redirects would loop on this address" },
    );
  }
}

function requireDomain(db: DbHandle, target: ServiceTarget, id: string): DomainRow {
  const row = findDomain(db, id);
  if (row === undefined || row.projectName !== target.projectName || row.serviceName !== target.serviceName) {
    throw notFound("This domain does not exist.");
  }
  return row;
}

const WILDCARD_CANNOT_BE_PRIMARY = "A wildcard domain can't be the primary domain";

function assertCanBePrimary(row: Pick<DomainRow, "wildcard">): void {
  if (row.wildcard) {
    throw conflict("domain_wildcard_primary", WILDCARD_CANNOT_BE_PRIMARY, {
      wildcard: WILDCARD_CANNOT_BE_PRIMARY,
    });
  }
}

function assertCompiles(deps: AppDeps, db: DbHandle, target: ServiceTarget): void {
  const record = findService(db, target.projectName, target.serviceName);
  if (record === undefined) {
    return;
  }
  compileService({
    project: requireProject(deps, target.projectName),
    service: { name: target.serviceName, spec: record.spec },
    domains: toCompileDomains(listServiceDomains(db, target.projectName, target.serviceName)),
    dataDir: deps.config.dataDir,
    forceUpdate: 0,
  });
}

/**
 * Applies a change to the domains of a service. Runs in one transaction with the compiler, so a route
 * that could not be written is never saved, then writes the proxy file. Docker is not involved.
 */
async function applyRouteChange<T>(
  deps: AppDeps,
  target: ServiceTarget,
  change: (tx: DbHandle) => T,
): Promise<T> {
  const result = deps.db.transaction((tx) => {
    const value = change(tx);
    assertCompiles(deps, tx, target);
    return value;
  });
  await writeProxyConfig(deps, target, requireService(deps, target).spec);
  return result;
}

/** What to check an upstream's certificate against means nothing to an upstream that has none. */
const upstreamCheck = (value: string | null, fields: SaveDomainFields) =>
  fields.destinationProtocol === "https" && value !== "" ? value : null;

const toColumns = (fields: SaveDomainFields) => ({
  host: fields.host,
  path: fields.path,
  stripPath: fields.stripPath,
  https: fields.https,
  port: fields.port,
  destinationProtocol: fields.destinationProtocol,
  destinationPath: fields.destinationPath,
  upstreamServerName: upstreamCheck(fields.upstreamServerName, fields),
  upstreamCa: upstreamCheck(fields.upstreamCa, fields),
  certificateResolver: fields.certificateResolver === "" ? null : fields.certificateResolver,
  wildcard: fields.wildcard,
  middlewares: fields.middlewares,
  ...(fields.composeService === undefined ? {} : { composeService: fields.composeService }),
});

export async function createDomain(
  deps: AppDeps,
  target: ServiceTarget,
  fields: SaveDomainFields,
): Promise<DomainEntry> {
  requireService(deps, target);
  assertHostAvailableForPanel(deps, fields.host, fields.wildcard);
  assertReadableCertificates(fields.upstreamCa);
  const id = nanoid();
  const now = new Date(deps.now());
  const row = await applyRouteChange(deps, target, (tx) => {
    assertRouteFree(tx, target, fields);
    const existing = listServiceDomains(tx, target.projectName, target.serviceName);
    if (existing.length >= MAX_DOMAINS_PER_SERVICE) {
      throw conflict("too_many_domains", "This service answers on as many domains as it can hold.");
    }
    insertDomain(tx, {
      id,
      projectName: target.projectName,
      serviceName: target.serviceName,
      ...toColumns(fields),
      // The first domain becomes the primary one, unless it is a wildcard that can't be opened.
      isPrimary: existing.length === 0 && !fields.wildcard,
      createdAt: now,
      updatedAt: now,
    });
    assertNoRedirectLoop(tx, target, fields);
    return findDomain(tx, id);
  });
  if (row === undefined) {
    throw new Error("The domain could not be read back.");
  }
  return toEntry(row);
}

export async function updateDomain(
  deps: AppDeps,
  target: ServiceTarget,
  id: string,
  fields: SaveDomainFields,
): Promise<DomainEntry> {
  requireService(deps, target);
  assertHostAvailableForPanel(deps, fields.host, fields.wildcard);
  assertReadableCertificates(fields.upstreamCa);
  const now = new Date(deps.now());
  const row = await applyRouteChange(deps, target, (tx) => {
    const current = requireDomain(tx, target, id);
    if (current.host !== fields.host || current.path !== fields.path) {
      assertRuntimeCertain(deps, target);
    }
    if (current.isPrimary) {
      assertCanBePrimary(fields);
    }
    // What a route already holds is not a new claim, so one that predates these rules can be edited.
    if (!sameRoute(current, fields)) {
      assertRouteFree(tx, target, fields, id);
    }
    updateDomainRow(tx, id, { ...toColumns(fields), updatedAt: now });
    if (!sameRoute(current, fields) || current.https !== fields.https) {
      assertNoRedirectLoop(tx, target, fields);
    }
    return findDomain(tx, id);
  });
  if (row === undefined) {
    throw new Error("The domain could not be read back.");
  }
  return toEntry(row);
}

export async function deleteDomain(deps: AppDeps, target: ServiceTarget, id: string): Promise<void> {
  requireService(deps, target);
  assertRuntimeCertain(deps, target);
  const now = new Date(deps.now());
  await applyRouteChange(deps, target, (tx) => {
    const current = requireDomain(tx, target, id);
    deleteDomainRow(tx, id);
    if (current.isPrimary) {
      // The service keeps something to Open and to offer `$(PRIMARY_DOMAIN)`, if it can.
      const next = listServiceDomains(tx, target.projectName, target.serviceName).find(
        (row) => !row.wildcard,
      );
      if (next !== undefined) {
        setPrimaryDomain(tx, next, now);
      }
    }
  });
}

/** Moves the star. Routes are unaffected, and `$(PRIMARY_DOMAIN)` follows at the next deploy. */
export function makeDomainPrimary(deps: AppDeps, target: ServiceTarget, id: string): DomainEntry {
  requireService(deps, target);
  const now = new Date(deps.now());
  const updated = deps.db.transaction((tx) => {
    const current = requireDomain(tx, target, id);
    assertCanBePrimary(current);
    setPrimaryDomain(tx, current, now);
    return findDomain(tx, id);
  });
  if (updated === undefined) {
    throw new Error("The domain could not be read back.");
  }
  return toEntry(updated);
}

/** What the image declares, for the "Select port" suggestions. Never an error for the user. */
export async function exposedPortsOf(deps: AppDeps, target: ServiceTarget): Promise<number[]> {
  const { source } = requireService(deps, target).spec;
  if (source === null) {
    return [];
  }
  const image =
    source.type === "image" ? source.image : builtImageName(target.projectName, target.serviceName);
  try {
    return await deps.docker.imageExposedPorts(image);
  } catch (error) {
    if (error instanceof DockerDriverError) {
      deps.logger.warn({ err: error, target }, "Could not read the image's exposed ports");
      return [];
    }
    throw error;
  }
}

/**
 * Writes every service's routes again at boot, so an upgrade or a missed write can't leave the proxy
 * behind what is stored. One service that can't be written says so and the others carry on.
 */
export async function rewriteAllRoutes(deps: AppDeps): Promise<void> {
  let records: ServiceRecord[];
  try {
    records = listServiceRecords(deps.db);
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not read the services to rewrite their routes");
    return;
  }
  for (const record of records) {
    const target = { projectName: record.projectName, serviceName: record.name };
    try {
      await writeProxyConfig(deps, target, record.spec);
    } catch (error) {
      deps.logger.warn({ err: error, target }, "Could not rewrite the routes of a service");
    }
  }
}
