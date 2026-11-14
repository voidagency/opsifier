import { isDatabaseEngine, type SessionState } from "@opsifier/contract";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { ActivityPage } from "../features/activity/ActivityPage";
import { CliLoginPage } from "../features/auth/CliLoginPage";
import { InvitationPage } from "../features/auth/InvitationPage";
import { LoginPage } from "../features/auth/LoginPage";
import { SetupPage } from "../features/auth/SetupPage";
import { sessionQuery } from "../features/auth/session";
import { TwoFactorRequiredPage } from "../features/auth/TwoFactorRequiredPage";
import { createBoxRoutes, createIdeRoute } from "../features/box/routes";
import { createComposeRoutes } from "../features/compose/routes";
import { servicePageLink } from "../features/databases/links";
import { createDatabaseRoutes } from "../features/databases/routes";
import { DomainsPage } from "../features/domains/DomainsPage";
import { MonitorPage } from "../features/monitor/MonitorPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectSettingsPage } from "../features/projects/ProjectSettingsPage";
import { ServerPurposePage } from "../features/server-purpose/ServerPurposePage";
import { serviceQuery } from "../features/services/api";
import {
  CreateServicePage,
  type CreateServiceTab,
  createServiceTabs,
} from "../features/services/CreateServicePage";
import { type CrumbControlProps, ProjectCrumb, ServiceCrumb } from "../features/services/Crumbs";
import { ServiceInitPage } from "../features/services/ServiceInitPage";
import { ServiceLayout } from "../features/services/ServiceLayout";
import { serviceTabs } from "../features/services/tabs";
import { AuthenticationPage } from "../features/settings/AuthenticationPage";
import { GithubPage } from "../features/settings/GithubPage";
import { createPlatformSettingsRoutes } from "../features/settings/routes";
import { SettingsLayout } from "../features/settings/SettingsLayout";
import { KnownHostsPage } from "../features/settings/server/KnownHostsPage";
import { StorageProvidersPage } from "../features/storage-providers/StorageProvidersPage";
import { createInstallRoute } from "../features/templates/routes";
import { isApiError } from "../lib/api";
import { BootScreen, NotFoundPage, RootError } from "./RouteStates";
import { AppShell } from "./shell/AppShell";

export interface RouterContext {
  queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }

  interface StaticDataRouteOption {
    /** Translation key, in the `shell` namespace, for this route's breadcrumb. */
    crumb?: string;
    /** Draws the breadcrumb itself, for names that come from the URL. */
    crumbControl?: ComponentType<CrumbControlProps>;
    /** Which URL parameter names the page, for the browser tab's title. */
    crumbParam?: "project" | "service";
  }
}

function getSession(queryClient: QueryClient): Promise<SessionState> {
  return queryClient.ensureQueryData(sessionQuery);
}

/** Only same-site paths are honoured, so a crafted link cannot send a fresh login elsewhere. */
function safeRedirectPath(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : undefined;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === "string" ? { token: search.token } : {},
  beforeLoad: async ({ context }) => {
    const session = await getSession(context.queryClient);
    if (session.status === "signed-out") {
      throw redirect({ to: "/login", replace: true });
    }
    if (session.status === "signed-in") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: SetupPage,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const path = safeRedirectPath(search.redirect);
    return path ? { redirect: path } : {};
  },
  beforeLoad: async ({ context, search }) => {
    const session = await getSession(context.queryClient);
    if (session.status === "needs-setup") {
      throw redirect({ to: "/setup", replace: true });
    }
    if (session.status === "signed-in") {
      throw redirect({ href: search.redirect ?? "/", replace: true });
    }
  },
  component: LoginPage,
});

/** Open to anyone holding a link: the page itself checks it. Accepting replaces any session in progress. */
const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "invitation",
  component: InvitationPage,
});

/** Where an account goes while the panel requires two-factor sign-in and it hasn't turned it on. */
const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "two-factor",
  beforeLoad: async ({ context }) => {
    const session = await getSession(context.queryClient);
    if (session.status !== "signed-in") {
      throw redirect({ to: "/login", replace: true });
    }
    if (!session.twoFactorSetupRequired) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: TwoFactorRequiredPage,
});

/** Where a person approves `opsifier login --web`: signed in, and past any required two-factor setup. */
const cliLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "cli-login",
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" ? { code: search.code } : {},
  beforeLoad: async ({ context, location }) => {
    const session = await getSession(context.queryClient);
    if (session.status === "needs-setup") {
      throw redirect({ to: "/setup", replace: true });
    }
    if (session.status === "signed-out") {
      throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
    }
    if (session.twoFactorSetupRequired) {
      throw redirect({ to: "/two-factor", replace: true });
    }
  },
  component: CliLoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const session = await getSession(context.queryClient);
    if (session.status === "needs-setup") {
      throw redirect({ to: "/setup", replace: true });
    }
    if (session.status === "signed-out") {
      throw redirect({
        to: "/login",
        search: location.href === "/" ? {} : { redirect: location.href },
        replace: true,
      });
    }
    if (session.twoFactorSetupRequired) {
      throw redirect({ to: "/two-factor", replace: true });
    }
  },
  component: AppShell,
});

/** An address given out once for two-factor setup, before it moved under Settings. */
const userAuthenticationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "user/authentication",
  beforeLoad: () => {
    throw redirect({ to: "/settings/user/authentication", replace: true });
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  staticData: { crumb: "nav.overview" },
  component: OverviewPage,
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "activity",
  staticData: { crumb: "nav.activity" },
  component: ActivityPage,
});

const monitorRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "monitor",
  staticData: { crumb: "nav.monitor" },
  component: MonitorPage,
});

const domainsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "domains",
  staticData: { crumb: "nav.domains" },
  component: DomainsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "settings",
  staticData: { crumb: "nav.settings" },
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/user/authentication", replace: true });
  },
});

const settingsAuthenticationRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "user/authentication",
  staticData: { crumb: "settingsNav.authentication" },
  component: AuthenticationPage,
});

const settingsServerPurposeRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "server/purpose",
  staticData: { crumb: "settingsNav.purpose" },
  component: ServerPurposePage,
});

const settingsStorageProvidersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "server/storage-providers",
  staticData: { crumb: "settingsNav.storageProviders" },
  validateSearch: (search: Record<string, unknown>): { connected?: string; oauthError?: string } => ({
    ...(typeof search.connected === "string" ? { connected: search.connected } : {}),
    ...(typeof search.oauthError === "string" ? { oauthError: search.oauthError } : {}),
  }),
  component: StorageProvidersPage,
});

const settingsGithubRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "server/github",
  staticData: { crumb: "settingsNav.github" },
  validateSearch: (search: Record<string, unknown>): { connected?: string; oauthError?: string } => ({
    ...(typeof search.connected === "string" ? { connected: search.connected } : {}),
    ...(typeof search.oauthError === "string" ? { oauthError: search.oauthError } : {}),
  }),
  component: GithubPage,
});

const settingsKnownHostsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "server/known-hosts",
  staticData: { crumb: "settingsNav.knownHosts" },
  component: KnownHostsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects/$project",
  staticData: { crumbControl: ProjectCrumb, crumbParam: "project" },
  component: Outlet,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: ProjectPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: ProjectSettingsPage,
});

const createServiceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "create",
  validateSearch: (search: Record<string, unknown>): { tab?: CreateServiceTab } =>
    createServiceTabs.includes(search.tab as CreateServiceTab) ? { tab: search.tab as CreateServiceTab } : {},
  component: CreateServicePage,
});

const serviceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "app/$service",
  staticData: { crumbControl: ServiceCrumb, crumbParam: "service" },
  beforeLoad: async ({ context, params, location }) => {
    const detail = await context.queryClient
      .ensureQueryData(serviceQuery(params.project, params.service))
      .catch((error: unknown) => {
        throw isApiError(error) && error.status === 404 ? notFound() : error;
      });
    if (isDatabaseEngine(detail.type) || detail.type === "box") {
      throw redirect({ ...servicePageLink(params.project, params.service, detail.type), replace: true });
    }
    const atInit = location.pathname.endsWith("/init/source");
    if (detail.source === null && !atInit) {
      throw redirect({ to: "/projects/$project/app/$service/init/source", params, replace: true });
    }
    if (detail.source !== null && atInit) {
      throw redirect({ to: "/projects/$project/app/$service/", params, replace: true });
    }
  },
  component: Outlet,
});

const serviceInitRoute = createRoute({
  getParentRoute: () => serviceRoute,
  path: "init/source",
  component: ServiceInitPage,
});

const serviceShellRoute = createRoute({
  getParentRoute: () => serviceRoute,
  id: "shell",
  component: ServiceLayout,
});

/** One route per entry of `serviceTabs`, so a tab is added in one place. */
const serviceTabRoutes = serviceTabs.map((tab) =>
  createRoute({
    getParentRoute: () => serviceShellRoute,
    path: tab.key === "overview" ? "/" : tab.key,
    component: tab.component,
  }),
);

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  invitationRoute,
  twoFactorRoute,
  cliLoginRoute,
  createIdeRoute(() => rootRoute),
  appRoute.addChildren([
    overviewRoute,
    userAuthenticationRoute,
    activityRoute,
    monitorRoute,
    domainsRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsAuthenticationRoute,
      settingsServerPurposeRoute,
      settingsGithubRoute,
      settingsKnownHostsRoute,
      settingsStorageProvidersRoute,
      ...createPlatformSettingsRoutes(() => settingsRoute),
    ]),
    projectRoute.addChildren([
      projectIndexRoute,
      projectSettingsRoute,
      createServiceRoute,
      serviceRoute.addChildren([serviceInitRoute, serviceShellRoute.addChildren(serviceTabRoutes)]),
      createComposeRoutes(() => projectRoute),
      createBoxRoutes(() => projectRoute),
      createInstallRoute(() => projectRoute),
      createDatabaseRoutes(() => projectRoute),
    ]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: false,
    defaultPendingMs: 120,
    defaultPendingMinMs: 240,
    defaultPendingComponent: BootScreen,
    defaultErrorComponent: RootError,
    defaultNotFoundComponent: NotFoundPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
