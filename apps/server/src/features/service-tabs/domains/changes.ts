import type { DomainEntry, SaveDomainFields } from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { DockerDriverError } from "../../../core/docker";
import { conflict, notFound } from "../../../core/errors";
import { compileService } from "../../services/compile";
import { builtImageName } from "../../services/compile/names";
import { findService, listServiceRecords, type ServiceRecord } from "../../services/repo";
import { requireProject, requireService, type ServiceTarget, writeProxyConfig } from "../../services/service";
import {
  type DomainRow,
  deleteDomain as deleteDomainRow,
  findDomain,
  findDomainByRoute,
  insertDomain,
  listServiceDomains,
  setPrimaryDomain,
  updateDomain as updateDomainRow,
} from "./repo";
import { toCompileDomains, toEntry } from "./service";

const TAKEN_BY_THIS_SERVICE = "This service already answers on this hostname and path";
const TAKEN_BY_ANOTHER_SERVICE = "Another service already uses this hostname on this path";

/** The UI compares these exact codes against its own translated messages. */
function assertRouteFree(
  db: DbHandle,
  target: ServiceTarget,
  route: Pick<DomainRow, "host" | "path" | "wildcard">,
  ownId?: string,
): void {
  const existing = findDomainByRoute(db, route.host, route.path, route.wildcard);
  if (existing === undefined || existing.id === ownId) {
    return;
  }
  const sameService =
    existing.projectName === target.projectName && existing.serviceName === target.serviceName;
  throw conflict("domain_taken", sameService ? TAKEN_BY_THIS_SERVICE : TAKEN_BY_ANOTHER_SERVICE, {
    host: sameService ? TAKEN_BY_THIS_SERVICE : TAKEN_BY_ANOTHER_SERVICE,
  });
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

const toColumns = (fields: SaveDomainFields) => ({
  host: fields.host,
  path: fields.path,
  https: fields.https,
  port: fields.port,
  destinationProtocol: fields.destinationProtocol,
  destinationPath: fields.destinationPath,
  certificateResolver: fields.certificateResolver === "" ? null : fields.certificateResolver,
  wildcard: fields.wildcard,
  middlewares: fields.middlewares,
});

export async function createDomain(
  deps: AppDeps,
  target: ServiceTarget,
  fields: SaveDomainFields,
): Promise<DomainEntry> {
  requireService(deps, target);
  const id = nanoid();
  const now = new Date(deps.now());
  const row = await applyRouteChange(deps, target, (tx) => {
    assertRouteFree(tx, target, fields);
    const existing = listServiceDomains(tx, target.projectName, target.serviceName);
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
  const now = new Date(deps.now());
  const row = await applyRouteChange(deps, target, (tx) => {
    const current = requireDomain(tx, target, id);
    if (current.isPrimary) {
      assertCanBePrimary(fields);
    }
    assertRouteFree(tx, target, fields, id);
    updateDomainRow(tx, id, { ...toColumns(fields), updatedAt: now });
    return findDomain(tx, id);
  });
  if (row === undefined) {
    throw new Error("The domain could not be read back.");
  }
  return toEntry(row);
}

export async function deleteDomain(deps: AppDeps, target: ServiceTarget, id: string): Promise<void> {
  requireService(deps, target);
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
