import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  BOX_WORKSPACE_VOLUME,
  MAX_MOUNTS,
  type MountEntry,
  type MountRisk,
  type MountSpec,
  type StorageDocument,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import type { SwarmServiceSpec } from "../../../core/docker";
import { badRequest, conflict, notFound } from "../../../core/errors";
import { writeFileAtomic } from "../../../core/proxy";
import { requireHostAccess } from "../../access/guard";
import type { Access } from "../../access/rules";
import {
  bindMountRisk,
  DOCKER_SOCKET_PATHS,
  type MountFile,
  type MountVolume,
} from "../../services/compile/mounts";
import { isOwnedVolume } from "../../services/ownership";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget, serviceDir } from "../../services/service";

/** The directory of a volume is reached by the container's own user, whichever that is. */
const VOLUME_DIRECTORY_MODE = 0o777;
const DEFAULT_FILE_MODE = 0o600;

function dockerSockets(deps: Pick<AppDeps, "config">): string[] {
  const { dockerSocket, dockerHost } = deps.config;
  const fromHost = dockerHost?.startsWith("unix://") ? dockerHost.slice("unix://".length) : undefined;
  return [...DOCKER_SOCKET_PATHS, dockerSocket, fromHost].filter(
    (path): path is string => path !== undefined,
  );
}

function riskOf(deps: Pick<AppDeps, "config">, hostPath: string): MountRisk | null {
  return bindMountRisk(hostPath, deps.config.dataDir, dockerSockets(deps));
}

function toEntry(deps: Pick<AppDeps, "config">, mount: MountSpec): MountEntry {
  return mount.type === "bind" ? { ...mount, risk: riskOf(deps, mount.hostPath) } : mount;
}

function toDocument(deps: Pick<AppDeps, "config">, mounts: readonly MountSpec[]): StorageDocument {
  return { mounts: mounts.map((mount) => toEntry(deps, mount)) };
}

const RISK_ERRORS: Record<MountRisk, { code: string; message: string; field: string }> = {
  "docker-socket": {
    code: "mount_exposes_docker_socket",
    message: "This path exposes the Docker socket, which gives the container control of the server.",
    field: "Exposes the Docker socket",
  },
  "data-directory": {
    code: "mount_exposes_data_directory",
    message: "This path exposes the panel's data directory, including its secrets.",
    field: "Exposes the panel's data directory",
  },
};

/** Keeps the confirmation only where it means something, so it never outlives the path it was for. */
function withAcknowledgement(deps: Pick<AppDeps, "config">, mount: MountSpec): MountSpec {
  if (mount.type !== "bind") {
    return mount;
  }
  const risk = riskOf(deps, mount.hostPath);
  if (risk !== null && !mount.acknowledgeRisk) {
    const { code, message, field } = RISK_ERRORS[risk];
    throw badRequest(code, message, { hostPath: field });
  }
  return { ...mount, acknowledgeRisk: risk !== null };
}

function assertPathFree(mounts: readonly MountSpec[], mountPath: string, except?: number): void {
  if (mounts.some((mount, index) => index !== except && mount.mountPath === mountPath)) {
    throw conflict("mount_path_taken", "Another mount already uses this path.", {
      mountPath: "Another mount already uses this path",
    });
  }
}

function save(deps: AppDeps, target: ServiceTarget, mounts: MountSpec[]): StorageDocument {
  const record = requireService(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, mounts },
    new Date(deps.now()),
  );
  return toDocument(deps, mounts);
}

export function getStorage(deps: AppDeps, target: ServiceTarget): StorageDocument {
  return toDocument(deps, requireService(deps, target).spec.mounts);
}

/**
 * A path on the host is the server's to give, so choosing one takes an administrator. Whoever works
 * on a service may still keep a mount an administrator gave it, or take one away.
 */
function assertHostPathAllowed(access: Access, mount: MountSpec, existing?: MountSpec): void {
  if (mount.type === "bind" && !(existing?.type === "bind" && existing.hostPath === mount.hostPath)) {
    requireHostAccess(access);
  }
}

export function addMount(
  deps: AppDeps,
  target: ServiceTarget,
  mount: MountSpec,
  access: Access,
): StorageDocument {
  assertHostPathAllowed(access, mount);
  const { mounts } = requireService(deps, target).spec;
  if (mounts.length >= MAX_MOUNTS) {
    throw badRequest("too_many_mounts", "This service has as many mounts as it can hold.");
  }
  assertPathFree(mounts, mount.mountPath);
  return save(deps, target, [...mounts, withAcknowledgement(deps, mount)]);
}

/** The workspace is what makes a box a box: taken away, a redeploy would start from nothing. */
function assertNotWorkspace(record: ServiceRecord, mount: MountSpec | undefined): void {
  if (record.spec.box !== null && mount?.type === "volume" && mount.name === BOX_WORKSPACE_VOLUME) {
    throw conflict(
      "box_workspace_mount",
      "A box's workspace can't be moved or removed. Add another mount if it needs more storage.",
    );
  }
}

export function updateMount(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  mount: MountSpec,
  access: Access,
): StorageDocument {
  const record = requireService(deps, target);
  const { mounts } = record.spec;
  if (index >= mounts.length) {
    throw notFound("This mount does not exist.");
  }
  assertNotWorkspace(record, mounts[index]);
  assertHostPathAllowed(access, mount, mounts[index]);
  assertPathFree(mounts, mount.mountPath, index);
  const accepted = withAcknowledgement(deps, mount);
  return save(
    deps,
    target,
    mounts.map((existing, position) => (position === index ? accepted : existing)),
  );
}

export function removeMount(deps: AppDeps, target: ServiceTarget, index: number): StorageDocument {
  const record = requireService(deps, target);
  const { mounts } = record.spec;
  if (index >= mounts.length) {
    throw notFound("This mount does not exist.");
  }
  assertNotWorkspace(record, mounts[index]);
  return save(
    deps,
    target,
    mounts.filter((_, position) => position !== index),
  );
}

/** Numbered by position, so a mount that moved or went away can leave a stale file behind. */
async function removeStaleFiles(directory: string, keep: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(
    entries.filter((name) => !keep.has(name)).map((name) => rm(join(directory, name), { force: true })),
  );
}

async function writeMountFiles(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  files: readonly MountFile[],
): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    // Never in place: a running task has this file mounted, and a full disk must not empty it.
    await writeFileAtomic(file.path, file.content, file.mode ?? DEFAULT_FILE_MODE);
  }
  await removeStaleFiles(
    join(serviceDir(deps, target.projectName, target.serviceName), "files"),
    new Set(files.map((file) => basename(file.path))),
  );
}

/**
 * Backs each volume with a directory under the service's data, which a process running as any user
 * can write to. A `local` volume bound to that directory is what Swarm mounts.
 */
async function prepareVolumes(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  volumes: readonly MountVolume[],
): Promise<void> {
  for (const volume of volumes) {
    const existing = await deps.docker.inspectVolume(volume.name);
    if (existing !== null && !isOwnedVolume(existing, target)) {
      throw conflict(
        "volume_not_owned",
        `Docker already has a volume named ${volume.name} that this panel did not create, so it was left alone.`,
      );
    }
    await mkdir(volume.directory, { recursive: true, mode: 0o700 });
    await chmod(volume.directory, VOLUME_DIRECTORY_MODE);
    if (existing === null) {
      await deps.docker.createVolume({
        name: volume.name,
        driver: "local",
        driverOptions: { type: "none", o: "bind", device: volume.directory },
        labels: volume.labels,
      });
    }
  }
}

/** How much of a volume is looked at. Enough to see a mismatch, and bounded however big the volume is. */
const MAX_CHECKED_ENTRIES = 1000;

/** The uid an image runs as. Null when it names a user only the image's own files could translate. */
function uidOf(user: string): number | null {
  const [name = ""] = user.split(":", 1);
  if (name === "" || name === "root") {
    return 0;
  }
  return /^\d+$/.test(name) ? Number(name) : null;
}

const WRITE_BY_OWNER = 0o200;
const WRITE_BY_GROUP = 0o020;
const WRITE_BY_OTHERS = 0o002;

function canWrite(
  entry: { uid: number; gid: number; mode: number },
  uid: number,
  groups: readonly number[],
): boolean {
  if (uid === 0) {
    return true;
  }
  if (entry.uid === uid) {
    return (entry.mode & WRITE_BY_OWNER) !== 0;
  }
  return groups.includes(entry.gid)
    ? (entry.mode & WRITE_BY_GROUP) !== 0
    : (entry.mode & WRITE_BY_OTHERS) !== 0;
}

/** The first entries under `directory` the identity can't write, up to a bounded number looked at. */
async function unwritableEntries(
  directory: string,
  uid: number,
  groups: readonly number[],
): Promise<{ checked: number; unwritable: string[] }> {
  let checked = 0;
  const unwritable: string[] = [];
  const pending = [directory];
  while (pending.length > 0 && checked < MAX_CHECKED_ENTRIES) {
    const current = pending.shift() as string;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (checked >= MAX_CHECKED_ENTRIES) {
        break;
      }
      const path = join(current, entry.name);
      checked += 1;
      if (!canWrite(await lstat(path), uid, groups)) {
        unwritable.push(relative(directory, path));
      }
      if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return { checked, unwritable };
}

/**
 * A volume is reached by whatever user the image runs as, along with the groups the service adds.
 * What is already inside it, from a restore or from an earlier image, may belong to someone else, and
 * a task would only find out when a write fails. It may well only read those files, so this is said
 * in the deployment's log rather than made to stop it.
 */
async function reportVolumeAccess(
  deps: Pick<AppDeps, "docker">,
  image: string,
  groups: readonly number[],
  volumes: readonly MountVolume[],
  log: (line: string) => void,
): Promise<void> {
  if (volumes.length === 0) {
    return;
  }
  const user = (await deps.docker.inspectImage(image).catch(() => null))?.user;
  if (user === undefined) {
    return;
  }
  const uid = uidOf(user);
  if (uid === null) {
    log(
      `The image runs as the user ${user}, whose number only the image knows, so its volumes weren't checked`,
    );
    return;
  }
  for (const volume of volumes) {
    const { checked, unwritable } = await unwritableEntries(volume.directory, uid, groups);
    const [example] = unwritable;
    if (example !== undefined) {
      log(
        `Volume ${volume.name}: the user this image runs as (${uid}) can't write ${unwritable.length} of the ${checked} files looked at, such as ${example}. Give them to that user, or use an image that runs as their owner.`,
      );
    }
  }
}

/** Everything a service's mounts need on disk and in Docker. Run before its tasks start. */
export async function prepareMounts(
  deps: Pick<AppDeps, "config" | "docker">,
  target: ServiceTarget,
  compiled: {
    files: readonly MountFile[];
    volumes?: readonly MountVolume[];
    swarmSpec?: SwarmServiceSpec | null;
  },
  log: (line: string) => void = () => {},
): Promise<void> {
  await writeMountFiles(deps, target, compiled.files);
  await prepareVolumes(deps, target, compiled.volumes ?? []);
  const container = compiled.swarmSpec?.TaskTemplate.ContainerSpec;
  if (container !== undefined) {
    await reportVolumeAccess(
      deps,
      container.Image,
      ((container.Groups ?? []) as string[]).map(Number),
      compiled.volumes ?? [],
      log,
    );
  }
}
