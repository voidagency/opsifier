import type { QueryClient } from "@tanstack/react-query";
import { type AnyRoute, createRoute, notFound } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { isApiError } from "../../lib/api";
import { serviceQuery } from "../services/api";
import { type CrumbControlProps, ServiceCrumb } from "../services/Crumbs";
import { BoxLayout } from "./BoxLayout";
import { IdePage } from "./ide/IdePage";
import { boxTabs } from "./tabs";

/** Every page of a box, under `/projects/<project>/box/<service>`, for the router to mount. */
export function createBoxRoutes<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  const boxRoute = createRoute({
    getParentRoute,
    path: "box/$service",
    staticData: {
      crumbControl: ServiceCrumb as ComponentType<CrumbControlProps>,
      crumbParam: "service",
    },
    beforeLoad: async ({ context, params }) => {
      const { project, service } = params as { project: string; service: string };
      const detail = await (context as { queryClient: QueryClient }).queryClient
        .ensureQueryData(serviceQuery(project, service))
        .catch((error: unknown) => {
          throw isApiError(error) && error.status === 404 ? notFound() : error;
        });
      if (detail.type !== "box") {
        throw notFound();
      }
    },
    component: BoxLayout,
  });

  return boxRoute.addChildren(
    boxTabs.map((tab) =>
      createRoute({ getParentRoute: () => boxRoute, path: tab.path, component: tab.component }),
    ),
  );
}

/** The editor itself. It sits outside the panel's frame and has no session: its token is its only way in. */
export function createIdeRoute<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  return createRoute({
    getParentRoute,
    path: "ide/$project/$service",
    component: IdePage,
  });
}
