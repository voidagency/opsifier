import { z } from "zod";
import { projectName, resourceName } from "../common";
import { isWorkspacePath } from "./box-modules";

/** Whether anyone can get in right now: `off`, `no_token`, `expired` or `open`. */
export const boxIdeAccessStates = ["off", "no_token", "expired", "open"] as const;
export const boxIdeAccess = z.enum(boxIdeAccessStates);
export type BoxIdeAccess = z.infer<typeof boxIdeAccess>;

/** GET .../box/ide: holds no secret, only what is known about the token. */
export const boxIdeStatus = z.object({
  enabled: z.boolean(),
  access: boxIdeAccess,
  createdAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  /** Where the editor opens, on the panel's own address. */
  path: z.string(),
});
export type BoxIdeStatus = z.infer<typeof boxIdeStatus>;

/** PUT .../box/ide. Turning it off ends every token. */
export const saveBoxIdeRequest = z.object({ enabled: z.boolean() });

export const BOX_IDE_TOKEN_LIFETIME_HOURS = { min: 1, default: 24 * 7, max: 24 * 90 } as const;

/** POST .../box/ide/token */
export const issueBoxIdeTokenRequest = z.object({
  /** It stops working by itself after this long. A token that never expires can't be issued. */
  expiresInHours: z
    .number()
    .int("Use a whole number of hours")
    .min(BOX_IDE_TOKEN_LIFETIME_HOURS.min, "It has to last at least an hour")
    .max(BOX_IDE_TOKEN_LIFETIME_HOURS.max, "It can last at most 90 days")
    .default(BOX_IDE_TOKEN_LIFETIME_HOURS.default),
});
export type IssueBoxIdeTokenRequest = z.input<typeof issueBoxIdeTokenRequest>;

export const issuedBoxIdeToken = boxIdeStatus.extend({
  /** Shown here and nowhere else: the panel keeps only its hash. */
  token: z.string(),
});
export type IssuedBoxIdeToken = z.infer<typeof issuedBoxIdeToken>;

/** Every route of the editor itself sits under this, and takes only its own bearer token. */
export const BOX_IDE_API_PREFIX = "/api/v1/ide/";

export const boxIdePath = z.object({ project: projectName, service: resourceName });

const idePath = z
  .string()
  .max(1024, "This is too long")
  .refine(isWorkspacePath, "Use a path inside the workspace, with no . or .. in it");

/** Where the listing starts. Empty means the workspace itself. */
export const boxIdeDirectoryQuery = z.object({ path: z.union([z.literal(""), idePath]).default("") });

export const boxIdeFileQuery = z.object({ path: idePath });

/** A file's content can be edited up to this size, which leaves room for it inside a JSON request. */
export const MAX_BOX_IDE_FILE_BYTES = 768 * 1024;
const MAX_BOX_IDE_LISTING = 5000;

export const boxIdeEntryKinds = ["file", "directory", "symlink", "other"] as const;

export const boxIdeEntry = z.object({
  name: z.string(),
  kind: z.enum(boxIdeEntryKinds),
});
export type BoxIdeEntry = z.infer<typeof boxIdeEntry>;

/** GET /api/v1/ide/{project}/{service}/session */
export const boxIdeSession = z.object({
  project: z.string(),
  service: z.string(),
  expiresAt: z.iso.datetime(),
  maxFileBytes: z.number().int(),
});
export type BoxIdeSession = z.infer<typeof boxIdeSession>;

/** GET /api/v1/ide/{project}/{service}/tree */
export const boxIdeDirectory = z.object({
  path: z.string(),
  entries: z.array(boxIdeEntry).max(MAX_BOX_IDE_LISTING),
  /** Set when the folder holds more than can be listed at once. */
  truncated: z.boolean(),
});
export type BoxIdeDirectory = z.infer<typeof boxIdeDirectory>;

/** GET /api/v1/ide/{project}/{service}/file */
export const boxIdeFile = z.object({
  path: z.string(),
  /** Null when the file can't be shown as text. */
  content: z.string().nullable(),
  /** Why it can't be shown as text. Null when it can. */
  unreadable: z.enum(["binary", "too_large"]).nullable(),
  /** Hands the next save a way to notice that something else changed the file meanwhile. */
  version: z.string(),
});
export type BoxIdeFile = z.infer<typeof boxIdeFile>;

/** PUT /api/v1/ide/{project}/{service}/file */
export const writeBoxIdeFileRequest = z.object({
  path: idePath,
  content: z.string(),
  /** What the file was when it was read. Null means it must not exist yet. */
  version: z.string().max(128).nullable(),
});
export type WriteBoxIdeFileRequest = z.input<typeof writeBoxIdeFileRequest>;

/** POST /api/v1/ide/{project}/{service}/directory */
export const createBoxIdeDirectoryRequest = z.object({ path: idePath });

/** POST /api/v1/ide/{project}/{service}/move */
export const moveBoxIdeEntryRequest = z.object({ from: idePath, to: idePath });

/** DELETE /api/v1/ide/{project}/{service}/entry */
export const deleteBoxIdeEntryRequest = z.object({
  path: idePath,
  /** Without it, a folder that is not empty stays. */
  recursive: z.boolean().default(false),
});
