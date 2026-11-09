import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StorageReport } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { readDockerDisk } from "../server/disk";
import { rememberOwnedImages } from "../server/docker-admin";
import { listServiceRecords } from "../services/repo";
import { HostProbe } from "./probe";

const CACHE_MS = 60_000;
const DOCKER_CACHE_MS = 30_000;
/** Reading Docker's disk starts a container on the host, so it is not done for every refresh. */
const DOCKER_DISK_CACHE_MS = 60_000;
/** Beyond this many files a size is an estimate, and the scan gives the disk a rest. */
const MAX_ENTRIES_PER_SCAN = 2_000_000;

interface ScanResult {
  scannedAt: number;
  sizes: Map<string, number>;
}

async function directorySize(
  path: string,
  budget: { entries: number },
  signal: AbortSignal,
): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0 && budget.entries > 0 && !signal.aborted) {
    const current = pending.pop() as string;
    let children: Dirent[];
    try {
      children = await readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const child of children) {
      budget.entries -= 1;
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

/** Sizes of the per-service directories. A scan is slow, so it runs behind the answer, one at a time. */
export class StorageScanner {
  private scan: ScanResult | null = null;
  private running: Promise<void> | null = null;
  private dockerUsage: { at: number; value: StorageReport["docker"] } | null = null;
  private dockerDisk: { at: number; value: StorageReport["dockerDisk"] } | null = null;
  private readonly controller = new AbortController();
  private readonly probe: HostProbe;

  constructor(private readonly deps: AppDeps) {
    this.probe = new HostProbe(deps.config.dataDir);
  }

  stop(): void {
    this.controller.abort();
  }

  /** The last known size of a service's data, or null before the first scan. */
  sizeOf(scope: string): number | null {
    return this.scan?.sizes.get(scope) ?? null;
  }

  async report(): Promise<StorageReport> {
    const { deps } = this;
    const now = deps.now();
    if (this.scan === null || now - this.scan.scannedAt >= CACHE_MS) {
      this.refresh();
    }
    const disk = await this.probe.read();
    const records = listServiceRecords(deps.db);
    return {
      scannedAt: this.scan === null ? null : new Date(this.scan.scannedAt).toISOString(),
      scanning: this.running !== null,
      disk: { usedBytes: disk.diskUsed, totalBytes: disk.diskTotal, path: deps.config.dataDir },
      docker: await this.readDockerUsage(now),
      dockerDisk: await this.readDockerDisk(now),
      services: records.map((record) => {
        const scope = `${record.projectName}/${record.name}`;
        return {
          projectName: record.projectName,
          serviceName: record.name,
          sizeBytes: this.scan?.sizes.get(scope) ?? null,
          path: join(deps.config.dataDir, "projects", record.projectName, record.name),
        };
      }),
    };
  }

  private refresh(): void {
    if (this.running === null) {
      this.running = this.runScan().finally(() => {
        this.running = null;
      });
    }
  }

  private async runScan(): Promise<void> {
    const { deps } = this;
    const budget = { entries: MAX_ENTRIES_PER_SCAN };
    const sizes = new Map<string, number>();
    for (const record of listServiceRecords(deps.db)) {
      if (this.controller.signal.aborted) {
        return;
      }
      const path = join(deps.config.dataDir, "projects", record.projectName, record.name);
      sizes.set(
        `${record.projectName}/${record.name}`,
        await directorySize(path, budget, this.controller.signal),
      );
    }
    this.scan = { scannedAt: deps.now(), sizes };
  }

  private async readDockerDisk(now: number): Promise<StorageReport["dockerDisk"]> {
    if (this.dockerDisk !== null && now - this.dockerDisk.at < DOCKER_DISK_CACHE_MS) {
      return this.dockerDisk.value;
    }
    const value = await readDockerDisk(this.deps);
    this.dockerDisk = { at: now, value };
    return value;
  }

  private async readDockerUsage(now: number): Promise<StorageReport["docker"]> {
    const { deps } = this;
    if (this.dockerUsage !== null && now - this.dockerUsage.at < DOCKER_CACHE_MS) {
      return this.dockerUsage.value;
    }
    try {
      const signal = AbortSignal.timeout(30_000);
      const usage = await deps.docker.diskUsage({ signal });
      rememberOwnedImages(deps, await deps.docker.listImages());
      this.dockerUsage = {
        at: now,
        value: {
          imagesBytes: usage.imagesBytes,
          containersBytes: usage.containersBytes,
          volumesBytes: usage.volumesBytes,
          buildCacheBytes: usage.buildCacheBytes,
        },
      };
      return this.dockerUsage.value;
    } catch (error) {
      if (error instanceof DockerDriverError) {
        this.dockerUsage = { at: now, value: null };
        return null;
      }
      throw error;
    }
  }
}
