import { join } from "node:path";
import { z } from "zod";

/**
 * Where `install.sh --restore` leaves what the panel still has to do: `pending.json` says which
 * backup was put back, and `dumps/` holds each database's export from it, by project.
 */
export const restoreDirectory = (dataDir: string): string => join(dataDir, "restore");
export const pendingRestoreFile = (dataDir: string): string =>
  join(restoreDirectory(dataDir), "pending.json");
export const restoreDumpsDirectory = (dataDir: string): string => join(restoreDirectory(dataDir), "dumps");

export const pendingRestore = z.object({
  snapshotId: z.string(),
  snapshotTime: z.string(),
  hostname: z.string(),
});
export type PendingRestore = z.infer<typeof pendingRestore>;
