import type { DatabaseEngine } from "@opsifier/contract";
import type { ComponentType } from "react";
import { BackupsTab } from "../services/tabs/backups/BackupsTab";
import { CredentialsTab } from "../services/tabs/credentials/CredentialsTab";
import { DatabaseAdvancedTab } from "../services/tabs/database-advanced/DatabaseAdvancedTab";
import { DatabaseOverviewTab } from "../services/tabs/database-overview/DatabaseOverviewTab";
import { DatabaseResourcesTab } from "../services/tabs/database-resources/DatabaseResourcesTab";
import { ExposeTab } from "../services/tabs/expose/ExposeTab";

const BASE = "/projects/$project/$engine/$service" as const;

/**
 * The tabs of a database page, in display order. `key` is its label in the `databases` namespace
 * and `path` its URL segment. `database-resources` and `database-advanced` carry that prefix on
 * disk because the App service has tabs of the same name doing different work.
 */
export const databaseTabs = [
  { key: "overview", path: "/", to: `${BASE}/`, component: DatabaseOverviewTab },
  { key: "credentials", path: "credentials", to: `${BASE}/credentials`, component: CredentialsTab },
  { key: "expose", path: "expose", to: `${BASE}/expose`, component: ExposeTab },
  { key: "backups", path: "backups", to: `${BASE}/backups`, component: BackupsTab },
  { key: "resources", path: "resources", to: `${BASE}/resources`, component: DatabaseResourcesTab },
  { key: "advanced", path: "advanced", to: `${BASE}/advanced`, component: DatabaseAdvancedTab },
] as const satisfies ReadonlyArray<{ key: string; path: string; to: string; component: ComponentType }>;

/** The tabs an engine shows. Redis has no backups, because it has no database to export. */
export const databaseTabsFor = (engine: DatabaseEngine) =>
  databaseTabs.filter((tab) => tab.key !== "backups" || engine !== "redis");
