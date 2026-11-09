import { z } from "zod";

/** Service and volume names follow this rule. Project names are stricter, see {@link projectName}. */
export const resourceName = z
  .string()
  .min(1, "Required")
  .max(63, "Must be at most 63 characters")
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, dashes and underscores")
  .regex(/(?:^|[a-z0-9])$/, "Must end with a letter or digit")
  .regex(/^(?!.*__)/, "Must not contain two underscores in a row");

/**
 * Projects allow no underscore, so `<project>_<service>` can only be split one way.
 * The length leaves room for a service name inside the 63 characters Docker allows.
 */
export const projectName = z
  .string()
  .min(1, "Required")
  .max(40, "Must be at most 40 characters")
  .regex(/^[a-z0-9-]*$/, "Use lowercase letters, digits and dashes")
  .regex(/^(?:[a-z0-9](?:.*[a-z0-9])?)?$/, "Must start and end with a letter or digit");

/** What one server holds at most. Refused here, before any of it can reach Docker. */
export const MAX_PROJECTS = 256;
/** A project's services share one overlay network, whose default subnet has 254 addresses. */
export const MAX_SERVICES_PER_PROJECT = 100;
export const MAX_DOMAINS_PER_SERVICE = 20;

const WHOLE_NUMBER = /^(?:0|[1-9]\d{0,14})$/;

/**
 * Text that is plainly a whole number becomes one, and anything else is left for the number check
 * to refuse. `Number()` would also read `0x10`, `1e3`, a blank and a padded ` 5` as numbers.
 */
export const digitsToNumber = (value: unknown): unknown =>
  typeof value === "string" && WHOLE_NUMBER.test(value) ? Number(value) : value;

/** A number in a query string or a path. */
export const wholeNumber = (min: number, max: number) =>
  z.preprocess(
    digitsToNumber,
    z.number("Must be a whole number").int("Must be a whole number").min(min).max(max),
  );

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

/**
 * `uncertain` is the panel saying it does not know how something ended: the work was under way, or
 * finished, but its outcome could not be recorded durably, so "failed" would be a guess.
 */
export const actionStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "uncertain"]);
export type ActionStatus = z.infer<typeof actionStatus>;

export const action = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: actionStatus,
  /** The step under way, or the last one reached. Null for work too short to have steps. */
  phase: z.string().nullable().default(null),
  projectName: z.string().nullable(),
  serviceName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type Action = z.infer<typeof action>;
