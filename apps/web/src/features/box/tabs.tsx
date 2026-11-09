import type { ComponentType } from "react";
import { BoxHooksTab } from "../services/tabs/box-hooks/BoxHooksTab";
import { BoxIdeTab } from "../services/tabs/box-ide/BoxIdeTab";
import { BoxModulesTab } from "../services/tabs/box-modules/BoxModulesTab";
import { BoxProcessesTab } from "../services/tabs/box-processes/BoxProcessesTab";
import { DeploymentsTab } from "../services/tabs/deployments/DeploymentsTab";
import { DomainsTab } from "../services/tabs/domains/DomainsTab";
import { EnvironmentTab } from "../services/tabs/environment/EnvironmentTab";
import { MaintenanceTab } from "../services/tabs/maintenance/MaintenanceTab";
import { RedirectsTab } from "../services/tabs/redirects/RedirectsTab";
import { ResourcesTab } from "../services/tabs/resources/ResourcesTab";
import { ScriptsTab } from "../services/tabs/scripts/ScriptsTab";
import { SecurityTab } from "../services/tabs/security/SecurityTab";
import { StorageTab } from "../services/tabs/storage/StorageTab";
import { BoxOverviewTab } from "./BoxOverviewTab";

const BASE = "/projects/$project/box/$service" as const;

/**
 * The tabs of a box, in display order. `key` is the tab's label in the `box` namespace and its URL
 * segment. What a box has of its own are its modules, processes, hooks and IDE: the rest is the same
 * tab an App has, because those only need the service to exist.
 */
export const boxTabs = [
  { key: "overview", path: "/", to: `${BASE}/`, component: BoxOverviewTab },
  { key: "modules", path: "modules", to: `${BASE}/modules`, component: BoxModulesTab },
  { key: "processes", path: "processes", to: `${BASE}/processes`, component: BoxProcessesTab },
  { key: "hooks", path: "hooks", to: `${BASE}/hooks`, component: BoxHooksTab },
  { key: "ide", path: "ide", to: `${BASE}/ide`, component: BoxIdeTab },
  { key: "deployments", path: "deployments", to: `${BASE}/deployments`, component: DeploymentsTab },
  { key: "environment", path: "environment", to: `${BASE}/environment`, component: EnvironmentTab },
  { key: "domains", path: "domains", to: `${BASE}/domains`, component: DomainsTab },
  { key: "redirects", path: "redirects", to: `${BASE}/redirects`, component: RedirectsTab },
  { key: "scripts", path: "scripts", to: `${BASE}/scripts`, component: ScriptsTab },
  { key: "security", path: "security", to: `${BASE}/security`, component: SecurityTab },
  { key: "resources", path: "resources", to: `${BASE}/resources`, component: ResourcesTab },
  { key: "maintenance", path: "maintenance", to: `${BASE}/maintenance`, component: MaintenanceTab },
  { key: "storage", path: "storage", to: `${BASE}/storage`, component: StorageTab },
] as const satisfies ReadonlyArray<{ key: string; path: string; to: string; component: ComponentType }>;
