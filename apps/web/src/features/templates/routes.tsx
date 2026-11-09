import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { InstallPage } from "./InstallPage";

/** What a template created, under `/projects/<project>/installs/<id>`, for the router to mount. */
export function createInstallRoute<TParent extends AnyRoute>(getParentRoute: () => TParent) {
  return createRoute({ getParentRoute, path: "installs/$install", component: InstallPage });
}
