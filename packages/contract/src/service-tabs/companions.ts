import { z } from "zod";
import type { DatabaseEngine } from "../databases";
import { servicePath } from "../services";

export const companionTool = z.enum(["pgweb", "dbgate", "phpmyadmin", "mongo-express", "redis-commander"]);
export type CompanionTool = z.infer<typeof companionTool>;

/** Which web admin tools each engine offers, in display order. */
export const companionsByEngine: Record<DatabaseEngine, readonly CompanionTool[]> = {
  postgres: ["pgweb", "dbgate"],
  mysql: ["phpmyadmin", "dbgate"],
  mariadb: ["phpmyadmin", "dbgate"],
  mongo: ["mongo-express", "dbgate"],
  redis: ["redis-commander", "dbgate"],
};

export const companionPath = servicePath.extend({ tool: companionTool });

export const companionState = z.object({
  tool: companionTool,
  enabled: z.boolean(),
  /** The tool's own address. Null until it has been enabled. */
  url: z.string().nullable(),
  /** The sign-in name for the panel's access gate. Null until it has been enabled. */
  username: z.string().nullable(),
});
export type CompanionState = z.infer<typeof companionState>;

/** GET /api/v1/projects/{project}/services/{service}/companions */
export const companionList = z.object({ companions: z.array(companionState) });
export type CompanionList = z.infer<typeof companionList>;

/** POST /api/v1/projects/{project}/services/{service}/companions/{tool}/reveal */
export const revealedCompanionToken = z.object({ token: z.string() });
export type RevealedCompanionToken = z.infer<typeof revealedCompanionToken>;
