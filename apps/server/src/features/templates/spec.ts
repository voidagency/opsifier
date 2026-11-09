import { localizedText } from "@opsifier/contract";
import { z } from "zod";

/** Sealing context of everything a template generates or asks for: it cannot be opened for anything else. */
export const TEMPLATE_SECRET_CONTEXT = "template-secret";

const storedSecret = z.object({
  sealed: z.string(),
  /** Set when the install page offers to show it, such as a first password. */
  label: localizedText.nullable().default(null),
});

/**
 * What a service's environment may refer to, resolved at deploy time. Secrets are sealed here and
 * databases are named: the plain-text environment only ever holds `$(secret.x)` and `$(db.x.password)`.
 */
export const storedReferences = z.object({
  secrets: z.record(z.string(), storedSecret).default({}),
  databases: z.record(z.string(), z.object({ service: z.string() })).default({}),
});
export type StoredReferences = z.infer<typeof storedReferences>;

/** Which template installed a service, for the components of one install to be found together. */
export const storedTemplateRef = z.object({
  installId: z.string(),
  role: z.string(),
  kind: z.enum(["app", "database", "compose"]),
});
export type StoredTemplateRef = z.infer<typeof storedTemplateRef>;
