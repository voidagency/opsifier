import { scriptSpec } from "@opsifier/contract";
import { z } from "zod";

/**
 * A script as the service's spec keeps it: what the API takes, and who last saved it. That is never
 * sent anywhere: a schedule or a deployment starts the script with nobody's request behind it, and in
 * a service that reaches the server it only runs while that account could still have saved it.
 */
export const storedScript = scriptSpec.extend({
  /** The administrator who last saved it. Null once anyone else does, and for scripts saved before. */
  savedBy: z.string().nullable().default(null),
});
export type StoredScript = z.infer<typeof storedScript>;
