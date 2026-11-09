import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RetainedVolumeList } from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { conflict, notFound } from "../../core/errors";
import { directorySize, formatSize, readDockerDisk, readPanelDisk } from "../server/disk";
import { qualifiedName } from "../services/compile/names";
import { findService, type ServiceRecord } from "../services/repo";
import { dockerFailure, type ServiceTarget, serviceDir } from "../services/service";
import {
  deleteRetainedVolume,
  findRetainedVolume,
  listRetainedVolumes as listRows,
  type RetainedVolumeRow,
  saveRetainedVolume,
} from "./repo";

const toKey = (target: ServiceTarget) => ({
  projectName: target.projectName,
  serviceName: target.serviceName,
});

/**
 * Notes every volume a service leaves behind, just before the service itself goes. Volumes are only
 * ever kept here: deleting one is a separate decision, made later and one volume at a time.
 */
export async function retainServiceVolumes(
  deps: Pick<AppDeps, "db" | "docker" | "now">,
  target: ServiceTarget,
  record: ServiceRecord | undefined,
  log: (line: string) => void,
): Promise<void> {
  const volumes = await deps.docker.listVolumes();
  const stack = qualifiedName(target.projectName, target.serviceName);
  const kept = new Map<string, RetainedVolumeRow["kind"]>();
  for (const { name, labels } of volumes) {
    if (
      labels["opsifier.project"] === target.projectName &&
      labels["opsifier.service"] === target.serviceName
    ) {
      kept.set(name, "app");
    } else if (labels["com.docker.compose.project"] === stack) {
      kept.set(name, "compose");
    }
  }
  const databaseVolume = record?.spec.database?.volume;
  if (databaseVolume !== undefined && volumes.some((volume) => volume.name === databaseVolume)) {
    kept.set(databaseVolume, "database");
  }

  const retainedAt = new Date(deps.now());
  for (const [name, kind] of kept) {
    saveRetainedVolume(deps.db, { name, kind, retainedAt, ...toKey(target) });
    log(`Keeping the volume ${name}. It can be deleted later under Monitor, Storage.`);
  }
}

/** A volume of an App lives in a folder of the data directory. Stacks and databases keep theirs in Docker. */
function volumeDirectory(deps: Pick<AppDeps, "config">, row: RetainedVolumeRow): string | null {
  const prefix = `${qualifiedName(row.projectName, row.serviceName)}_`;
  if (row.kind !== "app" || !row.name.startsWith(prefix)) {
    return null;
  }
  const mount = row.name.slice(prefix.length);
  // Only a single, harmless folder name can be derived from a name, whatever Docker holds.
  if (mount !== basename(mount) || mount === "" || mount === "." || mount === "..") {
    return null;
  }
  return join(serviceDir(deps, row.projectName, row.serviceName), "volumes", mount);
}

/** The service that has taken this volume up again, if one has. */
function claimingService(deps: Pick<AppDeps, "db">, row: RetainedVolumeRow): ServiceRecord | undefined {
  const record = findService(deps.db, row.projectName, row.serviceName);
  if (record === undefined) {
    return undefined;
  }
  const { database, compose, mounts } = record.spec;
  const prefix = `${qualifiedName(row.projectName, row.serviceName)}_`;
  const claimed =
    row.kind === "database"
      ? database?.volume === row.name
      : row.kind === "compose"
        ? compose !== null
        : mounts.some((mount) => mount.type === "volume" && `${prefix}${mount.name}` === row.name);
  return claimed ? record : undefined;
}

function assertUnclaimed(deps: Pick<AppDeps, "db">, row: RetainedVolumeRow): void {
  if (claimingService(deps, row) !== undefined) {
    throw conflict(
      "volume_in_use",
      `${row.serviceName} uses this volume again, so it is no longer kept on its own. Destroy that service first.`,
    );
  }
}

/** What is left of destroyed services: anything no service has picked up again and that still exists. */
export async function listRetainedVolumes(
  deps: Pick<AppDeps, "db" | "docker" | "config">,
): Promise<RetainedVolumeList> {
  let present: Set<string>;
  try {
    present = new Set((await deps.docker.listVolumes()).map((volume) => volume.name));
  } catch (error) {
    throw error instanceof DockerDriverError ? dockerFailure(error) : error;
  }
  const volumes = listRows(deps.db)
    .filter((row) => claimingService(deps, row) === undefined)
    .filter((row) => {
      const directory = volumeDirectory(deps, row);
      return present.has(row.name) || (directory !== null && existsSync(directory));
    })
    .map((row) => ({ ...row, retainedAt: row.retainedAt.toISOString() }));
  return { volumes };
}

/** A volume is in use until Swarm has finished stopping the tasks of the service it belonged to. */
async function removeDockerVolume(
  deps: Pick<AppDeps, "docker" | "rollout">,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + deps.rollout.timeoutMs;
  for (;;) {
    try {
      await deps.docker.removeVolume(name);
      return;
    } catch (error) {
      if (!(error instanceof DockerDriverError) || performance.now() >= deadline) {
        throw new Error(
          `The volume ${name} could not be deleted and is still there: ${(error as Error).message}`,
        );
      }
      await sleep(deps.rollout.pollMs, undefined, { signal });
    }
  }
}

/** Folders are only ever removed empty, so another kept volume of the same service stays intact. */
async function removeEmptyParents(deps: Pick<AppDeps, "config">, directory: string): Promise<void> {
  const parents = [dirname(directory), dirname(dirname(directory)), dirname(dirname(dirname(directory)))];
  const projects = join(deps.config.dataDir, "projects");
  for (const parent of parents.filter((path) => path.startsWith(`${projects}/`))) {
    await rmdir(parent).catch(() => undefined);
  }
}

async function deleteVolume(deps: AppDeps, name: string, ctx: ActionContext): Promise<void> {
  const row = findRetainedVolume(deps.db, name);
  if (row === undefined) {
    ctx.log("This volume is already gone.");
    return;
  }
  assertUnclaimed(deps, row);

  const directory = volumeDirectory(deps, row);
  const expected = directory === null ? null : await directorySize(directory);
  const readFree = directory === null ? () => readDockerDisk(deps, ctx.signal) : () => readPanelDisk(deps);
  const freeBefore = await readFree();
  const volumesBefore = directory === null ? await dockerVolumeBytes(deps) : null;

  ctx.log(`Deleting the volume ${name}${expected === null ? "" : ` (about ${formatSize(expected)})`}`);
  await removeDockerVolume(deps, name, ctx.signal);
  if (directory !== null) {
    await rm(directory, { recursive: true, force: true });
    if (findService(deps.db, row.projectName, row.serviceName) === undefined) {
      await removeEmptyParents(deps, directory);
    }
  }
  deleteRetainedVolume(deps.db, name);

  const freeAfter = await readFree();
  const volumesAfter = directory === null ? await dockerVolumeBytes(deps) : null;
  const reported = volumesBefore !== null && volumesAfter !== null;
  ctx.log(
    `Deleted ${name}.${expected === null ? "" : ` Expected back: ${formatSize(expected)}.`}${
      reported ? ` Docker reports ${formatSize(Math.max(0, volumesBefore - volumesAfter))} given back.` : ""
    }`,
  );
  if (freeBefore !== null && freeAfter !== null) {
    ctx.log(
      `Free space on its disk went from ${formatSize(freeBefore.freeBytes)} to ${formatSize(freeAfter.freeBytes)}.`,
    );
  }
}

async function dockerVolumeBytes(deps: Pick<AppDeps, "docker">): Promise<number | null> {
  return (await deps.docker.diskUsage().catch(() => null))?.volumesBytes ?? null;
}

/** The only way a kept volume ever goes: one at a time, its exact name typed, as its own Action. */
export function enqueueRetainedVolumeDeletion(
  deps: AppDeps,
  name: string,
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  const row = findRetainedVolume(deps.db, name);
  if (row === undefined) {
    throw notFound("No volume with this name is being kept.");
  }
  if (confirm !== name) {
    throw conflict("confirmation_mismatch", "Type the volume's exact name to confirm.", {
      confirm: "Does not match the volume's name",
    });
  }
  assertUnclaimed(deps, row);
  return deps.actions.enqueue({
    type: "volume.delete",
    title: `Delete the kept volume ${name}`,
    projectName: row.projectName,
    serviceName: row.serviceName,
    actorEmail,
    run: (ctx) => deleteVolume(deps, name, ctx),
  });
}
