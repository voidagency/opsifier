import { z } from "zod";

/** The words a person types to confirm these. Checked again on the server. */
export const panelUpdateConfirm = "update";
export const panelRollbackConfirm = "rollback";

/** One release, as the release feed announces it. */
export const panelRelease = z.object({
  version: z.string(),
  image: z.string(),
  /** What changed, in Markdown. */
  notes: z.string(),
  /** Data changes the update will make when it starts. Empty when there are none. */
  migrations: z.array(z.string()),
  publishedAt: z.string().nullable(),
});
export type PanelRelease = z.infer<typeof panelRelease>;

export const panelUpdateOutcome = z.object({
  kind: z.enum(["update", "rollback"]),
  /** `rolled-back` means a new version failed to start and the panel went back by itself. */
  result: z.enum(["succeeded", "failed", "rolled-back"]),
  fromVersion: z.string(),
  toVersion: z.string(),
  /** The delivered image, when it was pulled. */
  digest: z.string().nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  finishedAt: z.string().nullable(),
  message: z.string().nullable(),
});
export type PanelUpdateOutcome = z.infer<typeof panelUpdateOutcome>;

export const panelUpdateStatus = z.object({
  /** The version of the process answering this request. */
  activeVersion: z.string(),
  /** False where the panel doesn't run as the `opsifier` Swarm service, so it can't replace itself. */
  managed: z.boolean(),
  /** The image the Swarm service is set to run, which may be ahead of what is active mid-update. */
  deployedImage: z.string().nullable(),
  latest: panelRelease.nullable(),
  /** True only when `latest` is newer than what is active. */
  updateAvailable: z.boolean(),
  checkedAt: z.string().nullable(),
  /** Why the last check could not be made. Null when it worked, or when none has been made. */
  checkError: z.string().nullable(),
  /** False when the release feed is turned off on this server. */
  checksEnabled: z.boolean(),
  /** An update under way, including while the panel restarts into it. */
  inProgress: z
    .object({
      kind: z.enum(["update", "rollback"]),
      toVersion: z.string(),
      state: z.enum(["applying", "verifying"]),
      actionId: z.string().nullable(),
    })
    .nullable(),
  last: panelUpdateOutcome.nullable(),
  /** The version the panel can go back to, when there is one. */
  rollback: z
    .object({
      version: z.string(),
      /** True when going back also returns the panel's data to `savedAt`, losing what came after. */
      restoresData: z.boolean(),
      savedAt: z.string(),
    })
    .nullable(),
});
export type PanelUpdateStatus = z.infer<typeof panelUpdateStatus>;

/** POST /api/v1/system/update */
export const applyPanelUpdateRequest = z.strictObject({
  version: z.string().min(1, "Required"),
  confirm: z.string().min(1, "Required"),
});
export type ApplyPanelUpdateRequest = z.infer<typeof applyPanelUpdateRequest>;

/** POST /api/v1/system/update/rollback */
export const rollbackPanelRequest = z.strictObject({ confirm: z.string().min(1, "Required") });
export type RollbackPanelRequest = z.infer<typeof rollbackPanelRequest>;
