import type { Dirent } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "../../core/context";

export const PANEL_SERVICE = "opsifier";
/** A helper container answers in a second or two, so anything longer means it never will. */
const MEASURE_TIMEOUT_MS = 20_000;

export interface DiskReading {
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

export interface DockerDiskReading extends DiskReading {
  /** Where the daemon keeps its data, on the host. */
  path: string;
}

/** A size for a log line, which nobody reads in the browser's language. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export async function directorySize(path: string, limit = { entries: 500_000 }): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0 && limit.entries > 0) {
    const current = pending.pop() as string;
    let children: Dirent[];
    try {
      children = await readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const child of children) {
      limit.entries -= 1;
      const full = join(current, child.name);
      if (child.isDirectory()) {
        pending.push(full);
      } else if (child.isFile()) {
        const info = await stat(full).catch(() => null);
        total += info?.size ?? 0;
      }
    }
  }
  return total;
}

const PINNED = /@sha256:[0-9a-f]{64}$/;

/**
 * The image the panel's own running container was started from, by its ID. Of several tasks, as
 * during an update, the one this process runs in, whose ID its hostname begins with.
 */
async function runningPanelImage(deps: Pick<AppDeps, "docker">): Promise<string | null> {
  const running = (await deps.docker.listContainers()).filter(
    (container) =>
      container.state === "running" &&
      container.labels["com.docker.swarm.service.name"] === PANEL_SERVICE &&
      container.imageId !== "",
  );
  const own = running.find((container) => container.id.startsWith(hostname()));
  return (own ?? (running.length === 1 ? running[0] : undefined))?.imageId ?? null;
}

/**
 * The image to run host operations from: a configured one, or exactly what the panel runs. A helper
 * runs as root with the server's files, its network or its processes, so it never goes by a tag, which
 * anything that builds an image on this server could move: it takes the image ID of the panel's own
 * container, or else a digest the service names. Without either, there is none.
 */
export async function helperImage(deps: Pick<AppDeps, "config" | "docker">): Promise<string | null> {
  if (deps.config.helperImage !== undefined) {
    return deps.config.helperImage;
  }
  const running = await runningPanelImage(deps).catch(() => null);
  if (running !== null) {
    return running;
  }
  const panel = await deps.docker.inspectService(PANEL_SERVICE).catch(() => null);
  const image = panel?.spec.TaskTemplate.ContainerSpec.Image ?? null;
  return image !== null && PINNED.test(image) ? image : null;
}

/** The disk the panel's data directory is on. */
export async function readPanelDisk(deps: Pick<AppDeps, "config">): Promise<DiskReading | null> {
  try {
    const fs = await statfs(deps.config.dataDir);
    const usedBytes = Number(fs.blocks - fs.bfree) * fs.bsize;
    const freeBytes = Number(fs.bavail) * fs.bsize;
    return { usedBytes, freeBytes, totalBytes: usedBytes + freeBytes };
  } catch {
    return null;
  }
}

/** The last line of `df -kP`: filesystem, blocks, used, available, percentage and mount point. */
function parseDiskFree(stdout: string): DiskReading | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const match = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/.exec(line);
  if (match === null) {
    return null;
  }
  const usedBytes = Number(match[2]) * 1024;
  const freeBytes = Number(match[3]) * 1024;
  return { usedBytes, freeBytes, totalBytes: usedBytes + freeBytes };
}

/**
 * The filesystem Docker writes images and containers to, which is often not the panel's own. The
 * panel only mounts its data directory, so this goes through a helper container that sees the host.
 * Null when it can't be measured: the reading is information and never stands in anyone's way.
 */
export async function readDockerDisk(
  deps: Pick<AppDeps, "config" | "docker">,
  signal?: AbortSignal,
): Promise<DockerDiskReading | null> {
  const timeout = AbortSignal.timeout(MEASURE_TIMEOUT_MS);
  try {
    const { rootDir } = await deps.docker.engineInfo();
    const image = await helperImage(deps);
    if (rootDir === "" || image === null) {
      return null;
    }
    const { exitCode, stdout } = await deps.docker.runHelper({
      image,
      command: ["df", "-k", "-P", "--", `/host${rootDir}`],
      binds: ["/:/host:ro"],
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const reading = exitCode === 0 ? parseDiskFree(stdout) : null;
    return reading === null ? null : { ...reading, path: rootDir };
  } catch {
    return null;
  }
}
