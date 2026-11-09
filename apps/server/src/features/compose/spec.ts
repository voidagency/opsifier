import { z } from "zod";

const storedInlineSource = z.object({ type: z.literal("inline"), content: z.string() });

const storedGitSource = z.object({
  type: z.literal("git"),
  url: z.string(),
  ref: z.string(),
  path: z.string(),
  file: z.string(),
});

export const storedComposeSource = z.discriminatedUnion("type", [storedInlineSource, storedGitSource]);
export type StoredComposeSource = z.infer<typeof storedComposeSource>;
export type StoredComposeGitSource = z.infer<typeof storedGitSource>;

/**
 * The `compose` field of a service's spec, set only on Compose stacks. A stack is not a Swarm service
 * but shares the rest of the row with one: `env`, `notes`, `stopped`, the deploy token and the domains.
 */
export const storedCompose = z.object({
  /** Null until a source is saved. */
  source: storedComposeSource.nullable().default(null),
  /** SHA-256 of the file someone confirmed may reach the host, so an edited file needs asking again. */
  acknowledgedHash: z.string().nullable().default(null),
  /** Writes the environment into `.env` next to the Compose file before each deploy. */
  envFile: z.boolean().default(false),
  /** Children that finished cleanly during the last deploy, and are not expected to keep running. */
  completedChildren: z.array(z.string()).default([]),
});
export type StoredCompose = z.infer<typeof storedCompose>;
