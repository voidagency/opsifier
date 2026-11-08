import type { ComponentType } from "react";
import { AdvancedTab } from "./tabs/advanced/AdvancedTab";
import { DeploymentsTab } from "./tabs/deployments/DeploymentsTab";
import { DomainsTab } from "./tabs/domains/DomainsTab";
import { EnvironmentTab } from "./tabs/environment/EnvironmentTab";
import { MaintenanceTab } from "./tabs/maintenance/MaintenanceTab";
import { OverviewTab } from "./tabs/overview/OverviewTab";
import { RedirectsTab } from "./tabs/redirects/RedirectsTab";
import { ResourcesTab } from "./tabs/resources/ResourcesTab";
import { ScriptsTab } from "./tabs/scripts/ScriptsTab";
import { SecurityTab } from "./tabs/security/SecurityTab";
import { SourceTab } from "./tabs/source/SourceTab";
import { StorageTab } from "./tabs/storage/StorageTab";

export const SERVICE_BASE = "/projects/$project/app/$service" as const;

/**
 * The tabs of a service page, in display order. `key` is the tab's URL segment, its label key in the
 * `services` namespace and the name of its folder under `tabs/`. A tab owns everything in that folder,
 * so filling one in never touches another.
 */
export const serviceTabs = [
  { key: "overview", to: `${SERVICE_BASE}/`, component: OverviewTab },
  { key: "source", to: `${SERVICE_BASE}/source`, component: SourceTab },
  { key: "deployments", to: `${SERVICE_BASE}/deployments`, component: DeploymentsTab },
  { key: "environment", to: `${SERVICE_BASE}/environment`, component: EnvironmentTab },
  { key: "domains", to: `${SERVICE_BASE}/domains`, component: DomainsTab },
  { key: "redirects", to: `${SERVICE_BASE}/redirects`, component: RedirectsTab },
  { key: "scripts", to: `${SERVICE_BASE}/scripts`, component: ScriptsTab },
  { key: "security", to: `${SERVICE_BASE}/security`, component: SecurityTab },
  { key: "resources", to: `${SERVICE_BASE}/resources`, component: ResourcesTab },
  { key: "maintenance", to: `${SERVICE_BASE}/maintenance`, component: MaintenanceTab },
  { key: "storage", to: `${SERVICE_BASE}/storage`, component: StorageTab },
  { key: "advanced", to: `${SERVICE_BASE}/advanced`, component: AdvancedTab },
] as const satisfies ReadonlyArray<{ key: string; to: string; component: ComponentType }>;
