import type { BackupConfigEntry, BackupEntry, BackupRunStatus, RestoreEntry } from "@opsifier/contract";
import { stateFromAction, type VisualState } from "../../ui";

/** How a backup or restore ended, in the state language. A run that is going is in progress. */
export function stateOfRun(status: BackupRunStatus): VisualState {
  return stateFromAction(status);
}

/** What a configuration's last result says about it, with the problems that outrank it first. */
export function stateOfConfig(config: BackupConfigEntry): VisualState {
  if (!config.destinationReady) {
    return "degraded";
  }
  if (config.lastRun !== null) {
    return stateOfRun(config.lastRun.status);
  }
  return config.enabled ? "unknown" : "stopped";
}

export type HistoryItem =
  | ({ entry: "backup"; at: string } & BackupEntry)
  | ({ entry: "restore"; at: string } & RestoreEntry);

/** Backups and restores in one timeline, the newest first, the way the log reads. */
export function historyItems(
  backups: readonly BackupEntry[],
  restores: readonly RestoreEntry[],
): HistoryItem[] {
  const items: HistoryItem[] = [
    ...backups.map((backup): HistoryItem => ({ ...backup, entry: "backup", at: backup.createdAt })),
    ...restores.map((restore): HistoryItem => ({ ...restore, entry: "restore", at: restore.createdAt })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export function stateOfHistoryItem(item: HistoryItem): VisualState {
  if (item.entry === "restore" && item.unresolved) {
    return "failed";
  }
  if (item.entry === "backup" && item.deletedAt !== null) {
    return "stopped";
  }
  if (item.entry === "backup" && item.cleanupError !== null && item.status === "succeeded") {
    return "degraded";
  }
  return stateOfRun(item.status);
}

/** The file part of a stored path, which is what a person recognises. */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
