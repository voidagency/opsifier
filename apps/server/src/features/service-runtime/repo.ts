import { type ScriptSpec, scriptSpec } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "../../core/db";
import { services } from "../../core/db/schema";

export interface ServiceRef {
  projectName: string;
  serviceName: string;
}

/** Any type of service. Logs, consoles and metrics only need it to exist, not to be of a given kind. */
export function serviceExists(db: DbHandle, target: ServiceRef): boolean {
  return (
    db
      .select({ name: services.name })
      .from(services)
      .where(and(eq(services.projectName, target.projectName), eq(services.name, target.serviceName)))
      .get() !== undefined
  );
}

const withScripts = z.object({ scripts: z.array(scriptSpec).catch([]) }).catch({ scripts: [] });

/** The scripts saved on a service. Only App services have any, the other types answer an empty list. */
export function listServiceScripts(db: DbHandle, target: ServiceRef): ScriptSpec[] {
  const row = db
    .select({ spec: services.spec })
    .from(services)
    .where(and(eq(services.projectName, target.projectName), eq(services.name, target.serviceName)))
    .get();
  return row === undefined ? [] : withScripts.parse(row.spec).scripts;
}
