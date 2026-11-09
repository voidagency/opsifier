import { z } from "zod";
import { action, actionStatus, resourceName, wholeNumber } from "./common";

/** How an Action came to be started. A deployment trigger and a push webhook are told apart. */
export const actionOrigin = z.enum(["session", "api_key", "trigger", "webhook", "system"]);
export type ActionOrigin = z.infer<typeof actionOrigin>;

/** One row of the Activity page. */
export const actionEntry = action.extend({
  /** False when the action never produced output: the UI offers no log view. */
  hasLog: z.boolean(),
  /** The account behind it: the one signed in, the owner of an API key, the one that issued a trigger. */
  actorEmail: z.string().nullable(),
  /** Recorded with the Action, so it stays true after a restart. */
  origin: actionOrigin.default("system"),
  /** What the origin leaves out: an API key's name, the commit a push announced. */
  originDetail: z.string().nullable().default(null),
});
export type ActionEntry = z.infer<typeof actionEntry>;

/** GET /api/v1/actions: newest first, filtered on any combination of fields. */
export const listActionsQuery = z.object({
  limit: wholeNumber(1, 100).default(15),
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
