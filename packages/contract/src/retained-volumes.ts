import { z } from "zod";

/** What a volume belonged to when its service was destroyed. */
export const retainedVolumeKinds = ["app", "database", "compose"] as const;
export const retainedVolumeKind = z.enum(retainedVolumeKinds);
export type RetainedVolumeKind = z.infer<typeof retainedVolumeKind>;

export const retainedVolume = z.object({
  name: z.string(),
  projectName: z.string(),
  serviceName: z.string(),
  kind: retainedVolumeKind,
  retainedAt: z.iso.datetime(),
});
export type RetainedVolume = z.infer<typeof retainedVolume>;

/** GET /api/v1/retained-volumes: what is left of destroyed services, and can be deleted on purpose. */
export const retainedVolumeList = z.object({ volumes: z.array(retainedVolume) });
export type RetainedVolumeList = z.infer<typeof retainedVolumeList>;

/** Docker's own rule for a volume name, so this segment of a path can never mean anything else. */
export const retainedVolumePath = z.object({
  name: z
    .string()
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Must be a volume name"),
});
