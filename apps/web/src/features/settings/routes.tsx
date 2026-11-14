import { type AnyRoute, createRoute, type RouteComponent } from "@tanstack/react-router";
import { AddressPage } from "../opsifier-address/AddressPage";
import { ApiReferencePage } from "./server/ApiReferencePage";
import { CertificatesPage } from "./server/CertificatesPage";
import { GeneralPage } from "./server/GeneralPage";
import { MonitoringPage } from "./server/MonitoringPage";
import { NotificationsPage } from "./server/NotificationsPage";
import { ServerBackupPage } from "./server/ServerBackupPage";
import { UsersPage } from "./server/UsersPage";
import { ApiKeysPage } from "./user/ApiKeysPage";

interface SettingsPage {
  path: string;
  crumb: string;
  component: RouteComponent;
}

const pages: readonly SettingsPage[] = [
  { path: "user/api-keys", crumb: "settingsNav.apiKeys", component: ApiKeysPage },
  { path: "server/general", crumb: "settingsNav.general", component: GeneralPage },
  { path: "server/address", crumb: "settingsNav.address", component: AddressPage },
  { path: "server/users", crumb: "settingsNav.users", component: UsersPage },
  { path: "server/notifications", crumb: "settingsNav.notifications", component: NotificationsPage },
  { path: "server/certificates", crumb: "settingsNav.certificates", component: CertificatesPage },
  { path: "server/monitoring", crumb: "settingsNav.monitoring", component: MonitoringPage },
  { path: "server/backup", crumb: "settingsNav.backup", component: ServerBackupPage },
  { path: "user/api", crumb: "settingsNav.api", component: ApiReferencePage },
];

/** The settings pages of this feature, for the router to mount under the settings layout. */
export function createPlatformSettingsRoutes<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  return pages.map((page) =>
    createRoute({
      getParentRoute,
      path: page.path,
      staticData: { crumb: page.crumb },
      component: page.component,
    }),
  );
}
