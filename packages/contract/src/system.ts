import { z } from "zod";

/** GET /api/v1/system/info */
export const systemInfo = z.object({
  version: z.string(),
  /** The address to point DNS at. Null when the panel has not been able to determine one. */
  serverIp: z.union([z.ipv4(), z.ipv6()]).nullable(),
});
export type SystemInfo = z.infer<typeof systemInfo>;
