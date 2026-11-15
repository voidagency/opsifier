import { type StudioSettings, studioAgent } from "@opsifier/contract";
import { z } from "zod";
import type { AppDeps } from "../../core/context";
import { getSetting, putSetting } from "../system/repo";

const SETTINGS_KEY = "studio";

/** Off until an administrator turns it on. Nothing here is secret: the agent server's key stays in its container. */
const stored = z.object({
  enabled: z.boolean().default(false),
  agent: studioAgent.nullable().default(null),
});

export function readStudioSettings(deps: Pick<AppDeps, "db">): StudioSettings {
  const parsed = stored.safeParse(getSetting(deps.db, SETTINGS_KEY) ?? {});
  return parsed.success ? parsed.data : { enabled: false, agent: null };
}

export function writeStudioSettings(
  deps: Pick<AppDeps, "db" | "now">,
  settings: StudioSettings,
): StudioSettings {
  putSetting(deps.db, SETTINGS_KEY, settings, new Date(deps.now()));
  return settings;
}
