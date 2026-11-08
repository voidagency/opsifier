import type { ResourcesSpec } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../core/docker";

const BYTES_PER_MEGABYTE = 1024 * 1024;
const NANOS_PER_CORE = 1e9;

type ResourceAmounts = { NanoCPUs?: number; MemoryBytes?: number };

/** Docker reads an absent field as unlimited, so zero is left out rather than sent. */
function amounts(memoryMegabytes: number, cores: number): ResourceAmounts {
  return {
    ...(cores > 0 ? { NanoCPUs: Math.round(cores * NANOS_PER_CORE) } : {}),
    ...(memoryMegabytes > 0 ? { MemoryBytes: Math.round(memoryMegabytes * BYTES_PER_MEGABYTE) } : {}),
  };
}

export function compileResources(
  resources: ResourcesSpec,
): NonNullable<SwarmServiceSpec["TaskTemplate"]["Resources"]> {
  return {
    Limits: amounts(resources.memoryLimit, resources.cpuLimit),
    Reservations: amounts(resources.memoryReservation, resources.cpuReservation),
  };
}
