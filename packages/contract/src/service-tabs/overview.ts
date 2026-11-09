import { z } from "zod";
import { metricOrigin, metricScope } from "../monitor";

/**
 * GET /api/v1/projects/{project}/services/{service}/metrics: summed across running tasks. A figure Docker
 * did not report is null, never zero: the service might be idle, or it might be that nothing was read.
 */
export const serviceMetrics = z.object({
  cpuPercent: z.number().min(0).nullable(),
  /** What `cpuPercent` can reach across those tasks: 100 per core they may use. */
  cpuCapacityPercent: z.number().min(0).nullable().default(null),
  memoryUsedBytes: z.number().int().min(0).nullable(),
  /** The memory those tasks may use together: their limits, or the host's memory. */
  memoryLimitBytes: z.number().int().min(0).nullable().default(null),
  /** Received and sent since each task started. */
  networkRxBytes: z.number().int().min(0).nullable(),
  networkTxBytes: z.number().int().min(0).nullable(),
  /** When Docker was read. Null when there is nothing to show. */
  readAt: z.iso.datetime().nullable(),
  /** False when Docker did not answer, which is a different thing from nothing running. */
  available: z.boolean().default(true),
  /** How many running tasks these figures add up. */
  tasks: z.number().int().min(0).default(0),
  /** The newest reading on record, so that a gap in the figures can be dated. */
  lastReadAt: z.iso.datetime().nullable().default(null),
  origin: metricOrigin.default("docker"),
  scope: metricScope.default("service"),
});
export type ServiceMetrics = z.infer<typeof serviceMetrics>;

/** PUT /api/v1/projects/{project}/services/{service}/notes */
export const serviceNotes = z.object({ notes: z.string().max(64 * 1024, "This is too long") });
export type ServiceNotes = z.infer<typeof serviceNotes>;

/** PUT /api/v1/projects/{project}/services/{service}/notes/visibility. Hidden notes stay saved. */
export const serviceNotesVisibility = z.object({ hidden: z.boolean() });
export type ServiceNotesVisibility = z.infer<typeof serviceNotesVisibility>;
