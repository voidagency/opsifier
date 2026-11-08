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

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

export const actionStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type ActionStatus = z.infer<typeof actionStatus>;

export const action = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: actionStatus,
  projectName: z.string().nullable(),
  serviceName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});
export type Action = z.infer<typeof action>;
