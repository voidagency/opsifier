import { z } from "zod";

const MAX_HOOK_CHARS = 64 * 1024;

const hookText = z
  .string()
  .max(MAX_HOOK_CHARS, "This is too long")
  .refine((value) => !value.includes("\0"), "Must not contain a NUL byte");

/**
 * Run by `/bin/sh`. `build` runs as root while the image is built, without the workspace, so it can add
 * system packages. `start` runs as the box's user at every start, in the workspace, before any process:
 * if it fails the task fails and a deployment does not go on to replace what was running.
 */
export const boxHooks = z.object({
  build: hookText.default(""),
  start: hookText.default(""),
});
export type BoxHooks = z.infer<typeof boxHooks>;

export const saveBoxHooksRequest = boxHooks;
export type SaveBoxHooksRequest = z.input<typeof saveBoxHooksRequest>;
