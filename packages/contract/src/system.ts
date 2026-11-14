import { z } from "zod";

/** GET /api/v1/system/info */
export const systemInfo = z.object({
  version: z.string(),
  /** The address to point DNS at. Null when the panel has not been able to determine one. */
  serverIp: z.union([z.ipv4(), z.ipv6()]).nullable(),
  /** True on the simulated Docker driver: nothing the panel shows or does here reaches a real server. */
  simulated: z.boolean(),
});
export type SystemInfo = z.infer<typeof systemInfo>;

/** A program in the panel's image, or a JavaScript package whose code the panel ships. */
export const thirdPartyComponent = z.object({
  name: z.string(),
  /** Null for a program whose version is whatever its own repository had when the image was built. */
  version: z.string().nullable(),
  /** An SPDX expression, as the component states it. */
  license: z.string(),
  url: z.string().nullable(),
  kind: z.enum(["program", "package"]),
});
export type ThirdPartyComponent = z.infer<typeof thirdPartyComponent>;

/** GET /api/v1/system/about: the panel's license, where its source is, and what it ships from others. */
export const systemAbout = z.object({
  version: z.string(),
  /** An SPDX identifier. */
  license: z.string(),
  copyright: z.string(),
  sourceUrl: z.string(),
  licenseUrl: z.string(),
  /** The file in the panel's image that holds every license text. Null outside the image. */
  noticesFile: z.string().nullable(),
  components: z.array(thirdPartyComponent),
});
export type SystemAbout = z.infer<typeof systemAbout>;

export const storageFailureReason = z.enum(["full", "read_only", "locked", "failed"]);
export type StorageFailureReason = z.infer<typeof storageFailureReason>;

/**
 * GET /api/v1/system/storage. Once a write of the panel's own state has failed, changes are refused
 * until a test write succeeds again.
 */
export const storageHealth = z.object({
  writable: z.boolean(),
  /** Why state cannot be written. Null while it can. */
  reason: storageFailureReason.nullable(),
  /** When the failure began. Null while state can be written. */
  since: z.iso.datetime().nullable(),
});
export type StorageHealth = z.infer<typeof storageHealth>;
