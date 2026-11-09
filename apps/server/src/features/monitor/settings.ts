import type { MonitoringSettings } from "@opsifier/contract";
import { monitoringSettings } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { getSetting, putSetting } from "../system/repo";

const KEY = "monitoring_settings";

/** Metrics are on by default: the panel keeps them itself, so there is nothing extra to run. */
export const defaultMonitoringSettings: MonitoringSettings = {
  metrics: { enabled: true, retention: 7, retentionUnit: "days", scrapeSeconds: 15 },
  logs: { enabled: false, retention: 7, retentionUnit: "days", maxSizeMb: 1024 },
};

export function readMonitoringSettings(deps: Pick<AppDeps, "db">): MonitoringSettings {
  const stored = monitoringSettings.safeParse(getSetting(deps.db, KEY));
  return stored.success ? stored.data : defaultMonitoringSettings;
}

export function saveMonitoringSettings(
  deps: Pick<AppDeps, "db" | "now">,
  settings: MonitoringSettings,
): void {
  putSetting(deps.db, KEY, settings, new Date(deps.now()));
}
