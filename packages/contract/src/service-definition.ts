import { z } from "zod";
import { MAX_DOMAINS_PER_SERVICE, resourceName } from "./common";
import { envText } from "./env";
import { saveDomainRequest } from "./service-tabs/domains";
import { resourcesSpec } from "./service-tabs/resources";
import { saveSourceRequest } from "./service-tabs/source";
import { mountSpec } from "./service-tabs/storage";

/** POST /api/v1/projects/{project}/services/definition: a whole service in one request, for scripts. */
export const serviceDefinitionRequest = z.strictObject({
  name: resourceName,
  source: saveSourceRequest,
  env: envText.default(""),
  domains: z
    .array(saveDomainRequest)
    .max(MAX_DOMAINS_PER_SERVICE, `At most ${MAX_DOMAINS_PER_SERVICE} domains`)
    .default([]),
  mounts: z.array(mountSpec).max(100, "At most 100 mounts").default([]),
  resources: resourcesSpec.optional(),
  /** Starts a deployment once everything is saved. */
  deploy: z.boolean().default(false),
});
export type ServiceDefinitionRequest = z.input<typeof serviceDefinitionRequest>;
