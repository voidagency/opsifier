import { type AnyRoute, createRoute, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { namedParams } from "../../lib/route-params";
import { withBinding } from "../../lib/session-binding";
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
    params: namedParams("project", "service"),
    // `c` names the conversation shown, or is "new" for the next one.
    validateSearch: (search: Record<string, unknown>): { c?: string } =>
      typeof search.c === "string" && search.c !== "" ? { c: search.c } : {},
    component: WorkspacePage,
  });
  // Signed in, a preview behind the panel's sign-in carries on through the panel's own hop.
  const openPreviewRoute = createRoute({
    getParentRoute: () => studioRoute,
    path: "open-preview",
    validateSearch: (search: Record<string, unknown>): { host?: string; to?: string } => ({
      ...(typeof search.host === "string" ? { host: search.host } : {}),
      ...(typeof search.to === "string" ? { to: search.to } : {}),
    }),
    component: OpenPreviewPage,
  });
  return studioRoute.addChildren([listRoute, openPreviewRoute, workspaceRoute]);
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

/** Hands a signed-in browser back to the panel's hop for a preview, which sends it on to the preview. */
function OpenPreviewPage() {
  const { t } = useTranslation("studio");
  const { host = "", to = "/" } = useSearch({ strict: false }) as { host?: string; to?: string };
  useEffect(() => {
    if (host !== "") {
      window.location.replace(
        withBinding(`/api/v1/studio/preview-signin?${new URLSearchParams({ host, to })}`),
      );
    }
  }, [host, to]);
  return <p className="m-6 text-sm text-muted">{t("preview.opening")}</p>;
}
