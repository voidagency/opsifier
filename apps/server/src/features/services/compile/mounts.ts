import { join } from "node:path";
import type { MountRisk, MountSpec } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../core/docker";
import { idLabel, qualifiedName } from "./names";

type ContainerMount = NonNullable<SwarmServiceSpec["TaskTemplate"]["ContainerSpec"]["Mounts"]>[number];

/** A file the deployer writes to disk before the rollout, for a `file` mount to bind. */
export interface MountFile {
  path: string;
  content: string;
  /** Defaults to owner-only. A container that reads it as another user needs more. */
  mode?: number;
}

/** A named volume the deployer creates before the rollout, backed by a directory it prepares. */
export interface MountVolume {
  name: string;
  /** Under the service's data directory, so it moves and is removed with the service. */
  directory: string;
  labels: Record<string, string>;
}

export interface CompiledMounts {
  mounts: ContainerMount[];
  files: MountFile[];
  volumes: MountVolume[];
  /** Mounts live on the node that holds the data. */
  constraints: string[];
}

export interface MountsInput {
  mounts: readonly MountSpec[];
  project: string;
  service: string;
  dataDir: string;
  /** The service's stable identifier, which outlives the name on the volume. */
  id?: string | null;
}

const MANAGER_ONLY = "node.role==manager";

/** On most distributions one of these is a link to the other. */
export const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"] as const;

/** Thrown when a mount would expose the server and nobody confirmed it. A deploy must not go ahead. */
export class UnacknowledgedMountError extends Error {
  override readonly name = "UnacknowledgedMountError";
}

function contains(parent: string, path: string): boolean {
  return parent === "/" || path === parent || path.startsWith(`${parent}/`);
}

/** Whether binding `hostPath` puts `target` inside the container: the path itself, within, or above it. */
const exposes = (hostPath: string, target: string): boolean =>
  contains(hostPath, target) || contains(target, hostPath);

/** What a bind mount of this host path would expose, worst first. Paths are already normalized. */
export function bindMountRisk(
  hostPath: string,
  dataDir: string,
  dockerSockets: readonly string[] = DOCKER_SOCKET_PATHS,
): MountRisk | null {
  if (dockerSockets.some((socket) => exposes(hostPath, socket))) {
    return "docker-socket";
  }
  return exposes(hostPath, dataDir) ? "data-directory" : null;
}

/** The Docker volume behind one named mount. */
export const volumeName = (project: string, service: string, mount: string): string =>
  `${qualifiedName(project, service)}_${mount}`;

export function compileMounts({ mounts, project, service, dataDir, id }: MountsInput): CompiledMounts {
  const files: MountFile[] = [];
  const volumes: MountVolume[] = [];
  const serviceDirectory = join(dataDir, "projects", project, service);

  const compiled = mounts.map((mount, index): ContainerMount => {
    if (mount.type === "bind") {
      if (!mount.acknowledgeRisk && bindMountRisk(mount.hostPath, dataDir) !== null) {
        throw new UnacknowledgedMountError(
          `The bind mount of ${mount.hostPath} exposes the server and was never confirmed.`,
        );
      }
      return { Type: "bind", Source: mount.hostPath, Target: mount.mountPath };
    }
    if (mount.type === "volume") {
      const name = volumeName(project, service, mount.name);
      volumes.push({
        name,
        directory: join(serviceDirectory, "volumes", mount.name),
        labels: { "opsifier.project": project, "opsifier.service": service, ...idLabel(id) },
      });
      return { Type: "volume", Source: name, Target: mount.mountPath };
    }
    const path = join(serviceDirectory, "files", `${index}.txt`);
    // Bound by itself into a container that may run as anyone. Its directories stay owner-only.
    files.push({ path, content: mount.content, mode: 0o644 });
    return { Type: "bind", Source: path, Target: mount.mountPath };
  });
  return { mounts: compiled, files, volumes, constraints: compiled.length > 0 ? [MANAGER_ONLY] : [] };
}
