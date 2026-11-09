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
import { storedBox } from "../box/spec";
import { storedCompose } from "../compose/spec";
import { type StoredDatabase, storedDatabase } from "../databases/spec";
import { type StoredImageSource, storedBuildState, storedSource } from "../service-tabs/source/stored";
import { storedReferences, storedTemplateRef } from "../templates/spec";

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
  /** The container's variables, as sealed dotenv text. Empty when there are none. */
  sealedEnv: z.string().default(""),
  /** Values this service's configuration used to hold, sealed, so that output can go on hiding them. */
  sealedRetired: z.string().nullable().default(null),
  /** Set from the Environment tab. Without it, a value that looks like `$(PROJECT_NAME)` stays as typed. */
  envInterpolation: z.boolean().default(false),
  notes: z.string().default(""),
  notesHidden: z.boolean().default(false),
  stopped: z.boolean().default(false),
  deploy: deploySettings.prefault({}),
  resources: resourcesSpec.prefault({}),
  mounts: z.array(mountSpec).default([]),
  ports: z.array(portSpec).default([]),
  scripts: z.array(scriptSpec).default([]),
  /** Set on database services, which reuse every other field here. */
  database: storedDatabase.nullable().default(null),
  /** Set on Compose stacks, which reuse every other field here. */
  compose: storedCompose.nullable().default(null),
  /** Set on a box, which reuses every other field here. */
  box: storedBox.nullable().default(null),
  /** Sealed values and databases this service's environment refers to. Usually from a template. */
  references: storedReferences.prefault({}),
  /** Set when a template created this service. */
  template: storedTemplateRef.nullable().default(null),
  redirects: redirectsSpec,
  basicAuth: z.array(storedBasicAuthEntry).default([]),
  maintenance: maintenanceSettings.prefault({}),
});
export type AppServiceSpec = z.infer<typeof appServiceSpec>;
