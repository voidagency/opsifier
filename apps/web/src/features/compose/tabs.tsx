import type { ComponentType } from "react";
import { DeploymentsTab } from "../services/tabs/deployments/DeploymentsTab";
import { MaintenanceTab } from "../services/tabs/maintenance/MaintenanceTab";
import { RedirectsTab } from "../services/tabs/redirects/RedirectsTab";
import { SecurityTab } from "../services/tabs/security/SecurityTab";
import { ComposeDomainsTab } from "./ComposeDomainsTab";
import { ComposeEnvironmentTab } from "./ComposeEnvironmentTab";
import { ComposeOverviewTab } from "./ComposeOverviewTab";
import { ComposeSourceTab } from "./ComposeSourceTab";

const BASE = "/projects/$project/compose/$service" as const;

/**
 * The tabs of a Compose stack, in display order. `key` is the tab's label in the `compose` namespace
 * and its URL segment. A stack shares its Deployments, Environment, Redirects, Security and
 * Maintenance tabs with every other service, because those tabs only need the service to exist.
 */
export const composeTabs = [
  { key: "overview", path: "/", to: `${BASE}/`, component: ComposeOverviewTab },
  { key: "source", path: "source", to: `${BASE}/source`, component: ComposeSourceTab },
  { key: "deployments", path: "deployments", to: `${BASE}/deployments`, component: DeploymentsTab },
  { key: "environment", path: "environment", to: `${BASE}/environment`, component: ComposeEnvironmentTab },
  { key: "domains", path: "domains", to: `${BASE}/domains`, component: ComposeDomainsTab },
  { key: "redirects", path: "redirects", to: `${BASE}/redirects`, component: RedirectsTab },
  { key: "security", path: "security", to: `${BASE}/security`, component: SecurityTab },
  { key: "maintenance", path: "maintenance", to: `${BASE}/maintenance`, component: MaintenanceTab },
] as const satisfies ReadonlyArray<{ key: string; path: string; to: string; component: ComponentType }>;
