import type { ComponentType } from "react";
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
  { key: "resources", path: "resources", to: `${BASE}/resources`, component: DatabaseResourcesTab },
  { key: "advanced", path: "advanced", to: `${BASE}/advanced`, component: DatabaseAdvancedTab },
] as const satisfies ReadonlyArray<{ key: string; path: string; to: string; component: ComponentType }>;
