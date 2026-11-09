import { isMajorVersionChange } from "@opsifier/contract";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import { backupOpsFor } from "../backups/engines";
import { takeDatabaseBackup } from "../backups/run";
import type { ServiceTarget } from "../services/service";
import { findProviderRow } from "../storage-providers/repo";
import { BUILT_IN_PROVIDER_ID } from "../storage-providers/service";
import type { DatabaseRecord } from "./service";

/** A stopped server has nothing to read its data with, so the copy this move depends on can't be taken. */
export function assertCopyPossible(record: DatabaseRecord): void {
  if (record.spec.stopped && backupOpsFor(record.spec.database.engine) !== null) {
    throw conflict(
      "major_change_needs_running",
      "Start this database first: a move to another major version takes a backup of it before anything else.",
    );
  }
}

/**
 * Whatever the running server holds, on Local Disk, right before a deployment moves it to another major
 * version. It fails outright when the server can't be read, because the point of it is that the old
 * data can always come back. Every way of replacing a database's tasks passes through here.
 */
export async function copyBeforeMajorChange(
  deps: AppDeps,
  target: ServiceTarget,
  record: DatabaseRecord,
  from: string,
  to: string,
  ctx: ActionContext,
): Promise<void> {
  if (!isMajorVersionChange(from, to)) {
    return;
  }
  ctx.log(`Moving from ${from} to ${to}, which may need its data to be migrated.`);
  assertCopyPossible(record);
  if (backupOpsFor(record.spec.database.engine) === null) {
    ctx.log("This engine has no backups in the panel, so none was taken. Its data stays on its volume.");
    return;
  }
  const local = findProviderRow(deps.db, BUILT_IN_PROVIDER_ID);
  if (local === undefined) {
    throw new Error("The built-in Local Disk is missing, so no safety backup can be taken.");
  }
  await takeDatabaseBackup(
    deps,
    {
      target,
      scope: "instance",
      databaseName: null,
      provider: local,
      directory: `safety/${target.projectName}/${target.serviceName}`,
      origin: "safety",
      configId: null,
      name: "Before a major version change",
    },
    ctx,
  );
}
