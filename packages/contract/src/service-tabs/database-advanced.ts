import { z } from "zod";
import { envText } from "../env";
import { imageReference } from "./source";

/**
 * GET and PUT /api/v1/projects/{project}/services/{service}/database-advanced
 *
 * `command` runs as `/bin/sh -c`, and empty means the image's own start command. `configFile`
 * only exists for MySQL and MariaDB.
 */
export const databaseAdvancedSettings = z.object({
  image: imageReference,
  command: z.string().trim().max(4096, "This is too long").default(""),
  env: envText.default(""),
  configFile: z
    .string()
    .max(64 * 1024, "This is too long")
    .default(""),
});
export type DatabaseAdvancedSettings = z.infer<typeof databaseAdvancedSettings>;
