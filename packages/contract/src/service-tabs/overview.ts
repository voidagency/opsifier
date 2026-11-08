import { z } from "zod";

/** GET /api/v1/projects/{project}/services/{service}/metrics: summed across running tasks. */
export const serviceMetrics = z.object({
  cpuPercent: z.number().min(0),
  memoryUsedBytes: z.number().int().min(0),
  networkRxBytes: z.number().int().min(0),
  networkTxBytes: z.number().int().min(0),
  readAt: z.iso.datetime().nullable(),
});
export type ServiceMetrics = z.infer<typeof serviceMetrics>;

/** PUT /api/v1/projects/{project}/services/{service}/notes */
export const serviceNotes = z.object({ notes: z.string().max(64 * 1024, "This is too long") });
export type ServiceNotes = z.infer<typeof serviceNotes>;
