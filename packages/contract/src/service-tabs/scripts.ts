import { z } from "zod";
import { servicePath } from "../services";

export const MAX_SCRIPTS = 64;

/** Fits in one exec argument, which the kernel caps at 128 KiB. */
const MAX_SCRIPT_CHARS = 64 * 1024;

const SCRIPT_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u;

/** A named shell snippet, run from the console in a task of the service. */
export const scriptSpec = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Required")
    .max(64, "Must be at most 64 characters")
    .regex(SCRIPT_NAME, "Use letters, digits, spaces, dots, dashes and underscores"),
  script: z.string().max(MAX_SCRIPT_CHARS, "This is too long").default(""),
});
export type ScriptSpec = z.infer<typeof scriptSpec>;

/** One script of a service, by its position in the list. */
export const scriptItemPath = servicePath.extend({ index: z.coerce.number().int().min(0).max(999) });

/** GET /api/v1/projects/{project}/services/{service}/scripts, and the answer to every change. */
export const scriptList = z.object({ scripts: z.array(scriptSpec) });
export type ScriptList = z.infer<typeof scriptList>;
