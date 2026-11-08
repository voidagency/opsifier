import { z } from "zod";
import { action, actionStatus, resourceName } from "./common";

/** One row of the Activity page. */
export const actionEntry = action.extend({
  /** False when the action never produced output: the UI offers no log view. */
  hasLog: z.boolean(),
  /** Who started it. Null for API tokens and for the panel's own work. */
  actorEmail: z.string().nullable(),
});
export type ActionEntry = z.infer<typeof actionEntry>;

/** GET /api/v1/actions: newest first, filtered on any combination of fields. */
export const listActionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(15),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, "Invalid cursor")
    .optional(),
  projectName: resourceName.optional(),
  serviceName: resourceName.optional(),
  type: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Invalid type")
    .optional(),
  status: actionStatus.optional(),
});
export type ListActionsQuery = z.infer<typeof listActionsQuery>;

export const actionPage = z.object({
  items: z.array(actionEntry),
  /** Pass as `cursor` to load the next page. Null when there is nothing more. */
  nextCursor: z.string().nullable(),
});
export type ActionPage = z.infer<typeof actionPage>;

/** GET /api/v1/actions/{id} */
export const actionDetail = actionEntry.extend({
  log: z.string(),
  /** True when the action wrote more than the panel keeps or returns. */
  logTruncated: z.boolean(),
  /** While running: stream events numbered up to this are already part of `log`. */
  logSeq: z.number().int().min(0),
});
export type ActionDetail = z.infer<typeof actionDetail>;

/** The global topic for "the list changed". Its payload is an {@link actionEntry}. */
export const actionsTopic = "actions";

/** The topic streaming one action. Its payloads are {@link actionStreamEvent}. */
export const actionTopic = (id: string) => `action:${id}`;

export const actionStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("log"),
    /** 1-based line number, to line the stream up with `logSeq` from the fetched log. */
    seq: z.number().int().min(1),
    line: z.string(),
  }),
  z.object({ kind: z.literal("status"), action: actionEntry }),
]);
export type ActionStreamEvent = z.infer<typeof actionStreamEvent>;
