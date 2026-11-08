import { mkdir, rename as moveDirectory, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CreateServiceRequest, RenameServiceRequest, ServiceDetail } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import type { DockerDriverError } from "../../core/docker";
import { AppError, badRequest, conflict, notFound } from "../../core/errors";
import { findProject, type ProjectRow } from "../projects/repo";
import { assertNoCompanions } from "../service-tabs/companions/service";
import {
  assignDefaultDomain,
  listDomainRows,
  primaryUrl,
  toCompileDomains,
} from "../service-tabs/domains/service";
import { toPublicSource } from "../service-tabs/source/public";
import { compileService, qualifiedName } from "./compile";
import { findService, insertService, moveServiceRow, type ServiceKey, type ServiceRecord } from "./repo";
import { type AppServiceSpec, appServiceSpec } from "./spec";
import { indexActiveActions, readLiveState, summarize } from "./status";

export interface ServiceTarget {
  projectName: string;
  serviceName: string;
}

const MAX_QUALIFIED_NAME = 63;

export function serviceDir(deps: Pick<AppDeps, "config">, project: string, service: string): string {
  return join(deps.config.dataDir, "projects", project, service);
}

/** A reported Docker failure on a synchronous route. Slow work reports its failures on the Action. */
export function dockerFailure(error: DockerDriverError): AppError {
  return new AppError(502, "docker_error", `Docker refused this: ${error.message}`);
}

export function requireProject(deps: Pick<AppDeps, "db">, name: string): ProjectRow {
  const project = findProject(deps.db, name);
  if (project === undefined) {
    throw notFound("This project does not exist.");
  }
  return project;
}

export function requireService(deps: Pick<AppDeps, "db">, target: ServiceTarget): ServiceRecord {
  const service = findService(deps.db, target.projectName, target.serviceName);
  if (service === undefined) {
    throw notFound("This service does not exist.");
  }
  return service;
}

/** Docker caps the qualified name, and each part only knows its own length. */
export function assertNameFits(project: string, service: string): void {
  if (qualifiedName(project, service).length > MAX_QUALIFIED_NAME) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      name: `Must fit in ${MAX_QUALIFIED_NAME} characters together with the project name`,
    });
  }
}

/** Recompiles the routes of a service and writes them. Traefik picks up the file by itself. */
export async function writeProxyConfig(
  deps: AppDeps,
  target: ServiceTarget,
  spec: AppServiceSpec,
): Promise<void> {
  if (spec.database !== null) {
    // A database has no routes, so it leaves the proxy's configuration exactly as it found it.
    return;
  }
  const project = requireProject(deps, target.projectName);
  const compiled = compileService({
    project,
    service: { name: target.serviceName, spec },
    domains: toCompileDomains(listDomainRows(deps.db, target)),
    dataDir: deps.config.dataDir,
    forceUpdate: 0,
  });
  await deps.proxy.writeService(target.projectName, target.serviceName, compiled.proxyConfig);
}

export async function getServiceDetail(deps: AppDeps, target: ServiceTarget): Promise<ServiceDetail> {
  const record = requireService(deps, target);
  const live = await readLiveState(deps);
  return toDetail(deps, record, live);
}

function toDetail(
  deps: AppDeps,
  record: ServiceRecord,
  live: Awaited<ReturnType<typeof readLiveState>>,
): ServiceDetail {
  const { source, notes, stopped } = record.spec;
  return {
    ...summarize(deps, record, live, indexActiveActions(deps)),
    source: source === null ? null : toPublicSource(source),
    notes,
    stopped,
    primaryUrl: primaryUrl(deps.db, { projectName: record.projectName, serviceName: record.name }),
  };
}

export async function createService(
  deps: AppDeps,
  projectName: string,
  request: CreateServiceRequest,
  actorEmail: string | undefined,
): Promise<ServiceDetail> {
  const target = { projectName, serviceName: request.name };
  requireProject(deps, projectName);
  assertNameFits(projectName, request.name);
  if (findService(deps.db, projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in this project",
    });
  }

  const now = new Date(deps.now());
  const spec = appServiceSpec.parse({});
  deps.db.transaction((tx) => {
    insertService(tx, projectName, request.name, request.type, spec, now);
    assignDefaultDomain(deps, tx, target, now);
  });

  await mkdir(serviceDir(deps, projectName, request.name), { recursive: true, mode: 0o700 });
  await writeProxyConfig(deps, target, spec);

  deps.actions.record({
    type: "service.create",
    title: `Create ${projectName}/${request.name}`,
    ...target,
    actorEmail,
  });
  return getServiceDetail(deps, target);
}

/** Renames or moves a stopped service, inside the Action that serializes work on it. */
export async function performRename(
  deps: AppDeps,
  from: ServiceTarget,
  request: RenameServiceRequest,
  log: (line: string) => void,
): Promise<void> {
  const record = requireService(deps, from);
  const to = { projectName: request.projectName, serviceName: request.name };

  log(`Removing the stopped Swarm service ${qualifiedName(from.projectName, from.serviceName)}`);
  await deps.docker.removeService(qualifiedName(from.projectName, from.serviceName));

  const key = (target: ServiceTarget): ServiceKey => ({
    project: target.projectName,
    name: target.serviceName,
  });
  moveServiceRow(deps.db, key(from), key(to), new Date(deps.now()));

  log("Moving the service's data directory");
  const source = serviceDir(deps, from.projectName, from.serviceName);
  const destination = serviceDir(deps, to.projectName, to.serviceName);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rm(destination, { recursive: true, force: true });
  await moveDirectory(source, destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  log("Rewriting the routes");
  await deps.proxy.removeService(from.projectName, from.serviceName);
  await writeProxyConfig(deps, to, record.spec);
}

export async function validateRename(
  deps: AppDeps,
  from: ServiceTarget,
  request: RenameServiceRequest,
): Promise<void> {
  requireService(deps, from);
  requireProject(deps, request.projectName);
  assertNameFits(request.projectName, request.name);
  assertNoCompanions(deps, from);

  const same = from.projectName === request.projectName && from.serviceName === request.name;
  if (same) {
    throw conflict("service_exists", "Pick a different name or project.", { name: "Nothing would change" });
  }
  if (findService(deps.db, request.projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in that project",
    });
  }
  const swarm = await deps.docker.inspectService(qualifiedName(from.projectName, from.serviceName));
  if (swarm !== null && (swarm.spec.Mode?.Replicated?.Replicas ?? 0) > 0) {
    throw conflict("service_running", "Stop the service before renaming it.");
  }
}
