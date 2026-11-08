import { z } from "zod";
import { databaseEngine, databasePassword } from "../databases";

/** Secrets never leave the server here: `maskedUrl` has the password blanked out. */
const connectionEndpoint = z.object({
  host: z.string(),
  port: z.number().int(),
  maskedUrl: z.string(),
});

/** GET /api/v1/projects/{project}/services/{service}/credentials */
export const databaseCredentials = z.object({
  engine: databaseEngine,
  user: z.string(),
  hasRootPassword: z.boolean(),
  databaseName: z.string().nullable(),
  internal: connectionEndpoint,
  /** Null while the database is not exposed on a public port. */
  external: connectionEndpoint.nullable(),
  /** True when a password change could not be confirmed either way after an interruption. */
  rotationUnresolved: z.boolean(),
});
export type DatabaseCredentials = z.infer<typeof databaseCredentials>;

export const databaseSecretName = z.enum(["password", "rootPassword", "internalUrl", "externalUrl"]);
export type DatabaseSecretName = z.infer<typeof databaseSecretName>;

/**
 * POST /api/v1/projects/{project}/services/{service}/credentials/reveal
 *
 * One secret per call, each recorded in the activity log with who asked for it.
 */
export const revealSecretRequest = z.object({ secret: databaseSecretName });
export type RevealSecretRequest = z.infer<typeof revealSecretRequest>;

export const revealedSecret = z.object({ value: z.string() });
export type RevealedSecret = z.infer<typeof revealedSecret>;

/**
 * PUT /api/v1/projects/{project}/services/{service}/credentials
 *
 * MySQL and MariaDB also accept `rootPassword`. Every other engine has one account, so a value for
 * it is rejected rather than ignored.
 */
export const changePasswordRequest = z
  .object({
    password: databasePassword.optional(),
    rootPassword: databasePassword.optional(),
  })
  .refine((request) => request.password !== undefined || request.rootPassword !== undefined, {
    path: ["password"],
    message: "Required",
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;
