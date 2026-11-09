import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";

interface CpuTimes {
  idle: number;
  total: number;
}

function cpuTimes(): CpuTimes | null {
  try {
    const list = cpus();
    if (list.length === 0) {
      return null;
    }
    let idle = 0;
    let total = 0;
    for (const { times } of list) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  } catch {
    return null;
  }
}

export interface HostReading {
  cpuPercent: number | null;
  cores: number | null;
  load: [number, number, number] | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

/** Reads the machine the panel runs on. Null for anything the platform can't tell it. */
export class HostProbe {
  private lastCpu: CpuTimes | null = null;

  constructor(private readonly dataDir: string) {}

  async read(): Promise<HostReading> {
    const now = cpuTimes();
    const previous = this.lastCpu;
    this.lastCpu = now;

    let cpuPercent: number | null = null;
    if (now !== null && previous !== null && now.total > previous.total) {
      cpuPercent = Math.min(
        100,
        Math.max(0, (1 - (now.idle - previous.idle) / (now.total - previous.total)) * 100),
      );
    }

    let cores: number | null = null;
    let load: [number, number, number] | null = null;
    try {
      cores = cpus().length || null;
      const [one = 0, five = 0, fifteen = 0] = loadavg();
      load = [one, five, fifteen];
    } catch {
      cores = null;
    }

    let memoryUsed: number | null = null;
    let memoryTotal: number | null = null;
    try {
      memoryTotal = totalmem();
      memoryUsed = memoryTotal - freemem();
    } catch {
      memoryTotal = null;
    }

    let diskUsed: number | null = null;
    let diskTotal: number | null = null;
    try {
      const fs = await statfs(this.dataDir);
      const used = Number(fs.blocks - fs.bfree) * fs.bsize;
      diskUsed = used;
      diskTotal = used + Number(fs.bavail) * fs.bsize;
    } catch {
      diskTotal = null;
    }

    return { cpuPercent, cores, load, memoryUsed, memoryTotal, diskUsed, diskTotal };
  }
}
