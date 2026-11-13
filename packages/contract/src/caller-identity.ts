import { z } from "zod";
import { allProjectsRole, apiKeyLevel } from "./access";
import { userRole } from "./auth";

/** What the caller holds in one project. An administrator holds `admin` in whichever projects it reaches. */
export const callerProjectRole = z.enum(["viewer", "operator", "admin"]);
export type CallerProjectRole = z.infer<typeof callerProjectRole>;

export const callerOperation = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** As written in the OpenAPI document, placeholders included. */
  path: z.string(),
  /** The projects it is allowed in. Null when it names none, or when every project is in reach. */
  projects: z.array(z.string()).nullable(),
});
export type CallerOperation = z.infer<typeof callerOperation>;

/**
 * GET /api/v1/auth/identity: who this credential speaks for and what it may do, as the server would
 * judge it right now. Clients use it to show only what will work. It grants nothing: every request is
 * still checked when it is made.
 */
export const callerIdentity = z.object({
  user: z.object({ id: z.string(), email: z.string(), role: userRole }),
  credential: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session") }),
    z.object({
      kind: z.literal("api_key"),
      name: z.string(),
      level: apiKeyLevel,
      /** The only projects the key reaches. Null means every project its owner reaches. */
      projects: z.array(z.string()).nullable(),
      expiresAt: z.iso.datetime().nullable(),
    }),
  ]),
  /** Each project in reach and the role held in it. Null means every project, as an administrator. */
  projects: z.array(z.object({ name: z.string(), role: callerProjectRole })).nullable(),
  /**
   * A member's role in every project, which also reaches the projects created later. `projects` already
   * counts it. Null without one, for an administrator, and for a key narrowed to a list of projects.
   */
  allProjects: allProjectsRole,
  /** Every API operation this caller would be allowed to call. */
  operations: z.array(callerOperation),
});
export type CallerIdentity = z.infer<typeof callerIdentity>;
