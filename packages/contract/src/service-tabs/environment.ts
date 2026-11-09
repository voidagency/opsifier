import { z } from "zod";
import { envDocument, envSummary, envText } from "../env";
import { servicePath } from "../services";

/**
 * GET and PUT /api/v1/projects/{project}/services/{service}/environment answer with the names only.
 * The values come from POST .../environment/reveal, which goes in the activity log.
 */
export const serviceEnvironment = envSummary.extend({
  /** Only when this is on are `$(PROJECT_NAME)`, `$(SERVICE_NAME)` and `$(PRIMARY_DOMAIN)` filled in. */
  interpolation: z.boolean(),
});
export type ServiceEnvironment = z.infer<typeof serviceEnvironment>;

/** The answer of POST .../environment/reveal. */
export const serviceEnvironmentText = envDocument;

/** The body of PUT .../environment. Whichever of the two is left out stays as it is. */
export const saveServiceEnvironment = z.object({
  env: envText.optional(),
  interpolation: z.boolean().optional(),
});
export type SaveServiceEnvironment = z.input<typeof saveServiceEnvironment>;

/** What `$(PROJECT_NAME)` and its two siblings stand for, when a service has turned them on. */
const ENV_PLACEHOLDER = /\$\((?:PROJECT_NAME|SERVICE_NAME|PRIMARY_DOMAIN)\)/;

/** Whether a value would change if placeholders were being filled in. */
export const usesEnvPlaceholders = (text: string): boolean => ENV_PLACEHOLDER.test(text);

const SEALED_REFERENCE = /\$\((?:secret|db)\.[A-Za-z0-9._-]+\)/;

/** A build argument can be read back from the image, so it can't be made to hold a sealed value. */
export const buildVariablesText = envText.superRefine((text, context) => {
  const line = text.split(/\r?\n/).findIndex((candidate) => SEALED_REFERENCE.test(candidate));
  if (line !== -1) {
    context.addIssue({
      code: "custom",
      message: `Line ${line + 1} refers to a sealed value, which would end up in the image. Use a build secret`,
    });
  }
});

/** PUT .../environment/build, and the answer of POST .../environment/build/reveal. */
export const buildVariablesDocument = z.object({ env: buildVariablesText });
export type BuildVariablesDocument = z.infer<typeof buildVariablesDocument>;

export const MAX_BUILD_SECRETS = 64;
const MAX_BUILD_SECRET_CHARS = 64 * 1024;

/** A build step reads it back under this name, as a file or a variable of its shell. */
export const buildSecretName = z
  .string()
  .min(1, "Required")
  .max(128, "This is too long")
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, digits and underscores");

export const buildSecretPath = servicePath.extend({ name: buildSecretName });

/** PUT .../environment/build/secrets/{name}. A build secret can be replaced, and never read back. */
export const saveBuildSecretRequest = z.object({
  value: z.string().min(1, "Required").max(MAX_BUILD_SECRET_CHARS, "This is too long"),
});

/** GET .../environment/build: what the next build is given, by name. */
export const buildEnvironment = z.object({
  variables: z.array(z.string()),
  secrets: z.array(z.object({ name: z.string(), updatedAt: z.iso.datetime() })),
  /**
   * True on a service that was building before these scopes existed, and whose builds still get its
   * runtime variables until someone chooses what they need.
   */
  inheritsRuntime: z.boolean(),
});
export type BuildEnvironment = z.infer<typeof buildEnvironment>;
