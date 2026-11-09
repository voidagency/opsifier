import { type AnyRoute, createRoute, notFound } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { isApiError } from "../../lib/api";
import { serviceQuery } from "../services/api";
import { type CrumbControlProps, ServiceCrumb } from "../services/Crumbs";
import { ComposeLayout } from "./ComposeLayout";
import { composeTabs } from "./tabs";

/** Every Compose stack page, under `/projects/<project>/compose/<service>`, for the router to mount. */
export function createComposeRoutes<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  const composeRoute = createRoute({
    getParentRoute,
    path: "compose/$service",
    staticData: {
      crumbControl: ServiceCrumb as ComponentType<CrumbControlProps>,
      crumbParam: "service",
    },
    beforeLoad: async ({ context, params }) => {
      const { project, service } = params as { project: string; service: string };
      const detail = await (
        context as { queryClient: import("@tanstack/react-query").QueryClient }
      ).queryClient
        .ensureQueryData(serviceQuery(project, service))
        .catch((error: unknown) => {
          throw isApiError(error) && error.status === 404 ? notFound() : error;
        });
      if (detail.type !== "compose") {
        throw notFound();
      }
    },
    component: ComposeLayout,
  });

  return composeRoute.addChildren(
    composeTabs.map((tab) =>
      createRoute({ getParentRoute: () => composeRoute, path: tab.path, component: tab.component }),
    ),
  );
}
