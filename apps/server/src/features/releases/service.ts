import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_RELEASES_KEPT,
  type DeploymentRecord,
  MAX_RELEASES_KEPT,
  type ReleaseDetail,
  type ReleaseEntry,
  type ReleaseList,
  type ReleaseRefusal,
} from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { ServiceInfo, SwarmServiceSpec } from "../../core/docker";
import { conflict, notFound } from "../../core/errors";
import { findAction, noteDeployment } from "../actions/repo";
import { isDatabaseRecord } from "../databases/service";
import { readApplied, recordApplied } from "../services/applied";
import { qualifiedName } from "../services/compile";
import type { MountFile, MountVolume } from "../services/compile/mounts";
import { releaseImageName } from "../services/compile/names";
import type { ImageIdentity } from "../services/image-identity";
import { inspectOwnedService } from "../services/ownership";
import {
  listActiveServiceActions,
  listServiceRecords,
  type ServiceRecord,
  saveDeployed,
  saveRuntimeUncertain,
} from "../services/repo";
import { runtimeUncertainty } from "../services/runtime-state";
import { requireService, type ServiceTarget, serviceDir } from "../services/service";
import { getSetting, putSetting } from "../system/repo";
import { diffEffective } from "./changes";
import {
  deleteReleaseRows,
  findReleaseRow,
  insertReleaseRow,
  listReleaseRows,
  nextReleaseNumber,
  type ReleaseRow,
} from "./repo";

/** Sealed, because a snapshot holds what a container really got: its secrets filled in. */
const SNAPSHOT_CONTEXT = "release-snapshot";
const RELEASES_KEPT_KEY = "releases_kept";

/** Exactly what a version ran with. It holds no way of reaching a registry or a Git host. */
export interface ReleaseSnapshot {
  swarm: SwarmServiceSpec;
  files: MountFile[];
  volumes: MountVolume[];
  /** What "applied" said, to say again if this version comes back. */
  effective: unknown;
}

export function releasesKept(deps: Pick<AppDeps, "db">): number {
  const stored = getSetting(deps.db, RELEASES_KEPT_KEY);
  return typeof stored === "number" && Number.isInteger(stored) && stored >= 1 && stored <= MAX_RELEASES_KEPT
    ? stored
    : DEFAULT_RELEASES_KEPT;
}

/** One container per service: Compose stacks are not, and an engine's data files can't go backwards. */
export const hasReleases = (record: ServiceRecord): boolean =>
  record.spec.compose === null && !isDatabaseRecord(record);

export interface DeploymentResult {
  identity: ImageIdentity;
  /** What Swarm was given, with the image pinned. */
  swarm: SwarmServiceSpec;
  compiled: { files: readonly MountFile[]; volumes?: readonly MountVolume[] };
  effective: unknown;
  requestedRef: string | null;
  builtCommit: string | null;
  rollbackOf: number | null;
  answering: boolean | null;
  desired: number;
}

async function retainImage(
  deps: Pick<AppDeps, "docker">,
  identity: ImageIdentity,
  tag: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await deps.docker.tagImage(identity.id, tag);
  } catch (error) {
    log(`Could not keep this version's image: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runningTaskCount(tasks: Awaited<ReturnType<AppDeps["docker"]["listTasks"]>>): number {
  return tasks.filter((task) => task.state === "running" && task.desiredState === "running").length;
}

/**
 * Writes down what a successful deployment put in place, all in one step: the applied record, the
 * image it really ran, the version kept of it, and what the history shows. The image is named first,
 * because a tag that outlives a crash here hurts nothing and the next number simply takes it over.
 */
export async function recordSuccess(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  result: DeploymentResult,
): Promise<void> {
  const { projectName, serviceName } = target;
  const name = qualifiedName(projectName, serviceName);
  const record = requireService(deps, target);
  const { identity, rollbackOf, answering, desired } = result;

  const serviceId = hasReleases(record) ? record.id : null;
  const number = serviceId === null ? null : nextReleaseNumber(deps.db, serviceId);
  if (serviceId !== null && number !== null) {
    await retainImage(deps, identity, releaseImageName(serviceId, number), ctx.log);
  }
  const running = runningTaskCount(await deps.docker.listTasks({ service: name }));

  const facts: Partial<DeploymentRecord> = {
    release: number,
    answering,
    runningTasks: running,
    desiredTasks: desired,
  };
  deps.db.transaction((tx) => {
    recordApplied({ db: tx, secrets: deps.secrets }, target, result.effective, answering);
    saveRuntimeUncertain(tx, projectName, serviceName, null);
    saveDeployed(tx, projectName, serviceName, {
      image: identity.ref,
      imageId: identity.id,
      digest: identity.digest,
      commit: result.builtCommit,
      release: number,
    });
    if (serviceId !== null && number !== null) {
      insertReleaseRow(tx, {
        serviceId,
        number,
        image: identity.ref,
        imageId: identity.id,
        digest: identity.digest,
        sizeBytes: identity.sizeBytes,
        requestedRef: result.requestedRef,
        builtCommit: result.builtCommit,
        ociRevision: identity.revision,
        rollbackOf,
        actorEmail: findAction(tx, ctx.id)?.actorEmail ?? null,
        actionId: ctx.id,
        snapshot: sealSnapshot(deps, {
          swarm: result.swarm,
          files: [...result.compiled.files],
          volumes: [...(result.compiled.volumes ?? [])],
          effective: result.effective,
        }),
        createdAt: new Date(deps.now()),
      });
    }
    noteDeployment(tx, ctx.id, facts);
  });

  ctx.log(`Running ${identity.ref} as ${identity.digest ?? identity.id}`);
  if (number !== null) {
    ctx.log(`Kept as version ${number}`);
    await pruneReleases(deps, requireService(deps, target), ctx.log);
  }
}

const sealSnapshot = (deps: Pick<AppDeps, "secrets">, snapshot: ReleaseSnapshot): string =>
  deps.secrets.seal(JSON.stringify(snapshot), SNAPSHOT_CONTEXT);

export const openSnapshot = (deps: Pick<AppDeps, "secrets">, row: ReleaseRow): ReleaseSnapshot =>
  JSON.parse(deps.secrets.unseal(row.snapshot, SNAPSHOT_CONTEXT)) as ReleaseSnapshot;

/**
 * Keeps the newest versions and lets go of the rest. The tag goes first, and a row only with its
 * tag: Docker refuses while a stopped task still uses the image, and the row stays until a later
 * deployment gets through.
 */
export async function pruneReleases(
  deps: Pick<AppDeps, "db" | "docker">,
  record: Pick<ServiceRecord, "id">,
  log: (line: string) => void,
): Promise<void> {
  if (record.id === null) {
    return;
  }
  const surplus = listReleaseRows(deps.db, record.id).slice(releasesKept(deps));
  let letGo = 0;
  for (const { number } of surplus) {
    try {
      await deps.docker.removeImage(releaseImageName(record.id, number));
      deleteReleaseRows(deps.db, record.id, [number]);
      letGo += 1;
    } catch (error) {
      log(`Keeping version ${number} for now: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (letGo > 0) {
    log(
      `Let go of ${letGo} older version${letGo === 1 ? "" : "s"}, keeping the newest ${releasesKept(deps)}`,
    );
  }
}

/**
 * Everything kept of a service, when the service itself is going. Docker refuses for as long as the
 * tasks that just went are still being cleaned up, and whatever it still refuses after that is left
 * for a cleanup, which no longer has any reason to keep it.
 */
export async function removeReleases(
  deps: Pick<AppDeps, "db" | "docker" | "rollout">,
  record: Pick<ServiceRecord, "id"> | undefined,
  log: (line: string) => void,
): Promise<void> {
  if (record?.id === undefined || record.id === null) {
    return;
  }
  const rows = listReleaseRows(deps.db, record.id);
  if (rows.length === 0) {
    return;
  }
  log("Removing the versions kept for going back");
  deleteReleaseRows(
    deps.db,
    record.id,
    rows.map((row) => row.number),
  );
  const deadline = performance.now() + deps.rollout.stableMs;
  for (const { number } of rows) {
    for (;;) {
      try {
        await deps.docker.removeImage(releaseImageName(record.id, number));
        break;
      } catch (error) {
        if (performance.now() >= deadline) {
          log(
            `Could not remove a kept image yet, a cleanup can: ${error instanceof Error ? error.message : error}`,
          );
          break;
        }
        await sleep(deps.rollout.pollMs);
      }
    }
  }
}

/** Saves how many versions each service keeps, and gives back at once whatever that no longer covers. */
export function saveReleasesKept(
  deps: AppDeps,
  keep: number,
  actorEmail: string | undefined,
): ActionRow | null {
  const before = releasesKept(deps);
  putSetting(deps.db, RELEASES_KEPT_KEY, keep, new Date(deps.now()));
  deps.actions.record({
    type: "server.releases-kept",
    title: `Keep ${keep} version${keep === 1 ? "" : "s"} of each service`,
    actorEmail,
  });
  if (keep >= before) {
    return null;
  }
  return deps.actions.enqueue({
    type: "releases.trim",
    title: "Let go of older versions",
    actorEmail,
    run: async (ctx) => {
      const busy = new Set(
        listActiveServiceActions(deps.db).map((action) => `${action.projectName}/${action.serviceName}`),
      );
      for (const record of listServiceRecords(deps.db)) {
        // Whatever is running on a service finishes by doing this itself, with the same number.
        if (!busy.has(`${record.projectName}/${record.name}`)) {
          await pruneReleases(deps, record, ctx.log);
        }
      }
    },
  });
}

/** Volumes and paths on the host: what a version shares with the world outside its own container. */
function persistentMounts(spec: SwarmServiceSpec, filesDirectory: string): Set<string> {
  return new Set(
    (spec.TaskTemplate.ContainerSpec.Mounts ?? [])
      .filter((mount) => mount.Type !== "tmpfs" && !mount.Source?.startsWith(`${filesDirectory}/`))
      .map((mount) => `${mount.Type}:${mount.Source ?? ""}`),
  );
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

export interface EligibilityContext {
  target: ServiceTarget;
  /** The version that is running, when the panel can vouch for it. */
  activeNumber: number | null;
  /** What Docker has under this service's name. */
  swarm: ServiceInfo | null;
}

/**
 * Why this version can't be gone back to, or null. Everything here is read from Docker, never
 * assumed, and it asks for no pull: an image that is not on this server is an answer in itself.
 */
export async function refusalOf(
  deps: Pick<AppDeps, "docker" | "config" | "secrets">,
  row: ReleaseRow,
  snapshot: ReleaseSnapshot,
  context: EligibilityContext,
): Promise<ReleaseRefusal | null> {
  const { target, swarm, activeNumber } = context;
  if (row.number === activeNumber) {
    return "active";
  }
  if (swarm === null) {
    return "not_deployed";
  }
  if (snapshot.swarm.Name !== qualifiedName(target.projectName, target.serviceName)) {
    return "renamed";
  }
  if ((await deps.docker.inspectImage(row.imageId)) === null) {
    return "image_missing";
  }
  const tagged = await deps.docker.inspectImage(releaseImageName(row.serviceId, row.number));
  if (tagged?.id !== row.imageId) {
    return "image_altered";
  }
  const filesDirectory = `${serviceDir(deps, target.projectName, target.serviceName)}/files`;
  return sameSet(
    persistentMounts(snapshot.swarm, filesDirectory),
    persistentMounts(swarm.spec, filesDirectory),
  )
    ? null
    : "volumes_differ";
}

const REFUSALS: Record<ReleaseRefusal, { code: string; message: (number: number) => string }> = {
  active: {
    code: "release_active",
    message: (number) => `Version ${number} is the one already running.`,
  },
  not_deployed: {
    code: "service_not_deployed",
    message: () => "This service is not deployed, so there is nothing to replace. Deploy it first.",
  },
  renamed: {
    code: "release_renamed",
    message: (number) =>
      `Version ${number} was deployed under another name, and what it ran was tied to it. Deploy again to keep a new version.`,
  },
  image_missing: {
    code: "release_image_missing",
    message: (number) =>
      `The image of version ${number} is no longer on this server, and a rollback never pulls one. Nothing was changed.`,
  },
  image_altered: {
    code: "release_image_altered",
    message: (number) =>
      `The tag keeping version ${number} was changed or removed outside the panel, so what it names can't be trusted. Nothing was changed.`,
  },
  volumes_differ: {
    code: "release_mount_incompatible",
    message: (number) =>
      `Version ${number} does not use the same volumes as what is running now, so it would not see the current data. Nothing was changed.`,
  },
};

export const refusalError = (refusal: ReleaseRefusal, number: number) => {
  const { code, message } = REFUSALS[refusal];
  return conflict(code, message(number));
};

function requireReleases(record: ServiceRecord): string {
  if (!hasReleases(record) || record.id === null) {
    throw conflict("rollback_not_available", "Only an App service has versions to go back to.");
  }
  return record.id;
}

export function requireRelease(deps: Pick<AppDeps, "db">, record: ServiceRecord, number: number): ReleaseRow {
  const row = findReleaseRow(deps.db, requireReleases(record), number);
  if (row === undefined) {
    throw notFound("This service has no such version.");
  }
  return row;
}

/** The version running now, or null when the panel can't vouch for what is running. */
export function activeNumberOf(deps: Pick<AppDeps, "db">, record: ServiceRecord): number | null {
  return runtimeUncertainty(deps, record) !== null ? null : (record.deployed?.release ?? null);
}

function toEntry(row: ReleaseRow, activeNumber: number | null, refusal: ReleaseRefusal | null): ReleaseEntry {
  return {
    number: row.number,
    active: row.number === activeNumber,
    image: row.image,
    imageId: row.imageId,
    digest: row.digest,
    sizeBytes: row.sizeBytes,
    requestedRef: row.requestedRef,
    builtCommit: row.builtCommit,
    ociRevision: row.ociRevision,
    rollbackOf: row.rollbackOf,
    actorEmail: row.actorEmail,
    actionId: row.actionId,
    createdAt: row.createdAt.toISOString(),
    refusal,
  };
}

export async function getReleaseList(deps: AppDeps, target: ServiceTarget): Promise<ReleaseList> {
  const record = requireService(deps, target);
  const keep = releasesKept(deps);
  if (!hasReleases(record) || record.id === null) {
    return { available: false, items: [], keep };
  }
  const rows = listReleaseRows(deps.db, record.id);
  const activeNumber = activeNumberOf(deps, record);
  const swarm = await inspectOwnedService(deps, target);
  const context = { target, activeNumber, swarm };
  const items = await Promise.all(
    rows.map(async (row) =>
      toEntry(row, activeNumber, await refusalOf(deps, row, openSnapshot(deps, row), context)),
    ),
  );
  return { available: true, items, keep };
}

export async function getReleaseDetail(
  deps: AppDeps,
  target: ServiceTarget,
  number: number,
): Promise<ReleaseDetail> {
  const record = requireService(deps, target);
  const row = requireRelease(deps, record, number);
  const snapshot = openSnapshot(deps, row);
  const activeNumber = activeNumberOf(deps, record);
  const swarm = await inspectOwnedService(deps, target);
  const refusal = await refusalOf(deps, row, snapshot, { target, activeNumber, swarm });
  const applied = readApplied(deps, target, record);
  return {
    ...toEntry(row, activeNumber, refusal),
    changes: applied === undefined ? [] : diffEffective(applied, snapshot.effective),
  };
}
