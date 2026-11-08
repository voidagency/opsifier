import { databaseEngine } from "@opsifier/contract";
import { z } from "zod";

/** Sealing contexts: a value sealed for one purpose cannot be opened for another. */
export const DATABASE_PASSWORD_CONTEXT = "database-password";
export const DATABASE_ROOT_PASSWORD_CONTEXT = "database-root-password";
export const COMPANION_TOKEN_CONTEXT = "database-companion-token";

const storedCompanion = z.object({
  sealedToken: z.string(),
  username: z.string(),
  host: z.string(),
});
export type StoredCompanion = z.infer<typeof storedCompanion>;

const sealedCredentials = z.object({
  sealedPassword: z.string(),
  sealedRootPassword: z.string().nullable(),
});

/**
 * A change that has started but not been recorded as finished. If the panel dies in that window,
 * this says which two sets of credentials to try, so the panel and the database end up agreeing.
 */
const storedRotation = z.object({
  from: sealedCredentials,
  to: sealedCredentials,
});
export type StoredRotation = z.infer<typeof storedRotation>;

/**
 * The `database` field of a service's spec, set only on database services. Everything shared with
 * App services (`source`, `env`, `resources`, `stopped`...) lives where it always does.
 */
export const storedDatabase = z.object({
  engine: databaseEngine,
  databaseName: z.string().nullable(),
  user: z.string(),
  sealedPassword: z.string(),
  sealedRootPassword: z.string().nullable(),
  /** Fixed at creation, so renaming the service never disconnects it from its data. */
  volume: z.string(),
  /** A host port, or 0 when the database is only reachable from inside. */
  exposedPort: z.number().int().min(0).max(65535).default(0),
  configFile: z.string().default(""),
  companions: z.record(z.string(), storedCompanion).default({}),
  rotation: storedRotation.nullable().default(null),
});
export type StoredDatabase = z.infer<typeof storedDatabase>;
