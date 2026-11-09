import { z } from "zod";

/** Ports under 1024 belong to system services: a database has no business there. */
export const FIRST_EXPOSED_PORT = 1024;

/**
 * Zero means not exposed. Everything else is a host port, checked for conflicts by the server.
 *
 * PUT /api/v1/projects/{project}/services/{service}/expose
 */
export const exposedPort = z
  .number({ error: "Enter a port number" })
  .int("Use a whole number")
  .min(0, "Use 0 or a port from 1024 to 65535")
  .max(65535, "Use 0 or a port from 1024 to 65535")
  .refine(
    (port) => port === 0 || port >= FIRST_EXPOSED_PORT,
    `Use 0 or a port from ${FIRST_EXPOSED_PORT} to 65535`,
  );

export const exposeSettings = z.object({ port: exposedPort });
export type ExposeSettings = z.infer<typeof exposeSettings>;

/** GET .../expose: what is saved, and what a deployment has actually published. */
export const exposeState = exposeSettings.extend({
  /** Null while Docker can't be asked. Differs from `port` until the next deployment. */
  publishedPort: z.number().int().min(0).max(65535).nullable(),
});
export type ExposeState = z.infer<typeof exposeState>;
