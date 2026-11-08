import { z } from "zod";
import { servicePath } from "../services";
import { goRegexError } from "./redirect-regex";

const MAX_LENGTH = 2048;
const CONTROL_OR_SPACE = /[\s\p{Cc}\p{Cs}]/u;
const MAX_RULES = 100;

const redirectPattern = z
  .string()
  .min(1, "Required")
  .max(MAX_LENGTH, "This is too long")
  .refine((value) => !CONTROL_OR_SPACE.test(value), "No spaces or control characters")
  .refine((value) => goRegexError(value) === null, "This regular expression can't be compiled");

const redirectTarget = z
  .string()
  .min(1, "Required")
  .max(MAX_LENGTH, "This is too long")
  .refine((value) => !CONTROL_OR_SPACE.test(value), "No spaces or control characters");

/** The part of a rule a client can set. */
export const saveRedirectRequest = z.object({
  enabled: z.boolean().default(true),
  regex: redirectPattern,
  replacement: redirectTarget,
  permanent: z.boolean().default(false),
});
export type SaveRedirectRequest = z.input<typeof saveRedirectRequest>;

/** One rule of a service, as stored in its `spec` and as sent back. */
export const redirectRule = z.object({
  id: z.string(),
  enabled: z.boolean(),
  regex: z.string(),
  replacement: z.string(),
  permanent: z.boolean(),
});
export type RedirectRule = z.infer<typeof redirectRule>;

/** A service's whole list of rules, in the order they are attached. */
export const redirectsSpec = z
  .array(redirectRule)
  .max(MAX_RULES, `At most ${MAX_RULES} redirects per service`)
  .default([]);

/** GET .../redirects */
export const redirectList = z.object({ redirects: z.array(redirectRule) });
export type RedirectList = z.infer<typeof redirectList>;

export const redirectPath = servicePath.extend({ redirect: z.string().min(1).max(64) });

/** DELETE on one rule. */
export const deletedRedirect = z.object({ id: z.string() });
export type DeletedRedirect = z.infer<typeof deletedRedirect>;

export { MAX_RULES as MAX_REDIRECT_RULES };
