import { mkdir, rename as moveDirectory, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CreateServiceRequest,
  MAX_SERVICES_PER_PROJECT,
  type RenameServiceRequest,
  type ServiceDetail,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import type { DockerDriverError } from "../../core/docker";
import { AppError, badRequest, conflict, notFound } from "../../core/errors";
import { PROXY_SERVICE } from "../projects/network";
import { findProject, type ProjectRow } from "../projects/repo";
import { assertNoCompanions } from "../service-tabs/companions/service";
import {
  assignDefaultDomain,
  listDomainRows,
  primaryUrl,
  toCompileDomains,
} from "../service-tabs/domains/service";
import { toPublicSource } from "../service-tabs/source/public";
import { hasPendingChanges } from "./applied";
import { compileService, qualifiedName } from "./compile";
import { volumeName } from "./compile/mounts";
import { builtImageName, heldImageName } from "./compile/names";
import { assertNameFreeInDocker, isOwnedSwarmService, isOwnedVolume, removeOwnedService } from "./ownership";
import {
  countServices,
  findService,
  insertService,
  listServiceIdentities,
  listServiceRecords,
  moveServiceRow,
  type ServiceKey,
  type ServiceRecord,
} from "./repo";
import { assertRuntimeCertain } from "./runtime-state";
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

/** A project's services share one overlay network, and it has only so many addresses to give out. */
export function assertRoomForServices(deps: Pick<AppDeps, "db">, project: string, adding = 1): void {
  if (countServices(deps.db, project) + adding > MAX_SERVICES_PER_PROJECT) {
    throw conflict("too_many_services", "This project holds as many services as it can.");
  }
}

/** What a service answers to on its project's network, spelled so that any client can use them. */
export const networkNames = (project: string, service: string): string[] => [
  qualifiedName(project, service),
  `${project}-${service}`,
];

/**
 * Every service is `<project>_<name>` and `<project>-<name>` on its project's network, and just
 * `<name>` there too. Those names mean nothing outside that network. Whoever holds an address keeps
 * it, so a name that would take one over is refused, in terms that say nothing about whose it is.
 */
export function assertAddressFree(
  deps: Pick<AppDeps, "db">,
  target: ServiceTarget,
  options: { moving?: ServiceTarget } = {},
): void {
  const everywhere = networkNames(target.projectName, target.serviceName);
  const inProject = [...everywhere, target.serviceName];
  const taken =
    everywhere.includes(PROXY_SERVICE) ||
    listServiceIdentities(deps.db).some((other) => {
      if (options.moving?.projectName === other.projectName && options.moving.serviceName === other.name) {
        return false;
      }
      return (
        other.projectName === target.projectName &&
        inProject.some((name) => [...networkNames(other.projectName, other.name), other.name].includes(name))
      );
    });
  if (taken) {
    throw conflict("address_taken", "This name can't be used: another service already answers to it.", {
      name: "Another service already answers to this name",
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
  const { source, notes, notesHidden, stopped } = record.spec;
  const target = { projectName: record.projectName, serviceName: record.name };
  return {
    ...summarize(deps, record, live, indexActiveActions(deps)),
    source: source === null ? null : toPublicSource(source),
    notes,
    notesHidden,
    stopped,
    primaryUrl: primaryUrl(deps.db, target),
    pendingChanges: hasPendingChanges(deps, target, record),
    answering: record.answering,
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
  assertRoomForServices(deps, projectName);
  if (findService(deps.db, projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in this project",
    });
  }
  assertAddressFree(deps, target);
  await assertNameFreeInDocker(deps, target);

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
  await assertDestinationFree(deps, to);

  await removeOwnedService(deps, from, log);
  await carryBuiltImage(deps, record, from, to, log);
  await dropHeldImage(deps, from);
  await removeRenamedVolumes(deps, record, from, log);

  const key = (target: ServiceTarget): ServiceKey => ({
    project: target.projectName,
    name: target.serviceName,
  });
  moveServiceRow(deps.db, key(from), key(to), new Date(deps.now()));

  log("Moving the service's data directory");
  const source = serviceDir(deps, from.projectName, from.serviceName);
  const destination = serviceDir(deps, to.projectName, to.serviceName);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await moveDirectory(source, destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  log("Rewriting the routes");
  await deps.proxy.removeService(from.projectName, from.serviceName);
  await writeProxyConfig(deps, to, record.spec);
}

/** A built image exists only here, under the service's name. Nothing should have to rebuild it. */
async function carryBuiltImage(
  deps: Pick<AppDeps, "docker">,
  record: ServiceRecord,
  from: ServiceTarget,
  to: ServiceTarget,
  log: (line: string) => void,
): Promise<void> {
  const { source } = record.spec;
  if (source === null || source.type === "image") {
    return;
  }
  const image = builtImageName(from.projectName, from.serviceName);
  if ((await deps.docker.inspectImage(image)) === null) {
    return;
  }
  log("Moving the built image to its new name");
  await deps.docker.tagImage(image, builtImageName(to.projectName, to.serviceName));
  await deps.docker.removeImage(image);
}

/** An outgoing image a deployment set aside and could not release. Its name is about to mean nothing. */
const dropHeldImage = (deps: Pick<AppDeps, "docker">, target: ServiceTarget): Promise<void> =>
  deps.docker.removeImage(heldImageName(target.projectName, target.serviceName)).catch(() => undefined);

/**
 * A volume's data lives in the service's folder, which is about to move, so the Docker object
 * pointing at it has to go. The next deploy or start makes one under the new name. Docker refuses for
 * as long as the tasks that just went are still being cleaned up.
 */
async function removeRenamedVolumes(
  deps: Pick<AppDeps, "docker" | "rollout">,
  record: ServiceRecord,
  from: ServiceTarget,
  log: (line: string) => void,
): Promise<void> {
  const names = record.spec.mounts.flatMap((mount) =>
    mount.type === "volume" ? [volumeName(from.projectName, from.serviceName, mount.name)] : [],
  );
  const deadline = performance.now() + deps.rollout.stableMs;
  for (const name of names) {
    const volume = await deps.docker.inspectVolume(name);
    if (volume === null || !isOwnedVolume(volume, from)) {
      continue;
    }
    for (;;) {
      try {
        await deps.docker.removeVolume(name);
        break;
      } catch (error) {
        if (performance.now() >= deadline) {
          log(
            `Could not remove the old Docker volume ${name}, which holds no data: ${(error as Error).message}`,
          );
          break;
        }
        await sleep(deps.rollout.pollMs);
      }
    }
  }
}

/** A service that is gone can have left kept volumes in the folder a rename would move into. */
async function assertDestinationFree(deps: Pick<AppDeps, "config">, to: ServiceTarget): Promise<void> {
  const entries = await readdir(serviceDir(deps, to.projectName, to.serviceName)).catch(() => []);
  if (entries.length > 0) {
    throw conflict(
      "name_holds_kept_data",
      "Volumes kept from an earlier service of this name are still on the server. Delete them under Monitor, Storage, or pick another name.",
      { name: "Holds volumes kept from an earlier service" },
    );
  }
}

/** A stack's containers, networks and volumes carry its name, and other services can refer to a database by it. */
function assertRenameable(deps: Pick<AppDeps, "db">, from: ServiceTarget, record: ServiceRecord): void {
  if (record.spec.compose !== null) {
    throw conflict(
      "service_renaming",
      "A Compose stack keeps its name: its volumes and networks are named after it.",
    );
  }
  if (record.spec.database !== null) {
    const dependents = listServiceRecords(deps.db, from.projectName).filter((candidate) =>
      Object.values(candidate.spec.references.databases).some(
        (reference) => reference.service === from.serviceName,
      ),
    );
    if (dependents.length > 0) {
      throw conflict(
        "service_renaming",
        `${dependents[0]?.name} connects to this database by name. Remove that first, or leave the name as it is.`,
      );
    }
  }
}

export async function validateRename(
  deps: AppDeps,
  from: ServiceTarget,
  request: RenameServiceRequest,
): Promise<void> {
  const record = requireService(deps, from);
  requireProject(deps, request.projectName);
  assertNameFits(request.projectName, request.name);
  assertNoCompanions(deps, from);
  assertRenameable(deps, from, record);
  assertRuntimeCertain(deps, from);

  const same = from.projectName === request.projectName && from.serviceName === request.name;
  if (same) {
    throw conflict("service_exists", "Pick a different name or project.", { name: "Nothing would change" });
  }
  if (from.projectName !== request.projectName) {
    assertRoomForServices(deps, request.projectName);
  }
  if (findService(deps.db, request.projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in that project",
    });
  }
  assertAddressFree(deps, { projectName: request.projectName, serviceName: request.name }, { moving: from });
  await assertDestinationFree(deps, { projectName: request.projectName, serviceName: request.name });
  await assertNameFreeInDocker(deps, { projectName: request.projectName, serviceName: request.name });
  // What someone else runs under this name is no reason to keep it: leaving it is the way out.
  const swarm = await deps.docker.inspectService(qualifiedName(from.projectName, from.serviceName));
  if (
    swarm !== null &&
    isOwnedSwarmService(swarm, from) &&
    (swarm.spec.Mode?.Replicated?.Replicas ?? 0) > 0
  ) {
    throw conflict("service_running", "Stop the service before renaming it.");
  }
}
