import { isDatabaseEngine } from "@opsifier/contract";
import { type AnyRoute, createRoute, notFound } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { isApiError } from "../../lib/api";
import { serviceQuery } from "../services/api";
import { type CrumbControlProps, ServiceCrumb } from "../services/Crumbs";
import { DatabaseLayout } from "./DatabaseLayout";
import { databaseTabs } from "./tabs";

/** Every database page, under `/projects/<project>/<engine>/<service>`, for the router to mount. */
export function createDatabaseRoutes<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  const databaseRoute = createRoute({
    getParentRoute,
    path: "$engine/$service",
    staticData: {
      crumbControl: ServiceCrumb as ComponentType<CrumbControlProps>,
      crumbParam: "service",
    },
    beforeLoad: async ({ context, params }) => {
      const { project, engine, service } = params as { project: string; engine: string; service: string };
      if (!isDatabaseEngine(engine)) {
        throw notFound();
      }
      const detail = await (
        context as { queryClient: import("@tanstack/react-query").QueryClient }
      ).queryClient
        .ensureQueryData(serviceQuery(project, service))
        .catch((error: unknown) => {
          throw isApiError(error) && error.status === 404 ? notFound() : error;
        });
      if (detail.type !== engine) {
        throw notFound();
      }
    },
    component: DatabaseLayout,
  });

  return databaseRoute.addChildren(
    databaseTabs.map((tab) =>
      createRoute({ getParentRoute: () => databaseRoute, path: tab.path, component: tab.component }),
    ),
  );
}
