import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { formatSize, readDockerDisk, readPanelDisk } from "../server/disk";
import { builtImageName } from "./compile/names";
import type { ServiceTarget } from "./service";

/** What is kept free beyond the estimate, so a deployment that fits doesn't leave the disk at zero. */
const MARGIN_BYTES = 128 * 1024 * 1024;
/** Stand-ins for an image nothing is known about yet. They only refuse a disk with no real room left. */
const PULL_ALLOWANCE_BYTES = 512 * 1024 * 1024;
const BUILD_ALLOWANCE_BYTES = 1024 * 1024 * 1024;
/** A new version shares most of its layers with the one it replaces. */
const CHANGED_LAYERS_RATIO = 0.5;

export interface DiskNeed {
  bytes: number;
  /** How the figure was arrived at, for the deployment's log. */
  basis: string;
}

async function sizeOnDaemon(deps: Pick<AppDeps, "docker">, ref: string): Promise<number | null> {
  try {
    return (await deps.docker.inspectImage(ref))?.sizeBytes ?? null;
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return null;
    }
    throw error;
  }
}

/**
 * What pulling this image is expected to add to Docker's disk. Only the image the service itself last
 * deployed is weighed: the log would otherwise tell anyone who names an image whether another project
 * has it on this server, and how large it is.
 */
export async function imageDiskNeed(
  deps: Pick<AppDeps, "docker">,
  ref: string,
  lastDeployed: string | null,
): Promise<DiskNeed> {
  const size = ref === lastDeployed ? await sizeOnDaemon(deps, ref) : null;
  return size === null
    ? { bytes: PULL_ALLOWANCE_BYTES, basis: `an allowance for ${ref}` }
    : {
        bytes: Math.ceil(size * CHANGED_LAYERS_RATIO),
        basis: `half of the ${formatSize(size)} that ${ref} takes on this server`,
      };
}

/** What building this service's image is expected to add to Docker's disk. */
export async function buildDiskNeed(deps: Pick<AppDeps, "docker">, target: ServiceTarget): Promise<DiskNeed> {
  const image = builtImageName(target.projectName, target.serviceName);
  const size = await sizeOnDaemon(deps, image);
  const estimate = size === null ? 0 : Math.ceil(size * CHANGED_LAYERS_RATIO);
  return estimate > BUILD_ALLOWANCE_BYTES
    ? { bytes: estimate, basis: `half of the ${formatSize(size as number)} of its last build` }
    : { bytes: BUILD_ALLOWANCE_BYTES, basis: "an allowance for a build" };
}

/**
 * Everything a stack's file asks for: its images share one allowance, and its builds another. Images
 * are not weighed by what the server holds under their names, which may be another project's.
 */
export async function stackDiskNeed(
  _deps: Pick<AppDeps, "docker">,
  children: ReadonlyArray<{ image?: unknown; build?: unknown }>,
): Promise<DiskNeed> {
  const builds = children.some((child) => child.build !== undefined);
  const images = children.some((child) => child.build === undefined && typeof child.image === "string");
  return {
    bytes: (images ? PULL_ALLOWANCE_BYTES : 0) + (builds ? BUILD_ALLOWANCE_BYTES : 0),
    basis: `the ${children.length} service${children.length === 1 ? "" : "s"} in its Compose file`,
  };
}

/**
 * Compares what a deployment is expected to write with the room on the disk it will land on, and
 * stops it there, before anything changes, if it can't fit. A disk that can't be measured stops
 * nothing: the check is an early warning, not a guard the deployment depends on.
 */
export async function assertDeploySpace(
  deps: Pick<AppDeps, "config" | "docker">,
  need: DiskNeed,
  ctx: ActionContext,
): Promise<void> {
  const required = need.bytes + MARGIN_BYTES;
  ctx.log(`Disk space this deployment needs: about ${formatSize(required)}, from ${need.basis}`);

  const docker = await readDockerDisk(deps, ctx.signal);
  if (docker === null) {
    ctx.log("Docker's disk can't be measured from here, so its free space wasn't checked");
  } else {
    ctx.log(`Free space on Docker's disk (${docker.path}): ${formatSize(docker.freeBytes)}`);
    if (docker.freeBytes < required) {
      throw new Error(
        `Not enough disk space to deploy: about ${formatSize(required)} is needed on Docker's disk and ${formatSize(docker.freeBytes)} is free. Nothing was changed. Free some space (Settings, General, Docker) and try again.`,
      );
    }
  }

  const panel = await readPanelDisk(deps);
  if (panel !== null && panel.freeBytes < MARGIN_BYTES) {
    throw new Error(
      `Not enough disk space to deploy: the panel's data disk has only ${formatSize(panel.freeBytes)} free. Nothing was changed.`,
    );
  }
}
