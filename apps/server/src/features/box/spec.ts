import {
  boxBuildEntry,
  boxHooks,
  boxManifest,
  boxModulesConfig,
  boxPresetId,
  boxProcess,
} from "@opsifier/contract";
import { z } from "zod";

/** What a token is worth: only its hash is kept, so it can't be read back, only proved. */
const storedIdeToken = z.object({
  hash: z.string(),
  /** The account that issued it, so a change to that account can end it. */
  createdBy: z.string().nullable().default(null),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type StoredIdeToken = z.infer<typeof storedIdeToken>;

/**
 * The `box` field of a service's spec, set only on a box. The rest of the row is the same as an App's:
 * a generated Dockerfile source, the workspace as a named volume, one stop-first task.
 */
export const storedBox = z.object({
  modules: boxModulesConfig.prefault({}),
  processes: z.array(boxProcess).default([]),
  hooks: boxHooks.prefault({}),
  preset: boxPresetId.nullable().default(null),
  ide: z
    .object({
      enabled: z.boolean().default(false),
      token: storedIdeToken.nullable().default(null),
    })
    .prefault({}),
  /** What the last successful build contains. Null until one has finished. */
  built: boxManifest.nullable().default(null),
  /** Newest first. */
  history: z.array(boxBuildEntry).default([]),
});
export type StoredBox = z.infer<typeof storedBox>;
