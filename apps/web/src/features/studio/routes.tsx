import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { StudioPage } from "./StudioPage";
import { StudioSettingsPage } from "./StudioSettingsPage";
import { WorkspacePage } from "./WorkspacePage";

/** `/studio` and `/studio/<project>/<service>`, for the router to mount in the panel's frame. */
export function createStudioRoutes<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  const studioRoute = createRoute({ getParentRoute, path: "studio", staticData: { crumb: "nav.studio" } });
  const listRoute = createRoute({ getParentRoute: () => studioRoute, path: "/", component: StudioPage });
  const workspaceRoute = createRoute({
    getParentRoute: () => studioRoute,
    path: "$project/$service",
    // `c` names the conversation shown, or is "new" for the next one.
    validateSearch: (search: Record<string, unknown>): { c?: string } =>
      typeof search.c === "string" && search.c !== "" ? { c: search.c } : {},
    component: WorkspacePage,
  });
  return studioRoute.addChildren([listRoute, workspaceRoute]);
}

/** Settings, Server, Studio. */
export function createStudioSettingsRoute<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  return createRoute({
    getParentRoute,
    path: "server/studio",
    staticData: { crumb: "settingsNav.studio" },
    component: StudioSettingsPage,
  });
}
