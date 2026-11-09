import { z } from "zod";
import { envText } from "../env";
import { imageReference } from "./source";

const databaseAdvancedFields = {
  image: imageReference,
  command: z.string().trim().max(4096, "This is too long").default(""),
  configFile: z
    .string()
    .max(64 * 1024, "This is too long")
    .default(""),
};

/**
 * GET /api/v1/projects/{project}/services/{service}/database-advanced
 *
 * `command` runs as `/bin/sh -c`, and empty means the image's own start command. `configFile`
 * only exists for MySQL and MariaDB. The extra variables are named here and read through
 * POST .../environment/reveal, like any service's.
 */
export const databaseAdvancedSettings = z.object({
  ...databaseAdvancedFields,
  envNames: z.array(z.string()),
});
export type DatabaseAdvancedSettings = z.infer<typeof databaseAdvancedSettings>;

/**
 * PUT .../database-advanced. With no `env`, the variables stay as they are. Moving to another major
 * version takes `confirm`, the service's name typed by a person: the engine may have to migrate its
 * data to read it, and the deployment that applies it takes a backup of the whole server first.
 */
export const saveDatabaseAdvancedRequest = z.object({
  ...databaseAdvancedFields,
  env: envText.optional(),
  confirm: z.string().max(256).optional(),
});
export type SaveDatabaseAdvancedRequest = z.input<typeof saveDatabaseAdvancedRequest>;
export type SaveDatabaseAdvancedFields = z.output<typeof saveDatabaseAdvancedRequest>;
