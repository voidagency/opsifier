import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  MAX_MOUNTS,
  type MountEntry,
  type MountRisk,
  type MountSpec,
  type StorageDocument,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { badRequest, conflict, notFound } from "../../../core/errors";
import {
  bindMountRisk,
  DOCKER_SOCKET_PATHS,
  type MountFile,
  type MountVolume,
} from "../../services/compile/mounts";
import { saveServiceSpec } from "../../services/repo";
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

export function addMount(deps: AppDeps, target: ServiceTarget, mount: MountSpec): StorageDocument {
  const { mounts } = requireService(deps, target).spec;
  if (mounts.length >= MAX_MOUNTS) {
    throw badRequest("too_many_mounts", "This service has as many mounts as it can hold.");
  }
  assertPathFree(mounts, mount.mountPath);
  return save(deps, target, [...mounts, withAcknowledgement(deps, mount)]);
}

export function updateMount(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  mount: MountSpec,
): StorageDocument {
  const { mounts } = requireService(deps, target).spec;
  if (index >= mounts.length) {
    throw notFound("This mount does not exist.");
  }
  assertPathFree(mounts, mount.mountPath, index);
  const accepted = withAcknowledgement(deps, mount);
  return save(
    deps,
    target,
    mounts.map((existing, position) => (position === index ? accepted : existing)),
  );
}

export function removeMount(deps: AppDeps, target: ServiceTarget, index: number): StorageDocument {
  const { mounts } = requireService(deps, target).spec;
  if (index >= mounts.length) {
    throw notFound("This mount does not exist.");
  }
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
    const mode = file.mode ?? DEFAULT_FILE_MODE;
    await writeFile(file.path, file.content, { mode });
    // The mode above only applies to a new file, and is always filtered by the umask.
    await chmod(file.path, mode);
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
async function prepareVolumes(deps: Pick<AppDeps, "docker">, volumes: readonly MountVolume[]): Promise<void> {
  for (const volume of volumes) {
    await mkdir(volume.directory, { recursive: true, mode: 0o700 });
    await chmod(volume.directory, VOLUME_DIRECTORY_MODE);
    if ((await deps.docker.inspectVolume(volume.name)) === null) {
      await deps.docker.createVolume({
        name: volume.name,
        driver: "local",
        driverOptions: { type: "none", o: "bind", device: volume.directory },
        labels: volume.labels,
      });
    }
  }
}

/** Everything a service's mounts need on disk and in Docker. Run before its tasks start. */
export async function prepareMounts(
  deps: Pick<AppDeps, "config" | "docker">,
  target: ServiceTarget,
  compiled: { files: readonly MountFile[]; volumes?: readonly MountVolume[] },
): Promise<void> {
  await writeMountFiles(deps, target, compiled.files);
  await prepareVolumes(deps, compiled.volumes ?? []);
}

const VOLUME_REMOVAL_ATTEMPTS = 5;
const VOLUME_REMOVAL_DELAY_MS = 1000;

/** Swarm takes a moment to stop the tasks of a removed service, and until then a volume is in use. */
export async function removeServiceVolumes(
  deps: Pick<AppDeps, "docker" | "logger">,
  target: ServiceTarget,
): Promise<void> {
  const volumes = (await deps.docker.listVolumes()).filter(
    (volume) =>
      volume.labels["opsifier.project"] === target.projectName &&
      volume.labels["opsifier.service"] === target.serviceName,
  );
  for (const volume of volumes) {
    for (let attempt = 1; attempt <= VOLUME_REMOVAL_ATTEMPTS; attempt += 1) {
      try {
        await deps.docker.removeVolume(volume.name);
        break;
      } catch (error) {
        if (attempt === VOLUME_REMOVAL_ATTEMPTS) {
          deps.logger.warn({ err: error, volume: volume.name }, "Could not remove a service's volume");
        } else {
          await new Promise((resolve) => setTimeout(resolve, VOLUME_REMOVAL_DELAY_MS));
        }
      }
    }
  }
}
