import { z } from "zod";

/** Docker refuses smaller memory limits and CPU quotas when it starts the container. */
export const MIN_MEMORY_MEGABYTES = 6;
export const MIN_CPU_CORES = 0.01;

const memoryMegabytes = z
  .number()
  .min(0, "Must be 0 or more")
  .max(16 * 1024 * 1024, "This is too large")
  .refine((value) => value === 0 || value >= MIN_MEMORY_MEGABYTES, {
    message: `Use 0 for none, or at least ${MIN_MEMORY_MEGABYTES} MB`,
  });

const cpuCores = z
  .number()
  .min(0, "Must be 0 or more")
  .max(4096, "This is too large")
  .refine((value) => value === 0 || value >= MIN_CPU_CORES, {
    message: `Use 0 for none, or at least ${MIN_CPU_CORES} cores`,
  });

/** Megabytes of memory and cores of CPU. Zero means no limit or reservation. */
export const resourcesSpec = z
  .object({
    memoryReservation: memoryMegabytes.default(0),
    memoryLimit: memoryMegabytes.default(0),
    cpuReservation: cpuCores.default(0),
    cpuLimit: cpuCores.default(0),
  })
  .superRefine((value, context) => {
    // Docker accepts these at creation, then fails every task when it tries to start one.
    if (value.memoryLimit > 0 && value.memoryReservation > value.memoryLimit) {
      context.addIssue({
        code: "custom",
        path: ["memoryReservation"],
        message: "Can't be more than the limit",
      });
    }
    if (value.cpuLimit > 0 && value.cpuReservation > value.cpuLimit) {
      context.addIssue({ code: "custom", path: ["cpuReservation"], message: "Can't be more than the limit" });
    }
  });
export type ResourcesSpec = z.infer<typeof resourcesSpec>;
