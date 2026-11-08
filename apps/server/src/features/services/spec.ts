import {
  deploySettings,
  maintenanceSettings,
  mountSpec,
  portSpec,
  redirectsSpec,
  resourcesSpec,
  scriptSpec,
  storedBasicAuthEntry,
} from "@opsifier/contract";
import { z } from "zod";
import { type StoredDatabase, storedDatabase } from "../databases/spec";
import { type StoredImageSource, storedBuildState, storedSource } from "../service-tabs/source/stored";

export type { StoredDatabase };

/** The password is sealed with this context, whichever service it belongs to. */
export const REGISTRY_PASSWORD_CONTEXT = "registry-password";

export type { StoredImageSource };

/**
 * The `spec` column of an App service. Each tab owns one field, whose schema lives in that tab's
 * contract file, so a tab can grow without touching the others.
 */
export const appServiceSpec = z.object({
  source: storedSource.nullable().default(null),
  build: storedBuildState.prefault({}),
  env: z.string().default(""),
  notes: z.string().default(""),
  stopped: z.boolean().default(false),
  deploy: deploySettings.prefault({}),
  resources: resourcesSpec.prefault({}),
  mounts: z.array(mountSpec).default([]),
  ports: z.array(portSpec).default([]),
  scripts: z.array(scriptSpec).default([]),
  /** Set on database services, which reuse every other field here. */
  database: storedDatabase.nullable().default(null),
  redirects: redirectsSpec,
  basicAuth: z.array(storedBasicAuthEntry).default([]),
  maintenance: maintenanceSettings.prefault({}),
});
export type AppServiceSpec = z.infer<typeof appServiceSpec>;
