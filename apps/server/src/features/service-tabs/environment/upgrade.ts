import { usesEnvPlaceholders } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../../../core/context";
import { projects, services } from "../../../core/db/schema";
import { openEnv } from "../../services/env-store";
import { getSetting, putSetting } from "../../system/repo";

const SETTING_KEY = "env-interpolation-upgraded";

type UpgradeDeps = Pick<AppDeps, "db" | "now" | "secrets">;

/** At boot a value that can't be opened must not keep the panel down: it just has no placeholders to keep. */
function usesPlaceholders(deps: UpgradeDeps, sealed: string): boolean {
  try {
    return usesEnvPlaceholders(openEnv(deps, sealed));
  } catch {
    return false;
  }
}

/**
 * Filling in `$(PROJECT_NAME)` and the like used to need no switch, so a service saved back then that
 * relies on it is given the switch, once, and stays as it was at its next deploy. Everything created
 * since has made its own choice, and that choice is left alone.
 */
export function keepExistingInterpolation(deps: UpgradeDeps): void {
  if (getSetting(deps.db, SETTING_KEY) === true) {
    return;
  }
  const inProject = new Map(
    deps.db
      .select()
      .from(projects)
      .all()
      .map((row) => [row.name, usesPlaceholders(deps, row.sealedEnv)]),
  );
  const now = new Date(deps.now());
  for (const row of deps.db.select().from(services).all()) {
    const spec = row.spec as Record<string, unknown>;
    if (spec.envInterpolation !== undefined) {
      continue;
    }
    const sealed = typeof spec.sealedEnv === "string" ? spec.sealedEnv : "";
    if (inProject.get(row.projectName) === true || usesPlaceholders(deps, sealed)) {
      deps.db
        .update(services)
        .set({ spec: { ...spec, envInterpolation: true }, updatedAt: now })
        .where(and(eq(services.projectName, row.projectName), eq(services.name, row.name)))
        .run();
    }
  }
  putSetting(deps.db, SETTING_KEY, true, now);
}
